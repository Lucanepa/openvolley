# Scoresheet field spec (indoor, Swiss Matchblatt layout)

Status: reference for the `scoresheet_pdf` rewrite (branch `feat/scoresheet-pdf`).
Date: 2026-10-07.

This file lists every area of the official paper scoresheet and how each one is filled in:
what gets written, ticked, circled or crossed, when, and in which format. It also covers the
special cases. The printed OpenVolley sheet must give a referee the same information as a
correctly hand-filled Matchblatt, with the same marks in the same places.

Sources (read in full for this spec):

- **MB**: the official blank Swiss Volley Matchblatt, A3 landscape, one page (a scanned image
  with an empty AcroForm, so it has no form fields). Local copy: `~/.cache/openvolley/sv-ref/matchblatt.pdf`.
- **SC**: the Swiss Volley Scorekeeper Course 2025, English, 91 slides (KS Wiedikon, 19.8.2025).
  Local copy: `~/.cache/openvolley/sv-ref/course.pdf`. Slide numbers are given as `SC p.N`.
- **FIVB**: the FIVB Official Volleyball Rules 2025-2028, quoted by SC p.33, 38 and 63. This
  source is used only where SC is silent. Those places are marked "(FIVB)".
- Rules that OpenVolley decides itself (things paper cannot show, data formats, branding) are
  marked **OV decision**.

Notation:

- `/` means a tick: a short diagonal stroke over a printed number.
- `X` means a cross.
- `( )` means a circle drawn around something.
- `T` means a vertical stroke with a bar on top, drawn through the printed numbers that were
  not used.
- `⊥` means a reverse T: a vertical stroke with a bar at the bottom.
- A score written `a:b` always puts **the concerned team's points first**. The concerned team is
  the team that asked for the time-out or substitution, or the team that was sanctioned or is
  named in a remark (SC p.46, 51, 55, 69).

---

## 1. Sheet anatomy

The sheet is A3 landscape. Its areas, from top to bottom:

| Area | Position | Section |
|---|---|---|
| Logo (federation) | top left | 2.1 |
| Competition category boxes, league designation, match no. | top centre | 2.2 |
| Second logo (FIVB on paper) | top right | 2.1 |
| Teams line (home : away with A/B circles), place, hall, date, time | under the header | 2.3 |
| Set 1 (left half) and Set 2 (right half) | row 1 | 4 |
| Set 3 (left half) and Set 4 (right half) | row 2 | 4 |
| Set 5 (tie-break, three panels) | row 3, left two thirds | 6 |
| Rosters, Team panel left = HOME, right = AWAY | row 3 to bottom, right third | 3 |
| Sanctions, with the improper-request box | bottom left | 7 |
| Remarks (4 lines) | bottom centre, top part | 8 |
| Approval (officials and signatures) | bottom centre, lower part | 10 |
| Final result, with start/end/duration and the winner | bottom centre-right | 9 |
| Vertical side text (copyright notice) | right margin | 2.1 |

Each set grid has a left legend column with these labels: "Aufgabenfolge" (service order),
"Startaufstellung" (starting line-up), "Spielerauswechslung / Nr. Spieler" (substitution, player
no.), "Spielstand" (score), and "Aufschlagrunde 1.-8." (service rounds; 1.-6. in set 5).

---

## 2. Header

### 2.1 Branding

- On paper: the Swiss Volley logo is top left and the FIVB logo is top right. The right margin
  carries the vertical text "Copyright Swiss Volley ... Nachdruck verboten".
- **OV decision.** The generated sheet and its PDF must contain **no Swiss Volley name or logo**.
  This covers the visible text, the text layer, the PDF metadata (Title, Subject, Author,
  Creator, Producer, Keywords) and the alt text.
  - The top-left logo is the **OpenVolley logo** (logo A, from `frontend/brand/`, `lockup.svg`
    or `mark.svg`). The same logo is used on every platform (web, desktop, Android), so the
    `noFederationLogo.js` special case for Android goes away.
  - The top right must **not repeat the OpenVolley logo**. To balance the header, put the match
    identity block there (game no., date, league), or put nothing there.
  - If a vertical side banner is kept, it reads exactly `OpenVolley eScoresheet` (capital O,
    capital V) and must not duplicate the top-left logo.
  - Ball graphics anywhere on the sheet use the **new flat ball A** (`frontend/brand/ball.svg`).
    The old green 3D ball must not appear anywhere: not in the set grids, the serve indicators
    or the PDF.

### 2.2 Category boxes

Each category is a square. The one that applies is marked with `X` (SC p.9). Choose exactly
one box per group, or leave the group empty if the data is not known.

| Group | Boxes on MB | Data |
|---|---|---|
| Competition | Meisterschaft (Championship), Cup, Freundschaftsspiel (Friendly), Turnier (Tournament) | `match.matchType` / `match_type_1` |
| Level | National, Regional, International, plus a blank "......" box for anything else | `match.championshipType`, with `championshipTypeOther` written on the dotted line |
| Gender / age | Männer (Men), Frauen (Women), U23, U19, U17, plus a blank "......" box | `match.gender` / `match_type_2`, and the age class |

Two more fields sit here:

- **League designation** ("Bezeichnung der Liga"): free text, for example `2 Liga`.
- **Match no.** ("Spiel Nr."): the official game number, for example `382208`.

### 2.3 Teams line and venue

- **Teams line**: `(A|B) HOME_NAME : AWAY_NAME (A|B)`.
  - The left name is **always the home team** and the right name is **always the away team**
    (SC p.9).
  - Each circle gets the letter that team drew in the coin toss (SC p.15).
  - Full team names are written here. Short names are allowed in the rosters, the set grids and
    the result table (SC p.15).
- **Ort** (city), **Halle** (hall).
- **Datum**: `DD.MM.YYYY`.
- **Zeit**: the **scheduled** start time, `HH:MM`, 24-hour clock.

---

## 3. Team rosters (right third, "Mannschaften/Equipes/Squadre")

There are two panels. The left panel is HOME and the right panel is AWAY (SC p.10). Each panel
contains:

1. **Panel header**: a circle with the letter A or B, and the team name (short name allowed).
2. **14 player rows** with three columns:
   - "Lizenz-Nr." column, which is **actually filled with the date of birth**. SC p.10 and p.11
     say explicitly: "It says Licence n. but actually it is DoB". Format `DD.MM.YYYY`.
     **OV decision:** the column header prints `DoB`.
   - "Spieler Nr.": the shirt number.
   - "Name": `Lastname, F.` (last name, comma, first initial with a full stop, SC p.10).

   Order rows by shirt number when possible (recommended, not mandatory). The **team captain's
   number is circled** (SC p.10). Liberos also appear in these 14 rows.
3. **LIBEROS («L»)**: 2 rows, with the same three columns. **A libero is written twice**: once in
   the general roster and once here (SC p.10).
4. **Officials (Offizielle)**: 5 rows labelled `C` (coach), `AC1`, `AC2` (assistant coaches),
   `P` (physio) and `M` (medical doctor). Each row has the DoB to the left of the label and the
   name to the right.
5. **Signatures ("Unterschrift")**: Kapitän (captain) and Trainer (coach). These are the
   **pre-match** signatures, given right after the coin toss (SC p.14).

Marks:

- **Empty rows or cells**: once both pre-match signatures are in, every unused part of the
  roster is struck off. Use a single line for one empty row and a "Z" for several (SC p.18).
  This applies to player rows, libero rows and official rows.
  - **OV decision:** print one horizontal stroke through a single empty row, and a Z across
    a block of empty rows.
- **Absent players**: a player who is not present at T-3 is struck through with a horizontal
  line across the whole row, including the libero row if they are a libero (SC p.25).
  - Data source: a player flagged absent or not checked in.
  - If the app has no such flag, nothing is struck through.

---

## 4. Set grid, sets 1 to 4

### 4.1 Which team is on which side

| Set | Left block | Right block |
|---|---|---|
| 1 | Team A | Team B |
| 2 | Team B | Team A |
| 3 | Team A | Team B |
| 4 | Team B | Team A |

Teams change sides after every set except between set 4 and set 5 (SC p.20, 42). The order is
pre-printed on MB as the A/B letters in the block headers.

### 4.2 Block header (one per team)

- **Mannschaft (team)**: the short team name, next to the pre-printed big letter A or B.
- **(S) / (R) circles**: put `X` on **S** for the team that serves first and `X` on **R** for
  the team that receives first (SC p.16).
- **Beginn (start)**: this field exists **only on the left block**. It holds the set start time,
  `HH:MM`.
- **Ende (end)**: this field exists **only on the right block**. It holds the set end time,
  `HH:MM`, which is the time of the last rally (SC p.39).

**Which team serves first in each set** (FIVB 7.1, SC p.42):

- Set 1: the coin-toss server.
- Sets 2 and 4: the team that received first in set 1.
- Set 3: the same team as set 1.
- Set 5: decided by a new coin toss.

### 4.3 Rows inside a team block

Each team block has six columns, one per position I to VI.

| Row | Content |
|---|---|
| Aufgabenfolge (service order) | Pre-printed `I II III IV V VI`. Nothing is written here. |
| Startaufstellung (starting line-up) | The shirt numbers from the line-up sheet, positions I to VI. Position I is the first server. Write them large, one per column (SC p.24). |
| Nr. Spieler (substitute no.) | The number of the substitute who entered **in this starting player's column** (SC p.51). |
| Spielstand 1 | The score `subTeam:opp` when the substitute entered (SC p.51). |
| Spielstand 2 | The score `subTeam:opp` when the starting player came back (SC p.52). |
| Aufschlagrunde (service rounds) | 8 boxes per position: 4 rows × 2 sub-columns, with small round numbers 1-4 on the left and 5-8 on the right (MB). |

Substitution rules for these rows:

- **Columns follow the starting line-up, not the current court position.** A substitution for
  starting player #9, who started at VI, goes under VI wherever #9 is on court at that moment.
- **Closing a substitution**: when the starting player re-enters, the substitute's number in the
  Nr. Spieler row is **circled** and the score goes into Spielstand 2. After that, the position is
  closed for further regular substitutions in the set (FIVB 15.6).
- **Several substitutions at once** (1 to 6 in one request): record each one in its own column
  with the **same score** (SC p.67).
- **Exceptional substitution, or any substitution that does not fit the column** (a third
  movement, a re-entry): goes **only in the remarks** (SC p.68 and 69). The column is left as it
  is.
- **Forced substitution after expulsion or disqualification, if legal**: recorded in the column
  like any other substitution (SC p.61: `4` under starter 12 with `24:18`).

### 4.4 Points column ("Punkte", between and after the blocks)

- In sets 1 to 4 each team has a column of **1-48**, printed as 4 sub-columns: 1-12, 13-24,
  25-36 and 37-48.
- **Every point won**: put `/` on that team's new running total (SC p.32).
- **A point awarded by sanction** (a misconduct penalty or a delay penalty, given to the
  opponent): the number is **circled, not ticked** (SC p.59 and 60).
- **Points above 48**: not possible on paper.
  - **OV decision:** keep printing the score correctly. Extend the column or wrap, and add the
    remark `Set n continued beyond 48, final a:b`.
  - Never drop or cap a point.

### 4.5 Time-outs ("T")

- Under each points column there are **2 lines**, each pre-printed with `:`. They hold the score
  `requestingTeam:opp` at the moment the time-out was requested (SC p.46-48).
- The limit is 2 per team per set. Swiss indoor has no technical time-outs.
- A request beyond the limit is an **improper request** (see section 7).

### 4.6 Service rounds: opening, closing and side-out

**Before the first rally**

- The receiving team's **box I, round 1 is crossed with `X`**. Its first server will be
  position II, because the team rotates on winning the service (SC p.16).
- When the 1st referee authorises the first service, **tick the small "1"** in box I of the
  serving team (SC p.28).
- **Never tick the receiving team's crossed box I.**

**During play**

| Event | Mark |
|---|---|
| Serving team wins a rally | Tick the point only. The same server continues and the service box is unchanged (SC p.32). |
| Serving team loses a rally (side-out) | 1. Tick the opponent's point. 2. **Close** the server's box by writing the **team's total points** at that moment (the total score, not the points made on that service) in the box of the player who last served (SC p.33). 3. **Open** the next server box of the team that won the service by ticking its small round number (SC p.34). |
| Point awarded by penalty to the receiving team | The same side-out logic as a lost rally: close the server's box, circle (do not tick) the point, open the opponent's next server box. |

Service passes through the positions in this order: I → II → … → VI → I. Each new pass fills
the next round box (1, 2, … 8).

**Invariants, to check in tests**

- Within a team, the closed service-box numbers **always increase** in service order (SC p.40).
- The last ticked or circled point equals the circled final number in the service boxes
  (SC p.40).

### 4.7 End of set (SC p.39, 64)

1. Write the **end time** in the right block's Ende field.
2. Close the **winner's** service box with its final points:
   - **If the winner was serving**: write the final points in the current server's box.
   - **If the winner was receiving on set point**: write the final points in the box of the
     player who would serve next (the rotation happened), and **do not tick** that box's round
     number (SC p.64).
3. **Circle the final points in the service boxes of BOTH teams.** For the loser, this is its
   last closed box. **Do not circle in the points column.**
4. In the points columns of **both** teams, draw a `T` from the first unused number to the
   bottom of the column.
5. Check the box counts:
   - The team that **served first** wins: both circled finals are at the **same** service count.
   - The team that **received first** wins: the winner has **one service box more** than the
     loser (SC p.40).

**Winning a set** (FIVB 6.2): the first team to 25 with a lead of at least 2. At 24:24, play
continues until one team leads by 2.

- Example: 25:23 is won at 25.
- Example: 30:28 is still won only after a 2-point lead. The set passes 24:24 → 25:25 → … →
  28:28 → 29:28 → 30:28. The 48-number column covers this.

---

## 5. Set intervals and line-ups

- The interval is 3 minutes. The next set's **Beginn** is the actual start. By default this is
  the previous set's end plus 3 minutes, unless something delayed it (SC p.42).
- **Set 1 Beginn** (SC p.17, 27):
  - Do not copy the scheduled time automatically.
  - If the match starts within a couple of minutes of the schedule, the scheduled time is
    written.
  - A real delay is written as is and explained in the remarks.
  - **OV decision:** print the recorded start time, rounded to the minute. If it differs from
    the schedule by more than 5 minutes and no remark exists, offer to add one. Never insert the
    remark silently.
- **Line-ups**: each set gets the line-up from that set's line-up sheet. Check every number
  against the roster, and check for disqualified players (SC p.23, 66).
  - A player **expelled** in the previous set may play again.
  - A **disqualified** player may not play for the rest of the match (SC p.66).

---

## 6. Set 5 (tie-break)

Layout (MB, SC p.74-81). The set grid has **three team panels**. The team letters are **not
pre-printed**: write A or B in each panel's empty circle.

| Panel | Team | Header fields | Points column |
|---|---|---|---|
| 1 (left) | Team on the scorer's **left** at the start (from the set-5 coin toss) | Beginn, (S)/(R) | **1-8** |
| 2 (middle) | Team on the **right** | (S)/(R), **Ende** | **1-30** (3 sub-columns: 1-10, 11-20, 21-30) |
| 3 (far right) | The **left** team again, used after the change of courts | "Pte. beim Seitenwechsel" (points at the change) box | **1-30** |

Other differences from sets 1 to 4:

- Each panel has **6 service rounds** per position (rows 1/4, 2/5, 3/6) instead of 8.
- Each panel has its own "T" time-out lines.
- The vertical label between panels 2 and 3 reads "Seitenwechsel / Changement / Cambio"
  (change of courts).

**Preparation** (SC p.75):

- Copy panel 1's line-up into panel 3 as well.
- Panel 3 stays unused until the change of courts.

**Change of courts at 8** (when either team reaches 8 points, FIVB 18.2.2):

1. Write the **left team's points at the change** (only the left team's points) in the
   "Pte. beim Seitenwechsel" box of panel 3.
2. In **panel 3's points column**, draw a **reverse T `⊥`** over numbers 1..N, the points
   already scored.
3. In **panel 1's points column**, draw a standard **T** over the numbers not ticked (N+1 to 8).
4. Copy **all time-outs and substitutions**, with their scores and circles, from panel 1 to
   panel 3.
5. Service boxes:
   - **Situation 1, left team serving at the change**: in panel 3, only **open** the current
     server's box (tick its round number). Do not copy earlier service boxes (SC p.78).
   - **Situation 2, left team receiving at the change**: in panel 3, copy **only the last closed
     service box**, with its score, in the same position and round (SC p.79).
6. Panel 1 is then out of use.
7. **OV decision:** the generated PDF does not hide or grey out panel 1. It is printed as it was
   at the moment of the change, so a reader can follow the record.

**After the change**: the left team is recorded in panel 3 and the right team stays in panel 2.

**Winning set 5** (FIVB 6.3.2): 15 points with a lead of at least 2, for example 15:13 or 17:15.

**End of set 5**: same steps as section 4.7, applied to panels 2 and 3. Panel 1 already has its
T. The end time goes in panel 2's **Ende** field.

**Best-of-3 formats**:

- The deciding set is stored at index 5 and printed as "3" (`displaySetNumber`).
- **OV decision:** the deciding set of a best-of-3 match is printed in the **set-5 grid**, with
  the change of courts at 8. The grid is labelled with its played number (3). Sets 3 and 4 of
  the standard grid stay empty and are struck off.

---

## 7. Sanctions box (bottom left)

### 7.1 Improper requests ("Nicht ordnungsgemässer Antrag")

- The header shows `Team (A)` and `Team (B)`. When the referee rejects a request as improper,
  **cross that team's letter with `X`** (SC p.56).
- Each team gets **one** improper request per match. Any further one is a **delay** (section
  7.2).
- No score, set or row entry is made for an improper request.

### 7.2 Sanction rows

There are **9 rows** with these columns:

| Column | Content |
|---|---|
| Verwarnung (warning) | The member code, in the warning column |
| Bestrafung (penalty) | The member code, in the penalty column |
| Hinausstellung (expulsion) | The member code |
| Disqualifikation (disqualification) | The member code |
| (A) oder (B) | The letter of the sanctioned team |
| Satz (set) | The set number |
| Spielstand (score) | `sanctionedTeam:opp`, the score when the sanction was given |

The member code goes into **exactly one** of the four sanction columns:

- A **player**: the shirt number, for example `14`.
  - If the player is **on the bench** (not on court), the number is **circled**, for example
    `(6)` (SC p.62).
- **C** (coach), **AC1** / **AC2** (assistant coaches), **P** (physio), **M** (doctor).
- **D** for a delay:
  - **Delay warning**: `D` in the **warning** column (SC p.57).
  - **Delay penalty**: `D` in the **penalty** column (SC p.59).

Examples taken from SC:

- `D | | | | B | 2 | 16:18`: Team B, delay warning.
- `C | | | | B | 2 | 16:18`: Team B coach, formal warning (yellow card).
- `| D | | | B | 2 | 16:22`: Team B, delay penalty. Team A's point is circled in the points
  column, and the score becomes A 23.
- `| 14 | | | A | 2 | 24:16`: Team A player 14, penalty (red card). Team B's point is circled.
- `| | 12 | | A | 2 | 24:18`: Team A player 12, expelled. If disqualified, the `12` goes in the
  4th column instead.
- `(6) | | | | A | 2 | 24:19`: Team A bench player 6, warning.
- `7 | | | | A | 5 | 8:11`: Team A player 7, warning in set 5.

Recording rules:

- Only the stage-2 (yellow-card) **formal warning** is recorded. A stage-1 verbal warning is not
  a sanction and is not written (SC p.63, FIVB 21.1).
- Sanctions are recorded in the order they happened. If there are **more than 9**, the extra
  rows continue in the remarks using the same format (OV decision, matching the current
  `overflowSanctions`).

**Consequences of each sanction** (FIVB 2025 table 9a/9b, SC p.63):

| Sanction | Cards | Consequence on the sheet |
|---|---|---|
| Delay warning | Hand signal 25 with yellow | None |
| Delay penalty | Hand signal 25 with red | Point **and service** to the opponent. The point is circled. Side-out marks follow section 4.6. |
| Warning (misconduct) | Yellow | None |
| Penalty | Red | Point **and service** to the opponent. The point is circled. |
| Expulsion | Red and yellow together | No point. The member leaves for the rest of the **set**. A player must be substituted: legally if possible (column), otherwise exceptionally (remarks), otherwise the team is **incomplete** for the set (section 11). |
| Disqualification | Red and yellow separately | No point. The member is out for the rest of the **match**. Substitution rules are the same as for expulsion. Later line-ups must not contain this player. |

The scorer reminds the referee when the escalation scale is not followed (SC p.63, 80). The PDF
records only what was imposed.

---

## 8. Remarks ("Bemerkungen/Remarques/Osservazioni")

There are 4 ruled lines. If more space is needed, the text keeps flowing (OV decision: wrap, and
continue on an overflow page if needed, never truncate).

Every remark states **Team A/B, the set number and the result** (concerned team first). Time
problems also state the times and the duration (SC p.71).

Typical entries, worded as in SC:

| Case | Text |
|---|---|
| Exceptional substitution (SC p.69) | `Team B, Set 3, Result 16:21: player no. 8 is exceptionally substituted by player no. 3 due to injury.` Other reasons: illness, expulsion, disqualification. |
| Libero declared unable to play, and re-designation (SC p.70) | `Team A, Set 3, Result 21:24: Libero no. 4 is declared unable to play. Player no. 13 is designated as new Libero.` |
| Delayed start (SC p.76) | `Set 5 start time 12:18 (5' delay) due to net replacement.` |
| Delayed match start | The scheduled time, the actual time and the reason. |
| Sanction overflow | The sanction rows beyond 9, in the section 7.2 format. |
| Incomplete team / default (section 11) | What happened and the result that was awarded. |
| Protest (FIVB 5.1.3.2) | The game captain's reservation, written as dictated. |
| Free scorer remarks | Stored in `match.remarks` and printed verbatim after the generated ones. |

---

## 9. Final result ("Endresultat/Résultat final/Risultato finale")

The table always has **Team A on the left** and **Team B on the right**. Short team names go in
the header.

Columns: `"T" | S | W | Punkte || Satz (Dauer) || Punkte | W | S | "T"`. They mean:

- `"T"`: the number of **time-outs** taken in the set (0 if none).
- `S`: the number of **substitutions** in the set (0 if none). This **includes exceptional
  substitutions**. SC p.71 counts "4 standard + 1 exceptional" as 5.
- `W`: **1** if the team won the set, **0** if it lost.
- `Punkte`: the points scored.
- `Satz (Dauer)`: the set number, with the **set duration in minutes** (end − start) in brackets.

Rows and footer:

- One row per set (1 to 5). Unplayed sets are struck off.
- **Total** row: the sums of T, S, W and Punkte for each team, and the **sum of the set
  durations** in the "Total ( )" bracket (SC p.86: 12+17+20+12+15 = 76).
- **Beginn**: the match start (set 1 Beginn), written as `HH h MM min`.
- **Ende**: the match end (the last set's Ende).
- **Dauer**: Ende − Beginn, written as `H h MM min`. This includes the intervals. SC p.86 shows
  76 + 3×3 + 8 = 93 min, i.e. `1 h 33 min`.
- **Gewinner (winner)**: the winning team's **full name**, then `3:x`, where x is the loser's
  sets (SC p.83).
  - The "3:" is pre-printed on paper. In best-of-3 the print shows `2:x` (OV decision).
  - The result is written as soon as the match ends, before the post-match signatures.

---

## 10. Approval ("Bestätigung/Approbation/Approvazione")

Rows, from top to bottom:

| Row | Name | Land | "Lizenz-Nr." → **DoB** | Signature |
|---|---|---|---|---|
| 1. (1st referee) | `Lastname, F.` | 3-letter country code, e.g. `CHE` | `DD.MM.YYYY` | yes |
| 2. (2nd referee) | same | same | same | yes |
| Schreiber (scorer) | same | same | same | yes |
| Schreiber Ass. (assistant scorer) | same | same | same | yes |
| Linienrichter (line judges) 1. 2. / 3. 4. | names only, two per row | none | none | none |
| Unterschrift Kapitäne (captains' signatures) | captain A next to `(A)`, captain B next to `(B)` | none | none | post-match |

- **DoB column.** The paper header says "Lizenz-Nr." but the column holds the **date of birth**
  (SC p.11). **OV decision, owner request:** the header prints **`DoB`**, not "Lic.". The value
  is the official's `dob` from `match.officials[].dob`, normalised to `DD.MM.YYYY` (section
  12.3). The column width stays the same as before, so the row lines and the signature column
  stay aligned.
- **Signing order** (SC p.84, 87):
  1. The captains sign right after the result is written.
  2. When the sheet is complete, the assistant scorer signs, then the scorer.
  3. The referees check the sheet, then sign.
  The scorer must **not** sign before the end (SC p.11).
- Rows for officials who were not present are struck off. Line-judge rows are empty in most
  Swiss matches and are struck off as well (OV decision).

---

## 11. Special cases

| Case | What the sheet shows |
|---|---|
| Set won 25:23 | Points column ticked to 25 and 23. T marks from 26 and from 24. Circled finals in the service boxes. W = 1/0. |
| Set won 30:28 | Same as above with 30 and 28. The 48-number column is enough. |
| Tie-break 15:x | Section 6: change of courts at 8, ⊥ and T marks, finals circled in panels 2 and 3. |
| Winner was receiving on set point | Final written in the next server's box, round number **not** ticked, circled (SC p.64). |
| Time-out | `req:opp` on a T line (4.5). Counted in the result "T". |
| Third time-out request | Improper request: cross the team letter (7.1). On a repeat: delay sanction. |
| Regular substitution | Number under the starting player, score in Spielstand 1 (4.3). |
| Starting player returns | Circle the substitute's number, score in Spielstand 2. |
| Multiple substitutions at once | Each in its column, all with the same score (SC p.67). |
| 5th or 6th substitution | Recorded normally. The scorer tells the referee. |
| Injury, legal substitution possible | Regular substitution in the column (FIVB 15.7, legal first). |
| Injury, no legal substitution | **Exceptional substitution** (FIVB 15.7): **remarks only**, counted in the result S. The replaced player may not play again in the match (SC p.68). |
| Expulsion | E column (7.2). The player must be substituted at once: legal (column) → exceptional (remarks) → otherwise the team is incomplete **for that set**. The player may return in the next set (SC p.66). |
| Disqualification | D column. Same substitution order as expulsion. Out for the match. If no player can replace them, the team is incomplete for the set, and for the match if the next set cannot be started with 6 players. |
| Libero unable to play / re-designation (FIVB 19.4) | Remarks text (section 8). The new libero's number is **not** added to the printed libero rows, because those show the pre-match list. |
| Penalty or delay penalty | Opponent's point **circled**. Side-out marks if the opponent was receiving (4.6). |
| Sanction to a bench player | Number circled in the sanction row (SC p.62). |
| Coach or staff sanction | C / AC1 / AC2 / P / M in the sanction row. |
| Incomplete team during a set (FIVB 6.4.3) | The opponent is given the points (and sets) needed to win. The incomplete team keeps its points and sets. **OV decision:** the awarded points are **circled** in the points column (they were not won in a rally), then T marks and finals follow 4.7, plus a remark with team, set, score and reason. |
| Default / forfeit (FIVB 6.4.1-2) | The team that defaults loses 0:3, each set 0:25. **OV decision:** set grids empty and struck off. Result rows printed as 25 / 0 with W 1/0, durations empty. Winner `3:0`. Remark: `Team X declared in default (reason), match result 3:0 (25:0, 25:0, 25:0).` |
| Absent player | Roster row struck through (section 3). |
| Delayed set or match start | Actual time in Beginn, plus a remark with the reason and the delay in minutes. |
| Match ends 3:0 / 3:1 / 3:2 | Unused set grids and result rows struck off with a Z. Result, winner, captains' signatures as in sections 9 and 10. |

---

## 12. Derived values and checks

The functions in `utils/scoresheetModel.ts` are pure, so all of these can be unit-tested.

### 12.1 Calculations

- `setStart[n]`, `setEnd[n]`: the recorded set start and set end (time of the last rally).
  Format `HH:MM`, local time in the match's time zone, Europe/Zurich by default.
- `setDuration[n] = minutes(setEnd − setStart)`, rounded down to whole minutes.
- `totalDuration = Σ setDuration`.
- `matchDuration = lastSetEnd − set1Start`, printed as `H h MM min`.
- `T[n][team]` = the number of time-out events. `S[n][team]` = the number of substitution events
  **including** exceptional ones.
  - Note: `countRegularSubstitutions` currently excludes exceptional substitutions. The
    "regular" count is still needed for the 6-substitution limit, but the result "S" column must
    use the total.
- `W[n][team] ∈ {0,1}`. `Σ W` is the sets won. The winner line is `fullName  setsWon:setsLost`.

### 12.2 Consistency checks

These run before rendering. If one fails, the sheet shows a warning in the UI and the remarks
are left unchanged.

1. For each team and set, the ticked plus circled points equal the set score.
2. Closed service-box values strictly increase in service order. The last one equals the
   circled final.
3. Service-box count parity with the first server (4.7, step 5).
4. Every lineup, substitution and sanction number exists in that team's roster. Liberos never
   appear in the starting lineup.
5. No disqualified player appears in a later lineup or substitution.
6. At most 2 time-outs per team per set, and at most 6 regular substitutions per team per set.
7. Set 5: the "points at change" value is 8 for one of the teams.

### 12.3 Formats

- **Dates**: `DD.MM.YYYY`, zero-padded. Inputs are accepted as ISO `YYYY-MM-DD`, `D.M.YYYY` or
  `DD.MM.YYYY`. Anything that cannot be parsed is printed verbatim, never as "Invalid Date".
- **Times**: `HH:MM`, 24-hour clock.
- **Names**: `Lastname, F.` for players and officials. Team names are full in the teams line and
  the winner line, short everywhere else.
- **Country**: 3 letters (`CHE`).

---

## 13. OpenVolley output requirements (owner request, 2026-10-07)

1. **Branding**: see 2.1. No Swiss Volley name or logo anywhere, including the PDF text layer
   and metadata.
   - PDF metadata: `Title = "OpenVolley eScoresheet: <Home> vs <Away>, <DD.MM.YYYY>, game <no>"`,
     `Creator = "OpenVolley eScoresheet"`.
2. **Ball**: only the new flat ball A from `brand/ball.svg`, everywhere on the sheet.
3. **Approval column**: `DoB` instead of `Lic.`, filled from the officials' `dob` (section 10).
4. **File name**: `<YYYYMMDD>_<gameNo>_<Home>_vs_<Away>.pdf`.
   - Use the **real** team names. Prefer the short name, but if a short name is empty or is a
     placeholder (`HOME`, `AWAY`, `Home`, `Away`, `Team A`, `Team B`), use the full name.
   - The date is the **local** match date. `toISOString()` is UTC and gives the wrong day near
     midnight.
   - The game number is omitted, together with its `_`, when it is unknown. Never use the
     literal `match`.
   - Sanitising:
     - transliterate `ä→ae, ö→oe, ü→ue, é/è/ê→e, à/â→a, ç→c`;
     - replace every other character outside `[A-Za-z0-9-]` with `-`;
     - collapse repeated `-` and trim them;
     - at most 30 characters per team;
     - total length at most 120 characters.
   - Example: `20261007_382208_KSCW-H1_vs_Spada-H1.pdf`.
5. **Saving and reporting**: the save must produce a valid PDF (starts with `%PDF-`, ends with
   `%%EOF`, opens in pdf.js and in the system viewer). The user must be told **exactly** where
   the file went:
   - **Desktop (Tauri)**: the full absolute path, plus **Open file** and **Show in folder**
     actions run on the Tauri side.
   - **Android**: the full path under `Documents/OpenVolley/scoresheets/`, plus **Open** and
     **Share** through the platform intent, with no new proprietary dependency.
   - **Web**: the browser download, with the file name shown in the notice.

---

## 14. Gaps seen in the current code

These are pointers for the implementation phase, not a complete audit.

- `App_Scoresheet.tsx` `handleSavePdf` builds the file name from
  `match.gameNumber || externalId || game_n || 'match'`, from `homeShortName` / `awayShortName`,
  and from a UTC date. This is how `match_HOME_AWAY_20261007.pdf` was produced. Fix per
  section 13.4.
- `FooterSection.tsx`:
  - line ~497: the approval header is `Lic.`, and line ~520 prints `official.license`. Both
    should become `DoB` and `official.dob` (formatted).
  - lines ~729 and 749 (roster): there is an extra `Lic.` column beside `DoB`. The Matchblatt
    roster has a single DoB column (section 3). Drop the licence column, or keep it only when
    licence data exists, without misaligning the columns.
- `scoresheetModel.countRegularSubstitutions` excludes exceptional substitutions. The result "S"
  column needs the total (12.1).
- `Header.tsx` and `components/swissvolleylogo.jpg`: these are the federation logo and naming to
  remove (2.1).

## 15. Open questions for the owner

1. Right-hand header: show the match identity block (game no., date, league), or keep the FIVB
   logo? The FIVB logo is on the paper sheet but is not part of the OpenVolley brand.
2. Set 1 Beginn: print the recorded minute, or the scheduled time when the difference is within
   2 minutes (paper practice, SC p.27)? This spec assumes the recorded minute.
3. Best-of-3 deciding set: printed in the set-5 grid and labelled "3" (section 6). Is that
   right for Swiss youth formats?
