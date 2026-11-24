# Club guides: team links (German)

Two printable guides for clubs that use team links (db/023, `docs/team-managers-spec.md`):

| Guide | For | PDF |
|---|---|---|
| `vereine.html` | club managers: create a team link, send it, see and remove team managers | `OpenVolley-Teamlinks-Vereine.pdf` (2 pages) |
| `teams.html` | coaches and team managers: open the link, the season's squad, send a game's roster, what happens in the hall | `OpenVolley-Kader-vor-dem-Spiel.pdf` (3 pages) |

Standard German with Swiss spelling (ss), "du" as in the app. The screenshots (`img/`) come from a
local test stack with made-up data (club VBC Musterdorf, schedule, players): a phone at 390 × 844
for the manager, a tablet at 1280 × 800 for the scorer, German UI. No real club or person is in them.
`t2-squad.jpg` and `t4-roster.jpg` were taken again on 20.11.2026 (licence numbers, no dates of birth)
from a local manager build of main whose API calls a Playwright route answered with the same made-up
club, team, squad and games (no backend involved).

The manager site's menu is a **Mein Verein** tree now: a club manager taps Mein Verein, then
Anfragen, Mitglieder, Teams, Lizenzen, Einladungscodes or API (on a phone in the row above the
bottom bar, on a computer indented under Mein Verein in the left rail). Team managers only see
Meine Teams. The texts follow app 3.2.5 (November 2026).

**A new PDF** after a text change: open the `.html` in Chrome or Chromium, Print, Save as PDF,
paper A4, margins None, Background graphics on. Each page is a fixed A4 sheet (`guide.css`); if a
page grows past its footer, shorten the text or the screenshot. Scripted, the same is Playwright
`page.pdf({ format: 'A4', printBackground: true, margin: 0, preferCSSPageSize: true })`. Check that
the PDFs keep 2 and 3 pages.

**New screenshots** when the screens change: same sizes and data as above, cropped to the part a
step shows, saved as JPEG at 2× (the step's image is 72 mm wide in print). Where a step needs two
parts of one screen (`v1-teams.jpg`: the list and the menu rows; `t4-roster.jpg`: the top of a game
and an unticked player), the two crops are stacked with a thin grey band between them.

**The manager site is not part of a test stack.** A stack serves only the scorer app, so for the
manager screenshots build it yourself: copy `escoresheet/frontend` to a scratch folder and run
`VITE_BACKEND_URL=<the stack's backend URL> node scripts/build-subdomains.js manager` there (output
`dist-manager/`). Serve that build on the stack's web origin (a Playwright `context.route` that
answers every request on that origin from `dist-manager/`, so the backend's CORS allows it) and
start Chromium with `--disable-features=LocalNetworkAccessChecks`. Accounts, the club, its teams
and games are made-up rows in the stack's own database, never production.
