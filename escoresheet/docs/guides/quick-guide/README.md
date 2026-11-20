# Quick guide for the scorer (en, de, fr, it)

A printable guide for the scorer at the table: one Swiss official match with the OpenVolley
eScoresheet 3.2.5, from the first open to the final scoresheet, in 18 steps (a short heading,
a few sentences and one screenshot each). It replaces the 30-slide deck of January 2026.

| Language | Page | PDF |
|---|---|---|
| English | `quick-guide.en.html` | `OpenVolley-Quick-guide-en.pdf` (7 pages) |
| German (standard, Swiss spelling) | `quick-guide.de.html` | `OpenVolley-Quick-guide-de.pdf` (7 pages) |
| French | `quick-guide.fr.html` | `OpenVolley-Quick-guide-fr.pdf` (7 pages) |
| Italian | `quick-guide.it.html` | `OpenVolley-Quick-guide-it.pdf` (7 pages) |

`guide.css` is the look of `../team-links/guide.css` (A4 sheets, red step numbers), with the
screenshot beside the text or, for wide screens, below it. The screenshots are in `img/<lang>/`.

## Rules for the texts

- Facts only from the in-app help (`contextHelp` in `frontend/src/i18n/locales/*.json`), the wiki
  `User-Guide.md` and what the app shows. Nothing the app does not do.
- A label in quotes is the label exactly as that language's app shows it: find the English label's
  key in `en.json`, take the same key from the other locale. Quotes: en “…”, de «…», fr « … », it «…».
- Informal address in every language (du / tu); German with ss, never ß.

## Invented names only

Every name in the screenshots and texts is made up: the game VBC Seeblick – Volley Bergtal in the
Sporthalle Seeblick, the referees Lea Muster and Tim Beispiel, the scorer Mia Muster, the team manager
Nina Beispiel, the Volley Bergtal players, and the app's own test roster for VBC Seeblick. No real
person, club or hall may appear, and no real e-mail address (only `@example.com`). Look at every
picture before it goes in. The QR code in `17-tablets.jpg` is blurred: it pointed at the test stack.

## New screenshots

Take them from an isolated test stack (never production), with made-up accounts and data:

- tablet in landscape, 1280 × 800 at device scale factor 2, Chromium;
- the app in each language (`localStorage.language` = `en` | `de` | `fr` | `it`) and the tool set to
  Swiss (`localStorage['ov-tool-mode'] = 'swiss'`), except step 1 (the first-open question);
- one official match, signed in as a scorer of the home club: Load match from schedule, the away
  team's roster sent ahead (so the "Roster sent by …" card shows), coin toss with one team signed
  (the other signs on the scoring screen), a time-out request from a bench tablet, three sets
  (set 3 = deciding set), match end, then Restore match on Home;
- crop each picture to what its step shows, JPEG quality about 85, at most 1800 px wide.

| Picture | What it shows |
|---|---|
| `01-tool` | first open: How do you use OpenVolley? |
| `02-home` | Home, signed in |
| `03-schedule` | Load match from schedule, the game found |
| `04-matchinfo` | Match info page filled from the schedule |
| `05-roster` | Edit roster (Upload PDF, captain) |
| `06-sentroster` | the away team's card with "Roster sent by …" |
| `07-backups` | the Backups bar opened |
| `08-cointoss` | coin toss, team A signed, team B's Captain / Coach |
| `09-lineup` | first line-up covered, "Missing signatures" |
| `10-scoring` | scoring screen during a rally (point buttons) |
| `11-decision` | Decision change dialog |
| `12-playermenu` | a court player's menu (Substitution, Libero, Sanction) |
| `13-benchrequest` | a bench's time-out request card |
| `14-setend` | set end dialog |
| `15-deciding` | deciding set: sides, serve, interval countdown |
| `16-matchend` | match end: official signatures, Confirm and approve |
| `17-tablets` | Connect tablets, referee selected (QR blurred) |
| `18-restore` | Restore match on Home |

The 15.11.2026 pictures were taken with Playwright driving the recorder harness of the support videos
(the app's language switched in place for each picture, so all four languages show the same moment).
`04-matchinfo` and `05-roster` were taken again on 20.11.2026 (the Licence field instead of the date of
birth): a local build of main (`CAPACITOR=true`, `VITE_BACKEND_URL` and `VITE_CLOUD_API_URL` at
`http://127.0.0.1:9`, every other host blocked), "New match" signed out in each language, the Match info
typed in by hand and the Volley Bergtal roster added row by row; 1280 px wide at scale 2, the viewport
just tall enough for the officials' Licence fields. Step 4's picture is 76% wide so that page 2 keeps
room above the footer.

## New PDFs

After a text change, open the `.html` in Chrome or Chromium and print it: paper A4, margins None,
Background graphics on, Save as PDF. Or with Playwright: `page.pdf({ format: 'A4', printBackground: true,
preferCSSPageSize: true })`. Each page is a fixed A4 sheet; if a step runs into the footer, shorten the
text or the picture (`style="width: …%"` on a wide picture), then look at every page of the PDF.
