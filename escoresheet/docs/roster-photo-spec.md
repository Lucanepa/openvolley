# Einsatzliste from a photo (Match Setup)

Status: **plan A built** (branch `feat/roster-photo-import`), text recognition on the device.
**Plan B planned, not built**: our own OCR server, only "if we start having big issues" with A
(owner, 2026-11-23). Privacy policy 1.29 names the photo import, with the Android camera file (owner OK 23.11 for the
wording; 1.28 is the audit's, released with 26.11.6; 1.29 goes to openvolley_home with the release
that ships this).

## 1. What the owner asked (2026-11-23)

- A photo import for the Einsatzliste on the scorer tablet that reuses the PDF importer: the same
  structure out of every reader, the same validation and merge path, nothing applied without the
  scorer's confirmation.
- "is there a possibility to do this without AI API?" → plan A (no API, no third party); "let's plan
  A and B but only deploy A, B if we start having big issues".
- "if they already put numbers and/or L/C then fill it for this game" (numbers, captain and liberos
  written on the list count for this game; blanks still come from the saved team, as for a PDF).
- "captain can be either C or K, libero L. if a number is circled, then it means captain".
- "coaches can write next (left) or between name and licence, kinda everywhere".
- "can a screenshot be used also?": yes ("Choose a picture" takes any image, a screenshot too).
- 2026-11-27, after testing on the A7 Lite: "just already import them in the official roster and fix
  there". Since then there is no check screen: the reading goes straight into the roster (the PDF
  import's path), the unsure fields are marked on the roster's own rows, and the roster offers Undo
  (section 3.4). This replaces "nothing applied without the scorer's confirmation" above.
- Bundle the recognition in the Android and desktop apps; the web loads it on first use.

Earlier rules that still hold: an Einsatzliste names only the coach and two assistants, exists in
DE / FR / IT only (2026-11-10); only the licence number is taken beside a name, never the date of
birth (db/048, 2026-11-19).

## 2. VolleyManager's Einsatzliste, as printed

From a real list the owner showed (2026-11-23; no copy kept, the test lists are made up):

- Title `Einsatzliste #<n> | <team> (<league>, ♀/♂, <region>)`, then
  `#<game> | <date time> | <home> — <away>` and `Generiert am: …`.
- The officials **above** the table, in English whatever the list's language:
  `Coach: #<SV number> | <first> <last> (<year>)`, `1. Assistant Coach: …`, `2. Assistant Coach: -`.
- A table **without rules**: `SV-Nr. | Vorname | Nachname | M / F | Geburtsdatum | LK | LAS | E | ⚠`
  (LK the league, e.g. RLL; LAS the LFP column with an X; E another X column; ⚠ a tick).
- SV numbers of 5 or 6 digits. A long last name wraps onto a second line in its cell.
- No shirt numbers, captain or liberos printed; a team may write them in by hand.

## 3. Plan A: read on the device (built)

```
camera / picture ──► scan.js ──► ocr.js (Tesseract.js) ──► ocrRoster.js ──► savedTeamNames.js
                     corners,     deu+fra+ita, LSTM,         words → the PDF       saved team's
                     warp, light, PSM 6, app's own files     reader's items →      spelling by
                     rules out                               parseRosterContent    SV number
                                                                    │
            MatchSetup.applyImportedRoster ◄── the roster editor: unsure fields marked on its rows
            (the PDF import's own path)        (red = fix, amber = check), banner with Undo
```

### 3.1 One structure for every reader (`src/domain/importedRoster.js`)

`importedRosterOf(raw, source)` turns what a reader gives into
`{ source: 'pdf'|'ocr'|'server', players: [{ number, licence, firstName, lastName, dob, isLfp,
isCaptain, isLibero, confidence? }], coach, ac1, ac2 }`. `parseRosterPdf`'s result goes through it
unchanged (a PDF has no flags and no confidence), a photo's carries both. `validateImportedRoster`
checks the shape (for a reader on a server too, plan B); `fieldIssues` gives the confirm screen its
red and amber fields (number 1 to 99 and once, licence digits, a last name, one captain, at most two
liberos, a libero is never captain; amber where the reader was unsure or a name looks misread).

`importedToSetup` is **the one way an import becomes Match Setup's roster and bench**: the list's
numbers kept, the missing ones from the side's saved team (`fillNumbersFromSaved`), the first
captain and the first two liberos marked, the licence beside the name (`importedIdValue`).
`MatchSetup.applyImportedRoster(side, roster)` uses it for the PDF and the photo alike (the two
copied PDF handlers became one), then the player pool above 14, else the import summary. A test
keeps a PDF's result equal to what the old handler gave.

### 3.2 The page (`src/utils/rosterPhoto/scan.js`)

No OpenCV (about 9 MB, slow on a Galaxy Tab A7 Lite). The photo is decoded at 2400 px at most
(EXIF upright); `guessCorners` takes the largest bright region of a small copy (the page on a
table), or the whole picture when the page fills it (a screenshot); the scorer drags the four
corners, Turn moves the top. `scanPage` undoes the perspective (homography, bilinear), evens the
light (each pixel against the page's brightness around it), stretches the contrast, takes out the
table's thin rules (Tesseract misreads every letter that touches a rule) and enlarges a small page
up to twice (2200 px; a phone screenshot's letters are ~8 px). Grey, kept in memory only.

### 3.3 The recognition (`ocr.js`) and the rows (`ocrRoster.js`)

Tesseract.js 7 with German, French and Italian (`4.0.0_best_int`), LSTM only, one block of text
(PSM 6); since 2026-11-27 only the languages of the list's language the scorer picked (section
3.10). The handwritten marks are read by the handwriting reader (section 3.9), Tesseract only where
it cannot run. Its files are the app's own (`vite-plugin-ocr-assets.js`, `ocr/<version>/`): never a CDN,
works offline and under `script-src 'self'` (the pages already allow `'wasm-unsafe-eval'`). Errors
have codes: `ocr-load` (could not start: the web offline before its first use), `ocr-timeout`
(120 s), `ocr-empty` (no player row), `ocr-cancelled` (dialog closed: the workers are ended at once).

Since 2026-11-27 (section 3.8) the recognition **starts when the photo dialog opens**
(`startOcrEngine`, while the scorer takes the photo and drags the corners), with as many workers as
the device has cores and memory for (`ocrWorkerCount`: one core left for the page, at most four,
three with Chrome's `deviceMemory` 2 or 3, one below 2); it is ended when the dialog closes, when
the list is read, and while the page is hidden (the camera app in front: its memory back, started
again when the photo comes). Tesseract is handed the page's **grey pixels as a PGM file**, never a
canvas (Tesseract.js encodes a canvas as PNG on the page, which a busy page puts off, and decodes it
again in the worker). The page itself is read by one worker; the others read the quarter turns of a
page on its side and the handwriting, SV numbers and circles read again, side by side. One progress
bar runs from the tap to the check screen ("Reading the list…", then "Reading the handwritten
numbers…").

`rosterFromOcr` makes Tesseract's words the **positioned items pdf.js gives** (one y per line,
column starts snapped together, letter height scaled to the PDF reader's units) and calls
`parseRosterContent`: the PDF importer's own columns, SV numbers, names, particles and officials.
Before that, per row:

- reading slips: specks and rule scraps out, O/I/S… read as digits inside numbers and dates, a
  lost dot in a date put back, a tick glued to a mark ("“L") split off;
- marks written in, **anywhere on the row** (owner): a number before the SV number (the nearest;
  "1" "1" joined; I/J/O… read as digits there only), else anywhere between the SV number and the
  date (taken out of the row, or it would break the names; not a piece of a split date), else after
  the date but right of the printed table (its tick column reads as "4"); C or K the captain, L a
  libero, before the SV number, right after it, as a bare capital between the names, or after the
  date (read small or twice: "c", "Cc"); a mark or number on a name's wrapped second line counts
  for that row; a **circled number** the captain: "(7)" as read, a ring round the number's box
  (`ringScore`), or, when the recognition skipped the circled number (it often does), a ring
  anywhere on the row up to the date, centred on it (`ringInRegion`: a hollow ring 1.3 to 5 lines
  across with ink inside it), whose inside is then read again alone as digits;
- a row is never lost: signs that are no name (a circle read as "@)") are dropped; a name the
  photo lost gets a stand-in in its column, emptied after (the confirm screen shows the gap, a
  missing last name red); a misread SV number or date keeps the row (red / dropped date);
- the X under the LAS / LFP header marks LFP (the header a mark stands under, not the PDF's narrow
  tolerance); a name's second line joins the name it stands under;
- the officials from their own lines above the table (2026-11-27): the colon, the "#", the "|" or
  the year in brackets lost or misread, the role in any of the three languages or with its first
  letter gone ("oach"); "1." / "2." before the label is that assistant whatever became of its words;
  the name is "first last" (the year is a birth year, never a name): the player row with the same
  SV number gives the split, else a particle ("von", "De") starts the last name, else the last word
  is it, and a guessed split (three words or more) is amber for both names;
- a row **struck out** (2026-11-27): a pen line through it, also pale or coloured, wavy, over part
  of the row or run into the words by the reading (scan.js `struckThrough`: two gaps between words
  crossed in a row, or ink along the row's middle longer than any word, across a gap); a struck
  row the reading garbled into no player, or skipped (a gap of a row between two players with a
  line across it, `lineAcross`, read again alone), is still named on the check screen.

Each field gets the lowest confidence of its words; handwritten marks never more than 0.7, so they
are always shown amber. `withSavedTeamNames` then gives a player whose SV number the side's saved
team has the saved spelling (sure), and a player whose SV number is no one's there but whose name
is (one person only) the saved number: amber when the read one looked right ("10031", a digit
lost).

### 3.4 The screen (`src/components/rosterPhoto/`, Match setup)

Match setup › Edit roster › Roster import › Photo (since 27.11.2026 one switch: Remote · PDF ·
Photo): first the list's language (Deutsch · Français · Italiano · Other, section 3.10: nothing
picked at first, the photo buttons disabled with a hint until one is), then "Take a photo" /
"Choose a picture" open their source at once, then the dialog: corners → reading (progress).
Cancel before the reading ends changes nothing.

**No check screen** (owner, 2026-11-27: "just already import them in the official roster and fix
there"). The reading goes straight into the roster through `applyImportedRoster`, as a PDF does:
it replaces the players and the bench officials, with more than 14 players the scorer ticks who
plays first, numbers left blank come from the saved team. Then, in the roster editor:
- every field `fieldIssues` names is marked on the editor's own rows: red = must fix, amber =
  check, with the reason as the field's title, in the table and the stacked (upright, phone)
  layouts, the coach and assistants too. A field's mark goes as soon as the field is changed;
- the marks are UI state only (`src/utils/rosterPhoto/photoMarks.js`): Match setup's state, keyed
  by a Symbol token on each row the photo gave (JSON and IndexedDB's structured clone skip symbol
  keys, and the players are written field by field). Nothing of them reaches the match, the
  roster, a sync job or the scoresheet. They go when the editor closes (Save or Back);
- a banner on top of the roster: "From the photo: n players · n fields to fix (red) · n fields to
  check (amber)", the rows struck out on the list by name, the reading's time ("Read in 11.4 s ·
  version …") and **Undo import** (the roster and bench officials as they were before the photo).
  It goes when dismissed, when every mark is fixed, or when the photo's rows are replaced.

The photo.read activity entry (#372) is written when the reading ends, as before. The banner
carries `data-sensitive` (it names people).

The check screen of 26–27.11 (a grid per row that fit the A7 Lite with a large system font, and its
fit script `e2e-ui/photo-check-fit.mjs`) went with it: the roster editor's own rows, which already
fit those sizes, are where the photo's rows are fixed now.

### 3.5 Platforms

- **Web / PWA**: `ocr/**` is not precached (about 12 MB, not on every install); `OCR_FILES_ROUTE`
  keeps what is loaded. Since 2026-11-26 (owner) the files are loaded ahead at the **first Match
  setup** (`ocrWarmup.js`), not at the first photo import, so a photo import works offline even if
  the scorer never tried one online: once the page is idle, one file after another at low priority,
  exactly the files `ocr.js` loads on that device (`ocrFiles.js`: the worker, the engine with or
  without SIMD, deu / fra / ita). Only with a service worker in charge, online, the page visible,
  Data Saver off, and once per tesseract.js version (a flag after all files came, or the files
  already in the cache); a failure is only logged and tried again at the next Match setup. Not in
  the apps (Capacitor, Tauri), whose build carries the files.
- **Android** (Capacitor): the file field with `capture` asks the camera app for a picture
  (`<queries>` for `IMAGE_CAPTURE`, Android 11+; no CAMERA permission). The camera app writes the
  photo into the app's own Pictures folder and nothing deleted it: `MainActivity` deletes those
  older than ten minutes at each start. Some camera apps also keep a copy in the gallery (device
  dependent, not ours to delete). F-Droid's scanner refuses `.gz` and `.wasm` files in the build
  (fdroidserver `scanner.py`: also `.zip`, `.jar`, `.so`, and binaries named `.bin` or without an
  extension): Tesseract's engine ships as `.wasm.js` and the languages decompressed
  (`.traineddata`); the handwriting reader's engine as `ort-wasm-simd-threaded.wasm.js` (the
  build writes onnxruntime-web's WebAssembly into it as base64, `export default "…"`, the worker
  hands the bytes to onnxruntime-web as `env.wasm.wasmBinary`) and its model as `.onnx` (passes);
  the worker imports onnxruntime-web's `ort.wasm.min.mjs` (alias `onnxruntime-web/wasm`), not its
  default build, which would have Vite copy the `.wasm` into `assets/`.
- **iOS**: the camera text names the photo of the Einsatzliste (`NSCameraUsageDescription`).
- **Desktop**: the field opens a file picker (a picture or a screenshot).
- **Backend-served pages** (the standalone / venue server handing out the frontend, `--local`):
  the backend sends the app's own policy with `'wasm-unsafe-eval'` (`lib/pageCsp.js`, SEC-46,
  openvolley#346; before it the recognition could not start there: checked with the built app
  served from a local backend). Anywhere WebAssembly is still refused, `wasmAllowed()` says so at
  once (`ocr-load`) instead of after the 60 s start limit; the PDF import works there.

### 3.6 Tests

`importedRoster.test.js` (structure, shape, fields, the one apply path, PDF parity),
`ocrRoster.test.js` (four recorded readings of made-up lists: VolleyManager's layout as a skewed
photo and as a phone screenshot, a ruled table in German and Italian; marks, circles, LFP, wrapped
names; and the marks spread over the row), `scan.test.js` (homography, corners, light, rules, rings), `ocr.test.js` (files from the
app, load error, timeout, empty, cancel), `savedTeamNames.test.js`, `RosterPhotoImport.test.jsx`
(the reading handed straight on with its time, struck rows, cancel, error and retry; the recognition
started when the dialog opens, ended on close and while the page is hidden), `photoMarks.test.js`
and `MatchSetupPhotoImport.test.jsx` (applied at once, the marks shown and cleared on edit, Undo, a
Save stores no mark, more than 14 players). Since 2026-11-27 also
the workers (one language each, merged line by line, PGM), struck rows drawn on made-up rows, made-up
officials in the three languages (the check screen's fit script went with the check screen,
27.11.2026). Since the handwriting reader (27.11.2026): `handModel.test.js` (the resize checked
against Pillow's, the batches, the masked CTC decode, the engine's script), `handReader.test.js`
(its worker: load, read, no SIMD, a failed or silent load, a worker that dies), `scan.test.js`
(`columnLine`, `marginBand` on drawn rows), `ocr.test.js` (on a made-up page drawn into a stand-in
canvas: the margin read by the reader and Tesseract never asked; Tesseract when the reader fails or
did not load; the list's languages for the workers), `src/__tests__/ocrAssets.test.js` (the build's
files, no `.wasm` or `.gz`, the model's SHA-256 and cache, the version pin), the photo.read keys
(`activitySummary.test.js`, `photoReadLog.test.js`, the backend's `activityLog.e2e.test.js`) and the
language pick (`RosterPhotoImport.test.jsx`, `walkthroughRosters.test.jsx`). The fixtures and
their sources: `src/utils/rosterPhoto/__tests__/fixtures/`.

### 3.7 Tuned on real photos (2026-11-26)

The owner's 13 photos (DE / FR / IT lists, pen marks, four on their side, one blurry, a phone's
shadow, one row struck out, one row added by hand) were run through the app's own path in Chromium
and scored against an answer key; they stay off the repo (names, dates of birth). What changed:

- **Corners**: the bright region's hull joined into four sides, and the four straight edges fitted
  to its outline; the one covering the region best wins (a shadow, a hand, a second sheet or
  something dark on the page's edge pulled the extreme points in or out).
- **Rows**: lines joined by their words' middle, never two with an SV number each; a page askew or
  bent is regrouped along its slope (the lower rows slope more); a row whose SV number the photo cut
  off is kept (SV number empty, to check); a row without a printed date (written in by hand) keeps
  its words and every field is to check; an SV number starting right of its column is read again
  from the column's start (a lost first digit), to check.
- **Names**: between the SV number and the date only print stays (handwriting read as "AT", "(x",
  "2g" is kept aside); "Anna(1)" is split; a small first letter gets its capital.
- **Handwriting** (`ocr.js` readHandwriting): the ink on each player row that no printed word
  explains (scan.js `handInk`: left of the SV number up to the date, and right of the table) is
  cut out, made black on white by its own ink, and read alone, digits and C / K / L only; a circled
  group is the captain and its inside is read. Every handwritten mark stays amber.
- **Struck rows** (scan.js `struckThrough`, on the page before its rules go): ink across most of
  the gaps between a row's words at their middle. Left out of the players, named on the confirm
  screen (`roster.struck`), never applied.
- **Orientation**: a page read with few sure words is tried a quarter turn either way and upside
  down on a small copy, then read the way it reads best; a page the right way up is read once.
  Turn stays.
- **Blur**: a page read below 55 % (or with no row below 70 %) is `ocr-blurry`: "take it again".

Result (counts only; the table is in PR #358): every printed row found on the 12 readable photos,
SV numbers, names and dates of birth 94 to 95 % exact, **no wrong field without amber or red**.
Handwritten shirt numbers are the weak part (Tesseract reads print; about half of them right),
always amber. If that is not good enough, plan B (section 4) is the next step.

### 3.8 Faster on a slow tablet (2026-11-27)

The owner timed about 20 s on the Galaxy Tab A7 Lite (Chrome, main 671315fb9) from "Read the list"
to the check screen, about 2 to 3 s on a desktop. Measured with the app's own dialog on the 14 real
photos (crop step open 4 s, then the tap), in Chromium with every renderer thread (page and workers)
slowed 5 times (stopped and resumed: CDP throttling does not reach workers) on 8 cores, 5 calibrated
so that main takes ≈ 20 s on the owner's own photo. Each idea measured alone:

- **kept** the recognition started when the dialog opens (the worker start: about 0.2 to 0.5 s on a
  desktop, seconds on the tablet);
- **kept** the grey pixels as PGM instead of a canvas: the page read a fifth faster on a desktop,
  word for word the same, and no wait for the page to encode its PNG (about 1 s in the dialog);
- **kept** three workers: the page read by the three side by side, one language each, merged line
  by line from the language surest of it (`mergeLanguages`); rows, SV numbers, names and dates as
  good or better than with the three languages in turn, the officials better; the turns of a page
  on its side and the handwriting read side by side too;
- **dropped** the page cut into bands read side by side (desktop 2.7 to 1.8 s): Tesseract reads a
  band differently from the whole page (a row lost on one photo, SV numbers and dates on others);
- **dropped** one language after reading the title: first names on the Italian lists and the
  handwritten marks read worse; the title's language first of three: no gain;
- **dropped** the columns after the date left out of the reading (a fixed share of the width):
  dates cut on some photos; the page read smaller (0.8 to 0.5 of 2200 px): 20 to 35 % faster
  reading, not needed after the above;
- **dropped** a left-margin read of the shirt numbers alone (digits, C, K, L, twice the size,
  bolder): fewer numbers right than the handwriting pass.

Result (seconds from the tap to the check screen, average of the 14 photos): desktop 4.5 to 2.2,
slowed 5 times (≈ the A7 Lite) 18.8 to 11.1 (the owner's photo 19.5 to 11.4; between 7.7 and 13
for every photo but one on its side, 24 to 21: the wrong quarter turn reads slowly). The 12 readable
photos: every row found as before (123 of 123), SV numbers / first names / last names / dates of
birth exact 99 / 98 / 98 / 100 % before, 99 / 99 / 99 / 100 % after, no wrong field without amber
or red, handwritten marks 32 right / 37 missing before, 34 / 34 after, the officials' fields 45 to
48 of 48. On a real A7 Lite three workers side by side share its memory bandwidth, which the
slowed desktop does not show: expect about 10 to 13 s there. The next step, if that is still too
slow, is the page read smaller (20 to 35 % less reading time, its accuracy not yet measured).

### 3.9 The handwriting read on the device (option B of the handwriting study, 2026-11-27)

The handwriting study (owner's 14 photos, 77 handwritten marks on the 12 readable ones) tried
recognisers on the crops the pipeline cuts: Tesseract's second reading read 34 marks right,
PP-OCRv6 rec tiny 63, with **one crop of a row's left margin** (up to the printed SV-number column
fitted down the page) in place of the margin's groups of ink. Owner: "ok B. just put it out". Built:

- `handReader.js` / `handReader.worker.js`: **PP-OCRv6 rec tiny** (PaddleOCR, as RapidOCR converts it
  to ONNX, Apache-2.0, 4.5 MB) in **onnxruntime-web**'s WebAssembly engine (MIT, one thread: threads
  need a cross-origin isolated page, which no page of the app is), in its own worker. It starts with
  the recognition (`startOcrEngine`, while the scorer takes the photo; engine.hand), and loads from
  the app's own files (`ocr/hand-<onnxruntime-web version>/`, `handFiles.js`; never a CDN): the
  model, the engine's loader `.mjs` and the engine as `.wasm.js` (section 3.5). Needs WebAssembly
  SIMD and module workers; where it cannot load (an old WebView, too little memory, a file missing),
  or fails, the marks are read by Tesseract as before (`marksBy: 'tesseract'` in photo.read). Still
  loading when there is handwriting to read, it gets 10 s more (`HAND_WAIT_MS`, counted in
  `msEngine`); a page without handwriting never waits for it.
- What it reads (`ocr.js` handMarks): for each player row with ink left of the SV number, **one
  crop of the margin** (`scan.js` `columnLine`: the SV column as a Theil-Sen line through the rows'
  SV starts, so a number that swallowed or lost a digit does not move it; `marginBand`: from two
  lines left of the margin's ink to a quarter line before the column, the row's y ±1.4 lines; the
  ink parts whose middle is on the row, no speck, no rule, nothing touching the column) in grey;
  every other group (inside the table, right of it, a circled number's inside) as Tesseract is
  handed it (black on white). Each crop scaled to 48 px high (antialiased bilinear, as Pillow:
  `handModel.js`), padded to 320 wide, the answer decoded greedily (CTC) with only blank, 0-9, C, K,
  L allowed; a reading below 0.3 is no mark. `withHandReadings` merges them unchanged: **every
  handwritten mark stays amber**.
- Measured in the app's own path (Chromium, the 14 photos, counts only; PR body): 12 readable
  photos 64 of 77 marks right (Tesseract 34), 8 wrong, 5 missing, 8 extra, photo 14 13 of 16 (5),
  no wrong field without amber or red; rows, SV numbers, names, dates and officials as before.
  Time (the renderer slowed 5 times, 8 cores, Chrome's 2 GB: one worker, the calibration of
  section 3.8; the engine started 5 s ahead): the marks 1.0 s a photo on average (Tesseract's
  second reading 0.7 s), the owner's photo 2.4 s; the reader had always loaded by then. Its files
  add about 25 MB to the build (the engine 19.8 MB as base64, 5.9 MB compressed; the model 4.5 MB).

### 3.10 The list's language (2026-11-27)

Owner: the scorer picks the list's language before the photo: Deutsch · Français · Italiano ·
Other (`ListLanguageChoice`, Match setup's Photo segment above "Take a photo" / "Choose a picture",
and in the dialog's source step). Nothing is picked at first (never from the device's or the app's
language, never remembered: a conscious pick each import); until then the photo buttons are
disabled and a hint says why. The walkthrough's Photo step shows it, inert like the buttons. The
pick goes to the reading (`ocrFiles.js` `ocrLangsFor`): Tesseract starts with those languages
only, fewer and faster, above all on a device with one worker:

| Pick | Tesseract | Why (the 14 real photos, one worker) |
|---|---|---|
| Deutsch | deu | German lists as with all three (every field, the officials); 10.1 s instead of 14.2 s a German list |
| Français | fra + deu | French alone lost SV numbers; the names on French lists are often German-Swiss; 8.5 s instead of 11.6 s |
| Italiano | ita + deu | Italian alone lost first and last names and officials (as the 26.11 title-language test); 11.9 s instead of 12.8 s |
| Other | deu + fra + ita | as before |

(Seconds from "Read the list" to the roster, at section 3.8's A7 calibration, one worker.)

A wrong pick never breaks the reading: the list is read with the other languages, the page's words
the picked one is unsure of re-read in the second where there is one. German left on a French list
(the 4 readable French photos): every row found, 1 SV number, 1 last name and 2 dates of birth more
to check (all amber or red, none wrong unflagged), 2 marks fewer right; German on an Italian list:
as good as Italian. A role word the photo blurred past reading ("Coach:" on the owner's tablet photo,
read with German alone) no longer loses the official: a line of the officials' shape ("#", a
five- or six-digit SV number, two names, the year in brackets) takes the first free slot, its
names to check (`ocrRoster.js` officialOf).

## 4. Plan B: our own OCR server (planned, not built)

Build it only if plan A shows big issues: on real lists, many misread SV numbers or names the
scorer has to retype, handwriting rarely read, or the tablet too slow (more than ~30 s a page).

### 4.1 What it is

A recognition service on **our own server**, so no photo or name leaves our infrastructure and the
privacy policy needs no new processor. Candidates, in order:

1. **PaddleOCR (PP-OCR) or RapidOCR (the same models on ONNX Runtime)**, Apache-2.0, runs on a
   CPU: text detection plus Latin recognition, generally stronger on photos than Tesseract.
   Handwriting, the time per page and the memory on the VPS (Infomaniak, 2 CPUs) are to be
   measured on the owner's sample photos before choosing.
2. A self-hosted vision model (e.g. Baidu's Unlimited OCR, a small Qwen-VL) only with a GPU, which
   production has none of. Unlimited OCR is built for long multi-page documents, documents fixed
   prompts and page text, not JSON; it would be a "text" reader feeding the same parser.

### 4.2 How it fits

- A container on the VPS's private network (as `ov-render`), not public; the backend forwards to it.
- `POST /api/roster-photo/read` on the backend: signed-in scorers only (bearer), rate-limited per
  account, body at most 2 MB (the flat page as JPEG, 1600 px), held in memory only, never stored;
  logs carry the request id, time, row count and status, never a name or a licence number.
- Configured by env, off unless set: `OV_ROSTER_OCR_URL`, `OV_ROSTER_OCR_TOKEN`,
  `OV_ROSTER_OCR_MODE=text|json` (`text`: the service returns words with boxes, the backend or the
  app runs `rosterFromOcr`; `json`: the service already returns the structure),
  `OV_ROSTER_OCR_TIMEOUT_MS`. Another model later is a new URL, no code.
- The answer is the structure of section 3.1 with `source: 'server'`, checked by
  `validateImportedRoster` on the server and again on the device.
- The app: online and signed in → the server first; offline, signed out, past **8 s**, or any error
  → plan A on the device, as today. The confirm screen shows which one read the list.
- Tests: the fallback (offline, timeout, error), the endpoint (auth, size, rate limit, off when
  unset, no names in logs), the shape check.
- Privacy: section 4 and the data map name the server reading (Infomaniak, Switzerland, already a
  processor); the photo is not kept.

## 5. Files

`src/domain/importedRoster.js`, `src/utils/rosterPhoto/{scan,ocr,ocrFiles,ocrWarmup,ocrRoster,savedTeamNames,photoReadLog}.js`,
`src/utils/rosterPhoto/{handFiles,handModel,handReader,handReader.worker}.js` (the handwriting reader),
`src/components/rosterPhoto/{RosterPhotoImport,PhotoCropStep}.jsx`, `src/utils/rosterPhoto/photoMarks.js`,
`src/components/MatchSetup.jsx` (`applyImportedRoster`, the marks, the banner, Roster import › Photo), `vite-plugin-ocr-assets.js`,
`pwa-workbox.js` (`ocr/**`, `OCR_FILES_ROUTE`), `scripts/build-subdomains.js`, the Android manifest
and `MainActivity`, iOS `Info.plist`, locales (`rosterPhoto.*`, help `importPhoto`), legal texts
(privacy 1.28, open-source notices, data map).

Activity log (owner 27.11, privacy 1.31): each reading that ends writes one `photo.read` entry
(`utils/rosterPhoto/photoReadLog.js`): its time, outcome code and counts (rows, fields to check,
struck rows), the device's cores and memory, the workers used and whether the page was turned;
since 27.11.2026 the time per stage (`msEngine`, `msPage`, `msHand`, `msRest`), the reader of the
marks (`marksBy`: `onnx` / `tesseract`) and the list's language picked (`lang`).
Never the photo or anything read from it (docs/activity-log-spec.md). On the server:

```sql
SELECT app_version, platform, data->>'cores' cores, data->>'memory' mem, data->>'outcome' outcome,
       count(*), round(avg((data->>'ms')::int) / 1000.0, 1) avg_s, round(max((data->>'ms')::int) / 1000.0, 1) max_s
FROM ov_read.activity_log WHERE kind = 'photo.read' GROUP BY 1,2,3,4,5 ORDER BY 6 DESC;
-- where the time went (entries since 27.11.2026)
SELECT data->>'lang' lang, data->>'marksBy' marks, data->>'workers' workers, count(*),
       round(avg((data->>'msEngine')::int) / 1000.0, 1) engine_s, round(avg((data->>'msPage')::int) / 1000.0, 1) page_s,
       round(avg((data->>'msHand')::int) / 1000.0, 1) hand_s, round(avg((data->>'msRest')::int) / 1000.0, 1) rest_s
FROM ov_read.activity_log WHERE kind = 'photo.read' AND data ? 'msPage' GROUP BY 1,2,3 ORDER BY 4 DESC;
```
