// volleyui — page titles.
//
// TitleCard      — the in-app title: a white card at the top of a list screen,
//                  title left, logo right. svrz_rc src/App.tsx:6749-6757.
// ReadingHeader  — a standalone page's header on the bare stone page: kicker
//                  over a big title, logo (and a DE/EN switch) on the right.
//                  svrz_rc src/components/InfosPage.tsx:107-128,
//                  GuidePage.tsx:136-142, CoacheeFilePage.tsx:201-224.
// PageLead       — the one-paragraph intro under a ReadingHeader.
//                  InfosPage.tsx:130.
// CenteredBrand  — logo + eyebrow centred above a narrow public form.
//                  SurveyPage.tsx:89-96.
import { cn } from './cn.js';

/**
 * @param {React.ReactNode} props.title     sentence case.
 * @param {React.ReactNode} [props.eyebrow] org name; hidden below sm.
 * @param {React.ReactNode} [props.logo]    sized h-10 w-auto.
 * @param {React.ReactNode} [props.actions] optional, placed before the logo.
 */
export function TitleCard({ title, eyebrow, logo, actions, className }) {
  return (
    <div className={cn('bg-white p-4 sm:p-5 rounded-2xl shadow-card border border-stone-200/70 mb-4 flex items-center sm:items-start gap-4 no-print', className)}>
      <div className="flex-1 min-w-0">
        <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-stone-900">{title}</h1>
        {eyebrow && (
          <p className="hidden sm:block text-[11px] font-semibold uppercase tracking-[0.12em] text-stone-400 mt-0.5">{eyebrow}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2 self-center">{actions}</div>}
      {logo && <div className="flex flex-col items-center justify-center gap-2 self-center sm:self-start">{logo}</div>}
    </div>
  );
}

/**
 * @param {React.ReactNode} props.kicker  eyebrow over the title.
 * @param {React.ReactNode} props.title
 * @param {React.ReactNode} [props.logo]  sized h-9 sm:h-11 w-auto.
 * @param {React.ReactNode} [props.aside] under the logo, right-aligned — the
 *   language switch (Segmented variant="pill").
 * @param {'mb-6'|'mb-8'} [props.spacing='mb-6'] GuidePage uses mb-8.
 */
export function ReadingHeader({ kicker, title, logo, aside, spacing = 'mb-6', className }) {
  return (
    <header className={cn('flex items-start justify-between gap-4', spacing, className)}>
      <div className="min-w-0">
        {kicker && <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-400">{kicker}</p>}
        <h1 className="mt-1 text-2xl sm:text-3xl font-bold tracking-tight text-stone-900">{title}</h1>
      </div>
      {(logo || aside) && (
        <div className="flex flex-col items-end gap-3 shrink-0">
          {logo}
          {aside}
        </div>
      )}
    </header>
  );
}

export function PageLead({ className, children }) {
  return <p className={cn('text-sm sm:text-base leading-relaxed text-stone-600 mb-6', className)}>{children}</p>;
}

/**
 * @param {React.ReactNode} props.logo     sized h-9 w-auto.
 * @param {React.ReactNode} [props.eyebrow] held at its height even when empty,
 *   so the line does not jump when text arrives (SurveyPage.tsx:90-96).
 */
export function CenteredBrand({ logo, eyebrow, className }) {
  return (
    <div className={cn('flex flex-col items-center mb-5', className)}>
      {logo}
      <p className="min-h-[1rem] text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-400 mt-3 text-center">{eyebrow}</p>
    </div>
  );
}

export default TitleCard;
