import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Check, ChevronRight, ClipboardCopy, Database, FileDown, History, Play, RefreshCw, Table2, Wand2, X } from 'lucide-react'
import { admin } from '../../../lib/accountApi'
import { OfflineBanner, PanelHead, useOnline } from '../common'
import { Banner, Button, IconButton, Input, Modal, Switch, confirmDialog, toast } from '../../../ui'
import CodeMirrorEditor from './CodeMirrorEditor'
import ResultsTable from './ResultsTable'
import { didYouMean, shortType, starterSelect } from './sqlSchema'
import { copyAsTable, downloadText, toCSV } from './exportResults'

/*
 * The SQL tab (super admins, lib/sqlWorkspace.js): a Postgres console.
 * Read mode reads every table by its plain name without the secret columns,
 * always rolled back. Write mode runs a preview first (rolled back, it shows
 * what would change); Commit runs the same SQL again and saves it. Every run
 * is audited on the server. The draft and the last 20 queries stay in this
 * browser (localStorage), nowhere else.
 */

const DRAFT_KEY = 'ov-sql-draft'
const RECENT_KEY = 'ov-sql-recent'
const MAX_RECENT = 20

function loadRecent() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]')
    return Array.isArray(parsed) ? parsed.slice(0, MAX_RECENT) : []
  } catch {
    return []
  }
}
function saveRecent(list) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, MAX_RECENT))) } catch { /* quota */ }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Swap a mistyped identifier for the suggested one (`me.game_nr` → `me.game_n`, the alias kept). */
export function applyIdentifierFix(sql, fix, suggestion) {
  const { name, qualifier } = fix.missing
  const pattern = qualifier
    ? new RegExp(`\\b${escapeRe(qualifier)}\\s*\\.\\s*${escapeRe(name)}\\b`, 'i')
    : new RegExp(`\\b${escapeRe(name)}\\b`, 'i')
  return sql.replace(pattern, suggestion)
}

export default function SqlPanel() {
  const { t } = useTranslation()
  const online = useOnline()
  const [sql, setSql] = useState(() => {
    try { return localStorage.getItem(DRAFT_KEY) ?? '' } catch { return '' }
  })
  const [writeMode, setWriteMode] = useState(false)
  const [schema, setSchema] = useState({ tables: [], server_version: null })
  const [schemaLoading, setSchemaLoading] = useState(true)
  const [schemaError, setSchemaError] = useState(null)
  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [result, setResult] = useState(null)
  // the SQL of the shown preview: Commit only while the editor still holds it
  const [previewSql, setPreviewSql] = useState(null)
  const [error, setError] = useState(null)
  const [errorSql, setErrorSql] = useState('')
  const [loading, setLoading] = useState(false)
  const [recent, setRecent] = useState(loadRecent)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const id = setTimeout(() => { try { localStorage.setItem(DRAFT_KEY, sql) } catch { /* quota */ } }, 400)
    return () => clearTimeout(id)
  }, [sql])

  const loadSchema = useCallback(async (refresh = false) => {
    setSchemaLoading(true)
    const res = await admin.sqlSchema({ refresh })
    setSchemaLoading(false)
    if (res.error) {
      setSchemaError(res.error)
      return
    }
    setSchemaError(null)
    setSchema(res.data || { tables: [] })
  }, [])
  useEffect(() => { loadSchema() }, [loadSchema])

  const tables = schema.tables || []
  const editorTables = useMemo(() => tables.map((tb) => ({
    name: tb.name,
    columns: tb.columns.map((c) => ({ name: c.name, dataType: c.data_type, values: c.values, pk: c.pk, ref: c.ref }))
  })), [tables])
  const fix = useMemo(() => (error?.message ? didYouMean(error.message, errorSql, editorTables) : null), [error, errorSql, editorTables])
  const shownTables = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return q ? tables.filter((tb) => tb.name.toLowerCase().includes(q) || tb.columns.some((c) => c.name.toLowerCase().includes(q))) : tables
  }, [tables, filter])

  const remember = (text) => {
    const next = [{ sql: text, ts: Date.now() }, ...recent.filter((r) => r.sql !== text)].slice(0, MAX_RECENT)
    setRecent(next)
    saveRecent(next)
  }

  const execute = useCallback(async ({ commit = false } = {}) => {
    const text = sql.trim()
    if (!text || loading) return
    setLoading(true)
    setError(null)
    const res = await admin.sqlRun({ sql: text, writeMode, commit })
    setLoading(false)
    if (res.error) {
      setError(res.error)
      setErrorSql(text)
      setResult(null)
      setPreviewSql(null)
      return
    }
    setResult(res.data)
    setPreviewSql(res.data?.write_mode && !res.data.committed ? text : null)
    remember(text)
    if (commit) {
      toast.success(t('manage.sql.committed'))
      loadSchema(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sql, writeMode, loading, recent, t, loadSchema])

  const commit = async () => {
    const yes = await confirmDialog({
      title: t('manage.sql.commitTitle'),
      message: t('manage.sql.commitBody'),
      confirmLabel: t('manage.sql.commit'),
      tone: 'danger'
    })
    if (yes) execute({ commit: true })
  }

  const insertStarter = (tb) => {
    if (sql.trim() && sql.trim() !== starterSelect(tb)) remember(sql.trim())
    setSql(starterSelect(tb))
    setSheetOpen(false)
  }
  const applyFix = (s) => {
    if (!fix) return
    setSql((cur) => applyIdentifierFix(cur, fix, s))
    setError(null)
  }
  const fileName = (ext) => `openvolley-sql-${new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+$/, '')}.${ext}`
  const exportCsv = () => result && downloadText(toCSV(result.columns, result.rows), fileName('csv'), 'text/csv;charset=utf-8')
  const copyTable = async () => {
    if (!result) return
    try {
      await copyAsTable(result.columns, result.rows)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      toast.error(t('manage.sql.copyFailed'))
    }
  }

  const isPreview = !!(result?.write_mode && !result.committed)
  const canCommit = isPreview && previewSql === sql.trim() && writeMode

  const schemaBrowser = (
    <div className="flex h-full min-h-0 flex-col" data-testid="sql-schema">
      <div className="mb-2 flex items-center gap-1.5">
        <Database size={14} className="shrink-0 text-stone-500" aria-hidden />
        <span className="text-xs font-semibold text-stone-800">{t('manage.sql.tables')}</span>
        <span className="ml-auto font-mono text-[10px] text-stone-500">{tables.length}</span>
        <IconButton variant="ghost" label={t('manage.sql.refreshSchema')} onClick={() => loadSchema(true)} className="h-7 w-7">
          <RefreshCw size={13} className={schemaLoading ? 'animate-spin motion-reduce:animate-none' : ''} aria-hidden />
        </IconButton>
      </div>
      <Input size="sm" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('manage.sql.filterTables')} aria-label={t('manage.sql.filterTables')} wrapperClassName="mb-2" />
      {schemaError && <p className="mb-2 text-xs text-red-700">{schemaError.message}</p>}
      <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-stone-200 bg-white">
        <ul className="divide-y divide-stone-100">
          {shownTables.map((tb) => {
            const open = expanded === tb.name
            return (
              <Fragment key={tb.name}>
                <li className="flex items-center">
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => setExpanded(open ? null : tb.name)}
                    className="flex min-h-9 min-w-0 flex-1 items-center gap-1.5 px-2 text-left hover:bg-stone-50"
                    title={tb.name}
                  >
                    <ChevronRight size={12} className={`shrink-0 text-stone-400 transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`} aria-hidden />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-stone-800">{tb.name}</span>
                    <span className="shrink-0 font-mono text-[10px] text-stone-400">{tb.columns.length}</span>
                  </button>
                  <button type="button" onClick={() => insertStarter(tb)} title={t('manage.sql.insertSelect')} className="shrink-0 px-2 py-1 font-mono text-[10px] font-semibold text-red-700 hover:bg-red-50">
                    SELECT
                  </button>
                </li>
                {open && [...tb.columns]
                  .sort((a, b) => Number(!!b.pk) - Number(!!a.pk) || a.name.localeCompare(b.name))
                  .map((c) => (
                    <li key={c.name} className="bg-stone-50 py-1 pl-6 pr-2 text-[11px]">
                      <div className="flex items-baseline gap-1.5">
                        <span className="min-w-0 flex-1 truncate font-mono text-stone-800" title={c.name}>{c.name}</span>
                        {c.pk && <span className="shrink-0 text-[9px] font-semibold uppercase text-red-700">pk</span>}
                        <span className="shrink-0 text-stone-500">{shortType(c.data_type)}{c.nullable ? '?' : ''}</span>
                      </div>
                      {c.ref && <div className="font-mono text-[10px] text-red-700/80">→ {c.ref}</div>}
                      {c.values?.length > 0 && <div className="truncate font-mono text-[10px] text-emerald-700" title={c.values.join(', ')}>{c.values.join(' · ')}</div>}
                    </li>
                  ))}
              </Fragment>
            )
          })}
          {!schemaLoading && shownTables.length === 0 && <li className="px-2 py-3 text-xs text-stone-500">{t('manage.sql.noTables')}</li>}
        </ul>
      </div>
    </div>
  )

  return (
    <section data-testid="sql-panel">
      <PanelHead title={t('manage.tabs.sql')}>
        {schema.server_version && <span className="rounded bg-stone-200/70 px-1.5 py-0.5 font-mono text-[10px] text-stone-600">PostgreSQL {schema.server_version.split(' ')[0]}</span>}
      </PanelHead>
      <OfflineBanner online={online} />
      <div className="flex gap-3">
        <aside className="hidden h-[calc(100vh-12rem)] w-64 shrink-0 lg:block">{schemaBrowser}</aside>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" icon={Table2} onClick={() => setSheetOpen(true)} className="lg:hidden">{t('manage.sql.tablesCount', { count: tables.length })}</Button>
            <label className={`inline-flex h-9 cursor-pointer select-none items-center gap-2 rounded-lg border px-2.5 text-xs font-medium ${writeMode ? 'border-red-300 bg-red-50 text-red-700' : 'border-stone-200 bg-white text-stone-600'}`}>
              <Switch checked={writeMode} onCheckedChange={(v) => { setWriteMode(v); setPreviewSql(null) }} aria-label={t('manage.sql.writeMode')} />
              <span>{t('manage.sql.writeMode')}</span>
            </label>
            <span className="hidden text-[11px] text-stone-400 sm:inline">{t('manage.sql.runHint')}</span>
            <div className="flex-1" />
            <Button icon={Play} onClick={() => execute()} loading={loading} disabled={!online || !sql.trim() || loading}>
              {writeMode ? t('manage.sql.preview') : t('manage.sql.run')}
            </Button>
          </div>
          {writeMode && <Banner tone="warning" className="text-xs">{t('manage.sql.writeModeHint')}</Banner>}
          <CodeMirrorEditor value={sql} onChange={setSql} onExecute={() => execute()} tables={editorTables} placeholder={t('manage.sql.placeholder')} label={t('manage.tabs.sql')} />
          {recent.length > 0 && (
            <div className="flex items-center gap-2">
              <History size={12} className="shrink-0 text-stone-400" aria-hidden />
              <span className="hidden shrink-0 text-[10px] uppercase tracking-wide text-stone-400 sm:inline">{t('manage.sql.recent')}</span>
              <div className="flex min-w-0 flex-1 flex-nowrap items-center gap-2 overflow-x-auto">
                {recent.slice(0, 10).map((r) => (
                  <button key={r.ts} type="button" onClick={() => setSql(r.sql)} title={r.sql} className="max-w-[220px] shrink-0 truncate rounded-md border border-stone-200 bg-white px-2 py-1 font-mono text-[11px] text-stone-600 hover:bg-stone-50">
                    {r.sql.replace(/\s+/g, ' ').slice(0, 60)}
                  </button>
                ))}
              </div>
              <IconButton variant="ghost" label={t('manage.sql.clearRecent')} onClick={() => { setRecent([]); saveRecent([]) }} className="h-7 w-7 shrink-0">
                <X size={13} aria-hidden />
              </IconButton>
            </div>
          )}

          {isPreview && (
            <Banner
              tone="warning"
              data-testid="sql-preview"
              action={canCommit ? { label: t('manage.sql.commit'), onClick: commit } : undefined}
            >
              {Number.isFinite(result.rows?.[0]?.[1]) && result.columns[0] === 'command'
                ? t('manage.sql.previewCount', { command: result.rows[0][0], count: result.rows[0][1] })
                : t('manage.sql.previewRows')}
              {!canCommit && <span className="ml-1">{t('manage.sql.previewStale')}</span>}
            </Banner>
          )}

          {result && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-stone-500">
                <span>{t('manage.sql.rows', { count: result.row_count })}</span>
                <span>· {t('manage.sql.duration', { ms: result.duration_ms })}</span>
                {result.statements > 1 && <span>· {t('manage.sql.statements', { count: result.statements })}</span>}
                {result.truncated && <span className="font-semibold text-amber-700">· {t('manage.sql.truncated')}</span>}
                {result.committed && <span className="font-semibold text-red-700">· {t('manage.sql.saved')}</span>}
              </div>
              {result.rows.length > 0 && (
                <div className="flex gap-1.5">
                  <Button size="sm" variant="secondary" icon={FileDown} onClick={exportCsv}>CSV</Button>
                  <Button size="sm" variant="secondary" icon={copied ? Check : ClipboardCopy} onClick={copyTable}>{copied ? t('manage.sql.copied') : t('manage.sql.copyTable')}</Button>
                </div>
              )}
            </div>
          )}

          {error && (
            <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-2.5 text-xs text-red-800" data-testid="sql-error">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
              <div className="min-w-0 flex-1 break-words">
                <div className="font-semibold">
                  {t('manage.sql.error')}
                  {error.code && <span className="ml-1.5 font-mono text-[10px] opacity-75">[{error.code}]</span>}
                </div>
                <div className="font-mono">{error.message}</div>
                {fix && (
                  <div className="mt-2 rounded-lg border border-stone-200 bg-white p-2 text-stone-800">
                    <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold"><Wand2 size={13} className="text-red-700" aria-hidden />{t('manage.sql.didYouMean')}</div>
                    <div className="flex flex-wrap gap-1.5">
                      {fix.suggestions.map((s) => (
                        <button key={s} type="button" onClick={() => applyFix(s)} className="rounded-md border border-red-200 bg-red-50 px-2.5 py-1 font-mono text-[11px] font-semibold text-stone-800 hover:bg-red-100">{s}</button>
                      ))}
                    </div>
                  </div>
                )}
                {error.details?.hint && <div className="mt-1 font-mono text-stone-700"><span className="font-sans font-semibold">hint:</span> {error.details.hint}</div>}
                {error.details?.detail && error.details.detail !== error.message && <div className="mt-1 font-mono text-stone-700"><span className="font-sans font-semibold">detail:</span> {error.details.detail}</div>}
                {error.code === 'write_required' && <div className="mt-1 text-stone-700">{t('manage.sql.writeRequiredHint')}</div>}
              </div>
            </div>
          )}

          {result && <ResultsTable columns={result.columns} rows={result.rows} />}
        </div>
      </div>
      <Modal open={sheetOpen} onClose={() => setSheetOpen(false)} title={t('manage.sql.tables')} sheet closeLabel={t('common.close', 'Close')}>
        <div className="h-[70dvh]">{schemaBrowser}</div>
      </Modal>
    </section>
  )
}
