<?php
declare(strict_types=1);

namespace OCA\WeeklyDashboard\Controller;

use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\DataResponse;
use OCP\AppFramework\Http\Response;
use OCP\AppFramework\Http\PlainTextResponse;
use OCP\Files\IRootFolder;
use OCP\IRequest;
use OCP\IUserSession;

class StateController extends Controller {
	private IRootFolder $rootFolder;
	private IUserSession $userSession;

	public function __construct(
		string $appName,
		IRequest $request,
		IRootFolder $rootFolder,
		IUserSession $userSession
	) {
		parent::__construct($appName, $request);
		$this->rootFolder = $rootFolder;
		$this->userSession = $userSession;
	}

	private function defaultCsv(): string {
		return "# weeklydashboard v1\n"
			. "# ui.backlogCollapsed=0\n"
			. "# ui.doneCollapsed=0\n"
			. "# ui.doneHeightPx=\n"
			. "id,title,description,lane,doneStamp,orderIndex\n";
	}

	/**
	 * @NoAdminRequired
	 */
	public function get(): Response {
		$user = $this->userSession->getUser();
		if ($user === null) {
			return new DataResponse(['ok' => false, 'error' => 'Not logged in'], 401);
		}

		$uid = $user->getUID();
		$userFolder = $this->rootFolder->getUserFolder($uid);

		$dirName = 'WeeklyDashboard';
		$fileName = 'dashboard.csv';

		// If folder/file doesn't exist, return default CSV with no ETag
		if (!$userFolder->nodeExists($dirName)) {
			return new PlainTextResponse(
				$this->defaultCsv(),
				200,
				[
					'Content-Type' => 'text/csv; charset=utf-8',
					'Cache-Control' => 'no-store',
				]
			);
		}

		$dir = $userFolder->get($dirName);
		if (!($dir instanceof \OCP\Files\Folder)) {
			return new DataResponse(['ok' => false, 'error' => 'Storage path is not a folder'], 500);
		}

		if (!$dir->nodeExists($fileName)) {
			return new PlainTextResponse(
				$this->defaultCsv(),
				200,
				[
					'Content-Type' => 'text/csv; charset=utf-8',
					'Cache-Control' => 'no-store',
				]
			);
		}

		$file = $dir->get($fileName);
		if (!($file instanceof \OCP\Files\File)) {
			return new DataResponse(['ok' => false, 'error' => 'State path is not a file'], 500);
		}

		$content = $file->getContent();
		$etag = $file->getEtag();

		$response = new PlainTextResponse($content, 200, [
			'Content-Type' => 'text/csv; charset=utf-8',
			'Cache-Control' => 'no-store',
			'ETag' => $etag,
		]);
		return $response;
	}

	/**
	 * @NoAdminRequired
	 */
	public function put(): Response {
		$user = $this->userSession->getUser();
		if ($user === null) {
			return new DataResponse(['ok' => false, 'error' => 'Not logged in'], 401);
		}

		$uid = $user->getUID();
		$userFolder = $this->rootFolder->getUserFolder($uid);

		$dirName = 'WeeklyDashboard';
		$fileName = 'dashboard.csv';

		$body = (string)$this->request->getContent();

		// Basic validation: must include header
		if (stripos($body, 'id,title,description,lane') === false) {
			return new DataResponse(['ok' => false, 'error' => 'Invalid CSV (missing header)'], 400);
		}

		// Ensure folder exists
		$dir = null;
		if ($userFolder->nodeExists($dirName)) {
			$node = $userFolder->get($dirName);
			if (!($node instanceof \OCP\Files\Folder)) {
				return new DataResponse(['ok' => false, 'error' => 'Storage path is not a folder'], 500);
			}
			$dir = $node;
		} else {
			$dir = $userFolder->newFolder($dirName);
		}

		// If file exists, enforce optimistic concurrency via If-Match
		if ($dir->nodeExists($fileName)) {
			$node = $dir->get($fileName);
			if (!($node instanceof \OCP\Files\File)) {
				return new DataResponse(['ok' => false, 'error' => 'State path is not a file'], 500);
			}
			$currentEtag = $node->getEtag();

			$ifMatch = $this->request->getHeader('If-Match');
			$ifMatch = $ifMatch !== null ? trim($ifMatch) : '';

			// Require If-Match for overwriting existing state
			if ($ifMatch === '') {
				return new DataResponse(
					[
						'ok' => false,
						'error' => 'Missing If-Match header (required to prevent overwrites)',
						'currentEtag' => $currentEtag,
					],
					428 // Precondition Required
				);
			}

			// Some clients wrap etag in quotes; accept both
			$normalizedIfMatch = trim($ifMatch, "\"");
			$normalizedCurrent = trim($currentEtag, "\"");

			if ($normalizedIfMatch !== $normalizedCurrent) {
				return new DataResponse(
					[
						'ok' => false,
						'error' => 'ETag mismatch (state changed since you loaded it)',
						'currentEtag' => $currentEtag,
					],
					409 // Conflict
				);
			}

			$node->putContent($body);
			$newEtag = $node->getEtag();
			$stat = $node->stat();

			return new DataResponse(
				[
					'ok' => true,
					'bytes' => $node->getSize(),
					'mtime' => $stat['mtime'] ?? null,
					'path' => '/' . $dirName . '/' . $fileName,
					'etag' => $newEtag,
				],
				200,
				[
					'ETag' => $newEtag,
					'Cache-Control' => 'no-store',
				]
			);
		}

		// If file doesn't exist yet, create it (no If-Match needed)
		$file = $dir->newFile($fileName);
		$file->putContent($body);

		$newEtag = $file->getEtag();
		$stat = $file->stat();

		return new DataResponse(
			[
				'ok' => true,
				'bytes' => $file->getSize(),
				'mtime' => $stat['mtime'] ?? null,
				'path' => '/' . $dirName . '/' . $fileName,
				'etag' => $newEtag,
			],
			200,
			[
				'ETag' => $newEtag,
				'Cache-Control' => 'no-store',
			]
		);
	}
}