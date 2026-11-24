// The technical remarks of a match (domain/technicalRemarks.js): one line
// each, oldest first, with the time it was noted. Never printed on the
// scoresheet; Match End and the Corrections panel list them. volleyui kit.
import { timeLabel } from '../ui/format'

function when(ts) {
  const ms = Date.parse(ts)
  if (!Number.isFinite(ms)) return ''
  return timeLabel(ms)
}

export default function TechnicalRemarksList({ items, emptyText, newestFirst = false }) {
  const list = newestFirst ? [...(items || [])].reverse() : (items || [])
  if (!list.length) return <p className="py-2 text-sm text-stone-500">{emptyText}</p>
  return (
    <ol className="divide-y divide-stone-100" data-testid="technical-remarks-list">
      {list.map((r, i) => (
        <li key={`${r.ts}-${i}`} className="flex gap-3 py-2 text-sm" data-testid="technical-remark">
          <time className="w-11 shrink-0 tabular-nums text-xs text-stone-500 pt-0.5" dateTime={r.ts || undefined}>{when(r.ts)}</time>
          <span className="min-w-0 break-words text-stone-800">{r.text}</span>
        </li>
      ))}
    </ol>
  )
}
