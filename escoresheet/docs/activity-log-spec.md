# Logging in OpenVolley: event history and activity log

As built on `feat/activity-log` (2.4.0). Deploy: `docs/activity-log-deploy.md`.
Privacy texts: `docs/legal/*/privacy.md` (section 5 and the retention table),
`docs/legal/data-map.md` 4.17.

## What exists

| Log | Where | Synced | Purpose |
|---|---|---|---|
| **Event history** | Dexie `event_history`; server `events.voided_*` + `event_revisions` | yes (sync queue) | Every undo, delete, edit and restore of a match event, with the reason. Part of the match record. |
| **Activity log** | Dexie `activity_log`; server `activity_log`; daily JSONL files in the apps | yes (sync queue) | What happened on the device: scoring, corrections, sets, match status, signatures, approvals, sync results, app start, update, quit and errors. |
| **Interaction log** | Dexie `interaction_logs` | **never** | Every click and key press, for troubleshooting. Local, exportable. Also holds the scoreboard's debug lines (category `debug`). |
| **Desktop log** | `<data dir>/OpenVolley/logs/desktop.log` (OpenBeach: `<data dir>/OpenBeach/logs`) | no | The Rust side: start, updates, popups, tablet count. |
| Console upload (`utils/logger.js`) | storage bucket | when signed in | Unchanged (deferred, see below). |

## 1. Event history

**Local (`db/eventHistory.js`).** Dexie hooks on `db.events` see every write,
whichever screen made it:

- `deleting` writes a `void` row.
- `updating` writes an `edit` row. Filling in the state snapshot of a
  freshly logged event (logEvent adds the event, then its snapshot) is not
  an edit, and neither are bookkeeping keys. Rewriting an existing snapshot
  is an edit.
- `creating` with an explicit id writes a `restore` row, but only for an
  event voided before (undo of a decision change puts sub-events back).

The *reason* comes from `withActivityContext({reason, actionId}, fn)`:

| Action | Reason |
|---|---|
| `handleUndo` | `undo` (one `actionId`) |
| decision change and replay (`handleDecisionChange`) | `decision_change` |
| `discardEvents(rows, reason)` fallback | `forfeit_reversal`, `reopen_set` |
| roster reopen renumbering | `roster_reopen` |
| ManualAdjustments save | `manual_adjustment` |
| MatchEnd forfeit reversal / reopen last set | `forfeit_reversal`, `reopen_set` |
| Corrections panel (`services/corrections/applyCorrectionPlan`, during the match and at the match end) | `correction` (one `actionId` per correction) |
| no context | `delete` (void), `other` (edit) |

Rows are written in the action's transaction when it includes
`EVENT_HISTORY_SCOPE` (`event_history`, `sync_queue`, `activity_log`), and
otherwise in one transaction right after it commits. The crash window closes
once `fix/atomic-actions` adds the scope to its transactions. A rolled-back
transaction leaves no history.

Whole-match wipes are not undo. Deleting a match, starting a new match,
clearing test data, closing and deleting a match, and restoring a backup all
use `wipeMatchEvents(db, matchId, {dropHistory})`. `Table.clear()` records
nothing either. Dexie 4 runs the deleting hook for every row of a clear, so
a dbcore middleware suppresses it for a full-range `deleteRange`.

**seq is never reused.** `getNextSeq` / `getNextSubSeq` take
`max(live, maxVoidedSeq(db, matchId[, range]))` (an indexed read of
`[matchId+seq]`).

**Sync.** For a cloud match (`seed_key`, not test) each row queues
`{resource:'event', action:'void'|'edit'|'restore', payload:{external_id,
match_id, rev_uid, op, reason, seq, set_index, type, client_ts, device_id,
app_version, after?}}`. `after` holds the server columns (`type, set_index,
payload, score_a, score_b`) and never `state_snapshot`. Events the scoreboard
never uploads (`rally_start`, `replay`) keep their history local.
`syncJobsForEvents` drops only the *insert* jobs of discarded events. The
queue posts revisions to `/api/match/event-revisions`:

- 404 `OV_MATCH_NOT_FOUND` is retried later.
- Any other 404 (older server, LAN) parks the job as `failed`; it is retried
  hourly.

**Server (`db/015`, `lib/eventRevisions.js`).** One transaction per call. The
writer must be the owner or an editor (admin: anyone; test-only accounts only
on test matches), which `pgQuery.assertMatchWritable` checks. Event ids must
be scoped to the match. For each revision the server:

1. locks the event;
2. inserts the revision, idempotent by `rev_uid`, with `applied` and `before`;
3. voids, edits or restores the event and counts `rev` up.

A void that arrives before its event makes it born voided (insert trigger;
the latest void or restore wins). Closed matches are frozen (409
`OV_MATCH_CLOSED`).

The void columns are on `/api/db`'s write denylist. Event selects leave out
voided rows, except with `include_voided: true` for an admin or for the
owner or editors of the match. The same applies to restore-by-pin, so a new
device never replays an undone point. `/api/match/restore` replaces events
and keeps `event_revisions`.

## 2. Activity log

**Writer (`utils/activity`).** `startActivityLog({db})` runs in `main.jsx`.
Entries are buffered and written with one `bulkAdd` every 250 ms or 50
entries, at once for an error and on quit. The writer is never awaited on the
scoring path.

Row: `{lid, uid, ts, kind, level, app, matchId, matchExt, setIndex, eventSeq,
eventExt, data, deviceId, appVersion, platform, accountId, synced: 0|1|2}`.
The device id is `utils/deviceId` (`ov.deviceId`), and `synced` 2 means
local only (test match, or refused by the server).

**Sources.** Dexie hooks (`hooks.js`, after commit):

- `event.add`, with the snapshot's score: it waits up to 2 s for the
  snapshot.
- `event.bulk_add` when a transaction adds more than 20 events.
- `event.undo/delete/edit/restore` from the event history.
- `set.start/end/reopen/delete`.
- From the match row (`MATCH_KEY_KINDS`): `match.create/status/close/coin_toss/
  manual_change/signature/approval/remarks/forfeit`.
- `match.roster` for the open match's teams.

The bus (`bus.js`, no database import) carries the rest:

- `sync.error/dropped`, with status, code and `X-Request-Id`.
- `sync.state` on group changes.
- `sync.summary`, at most every 5 minutes and at set end.
- `app.start/update`.
- `app.quit`: written before the desktop quits, and on `pagehide`.
- `app.error`: global errors and error boundaries; message ≤ 300 characters,
  top 5 `file:line` frames; the same message at most 5 times per 10 minutes.
- `backup.error`.
- `auth.sign_in/out`.

The activity uploads themselves are never logged.

**Privacy.** `domain/activitySummary.js` `sanitizeActivityData` applies:

- a key allowlist per kind;
- a key denylist (PIN, password, token, secret, signature, image, data URL,
  DOB, birth, email, phone, licence);
- no data URLs or JWTs;
- strings ≤ 200 characters, depth ≤ 3, ≤ 4 KB.

A manual change of a sensitive field becomes "changed". Remarks are logged by
length only. A signature is logged by role and signed/cleared only. An
approval is logged by role and method only. The server runs the same code
(`lib/activitySanitize.js`, compared by a test).

**Upload.** One coalesced `{resource:'activity', action:'flush'}` job:

- It is queued 10 s after new rows, and **only with a session**, so it never
  turns the sync status into "sign in required".
- Each run takes up to 500 waiting rows that have no account or the current
  one.
- Accepted rows become synced 1, refused rows 2. If more remain, the next
  flush is queued.
- Sent jobs are pruned after an hour.

**Server (`db/016`, `lib/activityLog.js`).**

- `POST /api/activity`: at most 500 entries and 512 KB, 30 per minute per
  user. `account_id` must be null or the caller. An entry for a match on the
  server needs the caller to be owner or editor; a match not yet on the
  server is accepted. Idempotent by uid.
- `GET /api/activity?match=`: owner or editors, and only rows uploaded by
  the match's scorers.
- Admin: `GET /api/admin/activity` (filters), `GET
  /api/admin/activity/export` (CSV/NDJSON, streamed, ≤ 50,000 rows) and
  `DELETE /api/admin/activity?match=|account=&confirm=yes` (audited
  `activity.delete`).
- `roles.sql` makes the table append-only for `ov_app`.

**Files.** Desktop: `activity_append` and `activity_open_dir`
(`src-tauri/src/activity.rs`, capability `activity.json`). Android: Capacitor
Filesystem in `Documents/OpenVolley/logs`. Both write `activity-YYYY-MM-DD.jsonl`
every 2 s or 50 lines and on quit, and keep 30 files and 50 MB.

**Retention.**

| Where | Rule |
|---|---|
| Device | Uploaded rows: 180 days and 100,000 rows. Waiting rows are kept below 200,000; beyond that the oldest go and an `activity.overflow` entry is written. |
| Server (`purgeActivity`, daily) | Match rows 24 months after the event, or deleted with the match. Rows without a match: 90 days. |
| Account deletion | Rows without a match are deleted. Match rows stay with the account cleared. |

## 3. Interaction log (local only)

- **Match context.** `useAutoBackup` sets the open match
  (`activity/activeMatch.setActiveMatch`), so every entry carries `matchId`
  and `gameNumber`. Before, it was always null and the match-end export was
  empty.
- **Export.** `getLogsForMatch({matchId, gameN, from, to})` returns entries
  by id, by game number, or, for untagged entries, by the time the match was
  open. It is used by the options' "Export diagnostic log", the match-end
  download and the ZIP.
- **Retention.** 30 days and 50,000 rows (`pruneInteractionLogs`, at start
  and hourly). The beforeunload copy is capped at 2,000 entries.
- **Debug lines.** `debugLogger.log` writes category `debug`; snapshots over
  20 KB are dropped. The old localStorage copy is migrated once.
  `debugLogger.getLogs()` now returns only the last 200 entries of the page
  load.

## 4. UI

- **App.** `ActivityLogModal`: the scoreboard options → Logs (this match),
  and the home options → Logs (all matches, with a picker). It has filter
  chips, an uploaded / waiting / local-only pill on each row, a "N not
  uploaded yet" header and JSON / CSV export. The match-end ZIP adds
  `activity_<date>.ndjson`.
- **Admin console.** An Activity tab (`ActivityPanel`). On the matches tab,
  "Activity" (the tab filtered to the match) and "Corrections"
  (`RevisionsModal`).

## 5. Differences from the plan

- A `restore` op was added, both locally and on the server, so that undoing
  a decision change does not leave its restored sub-events voided on the
  server.
- `Table.clear()` *does* fire the deleting hook in Dexie 4. It is suppressed
  by a dbcore middleware instead.
- `DELETE /api/admin/activity` takes `confirm=yes` in the query: the manage
  routes read no DELETE body.
- `ov_match_children_guard()` gains an account-deletion exception, so that
  clearing `voided_by` / `actor_id` on a closed match does not fail.
- The decision change and replay handler and the roster renumbering also
  set a context (two more small spots in Scoreboard.jsx).
- `tauri-plugin-log ~2.9`: 2.10 needs Rust 1.90.

## 6. Deferred

- A server-side reconcile (a manifest of the live event ids). It is unsafe
  until restore-by-pin keeps the cloud external ids.
- `utils/logger.js` console uploads: limit them to debug mode and add an
  admin viewer.
- Activity from the referee, bench and livescore apps. (OpenBeach uploads
  with `app='beach'` and the same catalog; its set entries carry team 1 as
  `home` and team 2 as `away`, see `lib/activitySanitize.js`.)
- Electron logging, logcat, the Windows event log.
- A self-service "delete my activity". Admin delete covers requests for now.
- Undone points struck through on the scoresheet or PDF.
- The inline `Math.floor(maxSeq)+0.1` sub-seq sites. They should adopt
  `maxVoidedSeq` in fix/atomic-actions.
