// Field: label + control + hint + error, and FormError / FormNotice for the
// messages that belong to the whole form.
//
// Three label tones, each one svrz_rc recipe:
//   form     reading / public forms: sentence-case label over an h-11 input
//            CoacheeFilePage.tsx:229 (label), :242 (hint)
//   compact  inline editors on a tinted panel: small grey label, h-9 inputs
//            RcMeetingsAdmin.tsx:131-132
//   eyebrow  admin consoles and filter bars: small-caps label
//            AdminConsole.tsx:756 (`fieldLabel`), StatisticsAdmin.tsx:919
//
// The control is passed as the single child. Field gives it an id (unless it
// has one), points aria-describedby at the hint/error and sets aria-invalid
// when there is an error, so the Input/Select/Textarea turn red on their own.
import { Children, cloneElement, isValidElement, useId } from 'react';
import { cn } from './cn.js';

const TONES = {
  form: {
    wrap: 'block',
    label: 'block text-sm font-medium text-stone-700 mb-1.5',
    hint: 'mt-1.5 block text-xs text-stone-500',
  },
  compact: {
    wrap: 'block text-xs text-stone-500',
    label: 'block mb-0.5',
    hint: 'mt-1 block text-[11px] text-stone-400',
  },
  eyebrow: {
    wrap: 'block',
    label: 'block text-[11px] font-semibold uppercase tracking-wide text-stone-500 mb-1',
    hint: 'mt-1 block text-[11px] text-stone-400',
  },
};

// Inline error under a control: AuthGate.tsx:497 (`text-red-600 text-xs mt-2 font-medium`),
// with mt-1.5 so it sits where the hint would.
const ERROR = 'mt-1.5 block text-red-600 text-xs font-medium';

/**
 * @param {object} props
 * @param {any} props.label
 * @param {any} [props.hint]   help text under the control
 * @param {any} [props.error]  replaces the hint while set; marks the control invalid
 * @param {'form'|'compact'|'eyebrow'} [props.tone]
 * @param {boolean} [props.required] passed on to the control as the native attribute
 * @param {string} [props.className] on the wrapper (e.g. "flex-1 min-w-[12rem]")
 */
export function Field({ label, hint, error, tone = 'form', required, className, children }) {
  const auto = useId();
  const t = TONES[tone] ?? TONES.form;
  const child = Children.only(children);
  const id = (isValidElement(child) && child.props.id) || `f${auto}`;
  const msgId = `${id}-msg`;
  const message = error || hint;
  const control = isValidElement(child)
    ? cloneElement(child, {
        id,
        required: required ?? child.props.required,
        'aria-invalid': error ? true : child.props['aria-invalid'],
        'aria-describedby': message ? [child.props['aria-describedby'], msgId].filter(Boolean).join(' ') : child.props['aria-describedby'],
      })
    : child;
  return (
    <div className={cn(t.wrap, 'min-w-0', className)}>
      <label htmlFor={id} className={t.label}>{label}</label>
      {control}
      {message && <span id={msgId} className={error ? ERROR : t.hint}>{message}</span>}
    </div>
  );
}

/**
 * Form-level error box, above the actions. size 'sm' = RcMeetingsAdmin.tsx:161 /
 * AdminConsole.tsx:3220 (editors); 'md' = CoacheeFilePage.tsx:244 (page forms).
 */
export function FormError({ size = 'sm', className, children }) {
  if (!children) return null;
  return (
    <p role="alert" className={cn(size === 'md' ? 'text-sm' : 'text-xs', 'text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2', className)}>
      {children}
    </p>
  );
}

/** One-line outcome under a submitted form, green or red. App.tsx:11229-11231. */
export function FormNotice({ error = false, className, children }) {
  if (!children) return null;
  return (
    <p role={error ? 'alert' : 'status'} className={cn('text-sm font-medium', error ? 'text-red-600' : 'text-green-600', className)}>
      {children}
    </p>
  );
}

export default Field;
