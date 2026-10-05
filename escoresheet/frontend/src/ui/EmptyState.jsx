// Empty states. Ported from svrz_rc. Two sizes, chosen by where the list lives.
//
//   EmptyState - icon disc + one sentence, centred, for a whole tab/list that is empty
//                (App.tsx:8063 coachees, 8422 games).
//   EmptyLine  - one muted sentence under a SectionHeader on a dashboard (App.tsx:7560, 7597, 7617).
//   EmptyInset - padded sentence inside a framed list / sheet (App.tsx:8860, 8960, 10749).
//   EmptyInCard- a sentence inside a card (FinanceChair.tsx:53, AdminConsole.tsx:5349).
// A list that is LOADING is never shown as empty: render RowListSkeleton instead
// (App.tsx:8053-8061, Skeleton.tsx:1-9).
import { cn } from './cn.js';

/** icon: a lucide component (e.g. Users, CalendarDays), drawn at 26 / strokeWidth 1.75.
 *  `<EmptyState icon={Users}>No people found</EmptyState>` or `title` + a quieter `children` line. */
export function EmptyState({ icon: Icon, title, children, action, className }) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-3 py-14 px-4 text-center', className)}>
      {Icon && (
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-stone-100 text-stone-400">
          <Icon size={26} strokeWidth={1.75} />
        </div>
      )}
      {/* `title` is the one sentence; without a title, children are that sentence. */}
      <p className="text-sm font-medium text-stone-500">{title ?? children}</p>
      {title != null && children && <p className="max-w-sm text-xs text-stone-400">{children}</p>}
      {action}
    </div>
  );
}

export function EmptyLine({ className, children }) {
  return <p className={cn('py-3 text-sm text-stone-400', className)}>{children}</p>;
}

export function EmptyInset({ className, children }) {
  return <p className={cn('text-sm text-stone-500 p-4', className)}>{children}</p>;
}

export function EmptyInCard({ className, children }) {
  return <p className={cn('text-sm text-stone-400', className)}>{children}</p>;
}

export default EmptyState;
