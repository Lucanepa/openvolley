// Select: the native <select> (use it by default: free keyboard, free phone
// picker), plus SelectTrigger for the rare custom popover (multi-pick, date range).
//
//   md  StatisticsAdmin.tsx:28 (`select`), used at :1003, :1008, :1014
//   lg  the lg Input shell (CoacheeFilePage.tsx:196) on a <select>, for page forms
//   SelectTrigger  App.tsx:1218 (multi-select) and App.tsx:986-990 (date range)
//   SELECT_PANEL   the popover under the trigger, App.tsx:993
//   SELECT_OPTION_ROW  a checkbox row in that panel, App.tsx:1235-1238
import { ChevronDown } from 'lucide-react';
import { cn } from './cn.js';
import { INPUT_INVALID } from './Input.jsx';

// `ov-select` (tokens.css) is the finish every size shares: appearance none,
// the chevron, no vertical padding, no text-transform. It also opts the select
// out of the legacy element rules in styles.css (`select:where(:not(.ov-select))`).
// Each size matches the Input of the same name: height, pl-3 (the text starts
// where an Input's does), pr-8 for the chevron, and a line height equal to the
// inner height (h - 2 px border), so the text is centred on every engine.
export const SELECT_BASE = 'ov-select';
export const SELECT_SIZES = {
  md: 'h-9 py-0 pl-3 pr-8 text-sm leading-[34px] rounded-lg border border-stone-300 bg-white text-stone-800 focus:outline-none focus:ring-2 focus:ring-red-500 disabled:bg-stone-50 disabled:text-stone-500 max-w-full',
  lg: 'h-11 py-0 pl-3 pr-9 text-base leading-[42px] rounded-xl border border-stone-200 bg-white text-stone-800 focus:outline-none focus:ring-2 focus:ring-red-700/20 focus:border-red-700/40 disabled:bg-stone-50 disabled:text-stone-500 max-w-full',
};

export const SELECT_PANEL = 'absolute z-50 mt-1 w-64 bg-white border border-stone-300 rounded shadow-lg p-3';
export const SELECT_OPTION_ROW = 'flex items-start gap-2 px-2 py-1.5 text-sm hover:bg-stone-50 cursor-pointer';

/**
 * @param {object} props
 * @param {'md'|'lg'} [props.size]
 * @param {Array<{value: string, label: any, disabled?: boolean}>} [props.options] or pass <option> children
 * @param {string} [props.placeholder] first, empty-valued option (svrz_rc's "Alle", StatisticsAdmin.tsx:1009)
 * @param {boolean} [props.invalid]
 * @param {boolean} [props.block] w-full (the native select is content-width otherwise)
 */
export function Select({ size = 'md', options, placeholder, invalid, block, className, children, ...rest }) {
  const bad = invalid || rest['aria-invalid'] === true || rest['aria-invalid'] === 'true';
  return (
    <select
      aria-invalid={bad || undefined}
      className={cn(SELECT_BASE, SELECT_SIZES[size] ?? SELECT_SIZES.md, block && 'w-full', bad && INPUT_INVALID, className)}
      {...rest}
    >
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options
        ? options.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)
        : children}
    </select>
  );
}

/**
 * The button that opens a custom popover. Pair it with SELECT_PANEL inside a
 * `relative` wrapper, and set aria-expanded yourself.
 */
export function SelectTrigger({ children, placeholder, className, type = 'button', ...rest }) {
  return (
    <button
      type={type}
      aria-haspopup="listbox"
      className={cn('h-9 w-full flex items-center justify-between gap-1 px-2 text-sm border border-stone-300 rounded bg-white outline-none focus-visible:ring-2 focus-visible:ring-red-400 text-left', className)}
      {...rest}
    >
      <span className={cn('truncate', children ? 'text-stone-700' : 'text-stone-400')}>{children || placeholder}</span>
      <ChevronDown className="w-4 h-4 text-stone-400 shrink-0" aria-hidden="true" />
    </button>
  );
}

export default Select;
