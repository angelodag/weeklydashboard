<?php
declare(strict_types=1);

namespace OCA\WeeklyDashboard\Controller;

use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\DataResponse;
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
	 * Returns JSON: { ok: true, csv: "...", etag: "..." }
	 *
	 * @NoAdminRequired
	 * @NoCSRFRequired
	 */
	public function get(): DataResponse {
		$user = $this->userSession->getUser();
		if ($user === null) {
			return new DataResponse(['ok' => false, 'error' => 'Not logged in'], 401);
		}

		$uid = $user->getUID();
		$userFolder = $this->rootFolder->getUserFolder($uid);

		$dirName = 'WeeklyDashboard';
		$fileName = 'dashboard.csv';

		$csv = $this->defaultCsv();
		$etag = null;

		if ($userFolder->nodeExists($dirName)) {
			$dir = $userFolder->get($dirName);

			if ($dir instanceof \OCP\Files\Folder && $dir->nodeExists($fileName)) {
				$file = $dir->get($fileName);

				if ($file instanceof \OCP\Files\File) {
					$csv = (string)$file->getContent();
					if (trim($csv) === '') {
						$csv = $this->defaultCsv();
					}
					$etag = $file->getEtag();
				}
			}
		}

		$headers = ['Cache-Control' => 'no-store'];
		if ($etag !== null) {
			$headers['ETag'] = $etag;
		}

		return new DataResponse(
			[
				'ok' => true,
				'csv' => $csv,
				'etag' => $etag,
			],
			200,
			$headers
		);
	}

	/**
	 * Expects raw CSV in request body.
	 *
	 * @NoAdminRequired
	 */
	public function put(): DataResponse {
		$user = $this->userSession->getUser();
		if ($user === null) {
			return new DataResponse(['ok' => false, 'error' => 'Not logged in'], 401);
		}

		$uid = $user->getUID();
		$userFolder = $this->rootFolder->getUserFolder($uid);

		$dirName = 'WeeklyDashboard';
		$fileName = 'dashboard.csv';

		// Portable: read raw request body
		$body = (string)file_get_contents('php://input');

		if (stripos($body, 'id,title,description,lane') === false) {
			return new DataResponse(['ok' => false, 'error' => 'Invalid CSV (missing header)'], 400);
		}

		// Ensure folder exists
		if ($userFolder->nodeExists($dirName)) {
			$node = $userFolder->get($dirName);
			if (!($node instanceof \OCP\Files\Folder)) {
				return new DataResponse(['ok' => false, 'error' => 'Storage path is not a folder'], 500);
			}
			$dir = $node;
		} else {
			$dir = $userFolder->newFolder($dirName);
		}

		// Existing file => require If-Match for overwrite protection
		if ($dir->nodeExists($fileName)) {
			$node = $dir->get($fileName);
			if (!($node instanceof \OCP\Files\File)) {
				return new DataResponse(['ok' => false, 'error' => 'State path is not a file'], 500);
			}

			$currentEtag = $node->getEtag();

			$ifMatch = $this->request->getHeader('If-Match');
			$ifMatch = $ifMatch !== null ? trim($ifMatch) : '';

			if ($ifMatch === '') {
				return new DataResponse(
					[
						'ok' => false,
						'error' => 'Missing If-Match header (required to prevent overwrites)',
						'currentEtag' => $currentEtag,
					],
					428
				);
			}

			// Accept quoted/unquoted and weak etags W/"..."
			$normalizedIfMatch = preg_replace('/^W\\//', '', trim($ifMatch));
			$normalizedIfMatch = trim((string)$normalizedIfMatch, "\"");

			$normalizedCurrent = preg_replace('/^W\\//', '', trim($currentEtag));
			$normalizedCurrent = trim((string)$normalizedCurrent, "\"");

			if ($normalizedIfMatch !== $normalizedCurrent) {
				return new DataResponse(
					[
						'ok' => false,
						'error' => 'ETag mismatch (state changed since you loaded it)',
						'currentEtag' => $currentEtag,
					],
					409
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

		// First-time create (no If-Match required)
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
