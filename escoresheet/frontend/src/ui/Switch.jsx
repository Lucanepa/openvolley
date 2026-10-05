// Switch (role="switch") and SwitchCard (a whole-card switch with title + hint).
//
//   md   h-5 w-9 track, h-4 thumb       App.tsx:10373-10381
//   lg   h-7 w-12 track, h-6 thumb      AdminConsole.tsx:6364 (the mail kill switch)
//   tone 'brand' = bg-red-600 when on (App.tsx:10375); 'amber' = bg-amber-500,
//        for a mode that changes what the app does (test mode, AdminConsole.tsx:6364)
//   SwitchCard  App.tsx:10362-10397: the card itself turns red while on, because
//        turning it on is the choice with a consequence; busy spinner on the right.
import { Loader2 } from 'lucide-react';
import { cn } from './cn.js';
import { FOCUS_RING } from './Button.jsx';

const TRACK = {
  md: 'relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors',
  lg: 'relative inline-flex h-7 w-12 shrink-0 rounded-full transition-colors',
};
const THUMB = {
  md: 'mt-0.5 inline-block h-4 w-4 rounded-full bg-white shadow transition-transform',
  lg: 'mt-0.5 inline-block h-6 w-6 rounded-full bg-white shadow transform transition-transform',
};
const THUMB_ON = { md: 'translate-x-4.5', lg: 'translate-x-5' };
const ON = { brand: 'bg-red-600', amber: 'bg-amber-500' };
const OFF = 'bg-stone-300';

/** The visual track + thumb only; for use inside another control (SwitchCard). */
export function SwitchTrack({ checked, size = 'md', tone = 'brand', className }) {
  return (
    <span aria-hidden="true" className={cn(TRACK[size], checked ? ON[tone] : OFF, className)}>
      <span className={cn(THUMB[size], checked ? THUMB_ON[size] : 'translate-x-0.5')} />
    </span>
  );
}

/**
 * Bare switch. Give it a name: `aria-label`, or `aria-labelledby` pointing at
 * the visible heading next to it (AdminConsole.tsx:6362 puts it beside an h2).
 * @param {object} props
 * @param {boolean} props.checked
 * @param {(next: boolean) => void} props.onCheckedChange
 * @param {'md'|'lg'} [props.size]
 * @param {'brand'|'amber'} [props.tone]
 */
export function Switch({ checked, onCheckedChange, size = 'md', tone = 'brand', disabled, className, ...rest }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange?.(!checked)}
      className={cn(TRACK[size], checked ? ON[tone] : OFF, FOCUS_RING, 'disabled:opacity-50', className)}
      {...rest}
    >
      <span className={cn(THUMB[size], checked ? THUMB_ON[size] : 'translate-x-0.5')} />
    </button>
  );
}

/**
 * A setting with a title and a sentence of why, the whole card clickable.
 * `count` is shown after the title in tabular figures (App.tsx:10388-10392).
 */
export function SwitchCard({ checked, onCheckedChange, title, hint, count, busy = false, disabled, className }) {
  return (
    <div className={cn(
      'rounded-xl border p-3 transition-colors',
      checked ? 'border-red-300 bg-red-50/70' : 'border-stone-200 bg-stone-50',
      className,
    )}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-busy={busy || undefined}
        disabled={disabled || busy}
        onClick={() => onCheckedChange?.(!checked)}
        className={cn('flex w-full items-center gap-3 rounded-lg text-left disabled:opacity-60', FOCUS_RING)}
      >
        <SwitchTrack checked={checked} />
        <span className="min-w-0 flex-1">
          <span className={cn('block text-sm font-semibold', checked ? 'text-red-800' : 'text-stone-700')}>
            {title}
            {count != null && <span className="ml-1.5 font-normal tabular-nums opacity-70">({count})</span>}
          </span>
          {hint && <span className="mt-0.5 block text-[11px] leading-snug text-stone-500">{hint}</span>}
        </span>
        {busy && <Loader2 size={14} className="shrink-0 animate-spin text-stone-400" aria-hidden="true" />}
      </button>
    </div>
  );
}

export default Switch;
