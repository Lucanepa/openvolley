# Deploying manager.openvolley.app

> **Host moved, 16.10.2026:** production now runs on lenovoserver. The Hetzner VPS belongs to
> another owner and must never host OpenVolley again. Run the `hetzner#` steps below on
> lenovoserver with `sudo` (`/opt/openvolley` is root-only there):
> `cd /opt/openvolley && docker compose ...` becomes
> `sudo docker compose --project-directory /opt/openvolley ...`, `ssh hetzner <cmd>` becomes
> `sudo <cmd>`, `build-image.sh --ship hetzner` becomes `--ship local`. Current commands:
> `deploy/RUNBOOK-hetzner.md` ("Updating", "Apply a new db migration").

`manager.openvolley.app` is the manage console as a site of its own: accounts,
invite codes, official games, closed matches (reopen), the audit log and saved
teams / competitions. Admins see every tab, competition managers saved teams.

It is also **where accounts are made**: `manager.openvolley.app/#signup` (and
"Create account" on the sign-in card) is the only sign-up form. The scorer
apps (web, desktop, Android, venue LAN server) sign in only; their sign-in
dialog says "Don't have an account? Create one at manager.openvolley.app" and
opens that page in the browser (system browser in the desktop and Android
apps). After sign-up the new, pending account lands on "Enter your club's
invite code"; an approved scorer without a manage role gets "You're all set,
sign in in the scorer app"; a referee-only account the "no access, ask an
admin" page with the invite-code field.

Inside the scorer app nothing moves: the user menu's Admin / Saved teams rows
still open the in-app console (the only console in the desktop and Android
apps). On the web the console header also links the manager site.

| Piece | Change |
|---|---|
| Frontend build | `node scripts/build-subdomains.js manager` -> `escoresheet/frontend/dist-manager` (page: `manager.html`, entry `src/manager-main.jsx`). No service worker and no manifest (an admin console must never run a stale cached build). `robots.txt`, a `<meta name="robots" content="noindex, nofollow">` and a `_headers` file (`X-Robots-Tag: noindex, nofollow`, `X-Frame-Options: DENY`, `Referrer-Policy`) keep it out of search engines and frames. |
| Backend | `https://manager.openvolley.app` is in `lib/cors.js` `ALLOWED_ORIGINS`. The running backend **already trusts it** (any `https://<name>.openvolley.app`), so the site works before the next backend image ships. |
| Env vars | Backend: none for production; the preview needs the test backend, see "Preview" below. Pages: `VITE_BACKEND_URL` (Production) and `VITE_DEV_BACKEND_URL` (Preview), as on the other projects. |
| Database | Nothing. |

## Cloudflare Pages project

Create it like the other six (`openvolley-app`, `-referee`, `-bench`,
`-livescore`, `-roster`, `-scoresheet`): Workers & Pages -> Create -> Pages ->
Connect to Git -> the `openvolley` repository.

| Setting | Value |
|---|---|
| Project name | `openvolley-manager` (gives `openvolley-manager.pages.dev`) |
| Production branch | `main` |
| Preview branches | Custom: `dev` only (as the other projects) |
| Framework preset | None |
| Root directory (advanced) | `escoresheet/frontend` |
| Build command | `npm ci && node scripts/build-subdomains.js manager` |
| Build output directory | `dist-manager` |
| Node version | from `escoresheet/frontend/.node-version` (22); nothing to set |
| Environment variables (Production) | `VITE_BACKEND_URL` = `https://backend.openvolley.app` |
| Environment variables (Preview) | `VITE_DEV_BACKEND_URL` = the test backend (e.g. `https://dev-backend.openvolley.app`); a preview build ignores `VITE_BACKEND_URL` ("Dev builds and the test backend" below) |
| Custom domain | `manager.openvolley.app` (Custom domains -> Set up; Cloudflare adds the proxied CNAME `manager` -> `openvolley-manager.pages.dev` in the openvolley.app zone) |

Optional: Settings -> Builds -> Build watch paths, include `escoresheet/frontend/*`
so backend-only commits do not rebuild it (only if the other projects do the same).

Do not set `DISABLE_PWA`: the manager has no service worker either way, and
the variable only matters for the other sites.

## Preview (dev branch)

The dev build is served at `https://dev.openvolley-manager.pages.dev`. It
talks to the test backend only, never to production ("Dev builds and the
test backend" below). That backend trusts Pages previews only through its
`PUBLIC_ORIGINS`, so add the origin there, next to the other
`dev.openvolley-<app>.pages.dev` entries, never to production's `.env`:

```bash
test-backend# grep ^PUBLIC_ORIGINS= .env                 # the current list
# append ,https://dev.openvolley-manager.pages.dev to that line, then:
test-backend# docker compose up -d ov-backend            # re-reads .env
```

Without it the preview loads but sign-in fails with a CORS error. Without a
test backend at all the preview says "No test backend configured". Production
(`manager.openvolley.app`) needs no backend change.

## Check after the first deploy

1. `https://manager.openvolley.app` shows "Manage OpenVolley" with a Sign in
   button; the tab title is "OpenVolley Manager".
2. `curl -sI https://manager.openvolley.app | grep -i x-robots-tag` prints
   `noindex, nofollow`; `https://manager.openvolley.app/robots.txt` disallows `/`.
3. Sign in as an admin: six tabs, no "Back to the app", "Scorer app" and
   "Sign out" in the header; a reload keeps the tab (`#invites` etc.).
4. Sign in as a competition manager: saved teams only. A scorer-only
   account: "You're all set". A pending account: "Enter your club's invite
   code". A referee-only account: "No access to the manager".
5. `https://manager.openvolley.app/#signup` shows "Create your account"; a
   throwaway account lands on the invite-code step (delete it afterwards). In
   the scorer app, Login -> "Create one at manager.openvolley.app" opens that
   page in a new tab (desktop / Android: the system browser).
6. In the scorer app on `app.openvolley.app`, user menu -> Admin: the console
   header shows `manager.openvolley.app`, opening it in a new tab.

## Local development

`cd escoresheet/frontend && npm run dev`, then open
`http://localhost:5173/manager.html` (the scorer app stays on `/`); the sign-up
page is `http://localhost:5173/manager.html#signup`. The scorer app's "Create
one at manager.openvolley.app" always opens the public site (a Pages preview
of the app opens the matching manager preview).

# OpenBeach's manager: manager-beach.openvolley.app

The same console built a second time with the OpenBeach brand (plan
`~/ov-ops/openbeach-separation-tournaments-PLAN.md` 1.6 and 2.1, phase S2;
`docs/app-separation-spec.md` section 8). One code base: `src/managerBrand.js`
holds the two brands, `src/manager-beach-main.jsx` starts the console as
OpenBeach.

What differs from `manager.openvolley.app`:

| | OpenVolley (`manager`) | OpenBeach (`manager-beach`) |
|---|---|---|
| Page, entry | `manager.html`, `src/manager-main.jsx` | `manager-beach.html`, `src/manager-beach-main.jsx` |
| Name, logo, icons | OpenVolley | OpenBeach, logo B2 (`brand/beach/`, copied over `favicon.*`, `apple-touch-icon.png`, `icon-192/512.png` by the build), its own `manifest.webmanifest` (no service worker) |
| Tabs (admin) | accounts, invites, official games, closed matches, audit, saved teams | accounts, invites, audit, saved teams, tournaments (T1) |
| Lists | `?app=indoor`: OpenVolley members, indoor codes (new codes `sport: 'indoor'`), indoor audit; saved teams as before | `?app=beach`: OpenBeach members, beach codes, beach audit, beach competitions and pairs (`?sport=beach`, no offline cache) |
| Roles | `scorer`, `referee`, `competition_manager`, `admin` | `beach:scorer`, `beach:referee`, `beach:competition_manager` (shown as Scorer, Referee, Competition manager). The global admin is managed in OpenVolley's console |
| Auth calls | no `app` | `app: 'beach'` on sign-up, reset, reset confirm and resend: OpenBeach's mails (`OpenBeach <noreply@openvolley.app>`), links to `manager-beach`, and sign-up joins OpenBeach |
| Signed-in account that has not joined OpenBeach | n/a | "Join OpenBeach" (`POST /api/account/join`), then the invite-code step |
| Scorer app link | `app.openvolley.app` | `beach.openvolley.app` |

Who sees what (D2: only the global admin administers both in v1): an admin
gets the five tabs, a `beach:competition_manager` saved teams and tournaments, a
`beach:scorer` "You're all set", a `beach:referee` "No access", an OpenBeach
member without a beach role the invite-code step, and any other signed-in
account "Join OpenBeach" first. An indoor role gives nothing here.

| Piece | Change |
|---|---|
| Frontend build | `node scripts/build-subdomains.js manager-beach` (also `npm run build:manager-beach`) -> `escoresheet/frontend/dist-manager-beach`. noindex as the indoor manager (`robots.txt`, meta, `_headers`). |
| Backend | `https://manager-beach.openvolley.app` is in `lib/cors.js` `ALLOWED_ORIGINS`; the running backend already trusts it (`*.openvolley.app`). The OpenBeach mails need the S2 backend image; the env defaults are right (`MAIL_FROM_BEACH` = OpenBeach <the address of `MAIL_FROM`>, `MANAGER_URL_BEACH` = `https://manager-beach.openvolley.app` while `MANAGER_URL` is the default), so nothing has to be set in production's `.env`. A backend with another `MANAGER_URL` (dev, test, staging) derives the OpenBeach base from it (`.../manager-beach.html`, or `MANAGER_URL` itself with a startup warning, `deploy/env.example`) and never links to production's manager-beach. |
| Database | Nothing new (db/012 from S1). |

## Cloudflare Pages project (owner: create it, nothing here creates it)

| Setting | Value |
|---|---|
| Project name | `openbeach-manager` (gives `openbeach-manager.pages.dev`) |
| Git repository | `openvolley` (this repository; the console lives here, not in the openbeach repo) |
| Production branch | `main` |
| Preview branches | Custom: `dev` only |
| Framework preset | None |
| Root directory (advanced) | `escoresheet/frontend` |
| Build command | `npm ci && node scripts/build-subdomains.js manager-beach` |
| Build output directory | `dist-manager-beach` |
| Environment variables (Production) | `VITE_BACKEND_URL` = `https://backend.openvolley.app` |
| Environment variables (Preview) | `VITE_DEV_BACKEND_URL` = the test backend ("Dev builds and the test backend" below) |
| Custom domain | `manager-beach.openvolley.app` |

## DNS (owner)

Custom domains -> Set up `manager-beach.openvolley.app` on the Pages project.
Cloudflare then adds, in the `openvolley.app` zone, the proxied record:

| Type | Name | Target | Proxy |
|---|---|---|---|
| CNAME | `manager-beach` | `openbeach-manager.pages.dev` | proxied |

It follows the naming rule of plan 2.1 (`<function>-beach.openvolley.app`).

## Preview (dev branch)

`https://dev.openbeach-manager.pages.dev` needs that origin in the test
backend's `PUBLIC_ORIGINS`, as for the indoor manager preview above, never in
production's. Production needs no backend change.

## Check after the first deploy

1. `https://manager-beach.openvolley.app` shows the OpenBeach logo and
   "Manage OpenBeach"; the tab title is "OpenBeach Manager", the tab icon the
   B2 ball. `curl -sI https://manager-beach.openvolley.app | grep -i x-robots-tag`
   prints `noindex, nofollow`.
2. Sign in as the global admin: five tabs (accounts, invites, audit, saved
   teams, tournaments). Invites: a new code shows the plain role and is listed only here,
   not in OpenVolley's console (`manager.openvolley.app` and the main app's
   console ask `?app=indoor`). Accounts: only OpenBeach members; a throwaway
   OpenBeach sign-up is pending here and absent from OpenVolley's accounts.
   An OpenBeach-only member appears in OpenVolley's console only once they
   join OpenVolley or get an indoor role (the global admin role included).
3. `#signup` with a throwaway address: the confirmation mail comes from
   `OpenBeach <noreply@openvolley.app>`, its link opens
   `manager-beach.openvolley.app/#confirm?token=`; the account lands on the
   invite-code step. Then "forgot password" on manager-beach: the OpenBeach
   reset mail says the password is the one of OpenVolley and OpenBeach. Delete
   the account afterwards.
4. Sign up again with an address that has an OpenVolley account: the form says
   to sign in with the existing password; after sign-in, "Join OpenBeach".

## Local development

`npm run dev`, then `http://localhost:5173/manager-beach.html` (the icons are
OpenVolley's in dev; the build swaps them).

# Web releases: match days and migrations (every Pages project)

Every Pages project built from this repository (`openvolley-app`, `-referee`,
`-bench`, `-livescore`, `-roster`, `-scoresheet`, `openvolley-manager`,
`openbeach-manager` and the OpenBeach sites) builds `main` on each merge and
puts it live within minutes; an open app takes the new build at its next start
or update. A merge to `main` is a web release, so it follows the backend's
rules:

- **Match-day freeze.** From Friday 17:00 to Sunday 23:59 nothing is merged to
  `main` (the window of `deploy/RUNBOOK-hetzner.md`, "Match-day rules"). Work
  goes to `dev`, whose builds talk to the test backend only, and is merged on
  Monday. A fix that cannot wait is the owner's call; check `/health` before
  and after it.
- **The migration first.** A change whose web app writes a new column or table
  (a new `backend/db/NNN_*.sql` with it) is released in two steps: first the
  backend, with `deploy.sh` (it runs the migrations), and a check that the
  database has it:

  ```bash
  ov-vps$ sudo docker compose --project-directory /opt/openvolley exec -T ov-backend node scripts/check-schema.mjs
  ov-vps$ sudo docker compose --project-directory /opt/openvolley exec -T ov-backend node scripts/migrate.mjs --status
  ```

  (the first exits 0, the second lists `NNN`); only then the web part is
  merged to `main`. While the migration is not released, keep the web part in
  its own pull request.
- **If the web app is out first anyway.** The backend writes the rows without
  the columns it does not know and logs
  `[pgQuery] unknown column dropped from a write on <table>: <column>` (once a
  minute per column; counted per column by the data layer's `droppedColumns()`,
  for `/health`). The matches still reach the cloud, but the values of those
  columns are lost until the migration. A write the backend cannot take at all
  (a table it does not have yet) is refused: the app keeps it, its sync
  indicator says "Server update pending", and it sends it again every hour.
- **Raising the minimum write protocol** (`MIN_WRITE_PROTO` in
  `backend/server.js` against the apps' `OV_PROTO` in
  `frontend/src/lib/apiClient.js`): only once the apps that speak the new
  protocol have been out for a while (the web app reloaded on every hall
  tablet, the Android and desktop apps updated), and never on a match day. An
  older app then keeps its writes on the device and says "Update needed:
  reload the app after this rally" (the web app) or asks for the app's update
  (Android, desktop); nothing is lost, but nothing reaches the cloud until it
  is updated.

Owner, optional: as a lock on the freeze, pause the production branch's
automatic deployments of each Pages project for the weekend (Settings ->
Builds) and turn them on again on Monday.

# Dev builds and the test backend (owner decision 5)

Builds of the `dev` branch, and of any other branch but `main`, are Cloudflare
Pages previews: `dev.openvolley-<app>.pages.dev` and the `dev-*.openvolley.app`
sites (`dev-app`, `dev-referee`, `dev-bench`, `dev-livescore`, `dev-roster`,
`dev-scoresheet`, `dev-beach` and the `dev-*-beach` ones). They run unreleased
code, so they must never write into the production database. `build-channel.js`
(in `vite.config.js` and `scripts/build-subdomains.js`) makes every such build:

- use the test backend named by `VITE_DEV_BACKEND_URL` (an https address, not
  `backend.openvolley.app`) and ignore `VITE_BACKEND_URL`;
- without `VITE_DEV_BACKEND_URL`, use no backend at all: the apps never fall
  back to `backend.openvolley.app`; the badge and the server screen say "No
  test backend configured", sign-in and sync answer "Backend not available";
- refuse `backend.openvolley.app` as a server (server screen, `?server=` links);
- stay out of search engines: a robots meta, `X-Robots-Tag: noindex, nofollow`
  in `_headers`, a `robots.txt` that disallows everything, and a small "Test
  build" badge bottom left that names its backend (it lets every tap through
  and is not printed).

Which builds: Pages sets `CF_PAGES=1` and `CF_PAGES_BRANCH`; every branch but
`main` is a dev build. `OV_BUILD_CHANNEL=dev` or `OV_BUILD_CHANNEL=production`
overrides that, e.g. a local check:
`OV_BUILD_CHANNEL=dev VITE_DEV_BACKEND_URL=https://dev-backend.openvolley.app node scripts/build-subdomains.js referee`.
The desktop, Android and release builds are production builds.

## Owner steps (nothing here does them)

1. **A test backend with its own database.** A second backend stack, for
   example `dev-backend.openvolley.app` on lenovoserver or ov-vps: its own
   compose project, Postgres database, storage folder and secrets (`.env` from
   `deploy/env.example`), never a copy of production data with real people in
   it. Its `PUBLIC_ORIGINS` lists the dev sites and the previews
   (`https://dev-app.openvolley.app,...,https://dev.openvolley-app.pages.dev,...`).
   Mail off (no SMTP) or a test sender, and `MANAGER_URL` =
   `https://dev.openvolley-manager.pages.dev`, so its mails never link to
   production.
2. **DNS and tunnel route.** The proxied hostname `dev-backend.openvolley.app`,
   routed through a Cloudflare Tunnel to that stack (a public-hostname route on
   the existing tunnel or a tunnel of its own).
3. **Pages variables.** On every Pages project (`openvolley-app`, `-referee`,
   `-bench`, `-livescore`, `-roster`, `-scoresheet`, `openvolley-manager`,
   `openbeach-manager` and the OpenBeach sites built from this repository):
   Settings -> Variables and Secrets -> **Preview**: `VITE_DEV_BACKEND_URL` =
   `https://dev-backend.openvolley.app`. **Production** keeps
   `VITE_BACKEND_URL` = `https://backend.openvolley.app`; the Preview
   `VITE_BACKEND_URL` can go (a preview build ignores it). Then retry the latest
   dev deployment of each project so it picks the variable up.
4. **Production `.env`.** Remove every `https://dev-*.openvolley.app` and
   `https://*.pages.dev` origin from `PUBLIC_ORIGINS` on the production host
   and restart the backend (`docker compose up -d ov-backend` re-reads `.env`);
   the `content-security-policy` header of `https://backend.openvolley.app`
   then no longer names them. The production backend still trusts
   `https://dev-*.openvolley.app` through its `*.openvolley.app` rule
   (`backend/lib/cors.js`): closing that is a backend change, not an `.env` one.

## Check after the change

1. `curl -sI https://dev-app.openvolley.app | grep -i x-robots-tag` prints
   `noindex, nofollow`; `https://dev-app.openvolley.app/robots.txt` disallows `/`.
2. `https://dev-app.openvolley.app` shows "Test build · dev-backend.openvolley.app"
   bottom left (before step 3: "Test build · No test backend configured").
3. In the browser's network panel, a sign-in on `dev-app` goes to
   `dev-backend.openvolley.app`, never to `backend.openvolley.app`.
4. `https://app.openvolley.app` has no badge and no `X-Robots-Tag`.
