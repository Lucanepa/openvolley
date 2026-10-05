// Checkbox and Radio: native inputs tinted with `accent-red-600` (the brand),
// always inside their <label> so the whole row is the hit area.
//
//   Checkbox default  setting row: box + title + hint   AdminConsole.tsx:3213-3218
//   Checkbox dense    option row in a popover list      App.tsx:1235-1245
//   Checkbox card     bordered tile that tints when on  App.tsx:9899-9907
//   Radio             answer list                       SurveyPage.tsx:176-184
import { cn } from './cn.js';

const BOX = {
  default: 'mt-0.5 h-4 w-4 shrink-0 accent-red-600',
  dense: 'h-3.5 w-3.5 mt-0.5 shrink-0 rounded border-stone-300 accent-red-600',
  card: 'h-4 w-4 shrink-0 accent-red-600',
};
const ROW = {
  default: 'flex items-start gap-3 cursor-pointer',
  dense: 'flex items-start gap-2 px-2 py-1.5 text-sm hover:bg-stone-50 cursor-pointer',
  card: 'flex min-w-0 items-center gap-2.5 cursor-pointer rounded-lg border px-2.5 py-2 transition-colors',
};

/**
 * @param {object} props
 * @param {any} props.label
 * @param {any} [props.hint]   second line
 * @param {'default'|'dense'|'card'} [props.variant]
 */
export function Checkbox({ label, hint, variant = 'default', checked, disabled, className, inputClassName, ...rest }) {
  const isCard = variant === 'card';
  return (
    <label className={cn(
      ROW[variant],
      isCard && (checked ? 'border-red-300 bg-red-50/40' : 'border-stone-200'),
      disabled && 'cursor-default opacity-50',
      className,
    )}>
      <input type="checkbox" checked={checked} disabled={disabled} className={cn(BOX[variant], inputClassName)} {...rest} />
      {variant === 'dense' ? (
        <span className="min-w-0 break-words">{label}</span>
      ) : (
        <span className="min-w-0 flex-1">
          <span className={isCard ? 'block text-[13px] font-medium text-stone-800 leading-snug' : 'block text-sm font-medium text-stone-700'}>{label}</span>
          {hint && <span className={isCard ? 'block text-[10px] font-semibold uppercase tracking-wide text-stone-400' : 'block text-xs text-stone-400'}>{hint}</span>}
        </span>
      )}
    </label>
  );
}

/**
 * One radio option. Group them in
 * <div role="radiogroup" aria-label="…" className="flex flex-col gap-1.5"> (SurveyPage.tsx:174 uses `flex flex-col gap-1.5 mt-3`).
 * svrz_rc writes `text-red-600 focus:ring-red-500` on the input, which only takes
 * effect with @tailwindcss/forms; `accent-red-600` is added so the dot is brand red without it.
 */
export function Radio({ label, className, ...rest }) {
  return (
    <label className={cn('flex items-center gap-2.5 cursor-pointer group', className)}>
      <input type="radio" className="h-4 w-4 border-stone-300 text-red-600 accent-red-600 focus:ring-red-500" {...rest} />
      <span className="text-sm text-stone-600 group-hover:text-stone-900">{label}</span>
    </label>
  );
}

export default Checkbox;
