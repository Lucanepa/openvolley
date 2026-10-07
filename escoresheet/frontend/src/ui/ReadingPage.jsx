// volleyui — frames for pages that live outside the app's navigation.
//
// ReadingPage — a public / standalone page (guide, info library, a personal
//   file behind a PIN): no nav, centred column, generous top padding.
//   svrz_rc src/components/InfosPage.tsx:105-106 (max-w-5xl),
//   GuidePage.tsx:134-135 (max-w-3xl), CoacheeFilePage.tsx:199-200 (max-w-2xl).
// FormPage    — a public one-task form (survey, signature): centred narrow
//   column. SurveyPage.tsx:88-89 (max-w-xl), SignaturePage.tsx:38-39 (max-w-md).
// GateScreen  — sign-in / no-connection / error: one card in the middle of the
//   screen. AuthGate.tsx:453-470, AdminConsole.tsx:1149-1186.
import { cn } from './cn.js';

const READING_WIDTH = {
  '2xl': 'max-w-2xl', // a form-like personal page
  '3xl': 'max-w-3xl', // prose: a guide, an explainer
  '5xl': 'max-w-5xl', // a library of cards (grid sm:2 lg:3)
};

export function ReadingPage({ width = '3xl', className, children }) {
  return (
    <div className="min-h-screen bg-gradient-to-b from-stone-50 to-stone-100">
      <div className={cn('mx-auto w-full px-4 py-8 sm:py-12', READING_WIDTH[width] || width, className)}>
        {children}
      </div>
    </div>
  );
}

const FORM_WIDTH = { md: 'max-w-md', xl: 'max-w-xl' };

export function FormPage({ width = 'xl', className, children }) {
  return (
    <div className="min-h-screen bg-gradient-to-b from-stone-50 to-stone-100 flex flex-col items-center p-4">
      <div className={cn('w-full mt-6 mb-10', FORM_WIDTH[width] || width, className)}>{children}</div>
    </div>
  );
}

/**
 * @param {React.ReactNode} [props.logo]     sized h-11 w-auto.
 * @param {React.ReactNode} [props.eyebrow]  under the logo.
 * @param {React.ReactNode} [props.corner]   top-right control, e.g. the
 *   language toggle: `inline-flex items-center gap-1 text-[11px] font-semibold
 *   text-stone-400 hover:text-stone-600` (AuthGate.tsx:460-466).
 * @param {React.ReactNode} [props.footer]   line under the card (AdminConsole.tsx:1185).
 * @param {boolean} [props.brandBar=true]    the 4px brand gradient on top.
 * @param {'sm'|'md'} [props.width='sm']     'md' for a longer public form
 *   (sign-up): the standalone `md` cap (shell.md).
 */
export function GateScreen({ logo, eyebrow, corner, footer, brandBar = true, width = 'sm', className, children }) {
  return (
    <div className="min-h-screen bg-gradient-to-br from-stone-100 via-stone-50 to-stone-100 flex items-center justify-center p-4">
      <div className={cn('w-full', width === 'md' ? 'max-w-md' : 'max-w-sm')}>
        <div className={cn('relative overflow-hidden bg-white rounded-3xl shadow-card-lg border border-stone-200/70 p-8', className)}>
          {brandBar && <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-red-600 to-red-500" />}
          {corner && <div className="absolute right-4 top-4">{corner}</div>}
          {(logo || eyebrow) && (
            <div className="flex flex-col items-center text-center mb-7">
              {logo}
              {eyebrow && <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-400 mt-4">{eyebrow}</p>}
            </div>
          )}
          {children}
        </div>
        {footer && <p className="text-center text-[11px] font-medium uppercase tracking-[0.12em] text-stone-400 mt-5">{footer}</p>}
      </div>
    </div>
  );
}

export default ReadingPage;
