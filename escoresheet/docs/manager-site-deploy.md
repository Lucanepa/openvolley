# Deploying manager.openvolley.app

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
| Env vars | Backend: optional, see "Preview" below. Pages: `VITE_BACKEND_URL` as on the other projects. |
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
| Environment variables (Production **and** Preview) | `VITE_BACKEND_URL` = `https://backend.openvolley.app` |
| Custom domain | `manager.openvolley.app` (Custom domains -> Set up; Cloudflare adds the proxied CNAME `manager` -> `openvolley-manager.pages.dev` in the openvolley.app zone) |

Optional: Settings -> Builds -> Build watch paths, include `escoresheet/frontend/*`
so backend-only commits do not rebuild it (only if the other projects do the same).

Do not set `DISABLE_PWA`: the manager has no service worker either way, and
the variable only matters for the other sites.

## Preview (dev branch)

The dev build is served at `https://dev.openvolley-manager.pages.dev`. The
backend trusts Pages previews only through `PUBLIC_ORIGINS`, so add that
origin on the VM next to the other `dev.openvolley-<app>.pages.dev` entries:

```bash
hetzner# cd /opt/openvolley
hetzner# grep ^PUBLIC_ORIGINS= .env                     # the current list
# append ,https://dev.openvolley-manager.pages.dev to that line, then:
hetzner# docker compose up -d ov-backend                # re-reads .env
```

Without it the preview loads but sign-in fails with a CORS error. Production
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
| Tabs (admin) | accounts, invites, official games, closed matches, audit, saved teams | accounts, invites, audit, saved teams |
| Lists | `?app=indoor`: OpenVolley members, indoor codes (new codes `sport: 'indoor'`), indoor audit; saved teams as before | `?app=beach`: OpenBeach members, beach codes, beach audit, beach competitions and pairs (`?sport=beach`, no offline cache) |
| Roles | `scorer`, `referee`, `competition_manager`, `admin` | `beach:scorer`, `beach:referee`, `beach:competition_manager` (shown as Scorer, Referee, Competition manager). The global admin is managed in OpenVolley's console |
| Auth calls | no `app` | `app: 'beach'` on sign-up, reset, reset confirm and resend: OpenBeach's mails (`OpenBeach <noreply@openvolley.app>`), links to `manager-beach`, and sign-up joins OpenBeach |
| Signed-in account that has not joined OpenBeach | n/a | "Join OpenBeach" (`POST /api/account/join`), then the invite-code step |
| Scorer app link | `app.openvolley.app` | `beach.openvolley.app` |

Who sees what (D2: only the global admin administers both in v1): an admin
gets the four tabs, a `beach:competition_manager` saved teams, a
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
| Environment variables (Production **and** Preview) | `VITE_BACKEND_URL` = `https://backend.openvolley.app` |
| Custom domain | `manager-beach.openvolley.app` |

## DNS (owner)

Custom domains -> Set up `manager-beach.openvolley.app` on the Pages project.
Cloudflare then adds, in the `openvolley.app` zone, the proxied record:

| Type | Name | Target | Proxy |
|---|---|---|---|
| CNAME | `manager-beach` | `openbeach-manager.pages.dev` | proxied |

It follows the naming rule of plan 2.1 (`<function>-beach.openvolley.app`).

## Preview (dev branch)

`https://dev.openbeach-manager.pages.dev` needs that origin in the backend's
`PUBLIC_ORIGINS`, as for the indoor manager preview above. Production needs
no backend change.

## Check after the first deploy

1. `https://manager-beach.openvolley.app` shows the OpenBeach logo and
   "Manage OpenBeach"; the tab title is "OpenBeach Manager", the tab icon the
   B2 ball. `curl -sI https://manager-beach.openvolley.app | grep -i x-robots-tag`
   prints `noindex, nofollow`.
2. Sign in as the global admin: four tabs (accounts, invites, audit, saved
   teams). Invites: a new code shows the plain role and is listed only here,
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
