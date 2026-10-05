// Placeholders for data in flight, plus the "list is loading" switch between
// skeleton and branded spinner. Port of svrz_rc src/components/Skeleton.tsx:1-31
// and App.tsx:820-866 (ListLoading).
//
// Skeletons keep a page's real layout on screen during a load, so a list that is
// merely loading never looks like a list that is empty. The branded spinner is
// for moments with no shape to hold yet: the session check, a lazily loaded
// tool, a server round-trip inside a modal.
import { AppSpinner } from './AppSpinner.jsx';

export function Skeleton({ className = '' }) {
  return <div aria-hidden="true" className={`animate-pulse rounded bg-stone-200/80 ${className}`} />;
}

/** Two text lines + an optional status pill per row. Skeleton.tsx:15-29 */
export function SkeletonRows({ rows = 6, pill = true }) {
  return (
    <div className="divide-y divide-stone-100" role="status" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-3 py-3">
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-1/2" />
            <Skeleton className="h-3 w-1/3" />
          </div>
          {pill && <Skeleton className="h-5 w-16 rounded-full" />}
        </div>
      ))}
    </div>
  );
}

/** A form waiting for its data: label, two fields, a big area. AdminConsole.tsx:3064-3069 */
export function SkeletonForm() {
  return (
    <div className="space-y-3" role="status" aria-busy="true">
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-9 w-full rounded-lg" />
      <Skeleton className="h-9 w-full rounded-lg" />
      <Skeleton className="h-48 w-full rounded-lg" />
    </div>
  );
}

/**
 * The wait shown in place of a list. App.tsx:820-866.
 * `first` = the app's one-time bootstrap → branded spinner, padded to roughly
 * the list's height (`py-20`) so nothing jolts when data lands. Every later load
 * → skeleton rows, because the reader now knows the page's shape.
 * `framed` wraps the skeleton in the bordered box a table normally sits in.
 */
export function ListLoading({ label, first, rows = 6, pill = true, framed = false, className = 'py-20', mark }) {
  if (!first) {
    const skeleton = <SkeletonRows rows={rows} pill={pill} />;
    return framed ? <div className="border border-stone-200 rounded">{skeleton}</div> : skeleton;
  }
  return (
    <div className={`flex justify-center ${className}`}>
      <AppSpinner size={132} label={label} mark={mark} />
    </div>
  );
}

/** Same component under the rows port's name (svrz_rc Skeleton.tsx `SkeletonRows`). */
export const RowListSkeleton = SkeletonRows;

export default Skeleton;
