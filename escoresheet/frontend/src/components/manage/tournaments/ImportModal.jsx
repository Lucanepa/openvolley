import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, FileSpreadsheet } from 'lucide-react'
import KitModal from '../KitModal'
import { InlineError } from '../common'
import { tournamentApi } from '../../../lib/tournamentApi'
import { columnLabel, decodeText, parseCsv, readImportSheets, templateFileName, templateSheets } from '../../../domain/beachImport'
import { Button, Chip, Notice, RowList, SectionHeader, StatusPill, dayTimeLabel, toast } from '../../../ui'
import { useDrawName, useTournamentError } from './shared'

const STATUS_TONE = { ok: 'done', warning: 'todo', error: 'brand' }
const SHOWN = 150
const SUMMARY = ['draws_new', 'entries_new', 'entries_changed', 'entries_removed', 'entries_unchanged', 'brackets', 'matches_changed', 'courts_new']
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/** The bytes of a File (FileReader where Blob.arrayBuffer is missing). */
function fileBytes(file) {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer()
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result)
    r.onerror = () => reject(r.error)
    r.readAsArrayBuffer(file)
  })
}

function download(fileName, bytes) {
  const url = URL.createObjectURL(new Blob([bytes], { type: XLSX_TYPE }))
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** The texts of the import's messages (rows, draws, problems), with their names localised. */
function useImportText() {
  const { t, i18n } = useTranslation()
  const drawName = useDrawName()
  const lang = i18n?.language || 'en'
  const drawOf = (m) => (m.category ? drawName({ category: m.category, gender: m.gender }) : '')
  const message = (m) => {
    if (m.code === 'slot_conflict') return t(`tournaments.slotConflicts.${m.reason}`, { n: m.game, code: m.match_code })
    if (m.code === 'too_few_teams' || m.code === 'board_courts') {
      return t('tournaments.import.msg.drawWarning', { draw: drawOf(m), text: t(`tournaments.warnings.${m.code}`, m) })
    }
    const params = {
      ...m,
      draw: drawOf(m),
      field: m.field ? columnLabel(m.field, lang) : '',
      expected: m.code === 'phase_mismatch' ? t(`tournaments.phases.${m.expected}`) : m.expected
    }
    if (m.code === 'date_outside') for (const k of ['date', 'starts_on', 'ends_on']) params[k] = dayTimeLabel(m[k])
    if (m.code === 'reinstated') params.status = t(`tournaments.import.entryStatus.${m.status}`)
    return t(`tournaments.import.msg.${m.code}`, params)
  }
  const problem = (p) => t(`tournaments.import.problems.${p.code}`, {
    ...p,
    kind: p.kind ? t(`tournaments.import.kinds.${p.kind}`) : '',
    columns: (p.columns || []).map((c) => `«${columnLabel(c, lang)}»`).join(', ')
  })
  return { message, problem, drawOf, lang }
}

/** One line of the diff: what happens to a pair, a game, a draw or a court. */
function useChangeLines(preview) {
  const { t } = useTranslation()
  const drawName = useDrawName()
  if (!preview) return []
  const drawOfKey = new Map(preview.draws.map((d) => [d.key, drawName(d)]))
  const value = (field, v) => {
    if (v == null || v === '') return '–'
    if (field === 'player1' || field === 'player2') return [v.first, v.last].filter(Boolean).join(' ') + (v.licence ? ` (${v.licence})` : '') + (v.country ? ` ${v.country}` : '')
    if (field === 'scheduled_at') return dayTimeLabel(v)
    if (field === 'wildcard') return v ? t('tournaments.import.yes') : t('tournaments.import.no')
    if (field === 'status') return t(`tournaments.import.entryStatus.${v}`, v)
    if (field === 'team_id') return t('tournaments.import.linked')
    if (field === 'court') return t('tournaments.courtN', { n: v })
    return String(v)
  }
  const changeText = (c) => `${t(`tournaments.import.fields.${c.field}`)}: ${value(c.field, c.from)} → ${value(c.field, c.to)}`
  const lines = []
  for (const d of preview.draws) {
    if (d.op === 'new') lines.push({ key: `d-${d.key}`, op: 'new', title: t('tournaments.import.drawNew', { draw: drawName(d) }) })
    if (d.bracket) {
      lines.push({
        key: `b-${d.key}`, op: 'new',
        title: t('tournaments.import.bracket', { draw: drawName(d), teams: d.bracket.teams, size: d.bracket.board_size, first: d.bracket.first_game, last: d.bracket.last_game })
      })
    }
  }
  for (const c of preview.courts) lines.push({ key: `c-${c.number}`, op: 'new', title: t('tournaments.import.courtNew', { n: c.number }) })
  for (const e of preview.entries) {
    const meta = e.op === 'new'
      ? [e.values.seed != null ? t('tournaments.import.seedN', { n: e.values.seed }) : null, e.saved_pair ? t('tournaments.import.savedPair', { name: e.saved_pair }) : null].filter(Boolean).join(' · ')
      : e.op === 'changed' ? e.changes.map(changeText).join(' · ') : ''
    lines.push({ key: `e-${e.entry_id || e.row}-${e.key}`, op: e.op, title: `${drawOfKey.get(e.key) || ''} · ${e.name}`, meta })
  }
  for (const m of preview.matches) {
    lines.push({
      key: `m-${m.game_n}`, op: 'changed',
      title: `${t('tournaments.import.gameLine', { n: m.game_n, code: m.code })} · ${drawOfKey.get(m.key) || ''}`,
      meta: m.changes.map(changeText).join(' · ')
    })
  }
  return lines
}

/**
 * The Excel/CSV import of a tournament (plan 3.4, phase T2): the template,
 * the file read in the browser, the server's preview (per row OK / warning /
 * error, the changes), and the apply with the preview's hash. Nothing
 * changes before "Apply"; a tournament changed meanwhile shows the new
 * preview instead.
 */
export default function ImportModal({ open, bundle, onClose, onApplied }) {
  const { t } = useTranslation()
  const errorText = useTournamentError()
  const { message, problem, lang } = useImportText()
  const fileInput = useRef(null)
  const [codec, setCodec] = useState(null)
  const [files, setFiles] = useState([])
  const [read, setRead] = useState(null) // readImportSheets()
  const [preview, setPreview] = useState(null)
  const [stale, setStale] = useState(false)
  const [busy, setBusy] = useState(null) // 'read' | 'preview' | 'apply' | 'template'
  const [error, setError] = useState('')
  const lines = useChangeLines(preview)
  const tid = bundle?.tournament?.id

  // the XLSX reader and writer load with the dialog (web only; the Android build has a stub)
  useEffect(() => {
    if (!open || codec) return
    let alive = true
    import('../../../lib/xlsxCodec').then((m) => { if (alive) setCodec(m) }).catch(() => { if (alive) setCodec({ XLSX_AVAILABLE: false }) })
    return () => { alive = false }
  }, [open, codec])
  useEffect(() => {
    if (open) return
    setFiles([]); setRead(null); setPreview(null); setStale(false); setError(''); setBusy(null)
  }, [open])

  const xlsx = codec?.XLSX_AVAILABLE === true

  const downloadTemplate = () => {
    if (!xlsx) return
    const sheets = templateSheets(lang, {
      title: t('tournaments.import.template.title'),
      lines: [1, 2, 3, 4, 5].map((n) => t(`tournaments.import.template.line${n}`)),
      exampleHead: t('tournaments.import.template.example'),
      sheetNames: {
        entries: t('tournaments.import.kinds.entries'),
        matches: t('tournaments.import.kinds.matches'),
        info: t('tournaments.import.template.info')
      },
      examples: {
        draw: 'A1', gender: t('tournaments.genders.women'), seed: '1', team: 'Muster/Beispiel', wildcard: t('tournaments.import.no'),
        p1_last: 'Muster', p1_first: 'Anna', p1_licence: '12345', p1_country: 'SUI',
        p2_last: 'Beispiel', p2_first: 'Bea', p2_licence: '12346', p2_country: 'SUI',
        game: '1', date: '11.07.2026', time: '09:00', court: '1', phase: t('tournaments.phases.winners'), round: '1',
        team1: '1', team2: '8', referee: 'Max Meier', scorer: 'Eva Keller'
      }
    })
    download(templateFileName(bundle?.tournament), codec.writeWorkbook(sheets))
  }

  const check = async (payload) => {
    setBusy('preview')
    const res = await tournamentApi.importPreview(tid, payload)
    setBusy(null)
    if (res.error) return setError(errorText(res.error))
    setPreview(res.data)
  }

  const choose = async (e) => {
    const list = Array.from(e.target.files || [])
    e.target.value = ''
    if (!list.length) return
    setFiles(list.map((f) => f.name)); setRead(null); setPreview(null); setStale(false); setError('')
    setBusy('read')
    const sheets = []
    const problems = []
    for (const f of list) {
      const ext = f.name.toLowerCase().split('.').pop()
      try {
        if (ext === 'xls') {
          problems.push({ code: 'xls', file: f.name })
        } else if (ext === 'xlsx' && xlsx) {
          const wb = codec.readWorkbook(await fileBytes(f))
          for (const s of wb.sheets) sheets.push({ ...s, file: f.name, date1904: wb.date1904 })
        } else if (ext === 'csv' || ext === 'txt' || ext === 'tsv') {
          sheets.push({ name: f.name.replace(/\.[^.]+$/, ''), file: f.name, rows: parseCsv(decodeText(await fileBytes(f))) })
        } else problems.push({ code: 'unreadable', file: f.name })
      } catch {
        problems.push({ code: 'unreadable', file: f.name })
      }
    }
    const r = readImportSheets(sheets)
    const result = { ...r, problems: [...problems, ...r.problems] }
    setRead(result)
    setBusy(null)
    if (!result.problems.length) await check(result.payload)
  }

  const apply = async () => {
    if (!preview?.can_apply || busy) return
    setBusy('apply')
    setError('')
    const res = await tournamentApi.importApply(tid, read.payload, preview.hash)
    setBusy(null)
    if (res.error) {
      const fresh = res.error.details?.preview
      if (fresh) {
        setPreview(fresh)
        setStale(res.error.code === 'OV_IMPORT_CHANGED')
      }
      if (!fresh || res.error.code !== 'OV_IMPORT_CHANGED') setError(errorText(res.error))
      return
    }
    toast.success(t('tournaments.import.applied'))
    onApplied?.(res.data)
  }

  const rows = preview ? [
    ...preview.rows.entries.map((r) => ({ ...r, kind: 'entries' })),
    ...preview.rows.matches.map((r) => ({ ...r, kind: 'matches' }))
  ] : []
  const flagged = rows.filter((r) => r.status !== 'ok').sort((a, b) => (a.status === 'error' ? 0 : 1) - (b.status === 'error' ? 0 : 1))
  const okCount = rows.length - flagged.length
  const working = busy === 'read' || busy === 'preview'

  return (
    <KitModal
      open={open}
      onClose={() => { if (busy !== 'apply') onClose() }}
      size="xl"
      dismissible={false}
      title={t('tournaments.import.title')}
      closeLabel={t('common.close', 'Close')}
      footer={<>
        <Button variant="secondary" size="lg" onClick={onClose} disabled={busy === 'apply'}>{t('common.cancel', 'Cancel')}</Button>
        <Button variant="dark" size="lg" onClick={apply} loading={busy === 'apply'} disabled={!preview?.can_apply || !!busy} data-testid="import-apply">
          {t('tournaments.import.apply')}
        </Button>
      </>}
    >
      <div className="space-y-4">
        <p className="text-xs text-stone-600">{t('tournaments.import.intro')}</p>
        <div className="flex flex-wrap gap-2">
          {xlsx && (
            <Button variant="ghost" size="sm" icon={Download} onClick={downloadTemplate} data-testid="import-template">{t('tournaments.import.template.download')}</Button>
          )}
          <Button variant="secondary" size="sm" icon={FileSpreadsheet} onClick={() => fileInput.current?.click()} loading={working} disabled={!!busy || !codec} data-testid="import-choose">
            {t('tournaments.import.choose')}
          </Button>
          <input
            ref={fileInput}
            type="file"
            multiple
            accept={xlsx ? `.xlsx,.csv,.txt,.tsv,${XLSX_TYPE},text/csv` : '.csv,.txt,.tsv,text/csv'}
            className="hidden"
            onChange={choose}
            data-testid="import-file"
            aria-label={t('tournaments.import.choose')}
          />
        </div>
        {files.length > 0 && !read && <p className="text-xs text-stone-500 break-all">{files.join(' · ')}</p>}
        {working && <p className="text-xs text-stone-500" role="status">{t(busy === 'read' ? 'tournaments.import.reading' : 'tournaments.import.checking')}</p>}

        {read && (
          <div className="space-y-2">
            {read.found.map((f) => (
              <p key={f.name} className="text-xs text-stone-600">
                <span className="font-medium text-stone-800">{f.name}</span>
                {' · '}{t(`tournaments.import.kinds.${f.kind}`)}{' · '}
                <span className="tabular-nums">{t('tournaments.import.rowsCount', { count: f.rows })}</span>
                {f.unknown.length > 0 && <span className="block text-stone-400">{t('tournaments.import.ignoredColumns', { columns: f.unknown.join(', ') })}</span>}
              </p>
            ))}
            {read.problems.map((p, i) => <Notice key={i}>{problem(p)}</Notice>)}
          </div>
        )}

        {preview && (
          <div className="space-y-4" data-testid="import-preview">
            {stale && <Notice tone="warning">{t('tournaments.import.changed')}</Notice>}
            <div className="flex flex-wrap gap-1.5">
              {SUMMARY.filter((k) => preview.summary[k] > 0).map((k) => (
                <Chip key={k}><span className="tabular-nums">{t(`tournaments.import.summary.${k}`, { count: preview.summary[k] })}</span></Chip>
              ))}
            </div>
            {preview.summary.errors > 0
              ? <Notice>{t('tournaments.import.hasErrors')}</Notice>
              : !preview.can_apply && <Notice tone="info">{t('tournaments.import.nothingToChange')}</Notice>}
            {preview.warnings.map((w, i) => <Notice key={i} tone="warning">{message(w)}</Notice>)}

            {rows.length > 0 && (
              <section>
                <SectionHeader title={t('tournaments.import.rows')} count={flagged.length} />
                {flagged.length > 0 && (
                  <RowList soft className="mt-1">
                    {flagged.slice(0, SHOWN).map((r) => (
                      <div key={`${r.kind}-${r.row}`} className="flex items-start gap-3 py-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-stone-800">
                            {t(`tournaments.import.kinds.${r.kind}`)} · {t('tournaments.import.rowN', { n: r.row })}
                            {(r.name || r.game_n) && <span className="font-normal text-stone-500"> · {r.name || t('tournaments.import.gameLine', { n: r.game_n, code: r.code || '' })}</span>}
                          </p>
                          <ul className="mt-0.5 space-y-0.5">
                            {r.messages.map((m, i) => (
                              <li key={i} className={m.level === 'error' ? 'text-xs font-medium text-red-700' : 'text-xs text-amber-800'}>{message(m)}</li>
                            ))}
                          </ul>
                        </div>
                        <StatusPill tone={STATUS_TONE[r.status]}>{t(`tournaments.import.status.${r.status}`)}</StatusPill>
                      </div>
                    ))}
                  </RowList>
                )}
                <p className="mt-2 text-xs text-stone-500 tabular-nums">{t('tournaments.import.rowsOk', { count: okCount })}</p>
              </section>
            )}

            {lines.length > 0 && (
              <section>
                <SectionHeader title={t('tournaments.import.changes')} count={lines.length} />
                <RowList soft className="mt-1">
                  {lines.slice(0, SHOWN).map((l) => (
                    <div key={l.key} className="flex items-start gap-3 py-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-stone-800">{l.title}</p>
                        {l.meta && <p className="text-xs text-stone-500">{l.meta}</p>}
                      </div>
                      <StatusPill tone={l.op === 'removed' ? 'attention' : l.op === 'new' ? 'planned' : 'neutral'}>{t(`tournaments.import.ops.${l.op}`)}</StatusPill>
                    </div>
                  ))}
                </RowList>
                {lines.length > SHOWN && <p className="mt-2 text-xs text-stone-500 tabular-nums">{t('tournaments.import.more', { count: lines.length - SHOWN })}</p>}
              </section>
            )}
          </div>
        )}
        <InlineError error={error} />
      </div>
    </KitModal>
  )
}
