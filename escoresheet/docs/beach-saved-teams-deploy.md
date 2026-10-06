# Deploying beach saved teams (db/009) to production

Owner checklist for the `feat/beach-saved-teams` branch: the competition
manager (OpenVolley's admin console) now manages **indoor and beach**
competitions, and OpenBeach loads beach teams in its match setup. Design:
`docs/beach-saved-teams-spec.md`; API: `backend/README.md` ("Accounts, admin
console and saved teams").

What changes on the server:

| Piece | Change |
|---|---|
| Database | `backend/db/009_beach_saved_teams.sql`: `competitions.sport` (`'indoor'`/`'beach'`, every existing row becomes indoor), the season check per sport (indoor `'2026/27'`, beach `'2026'`; 007's indoor-only check is dropped with a `NOTICE`), and `competition_players.country` (3 capital letters or NULL). One transaction, idempotent, no table rewrite (constant default), `lock_timeout` 5 s. |
| `roles.sql` | **Unchanged** (no new table, sequence or function; `ov_app`'s table grants cover the new columns). Run it after 009 anyway, as after every migration. |
| Backend image | New build: `GET /api/saved-teams?sport=indoor\|beach\|all` (no `sport` = indoor only), `sport` on create, the beach roster rules. |
| Env vars | None. |
| Frontend | Pages rebuild of OpenVolley (the console's Indoor / Beach switch and beach team editor). OpenBeach ships its "Load saved team" from its own `feat/beach-saved-teams` branch (it needs `feat/new-backend` deployed first). |

## Order, and why it is safe

1. **009** on the database, then `roles.sql`.
2. The **new backend** image.
3. The **frontends** (OpenVolley, later OpenBeach).

- The **running 2.1.0 backend keeps working on a migrated database**: its
  INSERTs name their columns, so new competitions get `sport = 'indoor'` and
  players `country = NULL`; it simply returns every competition (all indoor
  until someone creates a beach one with the new console).
- The **new backend on an unmigrated database** answers 503
  (`OV_DB_UNAVAILABLE`) on `/api/saved-teams*` (missing column `42703`);
  everything else works. So run 009 first.
- **2.1.0 apps** (installed tablets not yet updated) call `GET /api/saved-teams`
  without `sport` and get **indoor only**: MatchSetup and an old console never
  see a beach team. An old console creates indoor competitions, as before.

Respect the deploy freeze (`deploy/RUNBOOK-hetzner.md`, Friday 17:00 to
Sunday 23:59): do it on a weekday with no match running. Hosts as in the
runbook (`lenovo$` = lenovoserver, `hetzner#` = the VM).

## 1. Before: backup

```bash
hetzner# cd /opt/openvolley
hetzner# systemctl start openvolley-backup.service && journalctl -u openvolley-backup -n 20 --no-pager   # fresh dump, check it says OK
hetzner# grep ^OV_BACKEND_IMAGE= .env | tee -a DEPLOYED.log                                           # the tag to roll back to
```

Optional look at what 009 will meet (every season must already be `YYYY/YY`;
007's check guarantees it):

```bash
hetzner# docker compose exec -T ov-postgres psql -U ov_owner -d openvolley -c \
  "SELECT count(*) AS competitions, count(*) FILTER (WHERE season !~ '^\d{4}/\d{2}$') AS odd_seasons FROM public.competitions"
```

`odd_seasons` must be `0`.

## 2. Migration 009, then roles.sql

```bash
lenovo$ ssh hetzner 'cd /opt/openvolley && docker compose exec -T ov-postgres psql -U ov_owner -d openvolley -v ON_ERROR_STOP=1' \
          < escoresheet/backend/db/009_beach_saved_teams.sql
lenovo$ ssh hetzner /opt/openvolley/apply-roles.sh < escoresheet/backend/db/roles.sql   # "ok: ov_app logs in and sees N matches"
```

Expect `BEGIN`, `SET`, `ALTER TABLE`, `NOTICE: 009: dropped the indoor-only
season check competitions_season_check`, `DO`, `COMMIT`. A re-run prints no
NOTICE. If it stops on `lock_timeout` (something held the table for more
than 5 s), nothing was changed: run it again.

Do the same on the dev database.

## 3. Backend

```bash
lenovo$ cd ~/repos/openvolley && git switch <the merged branch> && git pull
lenovo$ escoresheet/deploy/build-image.sh --ship hetzner        # prints the NEW tag
hetzner# cd /opt/openvolley
hetzner# sed -i 's|^OV_BACKEND_IMAGE=.*|OV_BACKEND_IMAGE=openvolley-backend:<NEW>|' .env
hetzner# docker compose config --images | grep backend          # shows <NEW>
hetzner# docker compose up -d && docker compose ps
hetzner# docker compose exec ov-backend node -e 'fetch("http://127.0.0.1:8080/health").then(async r=>console.log(r.status, await r.text()))'
hetzner# echo "$(date -u +%FT%TZ) deployed openvolley-backend:<NEW> (db/009)" >> DEPLOYED.log
```

No kit (compose) change in this branch.

## 4. Frontend

Merge to the branch Cloudflare Pages builds from and let it rebuild
`app.openvolley.app`. Installed tablets pick up the new build on their next
online start (service worker); until then they keep working with indoor teams.

## 5. Where it lives (for you)

- **OpenVolley** (`app.openvolley.app`): sign in as `admin` or
  `competition_manager`, open the **user menu** (the rows are hidden while a
  match is open):
  - **Saved teams** opens the Manage console on the Saved teams tab. At the
    top, the **Indoor / Beach** switch (remembered on that device). Beach:
    "New competition" takes a year (`2026`) and no VolleyManager leagues; a
    team is a pair (Player 1 and Player 2: first and last name, date of
    birth, licence, country such as `CHE`) plus an optional coach.
  - **Admin** (admins only) opens the same console on Accounts, with the tabs
    Invite codes, Official games, Closed matches, Audit log and Saved teams.
- **OpenBeach** (after its own deploy): in match setup, Team 1 / Team 2 has
  **Load saved team**; after typing a team name a "Saved teams found" banner
  offers the pair. Only approved scorers, competition managers and admins see
  saved teams; never anonymous.

## 6. Smoke checklist

1. `curl -s https://backend.openvolley.app/health | jq .db` is `"ok"`.
2. Schema:
   ```bash
   hetzner# docker compose exec -T ov-postgres psql -U ov_owner -d openvolley -c "
     SELECT sport, count(*) FROM public.competitions GROUP BY sport;
     SELECT conname FROM pg_constraint WHERE conname IN
       ('competitions_sport_check','competitions_season_sport_check','competition_players_country_check');
     SELECT has_column_privilege('ov_app','public.competitions','sport','SELECT,INSERT,UPDATE') AS sport_ok,
            has_column_privilege('ov_app','public.competition_players','country','SELECT,INSERT,UPDATE') AS country_ok"
   ```
   Expect only `indoor` rows (until you create a beach competition), the three
   constraints, and `t`, `t`.
3. Anonymous is refused: `curl -s -o /dev/null -w '%{http_code}\n' 'https://backend.openvolley.app/api/saved-teams?sport=beach'` prints `401`.
4. In the app as admin: Saved teams shows your indoor competitions unchanged
   under **Indoor**. Switch to **Beach**, create a competition (season = this
   year), a team `Test / Pair` with two players (one country `CHE`) and a
   coach, save the roster. Switch back to Indoor: it is not listed there.
5. MatchSetup of an indoor test match: "Load saved team" lists indoor teams
   only (no `Test / Pair`).
6. Delete the test beach competition (cascades to its team).

## Rollback

- **Backend:** put the previous tag from `DEPLOYED.log` back into
  `OV_BACKEND_IMAGE` and `docker compose up -d ov-backend`. Keep 009: the
  2.1.0 backend runs on it. Note that it then returns beach competitions to
  every client (it does not know `sport`), so **delete the beach
  competitions first** if any were created, or MatchSetup's picker would list
  them as indoor teams.
- **Undo 009 without a restore** (only when no beach competition exists):
  ```sql
  BEGIN;
  ALTER TABLE public.competition_players DROP COLUMN IF EXISTS country;
  ALTER TABLE public.competitions DROP CONSTRAINT IF EXISTS competitions_season_sport_check;
  ALTER TABLE public.competitions DROP CONSTRAINT IF EXISTS competitions_sport_check;
  ALTER TABLE public.competitions DROP COLUMN IF EXISTS sport;
  ALTER TABLE public.competitions ADD CONSTRAINT competitions_season_check CHECK (season ~ '^\d{4}/\d{2}$');
  COMMIT;
  ```
- **Full undo:** restore the dump from step 1 (runbook "Restore the
  database"); saved teams changed after the deploy are lost.
