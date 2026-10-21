import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, Eye, RotateCcw } from 'lucide-react'
import { admin, scoresheetsApi } from '../../lib/accountApi'
import { openAppWindow, openPendingTab } from '../../utils/openAppWindow'
import { usePanelData, useOnline, OfflineBanner, PanelHead, MatchStatusPill, ReasonModal, useErrorText } from './common'
import { SegmentedControl, SearchInput, RowList, Row, RowTool, Chip, EmptyInset, SkeletonRows, Notice, dayTimeLabel, toast } from '../../ui'

// A viewed PDF stays readable (and saveable from the browser's viewer) this long
// (the server keeps a view link as long: lib/scoresheets.js VIEW_LINK_TTL_MS)
const VIEW_URL_TTL_MS = 10 * 60 * 1000
// RowTool has no disabled look of its own (offline, or another file on its way)
const TOOL_OFF = 'disabled:cursor-not-allowed disabled:opacity-50'

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

const pdfOf = (blob) => (blob.type === 'application/pdf' ? blob : new Blob([blob], { type: 'application/pdf' }))

/**
 * Every match of the console's sport with its stored scoresheet PDF (admins
 * and the sport's competition managers; lib/scoresheets.js on the server):
 * view it in a new tab or download it. Each open is in the audit log.
 * `app`: 'indoor' | 'beach' (the brand's scope).
 * OpenBeach: a closed match can be reopened here too, by the beach competition
 * managers as well as the admin (owner, 2026-10-21; the server checks the
 * match's sport, lib/accounts.js reopenMatch). OpenVolley keeps reopening in
 * the admins' Matches tab.
 */
export default function ScoresheetsPanel({ app = 'indoor' }) {
  const { t } = useTranslation()
  const online = useOnline()
  const errorText = useErrorText()
  const [state, setState] = useState('all')
  const [q, setQ] = useState('')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(null) // `${id}:view` | `${id}:download`
  const [reopenFor, setReopenFor] = useState(null)
  const canReopen = app === 'beach'
  const { data, error, loading, reload } = usePanelData(
    () => scoresheetsApi.list({ app, state, q: query || undefined, limit: 200 }),
    [app, state, query],
    { enabled: online }
  )
  const matches = data?.matches || []

  const open = async (m, download) => {
    setBusy(`${m.id}:${download ? 'download' : 'view'}`)
    // A browser blocks a tab opened after a request (Safari: the click's user
    // activation is gone by then): open it now, blank, and send it to the PDF
    // once there is one (closed again on an error). The apps open their own windows.
    const tab = download ? null : openPendingTab()
    const fail = (error) => {
      tab?.close()
      setBusy(null)
      toast.error(errorText(error))
    }
    if (!download) {
      // The browser's viewer on the server's link: its title and its Save use the
      // scoresheet's name (owner 2026-10-13). A server without the route (404 /
      // 405 before its update) or a blocked popup: the file as before.
      const link = await scoresheetsApi.viewLink(m.id)
      if (link.url) {
        if (tab) {
          tab.go(link.url)
          setBusy(null)
          return
        }
        if (openAppWindow(link.url, { title: link.filename || undefined }).ok) {
          setBusy(null)
          return
        }
      } else if (link.status !== 404 && link.status !== 405) {
        return fail(link.error)
      }
    }
    const res = await scoresheetsApi.pdf(m.id, { download })
    if (res.error) return fail(res.error)
    setBusy(null)
    const blob = pdfOf(res.blob)
    const name = res.filename || `scoresheet_game${m.game_n ?? ''}.pdf`
    if (download) return saveBlob(blob, name)
    const url = URL.createObjectURL(blob)
    if (tab) {
      tab.go(url)
      setTimeout(() => URL.revokeObjectURL(url), VIEW_URL_TTL_MS)
      return
    }
    // A popup blocker (Safari: a popup after a request) gets the file instead
    if (!openAppWindow(url, { title: name }).ok) {
      URL.revokeObjectURL(url)
      return saveBlob(blob, name)
    }
    setTimeout(() => URL.revokeObjectURL(url), VIEW_URL_TTL_MS)
  }

  return (
    <section data-testid="manage-scoresheets">
      <PanelHead title={t('manage.tabs.scoresheets')} />
      <OfflineBanner online={online} />
      <p className="mb-3 text-xs text-stone-500">{t('manage.scoresheets.intro')}</p>
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <SegmentedControl
          ariaLabel={t('manage.tabs.scoresheets')}
          value={state}
          onChange={setState}
          options={[
            { value: 'all', label: t('manage.matches.filterAll') },
            { value: 'closed', label: t('manage.matches.filterClosed') },
            { value: 'open', label: t('manage.matches.filterOpen') }
          ]}
        />
        <form className="sm:ml-auto sm:w-80" onSubmit={e => { e.preventDefault(); setQuery(q.trim()) }}>
          <SearchInput size="md" value={q} onChange={e => { setQ(e.target.value); if (!e.target.value) setQuery('') }} placeholder={t('manage.matches.search')} aria-label={t('manage.matches.search')} />
        </form>
      </div>
      {error && <Notice className="mb-3">{errorText(error)}</Notice>}
      {loading && !data ? (
        <SkeletonRows rows={5} pill={false} />
      ) : matches.length === 0 ? (
        <EmptyInset>{t('manage.matches.empty')}</EmptyInset>
      ) : (
        <RowList>
          {matches.map(m => {
            // null: the server could not read the storage; let the open try
            const noPdf = m.pdf === false
            return (
              <Row
                key={m.id}
                stripe={false}
                toolsIndent="sm:pl-2"
                actionIndent="pl-1.5"
                title={`${m.home_name || '–'} vs ${m.away_name || '–'}`}
                status={<MatchStatusPill status={m.status} />}
                meta={<>
                  {m.game_n ? <span className="tabular-nums">#{m.game_n}</span> : null}
                  {m.scheduled_at && <span className="tabular-nums">{dayTimeLabel(m.scheduled_at)}</span>}
                  {m.league && <span>{m.league}</span>}
                  {m.scorer_name && <span>{t('manage.games.scoredBy', { name: m.scorer_name })}</span>}
                </>}
                chips={noPdf
                  ? <Chip>{t('manage.scoresheets.noPdfYet')}</Chip>
                  : m.pdf_updated_at && <span className="text-xs text-stone-600">{t('manage.scoresheets.storedAt', { date: dayTimeLabel(m.pdf_updated_at) })}</span>}
                tools={(!noPdf || (canReopen && m.closed_at)) && <>
                  {!noPdf && <>
                    <RowTool primary className={TOOL_OFF} disabled={!online || !!busy} onClick={() => open(m, false)} aria-busy={busy === `${m.id}:view` || undefined}>
                      <Eye size={13} aria-hidden />{t('manage.scoresheets.view')}
                    </RowTool>
                    <RowTool className={TOOL_OFF} disabled={!online || !!busy} onClick={() => open(m, true)} aria-busy={busy === `${m.id}:download` || undefined}>
                      <Download size={13} aria-hidden />{t('manage.scoresheets.download')}
                    </RowTool>
                  </>}
                  {canReopen && m.closed_at && (
                    <RowTool className={TOOL_OFF} disabled={!online || !!busy} onClick={() => setReopenFor(m)}>
                      <RotateCcw size={13} aria-hidden />{t('manage.matches.reopen')}
                    </RowTool>
                  )}
                </>}
              />
            )
          })}
        </RowList>
      )}
      <ReasonModal
        open={!!reopenFor}
        title={t('manage.matches.reopenTitle', { game: reopenFor?.game_n ?? '' })}
        body={t('manage.matches.reopenBody')}
        label={t('manage.matches.reopenReason')}
        confirmLabel={t('manage.matches.reopen')}
        onClose={() => setReopenFor(null)}
        onSubmit={async (reason) => {
          const res = await admin.reopenMatch(reopenFor.id, { reason })
          if (res.error && res.error.code !== 'OV_NOT_CLOSED') return errorText(res.error)
          setReopenFor(null)
          toast.success(t('manage.matches.reopened'))
          reload()
          return null
        }}
      />
    </section>
  )
}
