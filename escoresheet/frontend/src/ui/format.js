// Swiss formatting: every clock is a Zürich clock, every number a de-CH one.
//
// Port of svrz_rc src/lib/appTime.ts (zonedParts, weekdayLabel, dayLabel,
// timeLabel, shortDayLabel, dayTimeLabel, dayKey, todayKey) plus the number
// formatters from components/BudgetCard.tsx:51-52 and
// components/StatsCharts.tsx:20-21.
//
// Why a Zürich clock and not the device's: a match starts at 20:45 in a gym in
// Zürich, for the scorer in the hall and for the coach reading the list
// abroad. Rendering through getHours()/getDate() turned every kick-off into
// 21:45 in EEST and pushed late Saturday games onto Sunday (appTime.ts:1-14).
//
// A stored value comes in one of three shapes:
//   "2026-09-21 18:45:00.000Z" / ISO with offset  -> an instant, shown in Zürich
//   "2026-09-21T20:45" / "2026-09-21 20:45:00"    -> already wall time, taken as-is
//   "2026-09-21"                                  -> a date with no time; no clock shown
// Numbers and Date objects are accepted too. Nothing here throws. These run
// inside render, where a TypeError means a blank page.

export const APP_TZ = 'Europe/Zurich';

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const WALL_CLOCK_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/;
const HAS_ZONE_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

const INVALID = { valid: false, timed: false, year: 0, month: 0, day: 0, hour: 0, minute: 0 };

const partsFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: APP_TZ,
  hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});

function fromInstant(date) {
  if (Number.isNaN(date.getTime())) return INVALID;
  const parts = partsFormatter.formatToParts(date);
  const at = (type) => Number(parts.find((p) => p.type === type)?.value ?? NaN);
  const hour = at('hour');
  return {
    valid: true,
    timed: true,
    year: at('year'), month: at('month'), day: at('day'),
    // Some ICU builds render midnight as hour 24 under hour12:false.
    hour: hour === 24 ? 0 : hour,
    minute: at('minute'),
  };
}

/** The Zürich wall clock of a stored value, whatever shape it arrived in. */
export function zonedParts(value) {
  if (value instanceof Date) return fromInstant(value);
  if (typeof value === 'number') return Number.isFinite(value) ? fromInstant(new Date(value)) : INVALID;
  if (typeof value !== 'string') return INVALID;
  const text = value.trim();
  if (!text) return INVALID;

  const dateOnly = DATE_ONLY_RE.exec(text);
  if (dateOnly) {
    return { valid: true, timed: false, year: +dateOnly[1], month: +dateOnly[2], day: +dateOnly[3], hour: 0, minute: 0 };
  }
  if (!HAS_ZONE_RE.test(text)) {
    const wall = WALL_CLOCK_RE.exec(text);
    if (wall) {
      return { valid: true, timed: true, year: +wall[1], month: +wall[2], day: +wall[3], hour: +wall[4], minute: +wall[5] };
    }
  }
  // "2026-09-21 18:45:00.000Z": the T keeps it off the engine's lenient parser.
  return fromInstant(new Date(text.replace(' ', 'T')));
}

const pad = (n) => String(n).padStart(2, '0');

/** 'DE' | 'EN' (or a BCP-47 tag) -> the locale used for words (weekday, month). */
export const localeOf = (lang) => {
  const l = String(lang || 'DE').toLowerCase();
  if (l.startsWith('en')) return 'en-GB';
  if (l.startsWith('fr')) return 'fr-CH';
  if (l.startsWith('it')) return 'it-CH';
  return 'de-CH';
};

/** "Di" / "Tue": the weekday of the Zürich day, in the reader's language. */
export function weekdayLabel(value, lang = 'DE') {
  const p = zonedParts(value);
  if (!p.valid) return '';
  return new Date(Date.UTC(p.year, p.month - 1, p.day))
    .toLocaleDateString(localeOf(lang), { weekday: 'short', timeZone: 'UTC' });
}

/** "21.09." or, with { year: true }, "21.09.2026". Swiss order, built by hand
 *  so the browser's locale can never reorder it. */
export function dayLabel(value, opts = {}) {
  const p = zonedParts(value);
  if (!p.valid) return '';
  return `${pad(p.day)}.${pad(p.month)}.${opts.year ? p.year : ''}`;
}

/** "20:45", 24-hour, or '' when the value carries no clock. Never invent one. */
export function timeLabel(value) {
  const p = zonedParts(value);
  return p.valid && p.timed ? `${pad(p.hour)}:${pad(p.minute)}` : '';
}

/** "Di 21.09.": the date shorthand list rows use. */
export function shortDayLabel(value, lang = 'DE') {
  const p = zonedParts(value);
  if (!p.valid) return '';
  return `${weekdayLabel(value, lang)} ${pad(p.day)}.${pad(p.month)}.`;
}

/** "21.09.2026 20:45": the long form for documents, mails and detail views. */
export function dayTimeLabel(value) {
  const p = zonedParts(value);
  if (!p.valid) return '';
  const date = `${pad(p.day)}.${pad(p.month)}.${p.year}`;
  return p.timed ? `${date} ${pad(p.hour)}:${pad(p.minute)}` : date;
}

/** "YYYY-MM-DD" of the Zürich day: the key a calendar cell is filed under. */
export function dayKey(value) {
  const p = zonedParts(value);
  return p.valid ? `${p.year}-${pad(p.month)}-${pad(p.day)}` : '';
}

/** Today in Zürich, which is not the reader's today everywhere. */
export function todayKey() {
  return dayKey(new Date());
}

/** A day key moved by whole calendar days. Not ± 86 400 000 ms, which lands on
 *  the same day across the spring DST switch (appTime.ts:193-206). */
export function shiftDayKey(key, delta) {
  const [y, m, d] = String(key || '').split('-').map(Number);
  if (!y || !m || !d) return '';
  const moved = new Date(Date.UTC(y, m - 1, d + delta));
  return `${moved.getUTCFullYear()}-${pad(moved.getUTCMonth() + 1)}-${pad(moved.getUTCDate())}`;
}

// ── Numbers ────────────────────────────────────────────────────────────────
// de-CH groups thousands with an apostrophe and uses a point for decimals:
// 1'234.50. The apostrophe's code point depends on the engine's ICU data:
// current Chromium and Node (ICU 78) give U+0027 ('), older or other ICU data
// gives U+2019 (’). Tests should match both, e.g. /1['’]234\.50/. Always render
// numbers in a `tabular-nums` span.

const intFmt = new Intl.NumberFormat('de-CH');
const chfFmt = new Intl.NumberFormat('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 1'234, rounded (separator U+0027 or U+2019, see above). */
export const fmtInt = (n) => intFmt.format(Math.round(n));

/** 3.5 with a fixed number of decimals. */
export const fmtDec = (n, digits = 1) =>
  new Intl.NumberFormat('de-CH', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);

/** 1'234.50, the amount only. Write the currency as text in front: `CHF ${chf(n)}`. */
export const chf = (n) => chfFmt.format(n);

/** A signed amount with a real minus sign (U+2212), as svrz_rc BudgetCard.tsx:130 does. */
export const chfSigned = (n) => (n < 0 ? `− ${chf(-n)}` : chf(n));
