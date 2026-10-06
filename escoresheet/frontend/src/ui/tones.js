// Semantic colour recipes. Exact class strings from svrz_rc.
//
// Light only, stone neutrals. `red-600` / `red-700` are the brand red (see
// tokens.css), so `danger` and `brand` share a hue on purpose: in this
// language red marks the brand action and errors alike, and the copy says
// which one it is. Colour never carries meaning alone: every tone sits next
// to a word ("Overdue", "Saved", "Offline").
//
// Hue roles:
//   red      brand action, error, destructive, "this is you" / urgent
//   amber    warning, attention needed, highlight ("one of yours")
//   green    success notices ("Saved")    emerald  done / confirmed state, OK accept
//   sky      info, hints, explanations    indigo / violet  extra categorical chips only
//   stone    neutral                      slate-900  selected / inverted key action

// ── Notice strips (inline alert under a form or card) ───────────────────────
// Base `rounded-lg border px-3 py-2 text-xs`. Add `mt-2` / `mt-3` at the call
// site. svrz_rc writes the same recipe in several word orders; these are
// normalised to one.
export const NOTICE = {
  // BudgetCard.tsx:212, StatisticsAdmin.tsx:1026
  error: 'text-xs text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2',
  // NotebookSheet.tsx:498 (amber-200 border); AdminConsole.tsx:1734 uses border-amber-100
  warning: 'text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2',
  // AdminConsole.tsx:1729, 2031, 2362
  success: 'text-xs text-green-700 bg-green-50 border border-green-100 rounded-lg px-3 py-2',
  // App.tsx:6858. Info strips carry an icon, hence flex + font-medium.
  info: 'flex items-center gap-2 rounded-lg border border-sky-300 bg-sky-50 px-3 py-2 text-xs font-medium text-sky-800',
};

// ── Floating banner (connection state, top of screen) ──────────────────────
// ConnectionBanner.tsx:51-55
export const BANNER_BASE = 'flex max-w-md items-start gap-2 rounded-xl border px-3 py-2 text-xs font-medium shadow-md';
export const BANNER = {
  severe: 'border-red-300 bg-red-50 text-red-800',
  mild: 'border-amber-300 bg-amber-50 text-amber-900',
};

// ── Meta chips (square-cornered facts on a row) ────────────────────────────
// GameRow.tsx:253 (base) + GameRow.tsx:221-236 (tones). `rounded` (4px), never
// a pill. Pills (`rounded-full`) are for status and counts.
export const CHIP_BASE =
  'inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-[3px] text-[10.5px] font-semibold leading-none sm:text-[11px]';
// A chip that holds a person's name must wrap: GameRow.tsx:254-257
export const CHIP_WRAP = 'whitespace-normal text-left leading-tight';
export const CHIP_TONE = {
  stone: 'bg-stone-50 border-stone-200 text-stone-600',
  me: 'bg-red-50 border-red-200 text-red-700',
  urgent: 'bg-red-50 border-red-300 font-semibold text-red-800', // svrz_rc: `boerse`
  indigo: 'bg-indigo-50 border-indigo-200 text-indigo-800', // svrz_rc: `rc`
  sky: 'bg-sky-50 border-sky-200 text-sky-800',
  amber: 'bg-amber-50 border-amber-300 text-amber-800',
  emerald: 'bg-emerald-50 border-emerald-200 text-emerald-700',
  dark: 'bg-stone-900 border-stone-900 text-white',
  violet: 'bg-violet-50 border-violet-300 text-violet-800',
  ghost: 'bg-transparent border-transparent text-stone-500 px-0',
};

// Micro badge glued to a name (uppercase, 9px). CoacheeChips.tsx:3, GameMarks.tsx:93
export const MICRO_BADGE =
  'ml-1.5 inline-block align-middle whitespace-nowrap rounded px-1 py-px text-[9px] font-bold uppercase tracking-wide';
export const MICRO_BADGE_TONE = {
  amber: 'text-amber-800 border border-amber-200 bg-amber-100',
  emerald: 'border border-emerald-200 bg-emerald-50 text-emerald-800',
  stone: 'text-stone-500 border border-stone-200 bg-stone-50', // AdminConsole.tsx:1800
};

// ── Row state: date text + 2px rail ────────────────────────────────────────
// GameRow.tsx:34-48. State lives on a thin rail and the date's colour, never
// on a filled row.
export const TONE_TEXT = {
  red: 'text-red-600',
  amber: 'text-amber-700',
  sky: 'text-sky-700',
  emerald: 'text-emerald-600',
  stone: 'text-stone-700',
};
export const TONE_RAIL = {
  red: 'bg-red-400',
  amber: 'bg-amber-400',
  sky: 'bg-sky-500',
  emerald: 'bg-emerald-400',
  stone: 'bg-stone-200',
};

// ── Toast left edge + icon ─────────────────────────────────────────────────
// ui/Toast.tsx:8-12. The card itself is
// 'bg-white rounded-xl shadow-lg border border-stone-200 border-l-4' (Toast.tsx:54-55).
export const TOAST_ACCENT = {
  success: { border: 'border-l-emerald-500', icon: 'text-emerald-600' },
  error: { border: 'border-l-red-500', icon: 'text-red-600' },
  info: { border: 'border-l-blue-500', icon: 'text-blue-600' },
};

// ── Confirm accept button ──────────────────────────────────────────────────
// ui/ConfirmDialog.tsx:138-139. A neutral "yes" is emerald, a destructive one
// is brand red.
export const CONFIRM_ACCEPT = {
  danger: 'bg-red-600 hover:bg-red-700',
  ok: 'bg-emerald-700 hover:bg-emerald-800',
};

// ── Status dots ────────────────────────────────────────────────────────────
// `h-2 w-2 rounded-full` legend dots (BudgetCard.tsx:154-156) and
// `h-2.5 w-2.5 rounded-full bg-green-500` live dots (AdminConsole.tsx:5894).
export const DOT = {
  brand: 'bg-red-600',
  brandSoft: 'bg-red-300',
  neutral: 'bg-stone-300',
  ok: 'bg-green-500',
  warn: 'bg-amber-500',
  info: 'bg-sky-500',
};

// ── Chart series (inline SVG, light surface) ───────────────────────────────
// StatsCharts.tsx:9-17. Blue / brand red / yellow, CVD-separable as
// neighbours. The yellow needs a direct label. Ink and grid are stone.
export const SERIES = ['#2a78d6', '#e2001a', '#eda100'];
export const SERIES_SOFT = ['#9ec5f4', '#f2a3a3', '#f6d58a'];
export const CHART_INK = '#44403c'; // stone-700
export const CHART_INK_SOFT = '#78716c'; // stone-500
export const CHART_GRID = '#e7e5e4'; // stone-200
