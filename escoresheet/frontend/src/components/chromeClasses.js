// Shared volleyui class strings for the app chrome (P2a): header bars, header
// buttons, anchored dropdown menus and info popovers. Used by MainHeader,
// SimpleHeader, DashboardHeader, MenuList, ConnectionStatus and
// TabletStatusIndicator so every top bar and dropdown has the same face.
//
// These elements are NOT inside `.ov-kit` (they sit next to legacy components
// such as UserButton), so every class string sets the properties the legacy
// element rules in styles.css would otherwise supply: background, padding,
// border, radius, size, weight and colour (`button { background: var(--accent) }`
// is the scoring green). `tracking-normal` cancels the legacy `.text-xs` /
// `.text-sm` letter-spacing. Utilities sit above the legacy layer, so these win;
// inline style still beats them, so converted elements drop the matching keys.
import i18n from 'i18next' // the app's singleton (configured in ../i18n); no react-i18next import, so tests that mock it still load
import { FOCUS_RING } from '../ui/Button.jsx'

export { FOCUS_RING }

/**
 * Wrapper for a single header control outside `.ov-kit`: `display: contents`
 * (no box, the layout is unchanged) but the control is then inside the kit
 * scope, so it draws only the kit FOCUS_RING and not also the legacy
 * `:not(.ov-kit *):focus-visible` outline (styles.css), and the legacy
 * `button {}` rules no longer reach it.
 */
export const KIT_SCOPE = 'ov-kit contents'

/** Top bar: white with a stone hairline (svrz header, RESTYLE-SPEC 3.5). */
export const HEADER_BAR = 'bg-white border-b border-stone-200/70'

/** Small header button (?, menu, fullscreen, match info). 32 px: the bar is 40 px. */
export const HEADER_BTN = `inline-flex shrink-0 items-center justify-center gap-1.5 h-8 px-2.5 rounded-lg border border-stone-200 bg-white text-xs font-medium tracking-normal text-stone-600 hover:bg-stone-100 transition-colors cursor-pointer ${FOCUS_RING}`

/** The same button while its panel is open / its mode is on (selection = slate-900). */
export const HEADER_BTN_ON = 'border-slate-900 bg-slate-900 text-white hover:bg-slate-800'

/** The Online / Offline switch in the bar: the header button face holding a word and a switch track. */
export const HEADER_SWITCH = `inline-flex shrink-0 items-center gap-2 h-8 pl-2.5 pr-1.5 rounded-lg border border-stone-200 bg-white text-xs font-medium tracking-normal whitespace-nowrap text-stone-700 hover:bg-stone-100 transition-colors cursor-pointer ${FOCUS_RING}`

/** Header title / section name beside the menu (svrz app title). */
export const HEADER_TITLE = 'truncate text-sm font-semibold tracking-normal text-stone-900'
export const HEADER_META = 'truncate text-[11px] font-medium tracking-normal text-stone-500'

/** Anchored dropdown panel (svrz anchored menu: rounded-xl, hairline, shadow-card-lg). */
export const MENU_PANEL = 'rounded-xl border border-stone-200 bg-white p-1.5 shadow-card-lg text-stone-700'

/** Info popover (connection status, tablets, dashboard info). */
export const POPOVER_PANEL = 'rounded-xl border border-stone-200 bg-white p-3 shadow-card-lg text-stone-800'

/** Eyebrow over a menu or popover. stone-500, not the kit's stone-400: it names
 *  the panel, so it carries information (RESTYLE-SPEC R13, 4.6:1 on white). */
export const MENU_TITLE = 'px-3 pt-1.5 pb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-stone-500'

/** Section header inside a menu ("Connection", "Status"); stone-500 like MENU_TITLE. */
export const MENU_SECTION = 'px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-stone-500'

/** Menu row: 48 px tall, full width, stone text, stone-100 hover (svrz menu row). */
export const MENU_ROW = `flex w-full min-h-12 items-center gap-3 px-3 py-2 rounded-lg border-0 bg-transparent text-left text-sm font-medium tracking-normal text-stone-700 hover:bg-stone-100 transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent ${FOCUS_RING}`

/** Compact row for nested choices (language, scale): still a full 44 px target. */
export const MENU_SUBROW = `flex w-full min-h-11 items-center gap-2.5 px-3 py-2 rounded-lg border-0 bg-transparent text-left text-sm font-medium tracking-normal text-stone-700 hover:bg-stone-100 transition-colors cursor-pointer ${FOCUS_RING}`

/** The chosen row in a choice list (language, scale, connection mode). */
export const MENU_ROW_ON = 'bg-slate-900 text-white hover:bg-slate-800'

/**
 * Informational menu row (a status, the TEST MODE flag): not a control, so no
 * hover, no pointer and full opacity. Text is a 700/800 tone (AA on white).
 */
export const MENU_INFO_ROW = 'flex w-full min-h-11 items-center gap-3 px-3 py-2 rounded-lg text-left text-sm font-medium tracking-normal cursor-default select-none'

/** Destructive / leave row (Stop the match, Back, Exit, Clear cache). */
export const MENU_ROW_DANGER = 'text-red-600 hover:bg-red-50'

/** Nested choice list under a row. */
export const MENU_NEST = 'my-1 rounded-lg bg-stone-50 p-1'

/** Hairline between menu groups. */
export const MENU_SEP = 'my-1 h-px bg-stone-100'

/** Leading icon slot in a row. */
export const MENU_ICON = 'flex w-5 shrink-0 items-center justify-center text-stone-400'

/** Count / value pill at the end of a row (svrz count pill). */
export const MENU_COUNT = 'inline-flex items-center rounded-full bg-stone-100 px-2 py-0.5 text-[11px] font-semibold tabular-nums tracking-normal text-stone-600'

/**
 * Header status trigger (Connected / Ready / Offline / Error, the dashboards
 * and tablets counts). It opens a panel, so it is a control and wears the svrz
 * header button (AdminConsole.tsx:1225: white, stone-200 hairline, rounded-lg),
 * at the bar's h-8, never a tinted state pill (volleyui: a status is never a
 * control). The state is a coloured dot plus the word in its tone (`tone.pill`).
 */
export const STATUS_PILL = 'inline-flex shrink-0 items-center gap-1.5 h-8 px-2.5 rounded-lg border border-stone-200 bg-white text-xs font-medium tracking-normal whitespace-nowrap text-stone-700 hover:bg-stone-100 transition-colors cursor-pointer'

/**
 * Each tone: `pill` the word colour on a STATUS_PILL trigger, `dot` its dot,
 * `text` a word on white, `tint` the kit StatusPill face for a state inside a
 * panel or menu (`<StatusPill className={tone.tint}>`, rounded-full, no border).
 */
export const STATUS_TONES = {
  ok: { pill: 'text-emerald-800', dot: 'bg-emerald-500', text: 'text-emerald-800', tint: 'bg-emerald-100 text-emerald-800' },
  warn: { pill: 'text-amber-800', dot: 'bg-amber-500', text: 'text-amber-800', tint: 'bg-amber-100 text-amber-800' },
  error: { pill: 'text-red-700', dot: 'bg-red-500', text: 'text-red-700', tint: 'bg-red-50 text-red-700' },
  info: { pill: 'text-sky-800', dot: 'bg-sky-500', text: 'text-sky-800', tint: 'bg-sky-100 text-sky-800' },
  neutral: { pill: 'text-stone-700', dot: 'bg-stone-400', text: 'text-stone-600', tint: 'bg-stone-100 text-stone-600' },
  violet: { pill: 'text-violet-800', dot: 'bg-violet-500', text: 'text-violet-800', tint: 'bg-violet-100 text-violet-800' },
}

/**
 * Legacy menu-item colours passed in by callers (Referee, UploadRoster...)
 * mapped to the kit's text tones. Unknown values fall back to the inline colour.
 */
const ITEM_TONES = {
  '#22c55e': 'text-emerald-700',
  '#10b981': 'text-emerald-700',
  '#3b82f6': 'text-sky-700',
  '#60a5fa': 'text-sky-700',
  '#fbbf24': 'text-amber-700',
  '#f59e0b': 'text-amber-700',
  '#eab308': 'text-amber-700',
  '#ef4444': 'text-red-600',
  '#dc2626': 'text-red-600',
  'var(--text)': 'text-stone-700',
}

/** The kit toast's own label language (its dismiss button): DE for German UIs, else EN. */
export function toastLang() {
  return String(i18n.language || '').startsWith('de') ? 'DE' : 'EN'
}

/**
 * The same legacy colours as a STATUS_TONES key, for informational rows (a
 * status reads as a status, never as the red destructive-action row).
 */
const ITEM_STATUS_TONES = {
  'text-emerald-700': 'ok',
  'text-sky-700': 'info',
  'text-amber-700': 'warn',
  'text-red-600': 'error',
}

/** STATUS_TONES key for a caller-supplied menu item colour (neutral when unknown). */
export function itemStatusTone(color) {
  const cls = color ? ITEM_TONES[String(color).toLowerCase()] : undefined
  return ITEM_STATUS_TONES[cls] || 'neutral'
}

/** { className, style } for a caller-supplied menu item colour. */
export function itemTone(color) {
  if (!color) return { className: '', style: undefined }
  const cls = ITEM_TONES[String(color).toLowerCase()]
  return cls ? { className: cls, style: undefined } : { className: '', style: { color } }
}
