# Quick guide for the scorer (en, de, fr, it)

A printable guide for the scorer at the table: one Swiss official match with the OpenVolley
eScoresheet 26.11.9, from the first open to the final scoresheet, in 18 steps (a short heading,
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
- German and French volleyball words are the official ones of the Swiss Volley rules 2025-2028
  (Kapitän, Trainer, Auszeit, Auswechslung, Spielzug, Aufschlagspieler; capitaine, coach, temps-mort,
  remplacement, échange, premier/second arbitre), as in the app. Where a tablet button shows a short
  form (the team sanctions: «Nicht ordn. Anträge», «Dem. non fondée»), the text names the official
  term without quotes.
- Informal address in every language (du / tu); German with ss, never ß.

## Invented names only

Every name in the screenshots and texts is made up: the game VBC Seeblick – Volley Bergtal in the
Sporthalle Seeblick, the referees Lea Muster and Tim Beispiel, the scorer Mia Muster, the team manager
Nina Beispiel, the Volley Bergtal players (Ada to Lia Beispiel, coach Tea Trainer) and the VBC Seeblick
players (Ada to Lia Muster, coach Kai Coach). No real
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
  (set 3 = deciding set), match end; Restore match on Home is taken during set 2;
- crop each picture to what its step shows, JPEG quality about 85, at most 1800 px wide.

| Picture | What it shows |
|---|---|
| `01-tool` | first open: How do you use OpenVolley? |
| `02-home` | Home, signed in |
| `03-schedule` | Load match from schedule, the game found |
| `04-matchinfo` | Match info page filled from the schedule |
| `05-roster` | Edit roster (Roster import: PDF, Upload PDF, captain) |
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
| `18-restore` | Restore match on Home, the cloud backups found |

The 28.11.2026 pictures (26.11.9, main) were taken with Playwright by the quick-guide scripts of the
support-video recorder (`quick-guide/run.mjs`: one official match on a throwaway cloud stack whose
schedule, clubs and sent roster are seeded with invented data; the scorer Mia Muster is a scorer of
VBC Seeblick, so "SV match" lists the game). The app's language is switched in place for each picture,
so all four languages show the same moment (1280 × 800 at scale 2; `04-matchinfo` 1280 × 1020 and
`05-roster` 1280 × 900, for their lower rows); `finish.py` writes the JPEGs. The
set start time is the time the set really started (the app then asks for a reason, which goes to the
remarks of the throwaway match only).

## New PDFs

After a text change, open the `.html` in Chrome or Chromium and print it: paper A4, margins None,
Background graphics on, Save as PDF. Or with Playwright: `page.pdf({ format: 'A4', printBackground: true,
preferCSSPageSize: true })`. Each page is a fixed A4 sheet; if a step runs into the footer, shorten the
text or the picture (`style="width: …%"` on a wide picture), then look at every page of the PDF.
Step 4's picture is 64% wide, step 5's 70% and step 17's 72%, so that pages 2 and 7 keep room above
the footer in every language (French is the longest).
