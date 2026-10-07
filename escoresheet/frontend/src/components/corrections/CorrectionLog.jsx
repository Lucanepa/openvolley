// The correction log (match.manualChanges), read-only and shown to the
// referee: one sentence per correction, newest first. Entries written before
// the sentences existed go through describeLegacyChange (never raw JSON).
import { describeLegacyChange, tr } from '../../domain/describe'
import { SectionCard, EmptyLine } from './shared.jsx'

function when(ts) {
  const ms = Date.parse(ts)
  if (!Number.isFinite(ms)) return ''
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export default function CorrectionLog({ changes, ctx }) {
  const t = ctx.t
  const list = [...(changes || [])].reverse()
  return (
    <SectionCard
      title={tr(t, 'corrections.section.log', 'Correction log (shown to the referee)')}
      count={list.length}
    >
      {list.length === 0 ? (
        <EmptyLine>{tr(t, 'corrections.empty.log', 'No corrections yet.')}</EmptyLine>
      ) : (
        <ol className="divide-y divide-stone-100">
          {list.map((c, i) => (
            <li key={`${c.ts}-${i}`} className="flex gap-3 py-2 text-sm">
              <time className="w-11 shrink-0 tabular-nums text-xs text-stone-500 pt-0.5" dateTime={c.ts}>{when(c.ts)}</time>
              <span className="min-w-0 text-stone-800">{describeLegacyChange(c, t)}</span>
            </li>
          ))}
        </ol>
      )}
    </SectionCard>
  )
}
