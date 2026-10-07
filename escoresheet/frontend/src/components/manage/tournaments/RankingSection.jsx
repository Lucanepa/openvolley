import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Download } from 'lucide-react'
import { usePanelData } from '../common'
import { tournamentApi } from '../../../lib/tournamentApi'
import { rankingFileName } from '../../../domain/beachTournament'
import { Button, Card, CardHeading, Select, Table, EmptyInset, SkeletonRows, Notice, toast } from '../../../ui'
import { useDrawName, useTournamentError } from './shared'

/** Saves text as a file in the browser (a CSV for MyBeach). */
export function downloadText(fileName, text, type = 'text/csv;charset=utf-8') {
  // a BOM, so Excel opens the umlauts right
  const blob = new Blob(['\ufeff', text], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * The final ranking of a draw, in MyBeach order, with licences (managers
 * only): a table, a CSV download and a copy for typing it into MyBeach by
 * 12:00 the next day (Art. 29).
 */
export default function RankingSection({ bundle }) {
  const { t } = useTranslation()
  const errorText = useTournamentError()
  const drawName = useDrawName()
  const drawn = bundle.draws.filter(d => ['drawn', 'playing', 'done'].includes(d.status))
  const [drawId, setDrawId] = useState(drawn[0]?.id || '')
  const { data, error, loading } = usePanelData(() => tournamentApi.ranking(drawId), [drawId, bundle.matches], { enabled: !!drawId })

  const columns = [
    { key: 'rank', label: t('tournaments.rank'), numeric: true },
    { key: 'name', label: t('tournaments.team') },
    { key: 'players', label: t('tournaments.players') },
    { key: 'seed', label: t('tournaments.seed'), numeric: true }
  ]
  const player = (p) => [p?.last, p?.first].filter(Boolean).join(' ') + (p?.licence ? ` (${p.licence})` : '') + (p?.country ? ` ${p.country}` : '')
  const render = (row, col) => {
    if (col.key === 'rank') return <span className="tabular-nums font-semibold">{row.final_rank ? `${row.final_rank}.` : '–'}</span>
    if (col.key === 'seed') return <span className="tabular-nums">{row.seed ?? '–'}</span>
    if (col.key === 'players') return <span className="text-xs text-stone-600">{player(row.player1)} · {player(row.player2)}</span>
    return row.name
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(data.csv)
      toast.success(t('tournaments.copied'))
    } catch {
      toast.error(t('tournaments.copyFailed'))
    }
  }

  if (!drawn.length) return <Card><EmptyInset>{t('tournaments.noRanking')}</EmptyInset></Card>
  return (
    <Card>
      <CardHeading
        title={t('tournaments.sections.ranking')}
        hint={t('tournaments.rankingHint')}
        actions={data && <>
          <Button variant="ghost" size="sm" icon={Copy} onClick={copy}>{t('tournaments.copy')}</Button>
          <Button variant="dark" size="sm" icon={Download} onClick={() => downloadText(rankingFileName(bundle.tournament, data.draw), data.csv)} data-testid="ranking-csv">
            {t('tournaments.downloadCsv')}
          </Button>
        </>}
      />
      <Select value={drawId} onChange={e => setDrawId(e.target.value)} className="mb-3" aria-label={t('tournaments.sections.draws')}
        options={drawn.map(d => ({ value: d.id, label: drawName(d) }))} />
      {error && <Notice>{errorText(error)}</Notice>}
      {loading && !data ? <SkeletonRows rows={4} /> : data && (
        <>
          {!data.complete && <Notice tone="warning" className="mb-3">{t('tournaments.provisional')}</Notice>}
          <Table columns={columns} rows={data.ranking} render={render} rowKey={r => r.id} />
        </>
      )}
    </Card>
  )
}
