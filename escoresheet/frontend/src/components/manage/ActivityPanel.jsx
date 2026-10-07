import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, Search, Trash2 } from 'lucide-react'
import { admin } from '../../lib/accountApi'
import { activityLine } from '../../domain/activitySummary'
import { useOnline, OfflineBanner, PanelHead, useErrorText, useKitLang } from './common'
import {
  RowList, Row, DateRail, RowExpansion, EmptyInset, SkeletonRows, Notice, Button, Input, Select, Field, DateField,
  StatusPill, confirmDialog, toast, dayLabel, weekdayLabel
} from '../../ui'

const PAGE = 100
const KIND_PREFIXES = ['', 'event.', 'event.undo', 'set.', 'match.', 'match.manual_change', 'sync.', 'app.', 'app.error', 'auth.', 'backup.']
const LEVEL_TONE = { info: 'neutral', warn: 'todo', error: 'brand' }

const kindKey = (kind) => String(kind || '').replace(/\./g, '_')
const shortId = (id) => (id ? String(id).slice(0, 8) : '')

function timeWithSeconds(ts) {
  try {
    return new Intl.DateTimeFormat('de-CH', { timeZone: 'Europe/Zurich', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(ts))
  } catch {
    return ''
  }
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * The activity log of every scoring device (admins; db/016). Filters: game
 * number or external id, account email, kind, level, dates. Export CSV /
 * NDJSON; delete on request (audited).
 * `initialMatch`: opened from the matches tab ("Activity").
 */
export default function ActivityPanel({ app, initialMatch = '' }) {
  const { t } = useTranslation()
  const lang = useKitLang()
  const online = useOnline()
  const errorText = useErrorText()
  const [form, setForm] = useState({ match: initialMatch || '', email: '', kind: '', level: '', from: '', to: '' })
  const [filters, setFilters] = useState(null) // applied: { match, account, kind, level, from, to }
  const [entries, setEntries] = useState([])
  const [next, setNext] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [open, setOpen] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (initialMatch) setForm(f => ({ ...f, match: initialMatch }))
  }, [initialMatch])

  const resolveFilters = async () => {
    const out = { match: form.match.trim() || undefined, kind: form.kind || undefined, level: form.level || undefined, app: app || undefined }
    if (form.from) out.from = new Date(`${form.from}T00:00:00`).toISOString()
    if (form.to) out.to = new Date(`${form.to}T23:59:59`).toISOString()
    const email = form.email.trim().toLowerCase()
    if (email) {
      const res = await admin.listAccounts({ filter: 'all', q: email, app })
      const hit = (res.data?.accounts || []).find(a => String(a.email || '').toLowerCase() === email)
      if (!hit) return { error: t('manage.activity.noAccount') }
      out.account = hit.id
    }
    return { filters: out }
  }

  const load = async (applied, before = null) => {
    setLoading(true)
    const res = await admin.listActivity({ ...applied, before: before ?? undefined, limit: PAGE })
    setLoading(false)
    if (res.error) {
      setError(errorText(res.error))
      return
    }
    setError(null)
    const page = res.data?.entries || []
    setEntries(prev => (before ? [...prev, ...page] : page))
    setNext(res.data?.next ?? null)
  }

  const search = async (e) => {
    e?.preventDefault?.()
    const r = await resolveFilters()
    if (r.error) {
      setError(r.error)
      return
    }
    setFilters(r.filters)
    setOpen(null)
    await load(r.filters)
  }

  useEffect(() => {
    if (online) search()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, initialMatch])

  const exportAs = async (format) => {
    if (!filters) return
    setBusy(true)
    const res = await admin.exportActivity({ ...filters, format })
    setBusy(false)
    if (res.error) {
      toast.error(errorText(res.error))
      return
    }
    saveBlob(res.blob, res.filename || `openvolley-activity.${format}`)
  }

  const removeAll = async () => {
    if (!filters?.match && !filters?.account) return
    const what = filters.match ? t('manage.activity.ofMatch', { match: filters.match }) : t('manage.activity.ofAccount', { email: form.email.trim() })
    const ok = await confirmDialog({
      title: t('manage.activity.deleteTitle'),
      message: t('manage.activity.deleteBody', { what }),
      confirmLabel: t('manage.activity.delete'),
      tone: 'danger'
    })
    if (!ok) return
    setBusy(true)
    const res = await admin.deleteActivity({ match: filters.match, account: filters.match ? undefined : filters.account })
    setBusy(false)
    if (res.error) {
      toast.error(errorText(res.error))
      return
    }
    toast.success(t('manage.activity.deleted', { count: res.data?.deleted ?? 0 }))
    load(filters)
  }

  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }))
  const canDelete = !!(filters?.match || filters?.account)

  return (
    <section>
      <PanelHead title={t('manage.tabs.activity')}>
        <Button variant="ghost" size="sm" icon={Download} disabled={!online || busy || !filters} onClick={() => exportAs('csv')}>{t('manage.activity.exportCsv')}</Button>
        <Button variant="ghost" size="sm" icon={Download} disabled={!online || busy || !filters} onClick={() => exportAs('ndjson')}>{t('manage.activity.exportNdjson')}</Button>
        <Button variant="danger-outline" size="sm" icon={Trash2} disabled={!online || busy || !canDelete} onClick={removeAll} title={canDelete ? undefined : t('manage.activity.deleteNeedsFilter')}>{t('manage.activity.deleteEllipsis')}</Button>
      </PanelHead>
      <OfflineBanner online={online} />
      <form onSubmit={search} className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-6 lg:items-end">
        <Field label={t('manage.activity.match')} tone="compact"><Input value={form.match} onChange={set('match')} placeholder={t('manage.activity.matchPlaceholder')} /></Field>
        <Field label={t('manage.activity.account')} tone="compact"><Input type="email" value={form.email} onChange={set('email')} placeholder="name@example.ch" /></Field>
        <Field label={t('manage.activity.kind')} tone="compact">
          <Select value={form.kind} onChange={set('kind')} block>
            {KIND_PREFIXES.map(k => <option key={k} value={k}>{k ? t(`manage.activity.kinds.${kindKey(k.replace(/\.$/, ''))}`, k) : t('manage.activity.allKinds')}</option>)}
          </Select>
        </Field>
        <Field label={t('manage.activity.level')} tone="compact">
          <Select value={form.level} onChange={set('level')} block>
            <option value="">{t('manage.activity.allLevels')}</option>
            <option value="warn">{t('manage.activity.levels.warn')}</option>
            <option value="error">{t('manage.activity.levels.error')}</option>
            <option value="info">{t('manage.activity.levels.info')}</option>
          </Select>
        </Field>
        <Field label={t('manage.activity.from')} tone="compact"><DateField value={form.from} onChange={(iso) => setForm(f => ({ ...f, from: iso || '' }))} /></Field>
        <div className="flex items-end gap-2">
          <Field label={t('manage.activity.to')} tone="compact" className="flex-1"><DateField value={form.to} min={form.from || undefined} onChange={(iso) => setForm(f => ({ ...f, to: iso || '' }))} /></Field>
          <Button type="submit" variant="dark" icon={Search} disabled={!online || loading}>{t('manage.activity.search')}</Button>
        </div>
      </form>
      {error && <Notice className="mb-3">{error}</Notice>}
      {loading && !entries.length ? (
        <SkeletonRows rows={6} pill={false} />
      ) : entries.length === 0 ? (
        <EmptyInset>{t('manage.activity.empty')}</EmptyInset>
      ) : (
        <>
          <RowList>
            {entries.map(e => (
              <Row
                key={e.id}
                stripe={false}
                selected={open === e.id}
                onOpen={() => setOpen(open === e.id ? null : e.id)}
                label={t(`activity.kinds.${kindKey(e.kind)}`, e.kind)}
                leading={<DateRail weekday={weekdayLabel(e.client_ts, lang)} date={dayLabel(e.client_ts)} time={timeWithSeconds(e.client_ts)} />}
                title={<p className="text-sm font-semibold text-stone-900">{t(`activity.kinds.${kindKey(e.kind)}`, e.kind)} <span className="font-normal text-stone-500">{activityLine(e)}</span></p>}
                status={e.level !== 'info' ? <StatusPill tone={LEVEL_TONE[e.level] || 'neutral'}>{t(`manage.activity.levels.${e.level}`)}</StatusPill> : null}
                meta={<>
                  {e.game_n ? <span className="tabular-nums">#{e.game_n}</span> : e.match_external_id ? <span className="break-all">{e.match_external_id}</span> : null}
                  {e.set_index != null && <span className="tabular-nums">{t('activity.set', { n: e.set_index })}</span>}
                  {e.account_email && <span>{e.account_email}</span>}
                  {e.device_id && <span title={e.device_id}>{t('manage.activity.device', { id: shortId(e.device_id) })}</span>}
                  {e.app_version && <span className="tabular-nums">v{e.app_version}</span>}
                  {e.platform && <span>{e.platform}</span>}
                </>}
              >
                {open === e.id && (
                  <RowExpansion>
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-stone-50 p-3 text-xs text-stone-700">{JSON.stringify(e, null, 2)}</pre>
                  </RowExpansion>
                )}
              </Row>
            ))}
          </RowList>
          {next !== null && (
            <div className="mt-3 flex justify-center">
              <Button variant="secondary" loading={loading} disabled={!online || loading} onClick={() => load(filters, next)}>{t('manage.activity.loadMore')}</Button>
            </div>
          )}
        </>
      )}
    </section>
  )
}
