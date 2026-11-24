// IconButton: an icon-only button. `label` is required: it becomes both the
// aria-label (screen readers) and the title (hover tooltip), as svrz_rc does
// on every icon button (App.tsx:6216, :7861, :8497; ui/Toast.tsx:64).
//
// Each variant is one svrz_rc recipe, copied whole:
//   outline    h-9 square, white, hairline shadow  App.tsx:8496 (calendar export in a game row)
//   outline-sm h-8 square, the day-pager arrows    App.tsx:7861, :7886
//   close      h-11 round ghost, sheet/dialog X    App.tsx:6217
//   subtle     44px on phones, 28px from sm        ui/Toast.tsx:66 (toast dismiss)
//   toolbar    h-11 toolbar cell, flex-1 on phone  App.tsx:6674 (fullscreen toggle)
//   tool       h-8 glyph button (B / I / U)        RichText.tsx:77
//   hint       16px round "i" trigger              InfoHint.tsx:62
import { cn } from './cn.js';
import { FOCUS_RING, renderIcon } from './Button.jsx';

export const ICON_BUTTON_VARIANTS = {
  outline: 'h-9 w-9 flex items-center justify-center border border-stone-300 rounded-md bg-white shadow-sm hover:border-stone-400 hover:bg-stone-50 transition-colors cursor-pointer',
  'outline-sm': 'h-8 w-8 shrink-0 flex items-center justify-center border border-stone-300 rounded hover:bg-stone-50 text-stone-500',
  close: 'h-11 w-11 inline-flex items-center justify-center rounded-full text-stone-500 hover:bg-stone-100',
  subtle: 'shrink-0 h-10 w-10 sm:h-7 sm:w-7 inline-flex items-center justify-center rounded text-stone-400 hover:text-stone-700 hover:bg-stone-100 transition-colors',
  toolbar: 'flex h-11 flex-1 sm:flex-none items-center justify-center bg-white px-4 rounded-lg shadow-sm border border-stone-200 hover:bg-stone-50 transition-colors',
  tool: 'h-8 min-w-8 px-2 rounded-lg border border-stone-200 text-xs font-medium text-stone-700 hover:bg-stone-100 transition-colors',
  hint: 'inline-flex items-center justify-center w-4 h-4 rounded-full text-stone-400 hover:text-sky-700 hover:bg-sky-50 focus:outline-none focus:ring-2 focus:ring-sky-500/50 transition-colors',
};

// Icon size + colour that svrz_rc pairs with each recipe.
const ICON = {
  outline: { px: 16, cls: 'text-stone-500' }, // App.tsx:8499
  'outline-sm': { px: 16 },                   // App.tsx:7862
  close: { px: 18 },                          // App.tsx:6219
  subtle: { px: 14 },                         // ui/Toast.tsx:68
  toolbar: { px: 18 },                        // App.tsx:6676
  tool: { px: 14 },
  hint: { px: 14 },
};

/**
 * @param {object} props
 * @param {string} props.label  required accessible name + tooltip
 * @param {any} props.icon      lucide component (sized for you) or an element
 * @param {'outline'|'outline-sm'|'close'|'subtle'|'toolbar'|'tool'|'hint'} [props.variant]
 * @param {boolean} [props.pressed] for toggles: sets aria-pressed (svrz_rc App.tsx:6670)
 */
export function IconButton({ label, icon, variant = 'outline', pressed, type = 'button', className, children, ...rest }) {
  const spec = ICON[variant] ?? ICON.outline;
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      className={cn(variant !== 'hint' && FOCUS_RING, ICON_BUTTON_VARIANTS[variant], className)}
      {...rest}
    >
      {renderIcon(icon, spec.px, spec.cls)}
      {children}
    </button>
  );
}

export default IconButton;
