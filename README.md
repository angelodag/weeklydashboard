# Weekly Dashboard (Nextcloud App)

A lightweight weekly task dashboard that runs inside Nextcloud and persists the **entire dashboard state** (tasks, lanes, ordering, UI settings) as a **single CSV file** in the user’s Nextcloud Files.

## Key features

- Lanes: **Backlog**, **Monday–Friday**, **Done**
- Drag & drop between lanes
- Stable **reordering within lanes** (placeholder-based insertion)
- **Done stamping**: moving into Done sets `Done: <weekday> <YYYY-MM-DD>`; moving out clears it
- **Waiting state**:
  - Visible as a **red outline**
  - Encoded as a `WAITING` line inside the task description
  - Toggled via a **Waiting** button in the edit dialog header
  - When a task becomes Waiting, it moves to the **bottom** of its lane
  - When moved into Done, Waiting is **cleared automatically**
- Task editor:
  - Double-click to edit title/description
  - No Save/Cancel buttons — **auto-saves on close**
  - New task is only created if it has a **non-empty title** on close
  - Delete button for existing tasks
- Quick add in Backlog: type a title and press Enter / Add
- Collapsible lanes:
  - Backlog can collapse into a slim rail
  - Done can collapse into header-only
  - Collapse state is stored in the **Nextcloud snapshot**
- Resizable Done:
  - Drag splitter above Done
  - Initial size is **33%** of available height (unless restored)
  - Height is stored in the **Nextcloud snapshot**
- CSV:
  - Export/Import from local filesystem remains available
  - Archive Done exports done tasks and clears Done

## Persistence model (single file in Nextcloud Files)

This app stores the authoritative snapshot per user at:

- `/WeeklyDashboard/dashboard.csv`

The CSV contains:
- Comment meta lines (starting with `#`) for UI state, for example:
  - `# ui.backlogCollapsed=0|1`
  - `# ui.doneCollapsed=0|1`
  - `# ui.doneHeightPx=<number>`
- A task table:
  - `id,title,description,lane,doneStamp,orderIndex`

This provides cross-device persistence without using a custom database table.

## Overwrite protection (prevents accidental overwrites)

The app uses **optimistic concurrency** with **ETag**:

- `GET /api/state` returns the CSV plus an `ETag` header.
- `PUT /api/state` requires `If-Match: <etag>` when overwriting an existing file.
- If another device/tab saved in the meantime, the server rejects the save with **409 Conflict**.

### Typical workflow
1. Click **Load from Nextcloud** (the UI also attempts to auto-load on startup)
2. Make changes
3. Click **Save to Nextcloud**

### If you get a conflict
1. Click **Load from Nextcloud** to refresh to the newest state
2. Re-apply your latest edits if needed
3. Click **Save to Nextcloud** again

## Folder structure

Place the app in:

- `nextcloud/apps/weeklydashboard/`

Expected structure:

- `appinfo/info.xml`
- `appinfo/routes.php`
- `lib/AppInfo/Application.php`
- `lib/Controller/PageController.php`
- `lib/Controller/StateController.php`
- `templates/index.php`
- `css/style.css`
- `js/app.js`
- `img/app.svg`

Notes:
- **Do not use** `appinfo/app.php` (deprecated). This app uses `IBootstrap`.
- Navigation is declared via `<navigations>` in `info.xml`.

## Install / Deploy

1. Copy the app folder into `nextcloud/apps/weeklydashboard/`
2. Fix ownership/permissions (example for Debian/Ubuntu + Apache):
   ```bash
   sudo chown -R www-data:www-data /var/www/nextcloud/apps/weeklydashboard
   sudo find /var/www/nextcloud/apps/weeklydashboard -type d -exec chmod 750 {} \;
   sudo find /var/www/nextcloud/apps/weeklydashboard -type f -exec chmod 640 {} \;
