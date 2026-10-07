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
