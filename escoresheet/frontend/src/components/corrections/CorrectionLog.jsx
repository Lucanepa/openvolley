// The correction log (match.manualChanges), read-only and shown to the
// referee: one sentence per correction, newest first. Entries written before
// the sentences existed go through describeLegacyChange (never raw JSON).
// In a match with technical remarks (domain/technicalRemarks.js) it is the
// list of the technical remarks: the corrections and the event lines kept
// off the scoresheet (an injury substitution, a bench injury), as Match End
// lists them.
import { useMemo } from 'react'
import { describeLegacyChange, tr } from '../../domain/describe'
import { technicalRemarks, technicalRemarksOn } from '../../domain/technicalRemarks'
import { timeLabel } from '../../ui/format'
import TechnicalRemarksList from '../TechnicalRemarksList.jsx'
import { SectionCard, EmptyLine } from './shared.jsx'

function when(ts) {
  const ms = Date.parse(ts)
  if (!Number.isFinite(ms)) return ''
  return timeLabel(ms)
}

export default function CorrectionLog({ changes, ctx, events = null }) {
  const t = ctx.t
  const technical = technicalRemarksOn(ctx.match)
  const items = useMemo(
    () => (technical ? technicalRemarks({ match: { manualChanges: changes }, events, t }) : []),
    [technical, changes, events, t]
  )
  if (technical) {
    return (
      <SectionCard
        title={tr(t, 'corrections.section.technical', 'Technical remarks')}
        hint={tr(t, 'corrections.technical.hint', 'Not printed on the scoresheet')}
        count={items.length}
      >
        <TechnicalRemarksList items={items} newestFirst emptyText={tr(t, 'corrections.empty.technical', 'No technical remarks yet.')} />
      </SectionCard>
    )
  }
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
