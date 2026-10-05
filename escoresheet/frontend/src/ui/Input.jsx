// Input (text, email, url, date, time, month, number, password, search) and
// SearchInput. Heights follow the Button scale so a field and its button line up.
//
//   sm   h-8, in popovers and date-range panels    App.tsx:1042 (focus-visible red-400 ring)
//   md   h-9, every admin / editor field            AdminConsole.tsx:751 + BudgetCard.tsx:54
//   lg   h-11 rounded-xl, page and public forms     CoacheeFilePage.tsx:196, InfosPage.tsx:141
//   copy read-only monospace value to copy         App.tsx:10421
//
// invalid: AuthGate.tsx:149 swaps the border for `border-red-400 bg-red-50`.
// numeric: hides the browser spinners, App.tsx:10996.
import { Search } from 'lucide-react';
import { cn } from './cn.js';
import { renderIcon } from './Button.jsx';

export const INPUT_SIZES = {
  sm: 'h-8 w-full px-2 text-sm border border-stone-300 rounded bg-white outline-none focus-visible:ring-2 focus-visible:ring-red-400',
  md: 'h-9 w-full px-3 text-sm rounded-lg border border-stone-300 bg-white text-stone-800 focus:outline-none focus:ring-2 focus:ring-red-500',
  lg: 'w-full h-11 px-3 rounded-xl border border-stone-200 bg-white text-base text-stone-800 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-red-700/20 focus:border-red-700/40',
  // w-full: alone or in a Field it fills the line; in `flex gap-2` beside its copy button flex-1 wins.
  copy: 'w-full min-w-0 flex-1 h-9 rounded-lg border border-stone-200 bg-stone-50 px-2.5 font-mono text-[11px] text-stone-600',
};

export const INPUT_INVALID = 'border-red-400 bg-red-50';
export const INPUT_NUMERIC = '[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none';

// Leading-icon geometry. lg is svrz_rc's (InfosPage.tsx:134 icon, :141 pl-10;
// AuthGate.tsx:428). md and sm scale it down for the smaller heights.
const ICON_SLOT = {
  sm: { pad: 'pl-8', pos: 'left-2.5', px: 14 },
  md: { pad: 'pl-9', pos: 'left-3', px: 15 },
  lg: { pad: 'pl-10', pos: 'left-3.5', px: 16 },
};
const ICON_CLS = 'absolute top-1/2 -translate-y-1/2 text-stone-400 pointer-events-none';
// Trailing button slot (password eye): AuthGate.tsx:438-442.
const TRAILING_CLS = 'absolute right-3 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-600 transition-colors';

/**
 * @param {object} props
 * @param {'sm'|'md'|'lg'|'copy'} [props.size]
 * @param {any} [props.icon]      leading icon (lucide component or element)
 * @param {any} [props.trailing]  node pinned inside the right edge (e.g. a show-password button)
 * @param {boolean} [props.invalid]
 * @param {boolean} [props.numeric] hide number spinners (pair with inputMode="numeric"|"decimal")
 * @param {string} [props.wrapperClassName] when icon/trailing wrap the input in a relative div
 */
export function Input({ size = 'md', icon, trailing, invalid, numeric, className, wrapperClassName, ...rest }) {
  const bad = invalid || rest['aria-invalid'] === true || rest['aria-invalid'] === 'true';
  const slot = ICON_SLOT[size] ?? ICON_SLOT.md;
  const input = (
    <input
      aria-invalid={bad || undefined}
      className={cn(
        INPUT_SIZES[size],
        numeric && INPUT_NUMERIC,
        icon && slot.pad,
        trailing && 'pr-10',
        bad && INPUT_INVALID,
        className,
      )}
      {...rest}
    />
  );
  if (!icon && !trailing) return input;
  return (
    <div className={cn('relative', wrapperClassName)}>
      {icon && <span className={cn(ICON_CLS, slot.pos, 'inline-flex')}>{renderIcon(icon, slot.px)}</span>}
      {input}
      {trailing && <span className={TRAILING_CLS}>{trailing}</span>}
    </div>
  );
}

/**
 * Search field. 'lg' is the page search (InfosPage.tsx:133-143): magnifier,
 * rounded-xl, h-11. 'md' is the panel search without an icon (App.tsx:8711):
 * `h-10 ... rounded-lg ... focus-visible:ring-red-400`.
 * Always give it an aria-label: the placeholder is not a label.
 */
export function SearchInput({ size = 'lg', className, ...rest }) {
  if (size === 'lg') return <Input type="search" size="lg" icon={Search} className={cn('text-sm', className)} {...rest} />;
  return (
    <input
      type="search"
      className={cn('h-10 w-full px-3 text-sm border border-stone-300 rounded-lg bg-white outline-none focus-visible:ring-2 focus-visible:ring-red-400', className)}
      {...rest}
    />
  );
}

export default Input;
