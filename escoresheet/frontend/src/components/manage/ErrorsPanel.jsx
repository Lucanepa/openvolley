import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, BellOff, CheckCircle2, Copy, RefreshCw, RotateCcw, Search, Star, Trash2 } from 'lucide-react'
import { admin } from '../../lib/accountApi'
import { useOnline, OfflineBanner, PanelHead, useErrorText, useKitLang, usePanelData, usePanelRoute } from './common'
import {
  RowList, Row, DateRail, RowExpansion, EmptyInset, SkeletonRows, Notice, Button, Input, Select, Field, Textarea,
  StatusPill, SegmentedControl, KeyValue, Card, confirmDialog, toast, dayLabel, weekdayLabel, cn
} from '../../ui'

/**
 * The Errors tab (super admins; db/050, lib/errorTracker.js): every page's,
 * app's and the server's own errors, one row per kind ("group"). A group
 * opens its page (#errors/<id>): what it is, 14 days, where it happens (OS,
 * browser, version, tool, view) and each stored report with the member who
 * hit it (name, address, roles, clubs; reading them is audited) or "guest".
 * Resolve (now, or "in version x": an older version reporting it stays
 * quiet), mute (a day, a week, for good), important, a note and a commit.
 * A device's or an account's reports can be deleted on request.
 * The mail and the push name no member: this page is where names are.
 */
const STATUS_OPTIONS = ['open', 'resolved', 'muted', 'all']
const TOOLS = ['scorer', 'referee', 'bench', 'livescore', 'scoresheet', 'dictate', 'roster', 'manager', 'tv', 'scoreboard', 'board', 'other', 'server', 'render']
const SINCE = ['', '24h', '7d', '30d', '90d']
const shortId = (id) => (id ? String(id).slice(0, 8) : '')

function timeWithSeconds(ts) {
  try {
    return new Intl.DateTimeFormat('de-CH', { timeZone: 'Europe/Zurich', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(ts))
  } catch {
    return ''
  }
}

function ago(ts, t) {
  const ms = Date.now() - Date.parse(ts)
  if (!Number.isFinite(ms)) return ''
  const m = Math.round(ms / 60000)
  if (m < 1) return t('manage.errorsTab.justNow')
  if (m < 60) return t('manage.errorsTab.minutesAgo', { count: m })
  const h = Math.round(m / 60)
  if (h < 48) return t('manage.errorsTab.hoursAgo', { count: h })
  return t('manage.errorsTab.daysAgo', { count: Math.round(h / 24) })
}

function StatusOf({ group }) {
  const { t } = useTranslation()
  if (group.status === 'resolved') return <StatusPill tone="done">{t('manage.errorsTab.status.resolved')}</StatusPill>
  if (group.status === 'muted') return <StatusPill tone="neutral">{t('manage.errorsTab.status.muted')}</StatusPill>
  if (group.regressed) return <StatusPill tone="attention">{t('manage.errorsTab.regressed')}</StatusPill>
  return <StatusPill tone={group.level === 'error' ? 'brand' : 'todo'}>{t(`manage.errorsTab.level.${group.level}`)}</StatusPill>
}

const toolLabel = (t, tool) => t(`manage.errorsTab.tools.${tool}`, tool)

export default function ErrorsPanel({ route, onRoute }) {
  const [segments, go] = usePanelRoute(route, onRoute)
  const groupId = segments[0] && segments[0] !== 'device' ? segments[0] : null
  const device = segments[0] === 'device' ? segments[1] || '' : ''
  if (device) return <DeviceView device={device} onBack={() => go('', { push: true })} onOpenGroup={(id) => go([id])} />
  if (groupId) return <GroupView id={groupId} onBack={() => go('', { push: true })} onOpenDevice={(d) => go(['device', d])} />
  return <GroupList onOpen={(id) => go([id])} />
}

function GroupList({ onOpen }) {
  const { t } = useTranslation()
  const lang = useKitLang()
  const online = useOnline()
  const errorText = useErrorText()
  const [form, setForm] = useState({ status: 'open', product: '', tool: '', source: '', since: '', q: '', sort: 'last_seen' })
  const [applied, setApplied] = useState(form)
  const { data, error, loading, reload } = usePanelData(
    () => admin.listErrors({ ...applied, product: applied.product || undefined, tool: applied.tool || undefined, source: applied.source || undefined, since: applied.since || undefined, q: applied.q.trim() || undefined }),
    [applied], { enabled: online })
  const groups = data?.groups || []
  const counts = data?.counts || null
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e?.target ? e.target.value : e }))
  const search = (e) => {
    e?.preventDefault?.()
    setApplied({ ...form })
  }
  useEffect(() => {
    // the status switch applies at once
    setApplied((a) => ({ ...a, status: form.status }))
  }, [form.status])

  return (
    <section>
      <PanelHead title={t('manage.tabs.errors')}>
        <Button variant="ghost" size="sm" icon={RefreshCw} disabled={!online || loading} onClick={() => reload()}>{t('manage.errorsTab.refresh')}</Button>
      </PanelHead>
      <OfflineBanner online={online} />
      <p className="mb-3 text-sm text-stone-600">{t('manage.errorsTab.intro')}</p>
      <div className="mb-3">
        <SegmentedControl
          ariaLabel={t('manage.errorsTab.statusLabel')}
          value={form.status}
          onChange={(v) => setForm((f) => ({ ...f, status: v }))}
          options={STATUS_OPTIONS.map((s) => ({
            value: s,
            label: counts && s !== 'all' ? `${t(`manage.errorsTab.status.${s}`)} · ${counts[s] ?? 0}` : t(`manage.errorsTab.status.${s}`)
          }))}
        />
      </div>
      <form onSubmit={search} className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr_1fr_auto] lg:items-end">
        <Field label={t('manage.errorsTab.search')} tone="compact"><Input value={form.q} onChange={set('q')} placeholder={t('manage.errorsTab.searchPlaceholder')} /></Field>
        <Field label={t('manage.errorsTab.product')} tone="compact">
          <Select value={form.product} onChange={set('product')} block>
            <option value="">{t('manage.errorsTab.all')}</option>
            <option value="openvolley">OpenVolley</option>
            <option value="openbeach">OpenBeach</option>
          </Select>
        </Field>
        <Field label={t('manage.errorsTab.tool')} tone="compact">
          <Select value={form.tool} onChange={set('tool')} block>
            <option value="">{t('manage.errorsTab.all')}</option>
            {TOOLS.map((x) => <option key={x} value={x}>{toolLabel(t, x)}</option>)}
          </Select>
        </Field>
        <Field label={t('manage.errorsTab.since')} tone="compact">
          <Select value={form.since} onChange={set('since')} block>
            {SINCE.map((x) => <option key={x} value={x}>{x ? t(`manage.errorsTab.sinceOptions.${x}`) : t('manage.errorsTab.anyTime')}</option>)}
          </Select>
        </Field>
        <Field label={t('manage.errorsTab.sort')} tone="compact">
          <Select value={form.sort} onChange={set('sort')} block>
            <option value="last_seen">{t('manage.errorsTab.sortLast')}</option>
            <option value="count">{t('manage.errorsTab.sortCount')}</option>
            <option value="new">{t('manage.errorsTab.sortNew')}</option>
          </Select>
        </Field>
        <Button type="submit" variant="dark" icon={Search} disabled={!online || loading}>{t('manage.errorsTab.apply')}</Button>
      </form>
      {error && <Notice className="mb-3">{errorText(error)}</Notice>}
      {error && !groups.length ? null : loading && !data ? (
        <SkeletonRows rows={6} pill />
      ) : groups.length === 0 ? (
        <EmptyInset>{t(`manage.errorsTab.empty.${applied.status}`, t('manage.errorsTab.empty.all'))}</EmptyInset>
      ) : (
        <RowList>
          {groups.map((g) => (
            <Row
              key={g.id}
              onOpen={() => onOpen(g.id)}
              label={g.title}
              leading={<DateRail weekday={weekdayLabel(g.last_seen, lang)} date={dayLabel(g.last_seen)} time={timeWithSeconds(g.last_seen).slice(0, 5)} />}
              title={
                <p className="break-words text-sm font-semibold text-stone-900">
                  {g.important && <Star size={13} className="mr-1 inline -translate-y-px fill-amber-400 text-amber-500" aria-label={t('manage.errorsTab.important')} />}
                  {g.title}
                </p>
              }
              status={<StatusOf group={g} />}
              meta={<>
                <span className="font-medium tabular-nums text-stone-700">{t('manage.errorsTab.times', { count: g.event_count })}</span>
                {g.events_24h > 0 && <span className="tabular-nums">{t('manage.errorsTab.today', { count: g.events_24h })}</span>}
                <span>{g.product === 'openbeach' ? 'OpenBeach' : 'OpenVolley'} · {(g.tools?.length ? g.tools : [g.source === 'server' ? 'server' : 'other']).map((x) => toolLabel(t, x)).join(', ')}</span>
                {g.platforms?.length > 0 && <span>{g.platforms.slice(0, 3).join(', ')}</span>}
                {(g.first_version || g.last_version) && <span className="tabular-nums">{g.first_version === g.last_version ? `v${g.last_version}` : `v${g.first_version || '?'} – v${g.last_version || '?'}`}</span>}
                <span>{t('manage.errorsTab.accounts', { count: g.accounts ?? 0 })} · {t('manage.errorsTab.devices', { count: g.devices ?? 0 })}</span>
                <span className="font-mono text-[11px]">{g.kind}</span>
                <span>{ago(g.last_seen, t)}</span>
              </>}
            />
          ))}
        </RowList>
      )}
    </section>
  )
}

function Bars({ days }) {
  const { t } = useTranslation()
  const max = Math.max(1, ...days.map((d) => d.n))
  return (
    <div>
      <div className="flex h-16 items-end gap-1" role="img" aria-label={t('manage.errorsTab.daysLabel', { days: days.length })}>
        {days.map((d) => (
          <div key={d.day} className="flex h-full flex-1 items-end" title={`${d.day}: ${d.n}`}>
            <div className={cn('w-full rounded-sm', d.n ? 'bg-red-600/80' : 'bg-stone-200')} style={{ height: `${d.n ? Math.max(8, Math.round((d.n / max) * 100)) : 4}%` }} />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-stone-400">
        <span>{days[0]?.day?.slice(5)}</span>
        <span>{days[days.length - 1]?.day?.slice(5)}</span>
      </div>
    </div>
  )
}

function Breakdown({ title, rows }) {
  if (!rows?.length) return null
  const total = rows.reduce((n, r) => n + r.n, 0)
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-stone-500">{title}</p>
      <ul className="space-y-1">
        {rows.map((r) => (
          <li key={String(r.value)} className="flex items-center gap-2 text-xs">
            <span className="min-w-0 flex-1 truncate text-stone-800" title={String(r.value)}>{String(r.value)}</span>
            <span className="h-1.5 w-16 overflow-hidden rounded-full bg-stone-100"><span className="block h-full bg-stone-500" style={{ width: `${Math.round((r.n / total) * 100)}%` }} /></span>
            <span className="w-8 text-right tabular-nums text-stone-500">{r.n}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function MemberLine({ member }) {
  const { t } = useTranslation()
  if (!member) return <span className="text-stone-500">{t('manage.errorsTab.guest')}</span>
  const roles = (member.roles || []).join(', ')
  const clubs = (member.clubs || []).map((c) => c.name).join(', ')
  return (
    <span>
      <span className="font-medium text-stone-800">{member.name || member.email || shortId(member.id)}</span>
      {member.name && member.email && <span className="text-stone-500"> · {member.email}</span>}
      {(roles || clubs) && <span className="text-stone-500"> · {[roles, clubs].filter(Boolean).join(' · ')}</span>}
    </span>
  )
}

function EventRows({ events, open, setOpen, onOpenDevice, onOpenGroup }) {
  const { t } = useTranslation()
  const lang = useKitLang()
  const copy = (text) => {
    try { navigator.clipboard?.writeText(text); toast.success(t('manage.errorsTab.copied')) } catch { /* no clipboard */ }
  }
  return (
    <RowList>
      {events.map((e) => (
        <Row
          key={e.id}
          stripe={false}
          selected={open === e.id}
          onOpen={() => setOpen(open === e.id ? null : e.id)}
          label={e.message}
          leading={<DateRail weekday={weekdayLabel(e.client_ts, lang)} date={dayLabel(e.client_ts)} time={timeWithSeconds(e.client_ts)} />}
          title={<p className="text-sm text-stone-900"><MemberLine member={e.member} /></p>}
          status={e.level === 'warn' ? <StatusPill tone="todo">{t('manage.errorsTab.level.warn')}</StatusPill> : null}
          meta={<>
            {onOpenGroup && <span className="break-words font-medium text-stone-700">{e.group_title}</span>}
            <span>{toolLabel(t, e.tool)}{e.view ? ` · ${e.view}` : ''}</span>
            {e.device && <span>{e.device}</span>}
            {e.app_version && <span className="tabular-nums">v{e.app_version}</span>}
            {e.match_external_id && <span className="break-all">{e.match_external_id}</span>}
            {e.device_id && (
              onOpenDevice
                ? <button type="button" className="underline decoration-stone-300 underline-offset-2 hover:text-stone-800" onClick={(ev) => { ev.stopPropagation(); onOpenDevice(e.device_id) }}>{t('manage.errorsTab.device', { id: shortId(e.device_id) })}</button>
                : <span title={e.device_id}>{t('manage.errorsTab.device', { id: shortId(e.device_id) })}</span>
            )}
          </>}
        >
          {open === e.id && (
            <RowExpansion>
              <div className="space-y-3 text-xs">
                <p className="break-words font-mono text-stone-800">{e.error_name ? `${e.error_name}: ` : ''}{e.message}</p>
                {e.frames?.length > 0 && (
                  <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-stone-900 p-3 text-[11px] leading-relaxed text-stone-100">{e.frames.join('\n')}</pre>
                )}
                {e.breadcrumbs?.length > 0 && (
                  <div>
                    <p className="mb-1 font-medium text-stone-500">{t('manage.errorsTab.before')}</p>
                    <ol className="space-y-0.5">
                      {e.breadcrumbs.map((b, i) => (
                        <li key={i} className="flex gap-2">
                          <span className="w-16 shrink-0 font-mono text-stone-400">{b.t ? timeWithSeconds(b.t) : ''}</span>
                          <span className="w-12 shrink-0 text-stone-500">{b.c}</span>
                          <span className="min-w-0 break-words text-stone-800">{b.m}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
                <KeyValue items={[
                  { label: t('manage.errorsTab.fields.kind'), value: e.kind },
                  { label: t('manage.errorsTab.fields.runsAs'), value: e.runs_as || '–' },
                  { label: t('manage.errorsTab.fields.screen'), value: [e.screen, e.viewport && `${t('manage.errorsTab.fields.window')} ${e.viewport}`, e.dpr && `×${e.dpr}`].filter(Boolean).join(' · ') || '–' },
                  { label: t('manage.errorsTab.fields.lang'), value: [e.lang, e.tz].filter(Boolean).join(' · ') || '–' },
                  { label: t('manage.errorsTab.fields.online'), value: e.online == null ? '–' : e.online ? t('manage.errorsTab.yes') : t('manage.errorsTab.no') },
                  { label: t('manage.errorsTab.fields.build'), value: e.build || '–' },
                  ...(e.point_hub ? [{ label: 'Point Hub', value: t('manage.errorsTab.yes') }] : [])
                ]} />
                {e.request_id && (
                  <p className="flex items-center gap-2 text-stone-600">
                    {t('manage.errorsTab.requestId')}: <code className="font-mono">{e.request_id}</code>
                    <Button variant="ghost" size="sm" icon={Copy} onClick={() => copy(e.request_id)}>{t('manage.errorsTab.copy')}</Button>
                  </p>
                )}
                {onOpenGroup && <Button variant="secondary" size="sm" onClick={() => onOpenGroup(e.group_id)}>{t('manage.errorsTab.openGroup')}</Button>}
                {e.data && Object.keys(e.data).length > 0 && (
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-stone-50 p-3 text-[11px] text-stone-700">{JSON.stringify(e.data, null, 2)}</pre>
                )}
              </div>
            </RowExpansion>
          )}
        </Row>
      ))}
    </RowList>
  )
}

function useEventPages(fetchPage, deps, enabled) {
  const errorText = useErrorText()
  const [state, setState] = useState({ events: [], next: null, loading: enabled, error: null })
  const load = async (before = null) => {
    setState((s) => ({ ...s, loading: true }))
    const res = await fetchPage(before)
    if (res.error) {
      setState((s) => ({ ...s, loading: false, error: errorText(res.error) }))
      return
    }
    setState((s) => ({ events: before ? [...s.events, ...(res.data?.events || [])] : (res.data?.events || []), next: res.data?.next ?? null, loading: false, error: null }))
  }
  useEffect(() => {
    if (enabled) load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled])
  return [state, load]
}

function GroupView({ id, onBack, onOpenDevice }) {
  const { t } = useTranslation()
  const online = useOnline()
  const errorText = useErrorText()
  const { data, error, loading, reload } = usePanelData(() => admin.getError(id), [id], { enabled: online })
  const [events, loadEvents] = useEventPages((before) => admin.listErrorEvents(id, { before: before ?? undefined }), [id], online)
  const [open, setOpen] = useState(null)
  const [busy, setBusy] = useState(false)
  const [version, setVersion] = useState('')
  const [note, setNote] = useState(null)
  const [commitRef, setCommitRef] = useState(null)
  const g = data?.group
  useEffect(() => {
    setNote(null)
    setCommitRef(null)
  }, [id])

  const patch = async (body, done) => {
    setBusy(true)
    const res = await admin.updateError(id, body)
    setBusy(false)
    if (res.error) {
      toast.error(errorText(res.error))
      return
    }
    if (done) toast.success(done)
    reload({ quiet: true })
  }
  const resolve = (inVersion) => patch({ status: 'resolved', ...(inVersion ? { resolved_in_version: inVersion } : {}) }, t('manage.errorsTab.resolvedToast'))
  const mute = (span) => patch({ status: 'muted', mute: span }, t('manage.errorsTab.mutedToast'))
  const reopen = () => patch({ status: 'open' }, t('manage.errorsTab.reopenedToast'))
  const saveNote = () => patch({ note: (note ?? g?.note ?? '').trim() || null, commit_ref: (commitRef ?? g?.commit_ref ?? '').trim() || null }, t('manage.errorsTab.noteSaved'))

  const stats = data?.stats
  const b = data?.breakdowns || {}
  const versionOk = !version || /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/.test(version)

  return (
    <section>
      <div className="mb-3">
        <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={onBack}>{t('manage.errorsTab.back')}</Button>
      </div>
      <OfflineBanner online={online} />
      {error && <Notice className="mb-3">{errorText(error)}</Notice>}
      {loading && !g ? <SkeletonRows rows={4} pill={false} /> : !g ? null : (
        <>
          <div className="mb-4">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <StatusOf group={g} />
              {g.important && <StatusPill tone="todo">{t('manage.errorsTab.important')}</StatusPill>}
              <span className="font-mono text-xs text-stone-500">{g.kind}</span>
              <span className="text-xs text-stone-500">{g.product === 'openbeach' ? 'OpenBeach' : 'OpenVolley'} · {g.source === 'server' ? t('manage.errorsTab.sourceServer') : t('manage.errorsTab.sourceClient')}</span>
            </div>
            <h1 className="m-0 break-words text-lg font-bold tracking-tight text-stone-900 sm:text-xl">{g.title}</h1>
            {g.culprit && <p className="mt-1 break-all font-mono text-xs text-stone-500">{g.culprit}</p>}
          </div>

          <div className="mb-4 flex flex-wrap gap-2">
            {g.status !== 'resolved' && <Button variant="dark" size="sm" icon={CheckCircle2} disabled={!online || busy} onClick={() => resolve(null)}>{t('manage.errorsTab.resolve')}</Button>}
            {g.status !== 'resolved' && (
              <span className="inline-flex items-center gap-1">
                <Input size="sm" value={version} onChange={(e) => setVersion(e.target.value)} placeholder={g.last_version ? t('manage.errorsTab.versionPlaceholder', { v: g.last_version }) : '3.4.3'} className="w-28" aria-label={t('manage.errorsTab.resolveInVersion')} />
                <Button variant="secondary" size="sm" disabled={!online || busy || !version || !versionOk} onClick={() => resolve(version.trim())}>{t('manage.errorsTab.resolveInVersion')}</Button>
              </span>
            )}
            {g.status !== 'muted' && (
              <Select value="" onChange={(e) => { if (e.target.value) mute(e.target.value) }} aria-label={t('manage.errorsTab.mute')} disabled={!online || busy}>
                <option value="">{t('manage.errorsTab.muteEllipsis')}</option>
                <option value="24h">{t('manage.errorsTab.muteFor.24h')}</option>
                <option value="7d">{t('manage.errorsTab.muteFor.7d')}</option>
                <option value="30d">{t('manage.errorsTab.muteFor.30d')}</option>
                <option value="forever">{t('manage.errorsTab.muteFor.forever')}</option>
              </Select>
            )}
            {g.status !== 'open' && <Button variant="secondary" size="sm" icon={RotateCcw} disabled={!online || busy} onClick={reopen}>{t('manage.errorsTab.reopen')}</Button>}
            <Button variant="ghost" size="sm" icon={g.important ? BellOff : Star} disabled={!online || busy} onClick={() => patch({ important: !g.important })}>
              {g.important ? t('manage.errorsTab.notImportant') : t('manage.errorsTab.markImportant')}
            </Button>
          </div>

          <div className="mb-4 grid gap-3 lg:grid-cols-3">
            <Card stack={false} className="p-4 lg:col-span-2">
              <KeyValue items={[
                { label: t('manage.errorsTab.fields.count'), value: t('manage.errorsTab.times', { count: g.event_count }), tone: 'strong' },
                { label: t('manage.errorsTab.fields.affected'), value: stats ? [t('manage.errorsTab.accounts', { count: stats.accounts }), t('manage.errorsTab.devices', { count: stats.devices }), stats.guests ? t('manage.errorsTab.guests', { count: stats.guests }) : null].filter(Boolean).join(', ') : '–' },
                { label: t('manage.errorsTab.fields.firstSeen'), value: `${new Date(g.first_seen).toLocaleString('de-CH', { timeZone: 'Europe/Zurich' })}${g.first_version ? ` · v${g.first_version}` : ''}` },
                { label: t('manage.errorsTab.fields.lastSeen'), value: `${new Date(g.last_seen).toLocaleString('de-CH', { timeZone: 'Europe/Zurich' })}${g.last_version ? ` · v${g.last_version}` : ''}` },
                ...(g.status === 'resolved' ? [{ label: t('manage.errorsTab.fields.resolved'), value: `${g.resolved_at ? new Date(g.resolved_at).toLocaleString('de-CH', { timeZone: 'Europe/Zurich' }) : ''}${g.resolved_in_version ? ` · ${t('manage.errorsTab.inVersion', { v: g.resolved_in_version })}` : ''}` }] : []),
                ...(g.status === 'muted' ? [{ label: t('manage.errorsTab.fields.muted'), value: g.muted_until ? new Date(g.muted_until).toLocaleString('de-CH', { timeZone: 'Europe/Zurich' }) : t('manage.errorsTab.muteFor.forever') }] : []),
                { label: t('manage.errorsTab.fields.lastAlert'), value: g.last_alert_at ? new Date(g.last_alert_at).toLocaleString('de-CH', { timeZone: 'Europe/Zurich' }) : '–' }
              ]} />
              <div className="mt-4">
                <p className="mb-1 text-xs font-medium text-stone-500">{t('manage.errorsTab.last14')}</p>
                <Bars days={data.days || []} />
              </div>
            </Card>
            <Card stack={false} className="space-y-3 p-4">
              <Breakdown title={t('manage.errorsTab.by.os')} rows={b.os} />
              <Breakdown title={t('manage.errorsTab.by.browser')} rows={b.browser} />
              <Breakdown title={t('manage.errorsTab.by.version')} rows={b.version} />
              <Breakdown title={t('manage.errorsTab.by.tool')} rows={(b.tool || []).map((r) => ({ ...r, value: toolLabel(t, r.value) }))} />
              <Breakdown title={t('manage.errorsTab.by.runs_as')} rows={b.runs_as} />
              <Breakdown title={t('manage.errorsTab.by.view')} rows={b.view} />
            </Card>
          </div>

          <Card className="mb-4 p-4">
            <div className="grid gap-2 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
              <Field label={t('manage.errorsTab.note')} tone="compact"><Textarea rows={2} value={note ?? g.note ?? ''} onChange={(e) => setNote(e.target.value)} maxLength={1000} /></Field>
              <Field label={t('manage.errorsTab.commit')} tone="compact"><Input value={commitRef ?? g.commit_ref ?? ''} onChange={(e) => setCommitRef(e.target.value)} maxLength={80} placeholder="#123 / a1b2c3d" /></Field>
              <Button variant="secondary" disabled={!online || busy || (note === null && commitRef === null)} onClick={saveNote}>{t('manage.errorsTab.save')}</Button>
            </div>
          </Card>

          <h2 className="mb-2 text-base font-semibold text-stone-900">{t('manage.errorsTab.reports')}</h2>
          <p className="mb-2 text-xs text-stone-500">{t('manage.errorsTab.reportsNote')}</p>
          {events.error && <Notice className="mb-3">{events.error}</Notice>}
          {events.loading && !events.events.length ? <SkeletonRows rows={4} pill={false} /> : events.events.length === 0 ? (
            <EmptyInset>{t('manage.errorsTab.noReports')}</EmptyInset>
          ) : (
            <>
              <EventRows events={events.events} open={open} setOpen={setOpen} onOpenDevice={onOpenDevice} />
              {events.next && (
                <div className="mt-3 flex justify-center">
                  <Button variant="secondary" loading={events.loading} disabled={!online || events.loading} onClick={() => loadEvents(events.next)}>{t('manage.errorsTab.loadMore')}</Button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  )
}

function DeviceView({ device, onBack, onOpenGroup }) {
  const { t } = useTranslation()
  const online = useOnline()
  const errorText = useErrorText()
  const [events, loadEvents] = useEventPages((before) => admin.listDeviceErrors({ device, before: before ?? undefined }), [device], online)
  const [open, setOpen] = useState(null)
  const remove = async () => {
    const ok = await confirmDialog({
      title: t('manage.errorsTab.deleteDeviceTitle'),
      message: t('manage.errorsTab.deleteDeviceBody', { id: shortId(device) }),
      confirmLabel: t('manage.errorsTab.delete'),
      tone: 'danger'
    })
    if (!ok) return
    const res = await admin.deleteErrorEvents({ device })
    if (res.error) {
      toast.error(errorText(res.error))
      return
    }
    toast.success(t('manage.errorsTab.deleted', { count: res.data?.deleted ?? 0 }))
    loadEvents()
  }
  const label = useMemo(() => t('manage.errorsTab.deviceTitle', { id: shortId(device) }), [device, t])
  return (
    <section>
      <div className="mb-3">
        <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={onBack}>{t('manage.errorsTab.back')}</Button>
      </div>
      <PanelHead title={label}>
        <Button variant="danger-outline" size="sm" icon={Trash2} disabled={!online || !events.events.length} onClick={remove}>{t('manage.errorsTab.deleteEllipsis')}</Button>
      </PanelHead>
      <OfflineBanner online={online} />
      <p className="mb-3 break-all font-mono text-xs text-stone-500">{device}</p>
      {events.error && <Notice className="mb-3">{events.error}</Notice>}
      {events.loading && !events.events.length ? <SkeletonRows rows={4} pill={false} /> : events.events.length === 0 ? (
        <EmptyInset>{t('manage.errorsTab.noReports')}</EmptyInset>
      ) : (
        <>
          <EventRows events={events.events} open={open} setOpen={setOpen} onOpenGroup={onOpenGroup} />
          {events.next && (
            <div className="mt-3 flex justify-center">
              <Button variant="secondary" loading={events.loading} disabled={!online || events.loading} onClick={() => loadEvents(events.next)}>{t('manage.errorsTab.loadMore')}</Button>
            </div>
          )}
        </>
      )}
    </section>
  )
}
