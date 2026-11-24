# Einsatzliste from a photo (Match Setup)

Status: **plan A built** (branch `feat/roster-photo-import`), text recognition on the device.
**Plan B planned, not built**: our own OCR server, only "if we start having big issues" with A
(owner, 2026-11-23). Privacy policy 1.28 (draft for the owner's review) names the photo import.

## 1. What the owner asked (2026-11-23)

- A photo import for the Einsatzliste on the scorer tablet that reuses the PDF importer: the same
  structure out of every reader, the same validation and merge path, nothing applied without the
  scorer's confirmation.
- "is there a possibility to do this without AI API?" → plan A (no API, no third party); "let's plan
  A and B but only deploy A, B if we start having big issues".
- "if they already put numbers and/or L/C then fill it for this game" (numbers, captain and liberos
  written on the list count for this game; blanks still come from the saved team, as for a PDF).
- "captain can be either C or K, libero L. if a number is circled, then it means captain".
- "can a screenshot be used also?": yes ("Choose a picture" takes any image, a screenshot too).
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
            MatchSetup.applyImportedRoster ◄── "Use" ◄── confirm screen (every field editable,
            (the PDF import's own path)                   red = fix, amber = check)
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
(PSM 6). Its files are the app's own (`vite-plugin-ocr-assets.js`, `ocr/<version>/`): never a CDN,
works offline and under `script-src 'self'` (the pages already allow `'wasm-unsafe-eval'`). Errors
have codes: `ocr-load` (could not start: the web offline before its first use), `ocr-timeout`
(120 s), `ocr-empty` (no player row), `ocr-cancelled` (dialog closed: the worker is ended at once).

`rosterFromOcr` makes Tesseract's words the **positioned items pdf.js gives** (one y per line,
column starts snapped together, letter height scaled to the PDF reader's units) and calls
`parseRosterContent`: the PDF importer's own columns, SV numbers, names, particles and officials.
Before that, per row:

- reading slips: specks and rule scraps out, O/I/S… read as digits inside numbers and dates, a
  lost dot in a date put back, a tick glued to a mark ("“L") split off;
- marks written in (owner): a number before the SV number (the nearest; "1" "1" joined; I/J/O…
  read as digits there only), or after the date but right of the printed table (its tick column
  reads as "4"); C or K the captain, L a libero (read small or twice: "c", "Cc"); a **circled
  number** the captain: "(7)" as read, a ring round the number's box (`ringScore`), or, when the
  recognition skipped the circled number (it often does), a ring left of the SV number
  (`ringInRegion`: a hollow ring 1.3 to 5 lines across with ink inside it), whose inside is then read
  again alone as digits;
- the X under the LAS / LFP header marks LFP (the header a mark stands under, not the PDF's narrow
  tolerance); a name's second line joins the name it stands under; "1." / "2." before an official's
  label is that assistant whatever became of the label's words.

Each field gets the lowest confidence of its words; handwritten marks never more than 0.7, so they
are always shown amber. `withSavedTeamNames` then gives a player whose SV number the side's saved
team has the saved spelling (sure), and a player known by name whose number was not read the saved
number.

### 3.4 The screen (`src/components/rosterPhoto/`)

"Photo of the list" under "Upload PDF" (Local) on both sides. Steps: tips + Take a photo / Choose a
picture → corners → reading (progress) → confirm. The confirm screen: players (number, last and
first name, licence, C, L, remove) and the three official rows, the method ("Read on this device"),
how many names came from the saved team, how many fields to fix / check. "Use" is off while a red
field is left. Cancel at any step changes nothing. Lists with names carry `data-sensitive` (no name
in the interaction log).

### 3.5 Platforms

- **Web / PWA**: `ocr/**` is not precached (about 12 MB); `OCR_FILES_ROUTE` keeps the files after
  the first photo import, so later ones work offline.
- **Android** (Capacitor): the file field with `capture` asks the camera app for a picture
  (`<queries>` for `IMAGE_CAPTURE`, Android 11+; no CAMERA permission). The camera app writes the
  photo into the app's own Pictures folder and nothing deleted it: `MainActivity` deletes those
  older than ten minutes at each start. Some camera apps also keep a copy in the gallery (device
  dependent, not ours to delete). F-Droid's scanner refuses `.gz` and `.wasm` files in the build:
  the engine ships as `.wasm.js` and the languages decompressed (`.traineddata`).
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
names), `scan.test.js` (homography, corners, light, rules, rings), `ocr.test.js` (files from the
app, load error, timeout, empty, cancel), `savedTeamNames.test.js`, `RosterPhotoImport.test.jsx`
(nothing applied before "Use", red blocks, edits applied, remove, error and retry). The fixtures and
their sources: `src/utils/rosterPhoto/__tests__/fixtures/`.

**Not yet tried on real photos or real handwriting.** The fixtures are rendered lists with a
hand-like script and a drawn circle; real handwriting, real light and the A7 Lite's speed need the
owner's sample photos (DE / FR / IT). The confirm screen is there for exactly that.

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

`src/domain/importedRoster.js`, `src/utils/rosterPhoto/{scan,ocr,ocrRoster,savedTeamNames}.js`,
`src/components/rosterPhoto/{RosterPhotoImport,PhotoCropStep,RosterConfirmStep}.jsx`,
`src/components/MatchSetup.jsx` (`applyImportedRoster`, the button), `vite-plugin-ocr-assets.js`,
`pwa-workbox.js` (`ocr/**`, `OCR_FILES_ROUTE`), `scripts/build-subdomains.js`, the Android manifest
and `MainActivity`, iOS `Info.plist`, locales (`rosterPhoto.*`, help `importPhoto`), legal texts
(privacy 1.28, open-source notices, data map).
