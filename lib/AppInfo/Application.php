<?php
declare(strict_types=1);

namespace OCA\WeeklyDashboard\AppInfo;

use OCP\AppFramework\App;
use OCP\AppFramework\Bootstrap\IBootstrap;
use OCP\AppFramework\Bootstrap\IRegistrationContext;
use OCP\AppFramework\Bootstrap\IBootContext;

final class Application extends App implements IBootstrap {
	public const APP_ID = 'weeklydashboard';

	public function __construct() {
		parent::__construct(self::APP_ID);
	}

	public function register(IRegistrationContext $context): void {
		// nothing required
	}

	public function boot(IBootContext $context): void {
		// no boot logic required (navigation comes from appinfo/info.xml <navigations>)
	}
}
