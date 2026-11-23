# Photo import fixtures

Tesseract's answers (tesseract.js 7.0.0, `deu+fra+ita`, `4.0.0_best_int`, LSTM, PSM 6, the
`blocks` output cut to the words' text, confidence and box) for **made-up lists**. No real person,
SV number or game is in them. They are what `ocr.js` hands `rosterFromOcr`, so the parser's tests
run without Tesseract.

| File | List (`source/`) | Picture |
|---|---|---|
| `ocr-vm-de-skew.json` | `vm-de.html`: VolleyManager's layout (no rules, officials above the table, LK / LAS / E / ⚠ columns, a wrapped last name), numbers, C / L and a circled number written in a hand-like script | a skewed, unevenly lit photo on a table (JPEG 0.82, blurred, noise) |
| `ocr-vm-de-screenshot.json` | `vm-de.html` | a phone screenshot of the page (1080 px wide, PNG) |
| `ocr-vm-de-degraded.json` | `vm-de.html` | the skewed photo saved again as JPEG: a poorer reading (a digit lost, a date and a name misread) |
| `ocr-vm-de-anywhere-skew.json` | `vm-de-anywhere.html`: the same list with the marks spread over the row (margin, between SV number and name, between the names, after the name, a circle over a first name) | the skewed photo |
| `ocr-table-de-skew.json` | `table-de.html`: a ruled table, German headers | the skewed photo |
| `ocr-table-it-flat.json` | `table-it.html`: a ruled table, Italian headers | a straight photo |

How they were made (2026-11-23): the HTML rendered at 1240 × 1754 in Chromium, drawn into the
picture through a homography (`scan.js`), then the app's own pipeline in the dev server
(`loadPhoto` → `guessCorners` → `scanPage` → Tesseract with `ocr.js`'s settings), the first
`recognize` answer saved. Real photos and real handwriting are not in here (owner's samples stay
outside the repo).
