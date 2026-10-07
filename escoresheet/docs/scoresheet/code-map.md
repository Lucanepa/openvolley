# Scoresheet generation: code map

Read-only map of how the A3 scoresheet (and its PDF) is produced, end to end:
where every value comes from, how the page becomes a PDF, where the file goes
on each platform, and every logo / ball the sheet uses. Written against `main`
0399609b (branch `feat/scoresheet-pdf`) as the basis for the owner's request
of 2026-10-07:

> 1. exchange swiss volley with Openvolley; 2. could you ultracode the
> scoresheet generation etc? ... check it's saved correctly as pdf. and show
> exactly where it is saved. also there's still the old ball there, substitute
> it everywhere with the new one. and in approval -> instead of Lic have "DoB"

Paths are relative to `escoresheet/frontend/` unless they start with
`escoresheet/`. Line numbers are those of 0399609b.

---

## 0. Short answers for the request

| Item | What the code does today | Where |
|---|---|---|
| (a) Swiss Volley logo top left | `Header.tsx` imports `./swissvolleylogo.jpg` (327x154 JPEG, Vite-hashed) and shows it 40 px high in the left slot, `alt="Swiss Volley"`. Android build aliases the import to `noFederationLogo.js` (null), so the slot is empty there. The right slot shows `/openvolley_logo.png` (lockup, 24 px high). The 97 px column right of SET 2 is a grey box with the text `eScoresheet<br />Openvolley` (misspelt). | `scoresheet_pdf/components/Header.tsx:2,49-58,229-243`; `vite.config.js:79-86`; `App_Scoresheet.tsx:2839-2850` |
| (b) old green 3D ball | The repo no longer contains it: `public/ball.png` is the flat ball since 7f4a9af4 (in `desktop-v2.3.0`). The sheet shows it via an unhashed URL `<img src="/ball.png">`. The desktop's built-in server sends every non-HTML file with `cache-control: public, max-age=31536000`, and the service worker precaches `ball.png` and runs `CacheFirst` on `*.png`, so a desktop (or browser) that once loaded the old `/ball.png` keeps showing it after an update. Same risk for `/openvolley_logo.png`. | `App_Scoresheet.tsx:2928-2938`; `src-tauri/src/relay.rs:1247-1261`; `vite.config.js:211-262`; `pwa-workbox.js:16-20` |
| (c) APPROVAL "Lic." | Column header `Lic.`; cell prints `official.license`, a field nothing writes (`buildOfficialsArray` stores `dob`, never `license`), so the column is always empty. `official.dob` is there (`DD.MM.YYYY` typed in setup, `YYYY-MM-DD` from the referee DB, or the `01.01.1900` placeholder). The Swiss course says the official sheet's "Licence n." column "actually is DoB" for both the roster and the officials. | `components/FooterSection.tsx:493-521`; `src/components/MatchSetup.jsx:107-133,623`; course p. 9-10 |
| (d) file name `match_HOME_AWAY_20261007.pdf` | `${gameNumber ‖ externalId ‖ game_n ‖ 'match'}_${SAN(homeShortName ‖ homeTeam.name ‖ 'Home')}_${SAN(away...)}_${UTC yyyymmdd of scheduledAt ‖ today}.pdf`, `SAN` = `sanitizeSimple` (A-Z0-9, upper case, 20 chars). All three fallbacks fired, so in that window `match` had no game number, no short names, no `scheduledAt`, and `homeTeam` was not loaded. See 7.4 for the causes. | `App_Scoresheet.tsx:2408-2415`; `src/utils/stringUtils.js:73` |
| (e) valid PDF, exact place | jsPDF writes a valid one-page A3-landscape PDF holding one JPEG (no text layer). Where it lands depends on the platform (section 8). Desktop: `popups.rs` forces `~/Downloads/<name>` (or `<name> (n).pdf`) and tells the page the full path; the page shows it in a one-line `truncate` span (`max-w-[40ch]`) for 10 s, so a long path is cut off. No "open" / "show in folder". Android: written to `Documents/OpenVolley/scoresheets/<name>` (overwrites a same-named file), status only in the in-app view's top bar, no open / share. Web: browser download, no path known. | `App_Scoresheet.tsx:2370-2397,2486-2491,2708-2712`; `src-tauri/src/popups.rs:246-325`; `src/utils/openAppWindow.js:269-319` |
| The pasted text | `PDF saved to ...` + `Swiss Volley / Championship / ...` is the scoresheet window's text copied with select-all (the notice span, then the logo's `alt`, then the checkbox labels). It is not text from the PDF: the PDF is an image and has no text. | `App_Scoresheet.tsx:2708`; `Header.tsx:54` |

---

## 1. Entry points and routing

### 1.1 Who opens the sheet

| Caller | URL | Action | Code |
|---|---|---|---|
| MatchSetup "Scoresheet" | `/scoresheet/?matchId={id}` | preview | `src/components/MatchSetup.jsx:2647` |
| CoinToss | `/scoresheet/?matchId={id}` | preview | `src/components/CoinToss.jsx:1725` |
| Scoreboard menu: view / print / save | `/scoresheet/?matchId={id}[&action=print\|save]` | preview / print / save (print = save: both call `handleSavePdf`, nothing calls `window.print()`) | `src/components/Scoreboard.jsx:13024,13072,13120,13850` |
| MatchEnd "show scoresheet" | `/scoresheet/?matchId={id}[&action=…]` + `sessionStorage.scoresheetData` | preview / save | `src/components/MatchEnd.jsx:933-948` |
| MatchEnd "Approve" | `/scoresheet/?matchId={id}&action=getBlob` | getBlob (PDF goes back to MatchEnd) | `src/components/MatchEnd.jsx:1029-1035`, `src/utils/scoresheetPdfRequest.js` |
| Archive (scoresheets subdomain) | `ScoresheetApp.jsx` renders `App_Scoresheet` itself; links `?date=&game=` (View) and `?date=&game=&action=save` (Download PDF, new tab) | preview / save | `src/ScoresheetApp.jsx:300-350`, `src/scoresheet-main.jsx`, `scripts/build-subdomains.js:86` |
| Storage list inside `/scoresheet/` | `?list` or `/storage` path; "Download PDF" opens `?date=&game=&action=save` | save | `scoresheet_pdf/index_scoresheet.tsx:452-685` |
| Manual import | `/scoresheet/` with no data: upload a JSON file | any | `index_scoresheet.tsx:778-876` |

All `window.open`s go through `openAppWindow()` (`src/utils/openAppWindow.js`):
browser popup; desktop: `window.open`, turned into an app window labelled
`popup-<n>` by `src-tauri/src/popups.rs` (shares the web context, IndexedDB and
`window.opener`); Android: a full-screen same-origin iframe ("in-app view",
`showInAppView`) at `/scoresheet/index.html?...` (`capacitorPageUrl`).

### 1.2 Build entries

- `scoresheet/index.html` (build input `scoresheet`, `vite.config.js:315-322`) loads
  `/scoresheet_pdf/index_scoresheet.tsx`. Its `<title>` is `Openvolley Scoresheet`
  (misspelt; on desktop the window title follows the document title,
  `popups.rs:181-183`).
- `scoresheet_pdf/index_scoresheet.html` is NOT a build input (dev leftover with an
  `aistudiocdn.com` import map and `/index.css`); only `src/__tests__/brandAssets.test.js:27`
  reads it.
- Styles: `scoresheet_pdf/scoresheet.css` (full Tailwind with preflight, compiled).

### 1.3 Data source priority (`index_scoresheet.tsx:878-971`)

1. `?matchId=` -> `UrlMatchIdScoresheet` -> `LiveScoresheet` (Dexie live queries).
2. `?date=&game=` -> `StorageScoresheet` (backend storage JSON, own account only).
3. `?list` / `/storage` -> `ScoresheetList`.
4. `sessionStorage.scoresheetData` -> `LiveScoresheet` if it has `match.id`, else `StaticScoresheet`.
5. Nothing -> `ImportScoresheet`.

`?action=` (`preview|print|save|getBlob`, default preview) is read once at load
(`getActionFromUrl`, l. 221-230) and passed as `autoAction`.

---

## 2. Data sources

### 2.1 Dexie (`src/db/db.js`, schema v19)

`LiveScoresheet` (`index_scoresheet.tsx:233-356`) runs seven `useLiveQuery`s and
re-queries on `BroadcastChannel('escoresheet-updates')` messages
`MANUAL_ADJUSTMENT` / `DATA_CHANGED`:

| Query | Table / index | Feeds |
|---|---|---|
| `matches.get(matchId)` | `matches` | `match` (`{}` when not found) |
| `teams.get(match.homeTeamId / awayTeamId)` | `teams` | `homeTeam`, `awayTeam` (`null` until loaded) |
| `players.where('teamId')` | `players` | `homePlayers`, `awayPlayers` (`[]` while loading) |
| `sets.where('matchId').sortBy('index')` | `sets` | `sets` |
| `events.where('matchId').sortBy('seq')` | `events` | `events` |

`sanctions` is always `[]` (sanctions are read from `events`).

Load race: the sheet renders as soon as `match` resolves. Teams, players, sets
and events are dependent / parallel queries and may still be `undefined`
(rendered as empty). The `autoAction` timer (500 ms, `App_Scoresheet.tsx:2504-2524`)
does not wait for them and, being an effect with deps `[autoAction]`, calls the
`handleSavePdf` of the FIRST render: the file name is built from that render's
`match` / `homeTeam` (see 7.4). The DOM captured is the live one at capture time.

### 2.2 Match row fields the sheet reads

Written mainly by `MatchSetup.jsx` `saveDraft` (l. 1653-1830), CoinToss,
Scoreboard and MatchEnd; test matches by `App.jsx:2455-2480`; server matches by
`App.jsx:1794+` / `serverDataSync.js`.

| Field | Shape | Used for |
|---|---|---|
| `match_type_1` / `matchType` | `championship\|cup\|friendly\|tournament` | header checkboxes |
| `championshipType`, `championshipTypeOther` | `regional\|national\|international\|other` | header checkboxes + "other" field |
| `match_type_2` / `gender` | `men\|women` | header |
| `match_type_3` / `level`, `match_type_3_other` | `U23\|U19\|U17\|other` | header |
| `league` | string | header "League" |
| `gameNumber` (string), `game_n` (number), `externalId` | | header "Match No" (`gameNumber ‖ externalId`, NOT `game_n`), file name (`gameNumber ‖ externalId ‖ game_n`), storage path (`scoresheetGameId`: `gameNumber ‖ game_n ‖ externalId ‖ external_id`). Three different orders. |
| `homeShortName`, `awayShortName` | string (setup falls back to the first 8 letters of the name, upper case) | set boxes, results, roster headers, file name |
| `homeTeamId`, `awayTeamId` | Dexie ids | `teams` rows: `name` (header, winner, file-name fallback), `shortName`, `color`, `benchStaff` |
| `city`, `hall` | string | header |
| `scheduledAt` | UTC ISO | header date (UTC date, see 10.2) and time (local), match start fallback, file-name date (UTC) |
| `coinTossTeamA` (`home\|away`), `coinTossTeamB`, `coinTossServeA`, `coinTossServeB`, `firstServe` | | A/B mapping, S/R crosses, first server, "coin toss confirmed" |
| `set5LeftTeam` (`A\|B`), `set5FirstServe` (`A\|B`) | | deciding set panels |
| `bestOf` (3\|5) | | blank sets 3/4, "SET 3" label on the deciding set |
| `status` (`live\|ended\|final`) | | coin toss counted as confirmed |
| `officials[]` | `{ role: '1st referee'\|'2nd referee'\|'scorer'\|'assistant scorer', firstName, lastName, country, dob }`, line judges `{ role: 'line judge N', name }` (`MatchSetup.jsx:107-133`). Older rows may be the role-keyed object (`domain/officials.js officialsToArray`) or snake_case names. | APPROVAL, line judges |
| `bench_home`, `bench_away` | `[{ role: 'Coach'\|'Assistant Coach 1'\|'Assistant Coach 2'\|'Physiotherapist'\|'Medic', firstName, lastName, dob, license? }]` | roster BENCH OFFICIALS |
| `homeCaptainSignature`, `homeCoachSignature`, `away…` | data URL | roster signatures (pre-game) |
| `homePostGameCaptainSignature`, `away…` | data URL | APPROVAL captain signatures |
| `ref1Signature`, `ref2Signature`, `scorerSignature`, `asstScorerSignature` | data URL | APPROVAL signature column |
| `accountApprovals` `{ referee1, referee2, scorer }` | records | APPROVAL text stamp (`domain/accountApproval.js isApprovalValid / formatApprovalStamp`) |
| `remarks` | text (appended by Scoreboard via `domain/remarks.js appendRemark`) | REMARKS |

### 2.3 Players (`players` table) -> `formatPlayers` (`App_Scoresheet.tsx:58-71`)

`{ number, name: p.name ‖ "lastName firstName", firstName, lastName, dob, libero, isCaptain, isLfp ‖ is_lfp, license, role }`.
`dob` is printed as stored: test seeds use `DD/MM/YYYY` (`src/constants/testSeeds.js`),
setup uses `DD.MM.YYYY`, sync uses ISO. No normalisation anywhere on the sheet.

### 2.4 Sets and events

- `sets`: `{ index 1..5 (deciding set always 5), homePoints, awayPoints, finished, startTime, endTime }`.
- `events` (sorted by `seq`, `ts` only when `seq` is missing, `scoresheetModel.compareEventsBySeq`):
  - `point` `{ team }`
  - `lineup` `{ team, lineup: { I..VI }, isInitial }` (one per rotation / sub / libero swap)
  - `substitution` `{ team, playerOut, playerIn, position: 'I'..'VI', isExceptional }`
  - `timeout` `{ team }`
  - `sanction` `{ type: improper_request|delay_warning|delay_penalty|warning|penalty|expulsion|disqualification, team, playerNumber | role | playerType }`
  - libero events (read only by `utils/extractLiberoData.ts` for the LCS view)

### 2.5 Other sources

- Backend storage JSON (`StorageScoresheet`, `ScoresheetApp`): `{ match, homeTeam, awayTeam, homePlayers, awayPlayers, sets, events, uploadedAt }` written by `src/utils/scoresheetUploader.js` (in-match and `_final` after approval). The cloud backend is currently down (Supabase exit), so this path only works against the self-hosted backend.
- `sessionStorage.scoresheetData` (MatchEnd): same shape, but `LiveScoresheet` re-reads Dexie by `match.id`.
- Imported JSON file: same shape.

---

## 3. Sheet layout (component tree)

Container: `div.scoresheet-container` `410mm x 287mm`, `p-3`, inner padding
`4mm 7mm 6mm 5mm` (`App_Scoresheet.tsx:2767-2778`). Zoom is a CSS transform
(reset to 1 for capture). Order on the page:

```
Header (Header.tsx)                                         <- logos, match type, teams, place, date
Row 1: LeftInfoBox(set1) | SET 1 StandardSet | SET 2 StandardSet | [97px grey box "eScoresheet / Openvolley"]
Row 2: LeftInfoBox(set3) | SET 3 StandardSet | SET 4 StandardSet | [97px  <img src="/ball.png">]
Row 3-4 (left 290mm):  LeftInfoBox(set5) | SET 5 SetFive (3 panels + court change strip)
                       Sanctions (50mm) | Remarks (3/8) over Approvals (5/8) | Results
        (right 110mm): Roster HOME (A or B) | Roster AWAY
```

`LiberoControlSheet` is a separate view (toggle button, only when there is libero
activity). It replaces the sheet on screen (`display:none` on the container); it
is never captured into the PDF.

---

## 4. Field map

`L/R` = left / right half of a set box. Team A/B = coin-toss labels
(`teamAKey = match.coinTossTeamA ‖ 'home'`). Sets 1 and 3: A left; sets 2 and 4:
B left (`isSwapped`); set 5: `getSet5LeftTeamLabel(match)` (default B).

### 4.1 Header (`components/Header.tsx`)

| Box | Value | Source |
|---|---|---|
| Left slot (`min-w-[120px]`) | Swiss Volley logo 40 px (web, desktop); empty (Android) | `swissvolleylogo.jpg` / alias |
| Championship / Cup / Friendly / Tournament | `X` | `match_type_1 ‖ matchType` |
| Regional / National / International / other + text | `X`, text | `championshipType`, `championshipTypeOther` (an `<input disabled>` styled by `OTHER_FIELD_STYLE`) |
| Men / Women, U23 / U19 / U17 / other + text | `X`, text | `match_type_2 ‖ gender`, `match_type_3 ‖ level`, `match_type_3_other` |
| League | upper case | `league` |
| Match No | | `gameNumber ‖ externalId` |
| Right slot | `/openvolley_logo.png` 24 px high; on load error the text `FIVB` (!) | public file |
| A/B circles | after coin toss | `coinTossTeamA` |
| Team names (TEAMS VS) | full name, upper case | `homeTeam.name`, `awayTeam.name` (home always left) |
| City/Country, Hall/Gym | | `city`, `hall` |
| Date | `DD/MM/YYYY` of the UTC date | `scheduledAt` (see 10.2) |
| Time | local `HH:MM` | `formatTimeLocal(scheduledAt)` |

Official Matchblatt (`sv-ref/img/hdr_left.png`, `hdr_right.png`): Swiss Volley logo
left, FIVB logo right, trilingual labels. Our labels are English only.

### 4.2 Left info box (`components/LeftInfoBox.tsx`)

Static row labels only ("Rotation", "Starting line up", "Substitutions",
"Player N.", "Score", "Service Rounds" 1-8 or 1-6). Props `lineup / subs /
serviceRounds` are passed but unused.

### 4.3 Sets 1-4 (`components/StandardSet.tsx`, `PointsColumn.tsx`; data `getSetData`, `App_Scoresheet.tsx:124-1167`)

| Box | Value | Source / rule |
|---|---|---|
| Start / End | local `HH:MM` | `sets.startTime` (only once the set has points or a start time), `sets.endTime` |
| A/B circle | position | `isSwapped` |
| S/R cross | from `match.coinTossServeA` only, alternating by set parity | `StandardSet.tsx:308-330`. (The service tracker uses `getFirstServeTeamKey`, which also falls back to `match.firstServe`: with `coinTossServeA` missing the crosses stay blank while the boxes are filled.) |
| Team short name | when the set is "open": set 1 after coin toss, set n after set n-1 finished, set 4 only if both teams won a set, sets 3/4 never in best-of-3 | `homeShortName / awayShortName` |
| Roman header I-VI | static | |
| Starting players | lineup before the first point (`getStartingLineup`, FIVB 7.3.4 rectification aware) | `lineup` events |
| Substitution cell (per column) | `playerIn` of the first sub of that starter (circled when the starter came back) | `substitution` events, grouped by starter (`assignSubsToColumns`); exceptional subs skipped (said to go to remarks) |
| Sub scores (2 cells) | `subTeam:other` at the sub; second cell = the return sub | |
| Service boxes 1-8 per column | tick when that position served, team score when service was lost, circle on the last service at set end, `X` in box 1 of position I for the receiving team | replay of `point` events (`ServiceRound {position, box, ticked, points, circled}`) |
| Points 1-32 (expands to 48/64/80/96) | slash = scored; circle only (no slash) = point from a `penalty` / `delay_penalty` (next opponent point after the sanction); vertical "T" through unused numbers once `sets.finished` | `point` + `sanction` events, `finalScore` |
| "T" (timeouts) x2 | `requesting:other` at the timeout | `timeout` events |

### 4.4 Set 5 (`components/SetFive.tsx`; data `App_Scoresheet.tsx:1211-2249`)

Three panels: 1 = left team before the change (points 1-8), 2 = right team
(1-32+), 3 = left team after the change (numbers up to the score at the change
shown plain, later ones ticked). Court change at the first team to reach 8.
"Points at change" `leftScore:rightScore`. Left-team timeouts / subs split
before / after the change; panel 3 shows all of them. Shown only when
`set5LeftTeam ‖ set5FirstServe` is set or set 5 has started. Label "SET 3" in
best-of-3.

### 4.5 Results (`FooterSection.tsx` `Results`, data `calculateSetResults` l. 1232-1337)

Per finished set and team: T (timeouts), S (regular subs, `countRegularSubstitutions`),
W (1/0), P (points); set duration `endTime - startTime` (fallback: first event
`ts`) in minutes `25'`; totals; Match Start (set 1 `startTime`, else
`scheduledAt`), Match End (latest `endTime`), Match Duration; WINNER (full team
name) and RESULT `3:1` only once a team has 3 (2 in best-of-3) sets.

### 4.6 Sanctions and Remarks

- `processSanctions` (l. 1342-1454): `improper_request` -> `X` in the A/B circle;
  `delay_warning|delay_penalty` -> `D` in W / P; misconduct -> player number or
  role initial (`C AC1 AC2 P M`) in W / P / E / D; team A/B; set (`displaySetNumber`);
  score `sanctioned:other` (`getScoreBeforeEvent`). 10 rows; the rest go to REMARKS
  as text ("Sanctions (overflow)").
- REMARKS: `match.remarks` (pre-wrap) + overflow sanctions.

### 4.7 APPROVAL (`FooterSection.tsx` `Approvals`, l. 421-629)

| Column (width) | Value | Source |
|---|---|---|
| Official (`w-20`) | `1st Referee`, `2nd Referee`, `Scorer`, `Assistant Scorer` | static |
| Name (`w-28`) | `lastName firstName` | `match.officials[]` matched by role (case-insensitive; reads camelCase names only) |
| Country (`w-16`) | | `official.country` |
| **Lic. (`w-16`)** | **always empty** | `official.license` (never written). Target: **DoB**, `DD.MM.YYYY` from `official.dob`, empty for the `01.01.1900` placeholder (`src/utils/remoteRoster.js:116-121` has the placeholder check). Header cell l. 497, body cell l. 519-521. Same width keeps the columns aligned. |
| Signature (flex) | drawn signature image, else account-approval stamp (6 px text), else empty | `ref1Signature…`, `accountApprovals` |
| Line Judges 1-4 | `lastName firstName` (reorders "First Last") | officials `line judge N` `.name` |
| Captain signature A / B | post-game signatures | `home/awayPostGameCaptainSignature` |

### 4.8 Rosters (`FooterSection.tsx` `Roster`, l. 631-872)

Home always on the left, away on the right; header = short name + A/B circle.
Columns `DoB (44px) | No (20px) | Lic. (40px) | Name`: 14 player rows
(captain number circled, `LFP` tag), LIBERO (first 2 liberos by number),
BENCH OFFICIALS `C AC1 AC2 P M` (from `bench_home/away`), Captain and Coach
signatures (pre-game; clicking an empty one opens `SignatureModal`, which only
lives in this page's state and is lost on reload). DoB printed raw. The course
(p. 9) shows the official roster as `DoB | No | Name` ("It says Licence n. but
actually it is DoB"), names as "Last name, First initial." (`Meier, S.`); ours
prints the full name in upper case and adds a licence column.

### 4.9 Right-hand column of rows 1-2

- Row 1: grey 97 px box, vertical text `eScoresheet` / `Openvolley` (l. 2839-2850).
- Row 2: `<img src="/ball.png" alt="OpenVolley">` 97 x 97 (l. 2919-2939). This is
  where the owner saw the old green ball (right of SET 4).

---

## 5. Derivation logic and suspected defects

Everything below is in `App_Scoresheet.tsx` (one 3100-line component); only
small parts are in `utils/scoresheetModel.ts` (tested). `console.log` debug
output runs for every finished set on every render (l. 429-443, 624-637).

| # | Suspected defect | Where |
|---|---|---|
| D1 | Set 5, right team wins: the losing left team's last box is chosen by `set5LeftTeamTotalScore <= 8` (its own score), while every other branch uses the court-change flag. If the change happened because the right team reached 8 while the left had fewer points, the circle goes to panel 1 instead of panel 3. | l. 2201 |
| D2 | Set 5 "won on receive" fallbacks compute the next box without the "position I skips box 1 (X)" correction used in sets 1-4. | l. 2110-2129, 2145-2153, 2188-2196 |
| D3 | Sets 1-4 and set 5 are two copies of the same service-tracking algorithm (~900 lines); they have drifted (D1, D2). A single pure, tested function per panel would remove both. | l. 124-1167, 1684-2249 |
| D4 | Sanction-point circling duplicates `domain/sanctions.awardsPoint`. | l. 681, 1595 |
| D5 | S/R crosses use `coinTossServeA` only; the trackers also accept `firstServe`. | `StandardSet.tsx:313`, `scoresheetModel.ts:152-169` |
| D6 | `officials.find` / `benchStaff.find` crash (error boundary) when `match.officials` is the old role-keyed object or `bench_home` is `null` (defaults only cover `undefined`); snake_case official names print empty. Use `domain/officials.officialsToArray`. | `App_Scoresheet.tsx:3038-3041`, `FooterSection.tsx:481-486,790` |
| D7 | `formatPlayers(undefined)` crashes for a JSON without `homePlayers`. | l. 58, 3072 |
| D8 | Dates of birth printed raw (three formats in the data); header date `DD/MM/YYYY` from the UTC day. | `FooterSection.tsx:740,767,795`; `Header.tsx:41-42,290-298` |
| D9 | Exceptional substitutions are "handled in remarks" only if Scoreboard appended a remark; the sheet itself never writes them. To verify. | l. 840-841 |
| D10 | Header logo error fallback prints `FIVB`. | `Header.tsx:239-241` |

---

## 6. Capture and PDF pipeline (`handleSavePdf`, `App_Scoresheet.tsx:2399-2501`)

1. Guard: `containerRef` set and no capture running. (With the LCS view open the
   container is `display:none`: the capture is of a hidden element.)
2. File name (7.4), computed from the closure's `match` / `homeTeam`.
3. `setZoomLevel(1)`, wait 200 ms, `document.fonts.ready`.
4. Lazy `import('html-to-image')` (1.11.13) and `import('jspdf')` (4.2.1); chunk `pdf-vendor`.
5. `htmlToImage.toCanvas(sheet, { pixelRatio: 2, backgroundColor: '#fff', style: { transform: 'none' }, includeStyleProperties })`.
   - Not WebKitGTK: all computed properties; on failure retry with `usedStyleProperties`.
   - WebKitGTK (Linux desktop, `isWebKitGtk()`): `usedStyleProperties(sheet)` only
     (the full clone is an ~87 MB data URL, WebKitGTK refuses >64 MB); every
     loaded same-origin `<img>` is hidden during the capture and drawn onto the
     canvas afterwards from the page's own element (`drawableImages`,
     `hideImages`, `drawImagesOnto` with step-halving downscale). See
     `utils/pdfCapture.ts` (tested in `utils/__tests__/pdfCapture.test.ts`).
   - html-to-image fetches `<img>` URLs again to inline them: it gets whatever
     the HTTP cache / service worker returns for `/ball.png`.
6. Restore zoom; `canvas.toDataURL('image/jpeg', 0.85)` (~3100 x 2170 px).
7. `new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a3', compress: true })`,
   `addImage(…, 0, 0, 420, 297, undefined, 'FAST')`: the 410 x 287 mm sheet is
   stretched to 420 x 297 (x 1.024, y 1.035: not to scale, slightly distorted);
   no `setProperties` (Producer `jsPDF 4.2.1`, no Title / Author / Subject /
   Creator); image only, no text layer.
8. Output:
   - `returnBlob` (getBlob): `{ blob, filename }` -> `deliverPdfToOpener`.
   - Android in-app view: `savePdfThroughApp(blob, filename)` posts it to the app.
   - otherwise `pdf.save(filename)` (blob download) and `pendingDownload = filename`.
9. Errors: notice `scoresheetPdf.pdfFailed` (not for getBlob, which posts
   `pdfBlobFailed`).

`autoAction` (l. 2503-2524): 500 ms after mount + `fonts.ready`, `print|save`
-> `handleSavePdf()`; `getBlob` -> `handleSavePdf(true)` then
`deliverPdfToOpener(result)` which posts `pdfBlob { arrayBuffer, filename }` or
`pdfBlobFailed` and closes the window / in-app view.

`@media print` CSS (l. 2715-2736, `scoresheet/index.html`) still exists for a
browser print, which no button triggers.

---

## 7. File name

### 7.1 Today

```
const matchNum  = match?.gameNumber || match?.externalId || match?.game_n?.toString() || 'match';
const homeShort = match?.homeShortName || homeTeam?.name || 'Home';
const awayShort = match?.awayShortName || awayTeam?.name || 'Away';
const date      = (scheduledAt ? new Date(scheduledAt) : new Date()).toISOString().slice(0,10).replace(/-/g,'');
filename = `${matchNum}_${sanitizeSimple(homeShort, 20)}_${sanitizeSimple(awayShort, 20)}_${date}.pdf`;
```

`matchNum` is not sanitised (an `externalId` with `/` or spaces goes into the
name as is; `popups.rs` / browsers then mangle it). The date is the UTC day.

### 7.2 Other names for the same match

- MatchEnd ZIP: `Match_{home name}_vs_{away name}_{DD-MM-YYYY}.zip` (`sanitizeForFilename`), containing `MatchData_…json`, the PDF (its own name above), `interaction_logs_{date}.ndjson` (`MatchEnd.jsx:1014-1067`).
- Storage: `{UTC date}/game{n}_{key}[_final].{json|pdf}` (`scoresheetStorage.ts`).
- Android: `safeName` replaces `\/:*?"<>|` and cuts at 120 chars (`openAppWindow.js:285`).

### 7.3 Tests that use the current pattern

`src/utils/__tests__/openAppWindow.test.js:230-237,368-377` (`7_HOME_AWAY_20261006.pdf`).

### 7.4 Why the owner got `match_HOME_AWAY_20261007`

All three fallbacks fired, so the closure that built the name had a `match`
without `gameNumber/externalId/game_n/homeShortName/awayShortName/scheduledAt`
and no `homeTeam` / `awayTeam`. Candidates, to confirm on the desktop build:

- H1: the window's `matches.get(matchId)` returned nothing, so `LiveScoresheet`
  rendered `match = {}` (an empty sheet). Then the date is "today" (it was).
- H2: an `action=save` / `getBlob` window: the name comes from the first
  render's closure (stale), before the team rows loaded, and the match has no
  short names / game number (e.g. a quick match never saved through setup).
- H3: the short names really are `HOME` / `AWAY`: setup's fallback is the
  first 8 letters of the typed name in upper case (`MatchSetup.jsx:1735-1736`),
  so a team typed as "Home" gives `HOME`; `testSeeds.js:124-130` falls back to
  `HOME` / `AWAY` too.

Robust fix direction: build the name at click time from the latest data (a
ref), wait for all live queries before an automatic action, fall back to full
team names and to the match id / seed key, sanitise every part, use the local
match date.

---

## 8. Where the PDF goes (per platform)

### 8.1 Web (browser, LAN tablets)

`pdf.save(filename)` -> blob download; the browser chooses the folder; the page
cannot know the path. No message is shown on success (`ov-download-finished`
never fires).

### 8.2 Desktop (Tauri; `src-tauri/src/popups.rs`, `main.rs:145-146`)

- The main window loads `http://localhost:5173/` from the built-in server
  (`relay.rs`, embedded `dist/`); scoresheet windows are `popup-<n>` app windows.
- `on_download` `Requested`: destination forced to the Downloads folder
  (`downloads_dir`: XDG / known folder, else `~/Downloads`, else home) under a
  free name (`free_path`: `name (1).pdf`, ...). `Finished`: evaluates
  `ov-download-finished { path, fileName, success }` in every window (Linux:
  the handler is on the shared web context, so all windows hear all downloads;
  Windows: per webview, `build_popup` registers it on popups too).
- The page keeps only its own download (`isOwnDownload`, matches `name (n).ext`)
  and shows `PDF saved to {path}` for 10 s in a `truncate max-w-[40ch]` span
  (full text only in the `title` tooltip).
- Popup windows have NO Tauri commands (capabilities list `windows: ["main"]`
  only; `main.rs ipc_acl_tests`). An "Open file" / "Show in folder" action from
  the scoresheet window needs either a new capability for `popup-*` with two
  narrow commands that accept only an id of a download recorded by
  `on_download` (never a page-supplied path), or a postMessage hop to the main
  window. Existing helper to copy: `backup.rs file_manager_command`
  (`explorer` / `xdg-open`, one argument, spawn and reap). "Show in folder":
  `explorer /select,<path>` on Windows; on Linux open the parent folder (or the
  FileManager1 D-Bus `ShowItems`).
- The match-end ZIP (main window) also goes to Downloads via the same handler;
  MatchEnd shows no path for it.

### 8.3 Android (Capacitor in-app view)

- `savePdfThroughApp` (`appWindowGuest.js:33-38`) posts
  `ov-app-window:save-pdf { arrayBuffer, filename }` to the app page.
- `savePdf` / `writePdfNative` (`openAppWindow.js:292-319`):
  `@capacitor/filesystem` `writeFile` base64 to `Documents/OpenVolley/scoresheets/<safeName>`
  (recursive), else `External` (`Android/data/com.openvolley.escoresheet/files/OpenVolley/scoresheets/`).
  Same name overwrites. Status text in the in-app view bar (`role=status`), not in
  the scoresheet's own notice. No open / share (no plugin for it in
  `package.json`; adding one must keep the F-Droid build free of proprietary
  dependencies).
- getBlob on Android: the PDF is posted to MatchEnd (same as other platforms).

### 8.4 Match-end approval (all platforms; `MatchEnd.jsx:1029-1110`)

`waitForScoresheetPdf` (30 s timeout) -> `{ blob, filename }`; added to the ZIP;
for non-test matches uploaded to storage `scoresheets/{date}/game{n}_{key}.pdf`
(`scoresheetUploadPath(match, { ext: 'pdf' })`, `upsert`), and the `_final.json`
via `uploadScoresheet`; ZIP downloaded with an anchor click. A PDF failure does
not block approval (warning toast).

---

## 9. Archive and uploads

- Upload: in-match JSON (`uploadScoresheet`, final=false, from the scorer app),
  final JSON + PDF at approval (8.4). Owner-only read (`backend/lib/storage.js`).
- `ScoresheetApp.jsx` (scoresheets subdomain): lists the account's matches; "View"
  renders the `_final.json` through `App_Scoresheet`; "Download PDF" re-renders
  and re-captures in a new tab (`action=save`); the uploaded PDF itself is never
  offered. Header uses `BRAND.mark` (SVG, Vite-hashed).
- `/scoresheet/?list`: older list inside the scoresheet page (same storage).
- `MatchHistory.jsx` links to `finalScoresheetUrl(match)`.

---

## 10. Assets and brand strings

### 10.1 Images on the sheet / in the PDF

| Asset | File | Referenced as | Where | Platforms | Caching |
|---|---|---|---|---|---|
| Swiss Volley logo | `scoresheet_pdf/components/swissvolleylogo.jpg` (327x154) | `import` (hashed `/assets/…jpg`) | header left, 40 px | web, desktop; Android: `noFederationLogo.js` (null) via `vite.config.js:79-86` | hashed: safe |
| OpenVolley lockup | `public/openvolley_logo.png` (1024 wide, from `brand/lockup.svg`) | string `'/openvolley_logo.png'` | header right, 24 px | all | unhashed: stale-prone |
| Ball (new flat, "ball A") | `public/ball.png` (1024, from `brand/ball.svg`, white disc) | `<img src="/ball.png">` | right of SET 4, 97 px | all | unhashed: stale-prone |
| Signatures | data URLs in the match row | `<img src=data:…>` | roster, approval | all | n/a |
| SVG marks (circles, ticks, X, T) | inline `<svg>` | | sets, rosters | all | n/a |

Not on the sheet: `src/ball_fallback.png` (serve indicator on app screens),
favicons / apple-touch (page head), `brand/*.svg` via `src/brand.js` (archive
header, home, manager).

Brand sources: `brand/README.md` (lockup = ball + "OpenVolley" outlined Inter
Display Bold; `ball.svg` is the small-size cut "for the scoresheet PDF ball";
`make-brand-assets.py` renders the PNGs). The old green 3D ball is
`git show 7f4a9af4^:escoresheet/frontend/public/ball.png` (1.5 MB); it is not in
the tree any more.

### 10.2 Why an old ball can still appear

1. `relay.rs try_file` (l. 1247-1261): `public, max-age=31536000` for every
   non-`.html/.json/sw.js/.webmanifest` file, including the unhashed
   `/ball.png`, `/openvolley_logo.png`, `/favicon.ico`. The desktop webview's
   HTTP cache keeps the pre-2.3.0 file for a year. Only `/assets/*` is
   content-hashed.
2. Service worker (`registerType: 'prompt'`, `skipWaiting: false`): until the
   scorer accepts the update the old worker serves its precache (old
   `ball.png`); `runtimeCaching` `static-assets` is `CacheFirst` for
   `*.png|jpg|svg` (30 days).
3. A desktop install older than 2.3.0 (check the version in the app).

Durable fix: import the sheet's images through Vite (hashed URLs, like
`swissvolleylogo.jpg` and `src/brand.js`), so a new build always means a new
URL; optionally make the relay send `no-cache` for non-hashed paths.

### 10.3 Brand / federation text in the generated sheet and PDF

| Text | Where |
|---|---|
| `alt="Swiss Volley"` | `Header.tsx:54` (in copied text, not in the PDF) |
| `eScoresheet` / `Openvolley` (vertical) | `App_Scoresheet.tsx:2849` |
| `<title>Openvolley Scoresheet</title>` | `scoresheet/index.html:12` (desktop window title) |
| `FIVB` (logo fallback) | `Header.tsx:240` |
| PDF metadata | none set (Producer `jsPDF 4.2.1`) |
| Comments only | `Header.tsx:49`, `FooterSection.tsx:286,697`, `scoresheetModel.ts:113`, `vite.config.js:79` |

Elsewhere (not the sheet; renaming has side effects): `productName` "Openvolley
eScoresheet" in `src-tauri/tauri.conf.json` and `package.json` (install folder,
firewall rule `firewall.rs:283-392`, update asset names), and the
referee / bench / livescore page titles.

The official sheet's federation red (`#e2001a`) is also the OpenVolley brand
red; it is a colour, not a federation mark.

---

## 11. Tests and harnesses

- Unit: `scoresheet_pdf/__tests__/{App_Scoresheet,Header,ApprovalsStamp}.test.tsx`,
  `scoresheet_pdf/utils/__tests__/{scoresheetModel,pdfCapture,extractLiberoData,scoresheetStorage}.test.ts`,
  `src/utils/__tests__/openAppWindow.test.js` (in-app view, Android save,
  `isOwnDownload`, `deliverPdfToOpener`), `src/__tests__/brandAssets.test.js`
  (page heads, old green files gone), `src-tauri` `popups.rs` tests
  (`downloads_dir`, `free_path`, script escaping).
- No test covers: the file name, the header logos, `getSetData` service
  tracking end to end, set 5 panels, the APPROVAL columns, PDF validity.
- Earlier harnesses: `/tmp/claude-1000/ov-work/apps/scoresheet-windows`
  (desktop scoresheet window + Save PDF screenshots), `connect-modes/pw`
  (Playwright: `e2e.mjs`, `approval-shots.mjs`, `obfix-*.mjs`),
  `android*/verify-android` (emulator), `logo-a` (brand). Fixtures:
  `src/constants/testSeeds.js` (teams with `DD/MM/YYYY` DoBs, referee DoBs ISO).

---

## 12. Reference notes (Swiss Volley material in `~/.cache/openvolley/sv-ref/`)

- `matchblatt.pdf`: one page A3 (rotated), no form fields readable by pypdf;
  crops in `img/` (`hdr_left`, `hdr_right`, `appr`, `result`, `sanct`, ...).
  Approval columns: Land / Lizenz-Nr. / Unterschrift; line judges 1-4; captains A / B.
- `course.pdf` / `course.txt` (2025): roster and officials' "Licence n." column
  holds the date of birth (p. 9-10, e.g. `Kanagalingam, T. CHE 07.02.1999`);
  names "Last name, First initial."; at set end: close the winner's service,
  circle the final points in the service box only (never in the points box),
  strike the unused points with a vertical "T" (p. 39); the team that received
  first and wins has its circled point one service box further (p. 40);
  penalty and delay-penalty points are circled, not ticked (`course.txt` lines 1341, 1368).
