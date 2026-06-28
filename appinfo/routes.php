<?php
declare(strict_types=1);

return [
  'routes' => [
    // Main page
    ['name' => 'page#index', 'url' => '/', 'verb' => 'GET'],

    // Files-backed state (single CSV snapshot)
    ['name' => 'state#get', 'url' => '/api/state', 'verb' => 'GET'],
    ['name' => 'state#put', 'url' => '/api/state', 'verb' => 'PUT'],
  ],
];