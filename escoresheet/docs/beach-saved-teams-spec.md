# Beach saved teams: implementation spec

Extends `scorer-accounts-spec.md` §4.7, §5.5 and §6.4–6.6 (OpenVolley 2.1.0). The OpenVolley admin
console is the only competition manager, and it manages both indoor and beach competitions.
OpenBeach reads beach teams and never writes them.

Two agents work in parallel from this file:
- **Agent A** (OpenVolley, `/home/lucanepa/.cache/openvolley/wt-beachteams`, branch `feat/beach-saved-teams` from `main`): §1–§4, §6, and the A rows of §7.
- **Agent B** (OpenBeach, `/home/lucanepa/.cache/openvolley/wt-openbeach`, branch `feat/beach-saved-teams` from `feat/new-backend`): §5, and the B rows of §6 and §7.

The contract between the two agents is §2 (HTTP) together with the fixture in §2.6. Neither agent pushes, deploys or touches production.

---

## 0. Decisions

| # | Decision |
|---|---|
| D1 | `competitions.sport` is `'indoor'` or `'beach'`. Every existing row is indoor. Sport is fixed when the competition is created and cannot change afterwards. A team's sport is its competition's. |
| D2 | **Backward compatibility.** Clients from 2.1.0 send no `sport`. `GET /api/saved-teams` without `sport` returns **indoor only**, and `POST …/competitions` without `sport` creates an **indoor** competition. So a 2.1.0 console or MatchSetup never sees a beach row. |
| D3 | A beach team is a pair: 0–2 players numbered 1 and 2, unique. It is complete when it has 2 players. Player fields are first name, last name, date of birth, licence and country (optional, 3 letters such as `CHE`). There is no libero, captain or `active` flag; beach players are always active. Staff is at most one `Coach`. The captain is still chosen in MatchSetup_beach for each match. |
| D4 | The beach season is the calendar year (`'2026'`). The indoor season stays `'2026/27'`. VolleyManager leagues (`vm_leagues`) are indoor only. |
| D5 | Permissions are the same as indoor. GET needs `canReadTeams`, writes need `canManageTeams`. Anonymous gets 401, pending accounts get 403. Personal data is never served to anonymous requests. |
| D6 | No new error code. Every rule violation is 400 `OV_INVALID_REQUEST` with a `details` string. |
| D7 | OpenBeach is read-only: it has "Load saved team" plus suggestions. Saving a roster to a team is out of scope (only the console writes). The hidden Supabase-era competition admin (`CompetitionAdminApp_beach.jsx`, `COMPETITIONS_ENABLED=false`) stays hidden and untouched. |

---

## 1. Migration `escoresheet/backend/db/009_beach_saved_teams.sql` (Agent A, exact text)

```sql
-- 009_beach_saved_teams.sql: saved teams for beach volleyball (OpenBeach).
--
-- competitions.sport ('indoor' | 'beach'; every existing row is indoor), the
-- season format per sport (indoor '2026/27', beach '2026'), and
-- competition_players.country (3 letters, e.g. 'CHE'; beach only, the API
-- enforces that). The beach roster rules (a pair numbered 1 and 2, no libero
-- or captain, staff = at most one Coach) are lib/savedTeams.js's.
--
-- Run as ov_owner after 008 (restore.sh runs every db/NNN_*.sql with
-- NNN >= 003 in numeric order), then roles.sql. Idempotent. One transaction.
-- No new table, sequence or function: ov_app's table-level grants already
-- cover the new columns, so roles.sql is unchanged.
-- Safe on live data and under the running 2.1.0 backend: it names its
-- columns, inserts no sport (default 'indoor') and no country (NULL).

BEGIN;
SET LOCAL lock_timeout = '5s';

-- 1. competitions.sport (constant default: no table rewrite)
ALTER TABLE public.competitions ADD COLUMN IF NOT EXISTS sport text NOT NULL DEFAULT 'indoor';

DO $$
DECLARE r record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'competitions_sport_check' AND conrelid = 'public.competitions'::regclass) THEN
    ALTER TABLE public.competitions
      ADD CONSTRAINT competitions_sport_check CHECK (sport IN ('indoor', 'beach'));
  END IF;

  -- 2. The season format per sport replaces 007's column CHECK (indoor only)
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'competitions_season_sport_check' AND conrelid = 'public.competitions'::regclass) THEN
    ALTER TABLE public.competitions
      ADD CONSTRAINT competitions_season_sport_check CHECK (
        (sport = 'indoor' AND season ~ '^\d{4}/\d{2}$') OR (sport = 'beach' AND season ~ '^\d{4}$'));
  END IF;
  FOR r IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.competitions'::regclass AND contype = 'c'
              AND conname NOT IN ('competitions_sport_check', 'competitions_season_sport_check')
              AND pg_get_constraintdef(oid) LIKE '%season%' LOOP
    EXECUTE format('ALTER TABLE public.competitions DROP CONSTRAINT %I', r.conname);
    RAISE NOTICE '009: dropped the indoor-only season check %', r.conname;
  END LOOP;

  -- 3. competition_players.country
  ALTER TABLE public.competition_players ADD COLUMN IF NOT EXISTS country text;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'competition_players_country_check' AND conrelid = 'public.competition_players'::regclass) THEN
    ALTER TABLE public.competition_players
      ADD CONSTRAINT competition_players_country_check CHECK (country IS NULL OR country ~ '^[A-Z]{3}$');
  END IF;
END $$;

COMMIT;
```

Notes:
- The new season CHECK validates the existing rows. They all satisfy 007's indoor format, so it cannot fail on live data.
- **Deploy order:** run 009 first, then `roles.sql` (a no-op for these tables), then the new backend, then the frontends. The 2.1.0 backend keeps working on a migrated database. The new backend on an unmigrated database answers 503 on `/api/saved-teams*` (`42703`).
- `tests/helpers/pgTestDb.js`: append `'009_beach_saved_teams.sql'` to `MIGRATIONS_SQL`.
- `backend/README.md`: add a migration-table row for `009_beach_saved_teams.sql` ("after 008 · `competitions.sport`, season per sport, `competition_players.country`. Idempotent, no grants.") and document the `sport` param and fields in the saved-teams endpoint section.

---

## 2. HTTP API changes (`backend/lib/savedTeams.js`, `backend/lib/manageApi.js`; Agent A)

Paths, envelope, auth, rate limits and role checks are unchanged (scorer-accounts-spec §5, §5.5). Only the following changes.

### 2.1 `GET /api/saved-teams?sport=indoor|beach|all`
- `sport` absent or `''` means `indoor` (D2). Any value other than `indoor`, `beach` or `all` (case-sensitive) gets 400 `OV_INVALID_REQUEST` with `details: "sport: indoor, beach or all"`, before any database call.
- `manageApi.js`: `['GET', /^\/api\/saved-teams$/, 'readTeams', (m, c) => savedTeams.getBundle({ sport: q(c.query, 'sport') })]`.
- `getBundle({ sport })`:
  - competitions use `WHERE ($1 = 'all' OR sport = $1)`;
  - teams use `JOIN competitions c ON c.id = t.competition_id` with the same filter;
  - `version` is `greatest(max(c.updated_at), max(t.updated_at))` over the **filtered** rows, or `'0'` when there are none.
- Response `Bundle` (additions in **bold**):
  ```
  Bundle      { version, fetched_at, **sport: 'indoor'|'beach'|'all'**, competitions: [Competition], teams: [Team] }
  Competition { id, name, season, gender, category, vm_leagues, archived, updated_at, **sport** }
  Team        { id, competition_id, name, short_name, club, color, svrz_team_name, updated_at, **sport**, players, staff }
  Player      { id, number, first_name, last_name, dob, license_number, is_libero, is_captain, active, sort_order, **country** }
  Staff       unchanged
  ```
  `country` is `null` for indoor players. For beach players `is_libero` and `is_captain` are always `false` and `active` is always `true`. `ROSTER_SQL` adds `'country', p.country`. `teamOut` and `competitionOut` add `sport`. `TEAM_COLS` reads come from a join with `competitions` (`c.sport`) in `getBundle`, `teamById`, and `createTeam`. `createTeam` already selects the competition, so it selects `id, sport` there and sets `sport` on the output.

### 2.2 `POST /api/saved-teams/competitions`
Body as in 2.1.0, plus `sport?: 'indoor'|'beach'`.
- Absent or `null`: `'indoor'`. Anything else: 400 `"sport: indoor or beach"`.
- `season`:
  - indoor: unchanged (`"season: like '2026/27'"`, consecutive years);
  - beach: `/^\d{4}$/` with a year from 2000 to 2100, else `"season: like '2026'"`.
- `vm_leagues` on beach: absent, `null` or `[]` is fine. A non-empty list gets 400 `"vm_leagues: not for beach"`.
- The `INSERT` includes `sport`. The answer is **201** `{ competition }` with `sport`.

### 2.3 `PATCH /api/saved-teams/competitions/:id`
- Any `sport` key gets 400 `"sport: cannot be changed"`. Checked first, so it answers even for an unknown id.
- For any other non-empty body, the handler first runs `SELECT sport FROM competitions WHERE id = $1` (no row gives 404). It then validates `season` and `vm_leagues` with the rules of **that** sport (2.2), and updates as before.

### 2.4 Teams
`POST /teams`, `PATCH /teams/:id` and `DELETE /teams/:id`:
- Fields, rules and the 409 `OV_DUPLICATE` are unchanged for both sports.
- `svrz_team_name` is still accepted for beach, but no beach client uses it.
- Every `team` in an answer carries `sport` and players with `country`.

### 2.5 `PUT /api/saved-teams/teams/:id/roster`
Order:
1. A non-uuid id gets 404.
2. Shape check: body not an object gets 400 `"body: must be an object"`. `players` or `staff` not an array gets 400 `"players: an array"` / `"staff: an array"`.
3. In the transaction: `SELECT t.id, c.sport FROM public.competition_teams t JOIN public.competitions c ON c.id = t.competition_id WHERE t.id = $1 FOR UPDATE OF t`. No row gives 404.
4. `validateRoster(body, { sport })`. An error aborts with its 400.
5. Upsert as today. The players `INSERT … ON CONFLICT` adds `country`.

`export function validateRoster(body, { sport = 'indoor' } = {})`. The 2.1.0 unit tests call it with one argument and keep passing.
- **Indoor:** the 2.1.0 rules, plus `players[i].country` must be absent, `null` or `''` (stored `NULL`), else `"players[i].country: only for beach"`.
- **Beach:** checks run in this order, and the first error wins. `i` is the array index.
  - `players.length > 2` gives `"players: at most 2 in beach"`. `staff.length > 1` gives `"staff: at most 1 (the coach) in beach"`.
  - Person fields as indoor: `first_name` up to 80, `last_name` required 1–80, `dob` as `YYYY-MM-DD` or null, `license_number` up to 40.
  - `number` is required and must be the integer 1 or 2, else `"players[i].number: 1 or 2"`. A duplicate gives `"players[i].number: N is used twice"`.
  - `is_libero` / `is_captain`: absent, `null` or `false` is fine. A non-boolean gives `"players[i].is_libero: true or false"` (the 2.1.0 text). `true` gives `"players[i].is_libero: not in beach"` / `"players[i].is_captain: not in beach"`.
  - `active`: absent, `null` or `true` is fine. A non-boolean gives `"…: true or false"`. `false` gives `"players[i].active: not in beach"`.
  - `country`: absent, `null` or `''` is stored as null. Otherwise `String(v).trim().toUpperCase()` must match `/^[A-Z]{3}$/`, else `"players[i].country: 3 letters like 'CHE'"`. The value is stored upper-case.
  - `staff[0].role` must be `'Coach'`, else `"staff[0].role: Coach only in beach"`.
  - Stored values: `is_libero=false`, `is_captain=false`, `active=true`, `sort_order` = index.
- Exported constants: `SPORTS = ['indoor','beach']`, `BEACH_MAX_PLAYERS = 2`, `BEACH_MAX_STAFF = 1`.

### 2.6 Shared test fixture: one beach bundle (both agents use it verbatim in their tests)
```json
{ "version": "2026-10-06T08:00:00.000Z", "fetched_at": "2026-10-06T08:00:05.000Z", "sport": "beach",
  "competitions": [
    { "id": "11111111-1111-4111-8111-111111111111", "name": "Coop Beachtour", "season": "2026", "gender": "women",
      "category": "A1", "vm_leagues": [], "archived": false, "updated_at": "2026-10-06T08:00:00.000Z", "sport": "beach" },
    { "id": "22222222-2222-4222-8222-222222222222", "name": "Old tour", "season": "2025", "gender": "women",
      "category": null, "vm_leagues": [], "archived": true, "updated_at": "2026-01-01T00:00:00.000Z", "sport": "beach" } ],
  "teams": [
    { "id": "33333333-3333-4333-8333-333333333333", "competition_id": "11111111-1111-4111-8111-111111111111",
      "name": "Müller / Weber", "short_name": "MÜLLER/WEBER", "club": "BC Zürich", "color": "#3b82f6",
      "svrz_team_name": null, "updated_at": "2026-10-06T08:00:00.000Z", "sport": "beach",
      "players": [
        { "id": "44444444-4444-4444-8444-444444444441", "number": 1, "first_name": "Anna", "last_name": "Müller",
          "dob": "1998-01-05", "license_number": "B-1", "is_libero": false, "is_captain": false, "active": true,
          "sort_order": 0, "country": "CHE" },
        { "id": "44444444-4444-4444-8444-444444444442", "number": 2, "first_name": "Sara", "last_name": "Weber",
          "dob": "1997-03-12", "license_number": null, "is_libero": false, "is_captain": false, "active": true,
          "sort_order": 1, "country": "CHE" } ],
      "staff": [ { "id": "55555555-5555-4555-8555-555555555555", "role": "Coach", "first_name": "Eva", "last_name": "Kunz",
                   "dob": null, "license_number": null, "sort_order": 0 } ] },
    { "id": "66666666-6666-4666-8666-666666666666", "competition_id": "11111111-1111-4111-8111-111111111111",
      "name": "Rossi", "short_name": null, "club": null, "color": null, "svrz_team_name": null,
      "updated_at": "2026-09-01T00:00:00.000Z", "sport": "beach",
      "players": [ { "id": "77777777-7777-4777-8777-777777777777", "number": 1, "first_name": "Lia", "last_name": "Rossi",
          "dob": null, "license_number": null, "is_libero": false, "is_captain": false, "active": true,
          "sort_order": 0, "country": "ITA" } ],
      "staff": [] } ] }
```

---

## 3. OpenVolley frontend (Agent A)

### 3.1 API client: `src/lib/accountApi.js`
`savedTeamsApi.fetchBundle({ sport } = {})` calls `GET /api/saved-teams` when `sport` is falsy, else `GET /api/saved-teams?sport=${encodeURIComponent(sport)}`. The other functions are unchanged. `createCompetition(body)` passes `sport` through.

### 3.2 Domain: `src/domain/savedTeams.js` (pure, tested)
- `export const SPORTS = ['indoor', 'beach']`.
- `export function sportOf(x)` returns `'beach'` when `x?.sport === 'beach'`, else `'indoor'`. Works on a competition, an API team or a cache row's `competition`.
- `export function bundleForSport(bundle, sport)` returns a copy of the bundle with only the competitions of that sport and the teams whose `competition_id` is one of them. `version`, `fetched_at` and the other fields are copied, and `sport` is set to the argument.
- `export function beachSeasonOptions(now = new Date())` returns `[Y-1, Y, Y+1]` as strings, where `Y` is the Europe/Zurich calendar year (`Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year: 'numeric' })`).
- `export function validateSavedRoster(body, { sport = 'indoor' } = {})`: indoor is unchanged. Beach returns the same error objects for:
  - `last_name` missing: `savedTeams.errors.lastNameRequired`;
  - a non-empty `country` not matching `/^[A-Z]{3}$/i`: `savedTeams.errors.countryFormat` (list `'players'`);
  - more than 2 players or more than 1 staff: `manage.errors.generic`.
- `savedTeamToRoster`, `rosterToSavedRoster` and `findSavedTeamSuggestions` are unchanged (indoor only).

### 3.3 Cache: `src/db/savedTeams.js` (indoor only; **no Dexie version bump**, since rows from 2.1.0 are all indoor)
- `refreshSavedTeams` calls `savedTeamsApi.fetchBundle({ sport: 'indoor' })`.
- `storeSavedTeamsBundle(bundle, userId)` first does `bundle = bundleForSport(bundle, 'indoor')`. This is the single guarantee that the cache, `meta.competitions` and therefore MatchSetup, `SavedTeamPickerModal` and `SaveRosterToTeamModal` hold indoor teams only, whatever the caller fetched.
- `bundleCompetitions` adds `sport: sportOf(c)`.
- `getSavedTeams` additionally drops rows with `sportOf(row.competition) === 'beach'` (defensive).

### 3.4 MatchSetup (`src/components/MatchSetup.jsx`)
No code change: it reads the indoor-only cache (3.3). The tests in §6 pin the filter.

### 3.5 Console: `src/components/manage/SavedTeamsPanel.jsx`
- Load with `savedTeamsApi.fetchBundle({ sport: 'all' })`. The cache refresh call stays `storeSavedTeamsBundle(res.data, userId)`, which filters to indoor (3.3).
- At the top of the competitions view, above the season filter, add a `SegmentedControl` (`ariaLabel` = `savedTeams.sport`) with the options `indoor` → `savedTeams.sportIndoor` and `beach` → `savedTeams.sportBeach`.
  - State `sport` defaults to `'indoor'` and is remembered in `localStorage['ov_saved_teams_sport']`, read and written inside try/catch.
  - `competitions`, the season options and the team counts are filtered with `sportOf(c) === sport`.
- The competition header chips add `<Chip tone="sky">{t('savedTeams.sportBeach')}</Chip>` for beach competitions.
- `CompetitionModal` takes a `sport` prop:
  - new competition: the sport of the segment;
  - edit: `sportOf(form)`.

  It is shown read-only as a `Chip` under the title, and the sport is never editable.
  - Beach season `<Select>`: `beachSeasonOptions()` plus `form.season`, default the middle value (`Y`).
  - Indoor season: unchanged.
  - The VolleyManager leagues field and the svrz_games fetch are hidden and skipped for beach.
  - Body:
    - create: `{ …, sport }`, with `vm_leagues: []` for beach;
    - PATCH: never sends `sport`, and sends no `vm_leagues` for beach.
- `NewTeamModal`: unchanged.

### 3.6 Console: `src/components/manage/TeamEditor.jsx`
It branches on `sportOf(competition)`. Indoor is unchanged. For beach:
- **Team fields:** name, short name, club and colour. `svrz_team_name` is hidden and not sent. `fieldsDirty` ignores it for beach.
- **Hint:** above the players, `<p className="text-sm text-stone-500">{t('savedTeams.beachTeamHint')}</p>`.
- **Players:** exactly two fixed slots, rendered in order 1 and 2, with the `SectionHeader` title `savedTeams.players` and no add or remove buttons.
  - Each slot is headed by `savedTeams.beachPlayer` `{ number }`. It has first name, last name, DOB (`type=date`), licence (max 40) and country (`Input`, `maxLength={3}`, `className="font-mono uppercase"`, upper-cased on change, `hint` = `savedTeams.countryHint`), plus an `IconButton` `X` labelled `savedTeams.clearPlayer` `{ number }` that empties the slot.
  - There are no libero, captain or active controls.
  - Layout is one input per row below `sm`, and the grid `sm:grid-cols-[1fr_1fr_9.5rem_8rem_5rem_auto]` from `sm`, like the indoor rows.
  - A slot is filled from the saved player with that `number`, and keeps its `id`.
- **Coach:** under `SectionHeader` `savedTeams.coach`, at most one row: first, last, DOB and licence. The role is fixed to `'Coach'` and no role select is shown.
  - Without a coach row, a `Button variant="ghost" size="sm" icon={Plus}` reads `savedTeams.addCoach`.
  - With one, an `IconButton X` labelled `savedTeams.removeCoach`.
- **Save:** `export function draftToBeachRosterBody(slots, coach)`:
  - `players` = the slots whose first or last name is non-empty, each `{ id?, number: slotNumber, first_name, last_name, dob|null, license_number|null, country: upper|null }`;
  - `staff` = `[{ id?, role: 'Coach', first_name, last_name, dob|null, license_number|null }]` when a coach row has a first or last name, else `[]`.

  Validate with `validateSavedRoster(body, { sport: 'beach' })`, then call `putRoster` as for indoor. The server's 400 `details` show as today.
- **Team list row** (SavedTeamsPanel competition view): for beach, `status` shows `savedTeams.pickerPlayers` `{ count: players.length }`.

### 3.7 i18n (OpenVolley; Agent A)
New `savedTeams.*` keys go in all five `src/i18n/locales/{en,de,de-CH,fr,it}.json`, and are added to `SPEC_KEYS` in `src/i18n/__tests__/localeKeys.test.js`. `de-CH` = `de`. Use `ss`, never `ß`.

| key | en | de / de-CH | fr | it |
|---|---|---|---|---|
| `savedTeams.sport` | Sport | Sportart | Sport | Sport |
| `savedTeams.sportIndoor` | Indoor | Indoor | Indoor | Indoor |
| `savedTeams.sportBeach` | Beach | Beach | Beach | Beach |
| `savedTeams.beachPlayer` | Player {{number}} | Spieler/in {{number}} | Joueur/euse {{number}} | Giocatore/trice {{number}} |
| `savedTeams.country` | Country | Land | Pays | Nazione |
| `savedTeams.countryHint` | 3-letter code, e.g. CHE | Code mit 3 Buchstaben, z. B. CHE | Code à 3 lettres, p. ex. CHE | Codice di 3 lettere, p. es. CHE |
| `savedTeams.coach` | Coach | Trainer | Entraîneur | Allenatore |
| `savedTeams.addCoach` | Add coach | Trainer hinzufügen | Ajouter l'entraîneur | Aggiungi allenatore |
| `savedTeams.removeCoach` | Remove coach | Trainer entfernen | Retirer l'entraîneur | Rimuovi allenatore |
| `savedTeams.clearPlayer` | Clear player {{number}} | Spieler/in {{number}} leeren | Vider le joueur {{number}} | Svuota giocatore {{number}} |
| `savedTeams.beachTeamHint` | A beach team is a pair: player 1 and player 2, optionally with a coach. | Ein Beach-Team ist ein Paar: Spieler/in 1 und 2, optional mit Trainer. | Une équipe de beach est une paire : joueurs 1 et 2, entraîneur en option. | Una squadra beach è una coppia: giocatori 1 e 2, allenatore facoltativo. |
| `savedTeams.errors.countryFormat` | Country: 3 letters, e.g. CHE | Land: 3 Buchstaben, z. B. CHE | Pays : 3 lettres, p. ex. CHE | Nazione: 3 lettere, p. es. CHE |

---

## 4. Where it lives (for the owner)

- **OpenVolley:** sign in as `admin` or `competition_manager`, then open the user menu:
  - "Saved teams" opens the Manage console on the Saved teams tab, with the Indoor / Beach switch;
  - "Admin" (admins only) opens the same console on Accounts, with the tabs Invites, Official games, Matches, Audit and Saved teams.
- **OpenBeach:** in MatchSetup, open Team 1 or Team 2 and use "Load saved team". After typing a team name, a "Saved teams found" banner also appears.

---

## 5. OpenBeach client (Agent B; all paths under `escoresheet/frontend/src_beach/`)

OpenBeach has no Tailwind and no `src/ui` kit, and this change does not add them. Follow the /volleyui rules that apply:
- sentence case and one primary action per surface;
- confirmations via `Modal_beach`, never `window.confirm`;
- controls at least 36 px high and one input per row on narrow screens;
- the existing MatchSetup_beach inline-style buttons (`background:'#000'` primary, `className="secondary"` secondary);
- messages via `useAlert().showAlert`.

### 5.1 `lib_beach/access_beach.js` (new)
A verbatim port of OpenVolley `src/lib/access.js`: `ADMIN_ROLES`, `KNOWN_ROLES`, `normalizeRoles`, `accessFromRoles`, `NO_ACCESS` and `accessChanged`. `canReadTeams = canScore || canManageTeams`.

### 5.2 `lib_beach/apiClient_beach.js`
- `export async function apiGet(path, { timeoutMs = DB_REQUEST_TIMEOUT_MS, fallbackError = 'Request failed' } = {})` mirrors `postJson`: `method: 'GET'`, `headers: getAuthHeaders()`, no body, the same timeout signal, `safeJsonResponse` and `networkError`. It returns `{ data, error, status }`, and `{ data: null, error: { message: 'Backend not available' }, status: 0 }` when `getApiUrl` is null.
- `export const savedTeamsApi = { fetchBundle: () => apiGet('/api/saved-teams?sport=beach', { fallbackError: 'Saved teams load failed' }) }`.

### 5.3 `utils_beach/savedTeams_beach.js` (new, pure)
- `normalizeName(v)` = `String(v ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase()`.
- `beachNameKey(name)` = `normalizeName(name)`, then drop a trailing `\s*\([^)]*\)$` (for example `" (che)"`), then replace `\s*/\s*` with `'/'`, then `.trim()`. Examples: `'Müller / Weber (CHE)'` and `'müller/weber'` both give `'müller/weber'`.
- `pairKeyFromName(name)`: split `beachNameKey(name)` on `/`, trim the parts and drop empty ones. If there are exactly 2 parts, return them sorted and joined with `'/'`, else `''`.
- `pairKeyFromPlayers(players)`: when there are exactly 2 players with a non-empty last name, return the `normalizeName(last_name)` values sorted and joined with `'/'`, else `''`.
- `teamKeys(team)` = `{ nameKey: beachNameKey(team.name), pairKey: pairKeyFromPlayers(team.players) || pairKeyFromName(team.name) }`.
- `isoToBeachDob(iso)` turns `'YYYY-MM-DD…'` into `'DD/MM/YYYY'`, and anything else into `''`. This is MatchSetup_beach's format.
- `teamCountry(players)`: the distinct non-null `country` values. Exactly one gives that code. None or more than one gives `''`.
- `savedTeamToBeachRoster(team)` returns `{ roster, country, meta, coach, warnings }`:
  - `roster` always has 2 entries `{ number, firstName, lastName, dob, isCaptain: false }`, in number order 1 and 2. The player with `number` n fills slot n. A player without a valid number fills the first free slot. Players beyond 2 are ignored. An empty slot is `{ number: n, firstName: '', lastName: '', dob: '', isCaptain: false }`.
  - `country` = `teamCountry(players)`.
  - `meta` = `{ name, shortName: short_name || '', color: color || '' }`.
  - `coach` = `{ firstName, lastName }` of `staff` role `'Coach'`, or `null`.
  - `warnings`:
    - `{ key: 'savedTeams.incompleteTeam', params: { name } }` when fewer than 2 players;
    - `{ key: 'savedTeams.countryMismatch', params: { name } }` when the players have more than one distinct country.
- `rosterHasNames(roster)`: does any player have a non-empty `firstName` or `lastName` (trimmed)?
- `teamMatchesName(row, name)`: let `k = beachNameKey(name)`. If `k` is empty, return false. Otherwise true when `row.nameKey === k`, or when `pairKeyFromName(name)` is non-empty and equals `row.pairKey`.
- `findBeachTeamSuggestions(rows, { team1Name, team2Name, league, gender, date })` returns `{ team1: row|null, team2: row|null }`.
  - Candidates are rows whose competition is not archived and that match the side's name.
  - Rank, descending, in order:
    1. `normalizeName(competition.name) === normalizeName(league)`;
    2. `competition.gender === gender`;
    3. `competition.season === String(year)`, where `year` is `date` (`YYYY-MM-DD`) or else the current Europe/Zurich year;
    4. `Date.parse(updatedAt)`.
  - If both sides resolve to the same `id`, `team2` is `null`.

### 5.4 Dexie: `db_beach/db_beach.js`
Append after version 18:
```js
// Version 19: offline cache of the saved beach teams (db_beach/savedTeams_beach.js).
// New tables only, no upgrade function: nothing to migrate, so it cannot reject.
// The rows hold personal data (DOB, licence, country); they are cleared on
// sign-out, account switch and account deletion.
db.version(19).stores({
  saved_teams: 'id, competitionId, nameKey, pairKey',
  saved_teams_meta: 'key'
})
```
`__tests__/db/dbUpgrade.test.js`: change `expect(db.verno).toBe(18)` to `toBe(19)`.

### 5.5 `db_beach/savedTeams_beach.js` (new)
A port of OpenVolley `src/db/savedTeams.js` with these differences:
- It imports `db` from `./db_beach`, `savedTeamsApi` from `../lib_beach/apiClient_beach` and `accessFromRoles` from `../lib_beach/access_beach`.
- The event is `SAVED_TEAMS_CHANGED_EVENT = 'ob-saved-teams-changed'`, and `SAVED_TEAMS_MAX_AGE_MS = 10 * 60 * 1000`.
- `currentUserId()` reads `localStorage['api_auth_token']` → `.user.id`. `currentAccess()` reads `localStorage['cachedProfile'].roles`. Both use try/catch.
- `bundleCompetitions(bundle)` keeps only `sport === 'beach'` and maps each competition to `{ id, name, season, gender, category, archived, sport: 'beach' }`.
- `bundleToRows(bundle)` keeps only teams of those competitions. Each row is `{ id, competitionId, competition, name, shortName, club, color, nameKey, pairKey, players, staff, updatedAt }`, where `nameKey` and `pairKey` come from `teamKeys`, and `players` and `staff` keep the API's snake_case objects, `country` included.
- `refreshSavedTeams({ force, access, userId, online })` behaves as in OpenVolley:
  - it returns `skipped` without a user, without `canReadTeams`, or when `!isBackendAvailable()`;
  - it returns `offline`, `fresh` (under 10 minutes old for the same user), `refreshed`, or `forbidden` (401/403, which clears the cache);
  - any other error, including a LAN server's 404, returns `error` and keeps the cache.
- Exports: `getSavedTeams({ userId })` (`[]` for another account), `getSavedTeamsMeta()`, `clearSavedTeams()`, `storeSavedTeamsBundle(bundle, userId)` and `competitionsOf(rows, meta)`.
- Never `console.log` a row.

### 5.6 `hooks_beach/useSavedTeams_beach.js` (new)
A port of OpenVolley `src/hooks/useSavedTeams.js`, with the same signature `{ userId, access, enabled, refreshOnMount }` and the same return `{ teams, competitions, meta, loading, lastStatus, refresh, reload }`.

### 5.7 `contexts_beach/AuthContext_beach.jsx`
- `const access = useMemo(() => accessFromRoles(profile?.roles ?? getCachedProfile()?.roles ?? []), [profile])`, plus `NO_ACCESS` when there is no `user`. Expose it as `access` in the context value.
- Call `clearSavedTeams()`:
  - in `signOut` and `deleteAccount` after the local state is cleared;
  - and when `user?.id` changes from one non-null id to another (`useRef` of the previous id).
- When `user && access.canReadTeams`, after the profile loads: `refreshSavedTeams({ access, userId: user.id }).catch(() => {})`.

### 5.8 `components_beach/SavedTeamPickerModal_beach.jsx` (new)
Props: `{ open, onClose, onPick, userId, access, defaultCompetitionId = '', side }`. It renders nothing when `!open`. It uses `Modal_beach` with `title={t('savedTeams.pickerTitle')}` and `width={560}`.
- Data comes from `useSavedTeams_beach({ userId, access, refreshOnMount: true })`.
- When `navigator.onLine === false && meta?.fetchedAt`, a notice (`data-testid="saved-teams-offline"`) shows `savedTeams.pickerOffline` `{ date }`, with the date formatted `DD.MM.YYYY HH:mm` in local time.
- Controls, one per row:
  - a competition `<select>` (`aria-label` = `savedTeams.pickerCompetition`) with the first option `savedTeams.pickerAll` and then the non-archived competitions, sorted by season descending then name;
  - a search `<input type="search">` (`aria-label` and placeholder `savedTeams.pickerSearch`) matching `normalizeName(name + ' ' + club + ' ' + players' last names)`.
- List: rows of non-archived teams, sorted by name. Each row is a full-width `<button>` showing:
  - the name (bold);
  - a meta line: player last names joined with `' / '`, then club, then competition name, joined with `' · '`;
  - when there is a coach, `savedTeams.coach` `{ name }` (first and last name);
  - a chip `savedTeams.pickerPlayers` `{ count }`.

  Clicking a row calls `onPick(row)`.
- An empty list shows `savedTeams.pickerEmpty`. While loading, the modal shows "…" rows.

### 5.9 `components_beach/MatchSetup_beach.jsx`
- `const { user, profile, getCachedProfile, access } = useAuth()`.
- `const { teams: savedTeams, competitions: savedCompetitions } = useSavedTeams_beach({ userId: user?.id ?? null, access, enabled: !!access?.canReadTeams, refreshOnMount: true })`.
- New state:
  - `savedPicker` (`null | 'team1' | 'team2'`);
  - `savedReplace` (`null | { side, row }`);
  - `savedSuggestion` (`{ team1: row|null, team2: row|null }`);
  - `suggestionDismissed` (`{ team1: false, team2: false }`).
- **Button:** in the team1 roster header row (the `<div style={{ display: 'flex', gap: '8px' }}>` that holds "Delete Roster" and "Load TEST Roster", about line 3280), add a first button `savedTeams.load`, shown only when `access?.canReadTeams`, with `onClick={() => setSavedPicker('team1')}`. Do the same in the team2 twin (about line 3940). Use the same inline style as "Load TEST Roster".
- **Pick:**
  1. Run `onPick(row)`: `setSavedPicker(null)`.
  2. If `rosterHasNames(sideRoster)`, run `setSavedReplace({ side, row })`. That opens a `Modal_beach` (`width={400}`) titled `savedTeams.replaceConfirmTitle`, with body `savedTeams.replaceConfirmBody` `{ team: sideName || t('matchSetup.team1'|'team2') }` and the buttons `savedTeams.replace` (primary) and `common.cancel`.
  3. Otherwise apply directly.
- **Apply** (`applySavedTeam(side, row)`), with `const r = savedTeamToBeachRoster(row)`:
  - `setTeamXRoster(r.roster)`;
  - `if (!teamXName.trim()) setTeamXName(r.meta.name)`;
  - `if (!teamXShortName && r.meta.shortName) setTeamXShortName(r.meta.shortName)`;
  - `if (r.meta.color && teamXColor === DEFAULT)` set the colour, where DEFAULT is `'#ef4444'` for team1 and `'#3b82f6'` for team2;
  - `if (r.country) setTeamXCountry(r.country)`, because the pair's country goes with the pair;
  - `hasCoach` is **not** changed, since it is match-wide. The saved coach is only shown in the picker.
  - Then `showAlert(t('savedTeams.loaded', { name: row.name }), 'success')`, and each warning via `showAlert(t(w.key, w.params), 'info')`.
  - Captains stay unset. The existing roster error box asks the scorer to choose one.
- **Suggestion:**
  - A `useEffect` on `[savedTeams, team1Name, team2Name, team1Roster, team2Roster, league, type2, date, access?.canReadTeams]` computes `findBeachTeamSuggestions(savedTeams, { team1Name, team2Name, league, gender: type2, date })`. A side is kept only when `!rosterHasNames(thatRoster)` and `!suggestionDismissed[side]`. The result is stored in `savedSuggestion`.
  - Main view (`currentView === 'main'`, above the team cards): when either side has a suggestion, show a sky banner (`background:'rgba(14,165,233,0.12)'`, `border:'1px solid rgba(14,165,233,0.4)'`, radius 8, padding 12). It contains:
    - the title `savedTeams.suggestionTitle`;
    - one line per side, `savedTeams.suggestionTeam1` / `suggestionTeam2` `{ name }`;
    - the buttons `savedTeams.loadTeam1` / `loadTeam2` (secondary, which apply directly, since the roster has no names) and `savedTeams.dismiss`, which sets both sides to dismissed.
  - The team view (team1 or team2) shows the same one-side strip under the roster title row.
  - It never overwrites anything silently.
- The draft and auto-save logic is unchanged. The loaded roster flows through the existing `team1Roster` / `team2Roster` state.

### 5.10 i18n (OpenBeach; Agent B)
Add a new top-level `savedTeams` namespace to all five `i18n_beach/locales/{en,de,de-CH,fr,it}.json`. `de-CH` = `de`, with `ss` and never `ß`. If the file already addresses the user with Sie, adapt the du forms to it.

| key | en | de / de-CH | fr | it |
|---|---|---|---|---|
| `load` | Load saved team | Gespeichertes Team laden | Charger une équipe enregistrée | Carica squadra salvata |
| `pickerTitle` | Load saved team | Gespeichertes Team laden | Charger une équipe enregistrée | Carica squadra salvata |
| `pickerCompetition` | Competition | Wettbewerb | Compétition | Competizione |
| `pickerAll` | All competitions | Alle Wettbewerbe | Toutes les compétitions | Tutte le competizioni |
| `pickerSearch` | Search teams or players | Teams oder Spieler/innen suchen | Rechercher équipes ou joueurs | Cerca squadre o giocatori |
| `pickerEmpty` | No saved beach teams yet. They are added in the OpenVolley admin console. | Noch keine gespeicherten Beach-Teams. Sie werden in der OpenVolley-Verwaltung erfasst. | Aucune équipe de beach enregistrée. Elles sont saisies dans la gestion d'OpenVolley. | Nessuna squadra beach salvata. Si inseriscono nella gestione di OpenVolley. |
| `pickerOffline` | Offline – showing saved teams from {{date}}. | Offline – gespeicherte Teams vom {{date}}. | Hors ligne – équipes enregistrées du {{date}}. | Offline – squadre salvate del {{date}}. |
| `pickerPlayers` | {{count}}/2 players | {{count}}/2 Spieler/innen | {{count}}/2 joueurs | {{count}}/2 giocatori |
| `coach` | Coach: {{name}} | Trainer: {{name}} | Entraîneur : {{name}} | Allenatore: {{name}} |
| `replaceConfirmTitle` | Replace the players? | Spieler/innen ersetzen? | Remplacer les joueurs ? | Sostituire i giocatori? |
| `replaceConfirmBody` | The players of {{team}} are replaced by the saved team. You can still edit them afterwards. | Die Spieler/innen von {{team}} werden durch das gespeicherte Team ersetzt. Danach bleibt alles bearbeitbar. | Les joueurs de {{team}} sont remplacés par l'équipe enregistrée. Tout reste modifiable ensuite. | I giocatori di {{team}} vengono sostituiti dalla squadra salvata. Poi tutto resta modificabile. |
| `replace` | Replace | Ersetzen | Remplacer | Sostituisci |
| `loaded` | {{name}} loaded | {{name}} geladen | {{name}} chargée | {{name}} caricata |
| `incompleteTeam` | {{name}} has fewer than two saved players. Add the missing player. | Bei {{name}} sind weniger als zwei Spieler/innen gespeichert. Ergänze die fehlende Person. | {{name}} a moins de deux joueurs enregistrés. Ajoute le joueur manquant. | {{name}} ha meno di due giocatori salvati. Aggiungi quello mancante. |
| `countryMismatch` | The players of {{name}} have different countries. Choose the team country. | Die Spieler/innen von {{name}} haben verschiedene Länder. Wähle das Land des Teams. | Les joueurs de {{name}} ont des pays différents. Choisis le pays de l'équipe. | I giocatori di {{name}} hanno nazioni diverse. Scegli la nazione della squadra. |
| `suggestionTitle` | Saved teams found | Gespeicherte Teams gefunden | Équipes enregistrées trouvées | Squadre salvate trovate |
| `suggestionTeam1` | Team 1: {{name}} | Team 1: {{name}} | Équipe 1 : {{name}} | Squadra 1: {{name}} |
| `suggestionTeam2` | Team 2: {{name}} | Team 2: {{name}} | Équipe 2 : {{name}} | Squadra 2: {{name}} |
| `loadTeam1` | Load team 1 | Team 1 laden | Charger l'équipe 1 | Carica squadra 1 |
| `loadTeam2` | Load team 2 | Team 2 laden | Charger l'équipe 2 | Carica squadra 2 |
| `dismiss` | Not now | Nicht jetzt | Pas maintenant | Non ora |

---

## 6. Tests

Backend: `cd escoresheet/backend && PG_TEST_URL=postgres://postgres:test@127.0.0.1:<port>/postgres OV_PIN_SECRET=<40+ chars> npm test`, run against a throwaway `postgres:17-alpine` container (tmpfs, `--rm`, random port, unique name) that is stopped afterwards. Frontends: `npx vitest run`.

| Agent | File | Cases |
|---|---|---|
| A | `backend/tests/migration009.pg.test.js` (new) | Use the 007-style data setup, which needs 006, 007 and 008. Seed two indoor competitions with teams and players, then run 009 **twice**. Check: existing rows `sport='indoor'`, seasons unchanged, `country` NULL. A 2.1.0-style `INSERT` without `sport` gives `indoor`. Beach `'2026'` is accepted. Beach `'2026/27'` and indoor `'2026'` fail with 23514. `sport='x'` fails with 23514. `country='che'` and `'CH'` fail, `'CHE'` passes. No CHECK on `competitions` other than `competitions_sport_check` and `competitions_season_sport_check` mentions `season`. After `roles.sql` (when the harness has `ov_app`), `has_column_privilege('ov_app','public.competitions','sport','SELECT,INSERT,UPDATE')` and the same for `competition_players.country`. |
| A | `backend/tests/savedTeams.pg.test.js` | Unit `validateRoster(body, { sport:'beach' })`: every 2.5 error with its exact `details`, country normalisation (`' che '` → `'CHE'`), stored flags. Indoor `country` gives 400. Handlers: create without sport → indoor; beach create with `'2026'`; the three season and vm_leagues errors; PATCH `sport` → 400 even for a random id; PATCH season of a beach competition validated as beach; `getBundle()` vs `{sport:'beach'}` vs `{sport:'all'}` contents and per-filter `version`; `{sport:'Beach'}` → 400; beach PUT round trip with 2 players and a coach (with `country` in the answer); a 3rd player, number 3, duplicate number, libero, captain, `active:false`, a 2nd staff, `Assistant Coach 1` → 400 each; the indoor roster round trip unchanged. |
| A | `backend/tests/scorerAccounts.e2e.test.js` | HTTP: `?sport=beach` gives 401 anonymous, 403 pending, 200 scorer. `?sport=nope` gives 400 `OV_INVALID_REQUEST`. A CM creates a beach competition, team and roster. A plain `GET /api/saved-teams` (as a 2.1.0 client would send it) contains no beach competition. `?sport=all` contains both. |
| A | `frontend/src/domain/__tests__/savedTeams.test.js` | `sportOf`, `bundleForSport` (on the §2.6 fixture plus one indoor competition), `beachSeasonOptions` at 2026-12-31T23:30Z (Zurich 2027), `validateSavedRoster` beach. |
| A | `frontend/src/db/__tests__/savedTeamsCache.test.js` | `refreshSavedTeams` calls `fetchBundle({ sport:'indoor' })`. `storeSavedTeamsBundle` with a mixed bundle stores no beach team and no beach competition in `meta.competitions`. `getSavedTeams` drops a beach row put directly. |
| A | `frontend/src/lib/__tests__/accountApi.test.js` | `fetchBundle()` → `/api/saved-teams`. `fetchBundle({ sport:'beach' })` → `/api/saved-teams?sport=beach`. |
| A | `frontend/src/components/__tests__/SavedTeamsBeach.test.jsx` (new) | The segment switches the lists. A new beach competition posts `{ sport:'beach', season:'<Y>', vm_leagues:[] }` and shows no leagues field. The beach TeamEditor shows 2 slots and no libero/captain/active controls, and its save sends the 3.6 body. The console's mixed `all` bundle reaches `storeSavedTeamsBundle` (mocked) unchanged; the filtering is the cache's. |
| A | `frontend/src/i18n/__tests__/localeKeys.test.js` | The new keys go into `SPEC_KEYS`. |
| B | `src_beach/__tests__/utils/savedTeamsBeach.test.js` (new) | `beachNameKey` examples, pair keys (order-independent), `teamMatchesName`, `savedTeamToBeachRoster` (on the fixture: 2 slots, DOB `05/01/1998`, country `CHE`, coach; `Rossi` → slot 2 empty + `incompleteTeam`; mixed countries → `''` + `countryMismatch`), and `findBeachTeamSuggestions` ranking (league, gender, season, updatedAt; archived excluded; same team not on both sides). |
| B | `src_beach/__tests__/utils/access.test.js` (new) | Parity with OpenVolley: roles → flags, pending, `NO_ACCESS`. |
| B | `src_beach/__tests__/lib/apiClient.test.js` | `savedTeamsApi.fetchBundle` sends a GET to `<backend>/api/saved-teams?sport=beach` with `Authorization` and `X-OV-Proto`, and no body. A network failure gives `status: 0, error.network`. A 403 gives `{ error.status: 403 }`. |
| B | `src_beach/__tests__/db/savedTeamsCache.test.js` (new, fake-indexeddb) | Refresh stores the fixture (`refreshed`). `fresh` within 10 min, refetch on `force` or when older. Another user → `[]`. 403 → cache cleared, `forbidden`. Offline / network → cache kept. 404 → `error`, kept. A non-beach competition in the bundle is dropped. `clearSavedTeams` empties both tables. |
| B | `src_beach/__tests__/db/dbUpgrade.test.js` | Existing case: `verno` 19. New case: a v18 database with rows in `matches` and `sync_queue` opens at 19 with those rows intact and empty `saved_teams` and `saved_teams_meta` tables. A fresh database opens at 19. |
| B | `src_beach/__tests__/components/SavedTeamPickerModal.test.jsx` (new) | Lists the non-archived teams of the fixture. The competition filter and the search by player last name work. The offline notice shows the cached date. Picking calls `onPick` with the row. |
| B | `src_beach/__tests__/i18n/savedTeamsKeys.test.js` (new) | Every `savedTeams.*` key of `en.json` exists, non-empty, in `de`, `de-CH`, `fr` and `it`. No `ß` in `de` or `de-CH`. |

---

## 7. Work split and commits

| Agent | Order |
|---|---|
| A | (1) Write 009 and `pgTestDb`, with the migration test. (2) Change `savedTeams.js` and `manageApi.js`, with their tests and the README. (3) Change `accountApi`, `domain`, the cache and their tests. (4) Change the console (SavedTeamsPanel, TeamEditor), i18n and tests. Commit each step separately, with conventional messages (`feat(db): …`, `feat(api): …`, `feat(manage): …`). |
| B | (1) Write `access_beach`, `apiGet`, `savedTeamsApi` and their tests. (2) Add Dexie v19, the cache, the hook and their tests. (3) Change AuthContext. (4) Write the picker and the MatchSetup_beach wiring. (5) Add i18n and its test. Commit each step separately. Agent B tests against the §2.6 fixture with `fetch` mocked. Agent B does not need Agent A's backend running. |

Common rules:
- Stage paths explicitly and never commit `node_modules`. Never pass `--no-verify`, because gitleaks runs.
- End every commit with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- After any npm package change, run `npm install` in that frontend directory.
- No push, no tag, no deploy.
