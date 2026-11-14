import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, Upload } from 'lucide-react'
import Modal from './Modal'
import { Button } from '../ui'
import { parseGames, parseRosters } from '../domain/globalImport'
import { fold } from '../domain/globalImport'
import { downloadGlobalTemplate } from '../utils/globalTemplates'

/**
 * Global tool: upload an Excel/CSV of games or of rosters (domain/globalImport).
 * The file is read here and never stored or sent anywhere.
 *   kind 'games'   -> onPickGame(game)
 *   kind 'rosters' -> onApplyTeam(side, team); a team named like the home or
 *                     away team goes to that side, the rest are offered both
 */
export default function GlobalImportModal({ open, kind, onClose, onPickGame, onApplyTeam, homeName = '', awayName = '' }) {
  const { t } = useTranslation()
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState('')

  const close = () => { setResult(null); setFailed(''); onClose() }

  const readFile = async (file) => {
    if (!file) return
    setBusy(true); setFailed(''); setResult(null)
    try {
      const codec = await import('../lib/xlsxCodec')
      let rows; let date1904 = false
      if (/\.(csv|txt)$/i.test(file.name)) {
        const raw = await file.text()
        const sep = raw.split('\n')[0].includes(';') ? ';' : raw.split('\n')[0].includes('\t') ? '\t' : ','
        rows = raw.split(/\r?\n/).map((l) => l.split(sep).map((c) => c.replace(/^"|"$/g, '').trim()))
      } else {
        if (!codec.XLSX_AVAILABLE) throw new Error('xlsx')
        const wb = codec.readWorkbook(await file.arrayBuffer())
        date1904 = wb.date1904
        rows = wb.sheets[0]?.rows || []
      }
      const parsed = kind === 'games' ? parseGames(rows, { date1904 }) : parseRosters(rows, { date1904 })
      if (!parsed.ok) setFailed(parsed.error === 'empty' ? 'empty' : 'columns')
      else setResult(parsed)
    } catch {
      setFailed('file')
    } finally {
      setBusy(false)
    }
  }

  const download = () => downloadGlobalTemplate(kind)

  const sideOf = (name) => (name && fold(name) === fold(homeName) ? 'home' : name && fold(name) === fold(awayName) ? 'away' : null)

  return (
    <Modal open={open} onClose={close} width={640} title={kind === 'games' ? t('globalImport.gamesTitle', 'Import games') : t('globalImport.rostersTitle', 'Import rosters')}>
      <div className="ov-kit space-y-3" data-testid="global-import">
        <p className="m-0 text-sm text-stone-600">
          {kind === 'games'
            ? t('globalImport.gamesHint', 'An Excel or CSV file with one row per game: game, date, time, hall, city, league, home, away, best of, referees. Nothing is stored: the file is read on this device.')
            : t('globalImport.rostersHint', 'An Excel or CSV file with one row per person: team, number, first name, last name, role (player, libero, captain, coach...), date of birth. Nothing is stored: the file is read on this device.')}
        </p>
        <div className="flex flex-wrap gap-2">
          <label className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-xl bg-stone-900 px-4 text-sm font-semibold text-white">
            <Upload size={16} aria-hidden="true" />
            {busy ? t('home.preparing') : t('globalImport.choose', 'Choose file')}
            <input type="file" accept=".xlsx,.csv,.txt" className="sr-only" data-testid="global-import-file" onChange={(e) => { readFile(e.target.files?.[0]); e.target.value = '' }} />
          </label>
          <Button variant="secondary" size="lg" icon={Download} onClick={download}>{t('globalImport.template', 'Template')}</Button>
        </div>
        {failed && (
          <p className="m-0 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800" role="alert" data-testid="global-import-error">
            {failed === 'file' ? t('globalImport.errFile', 'The file could not be read.')
              : failed === 'empty' ? t('globalImport.errEmpty', 'The file has no rows.')
                : t('globalImport.errColumns', 'The columns were not found. Use the template.')}
          </p>
        )}
        {result?.games && (
          <ul className="m-0 max-h-72 list-none space-y-1 overflow-auto p-0" data-testid="global-import-games">
            {result.games.map((g, i) => (
              <li key={i}>
                <button type="button" className="flex w-full items-center justify-between gap-3 rounded-lg border border-stone-200 bg-white px-3 py-2 text-left hover:bg-stone-50"
                  onClick={() => { onPickGame(g); close() }}>
                  <span className="min-w-0 truncate text-sm font-semibold">{g.gameN ? `#${g.gameN} ` : ''}{g.home} – {g.away}</span>
                  <span className="shrink-0 text-xs tabular-nums text-stone-500">{[g.date, g.time, g.hall].filter(Boolean).join(' · ')}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {result?.teams && (
          <ul className="m-0 list-none space-y-2 p-0" data-testid="global-import-teams">
            {result.teams.map((team, i) => {
              const fixed = sideOf(team.name)
              return (
                <li key={i} className="flex items-center justify-between gap-3 rounded-lg border border-stone-200 bg-white px-3 py-2">
                  <span className="min-w-0 truncate text-sm">
                    <span className="font-semibold">{team.name || t('globalImport.noTeamName', '(no team name)')}</span>
                    <span className="ml-2 text-xs text-stone-500">{t('globalImport.counts', { players: team.players.length, staff: team.bench.length, defaultValue: '{{players}} players, {{staff}} staff' })}</span>
                  </span>
                  <span className="flex shrink-0 gap-2">
                    {(!fixed || fixed === 'home') && <Button variant="secondary" size="lg" onClick={() => { onApplyTeam('home', team); close() }}>{t('matchSetup.homeTeam')}</Button>}
                    {(!fixed || fixed === 'away') && <Button variant="secondary" size="lg" onClick={() => { onApplyTeam('away', team); close() }}>{t('matchSetup.awayTeam')}</Button>}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
        {result?.warnings?.length > 0 && (
          <p className="m-0 text-xs text-amber-800" data-testid="global-import-warnings">{t('globalImport.warnings', { count: result.warnings.length, defaultValue: '{{count}} rows were not clean: {{list}}', list: result.warnings.slice(0, 3).join('; ') })}</p>
        )}
      </div>
    </Modal>
  )
}
