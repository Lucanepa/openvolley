import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { admin } from '../../lib/accountApi'
import { formatApprovalTime, normalizeApprovalQuery } from '../../domain/accountApproval'
import { useErrorText } from './common'
import { Button, Checkbox, Chip, EmptyInset, Input, Notice, RowList, Row, SkeletonRows, StatusPill } from '../../ui'

/** "1st referee" etc. for a server slot (manage.* is standard German in de-CH). */
export function useSlotLabel() {
  const { t } = useTranslation()
  return (slot) => t(`manage.approvals.slots.${slot}`, slot)
}

/**
 * One chip per active account approval of a match row (listMatches,
 * listOfficialGames claim): "<slot> · <name>", time and ID in the tooltip.
 * A stale one (the result changed since) is amber with "Result changed".
 */
export function ApprovalChips({ approvals }) {
  const { t } = useTranslation()
  const slotLabel = useSlotLabel()
  if (!Array.isArray(approvals) || approvals.length === 0) return null
  return (
    <>
      {approvals.map(a => {
        const stale = a.result_matches === false
        return (
          <Chip
            key={`${a.slot}-${a.short_id}`}
            tone={stale ? 'amber' : 'emerald'}
            title={t('manage.approvals.chipTitle', { time: formatApprovalTime(a.approved_at), id: a.short_id })}
          >
            <span data-testid="approval-chip">
              {t('manage.approvals.chip', { slot: slotLabel(a.slot), name: a.name })}
              {stale ? ` · ${t('manage.approvals.resultChanged')}` : ''}
            </span>
          </Chip>
        )
      })}
    </>
  )
}

/**
 * Approval lookup for admins: the "ID" printed on a PDF, a game number or an
 * external_id (GET /api/admin/approvals). Lists the admin records.
 */
export function ApprovalLookup({ online }) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const slotLabel = useSlotLabel()
  const [q, setQ] = useState('')
  const [includeRevoked, setIncludeRevoked] = useState(false)
  const [state, setState] = useState({ loading: false, error: null, rows: null })

  const search = async (e) => {
    e?.preventDefault?.()
    // "ID 6F1C2A9B" as printed on the PDF, "#4711", or an external_id
    const query = normalizeApprovalQuery(q)
    if (!query || state.loading) return
    setState(s => ({ ...s, loading: true }))
    const res = await admin.listApprovals({ q: query, include_revoked: includeRevoked, limit: 50 })
    setState({ loading: false, error: res.error || null, rows: res.error ? null : (res.data?.approvals || []) })
  }

  return (
    <div className="mb-4 rounded-xl border border-stone-200/70 bg-stone-50/60 p-3" data-testid="approval-lookup">
      <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-stone-800">{t('manage.approvals.lookup')}</div>
      <form className="flex flex-col gap-2 sm:flex-row sm:items-center" onSubmit={search}>
        <Input
          size="md"
          type="search"
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder={t('manage.approvals.lookupPlaceholder')}
          aria-label={t('manage.approvals.lookupPlaceholder')}
          className="sm:w-72"
          autoComplete="off"
        />
        <Checkbox
          variant="dense"
          label={t('manage.approvals.includeRevoked')}
          checked={includeRevoked}
          onChange={e => setIncludeRevoked(e.target.checked)}
        />
        <Button type="submit" variant="secondary" loading={state.loading} disabled={!online || !q.trim() || state.loading} className="sm:ml-auto">
          {t('manage.approvals.lookupButton')}
        </Button>
      </form>
      {state.error && <Notice className="mt-2">{errorText(state.error)}</Notice>}
      {state.loading && !state.rows ? (
        <div className="mt-2"><SkeletonRows rows={2} pill={false} /></div>
      ) : state.rows && state.rows.length === 0 ? (
        <EmptyInset className="mt-2">{t('manage.approvals.lookupEmpty')}</EmptyInset>
      ) : state.rows ? (
        <RowList className="mt-2">
          {state.rows.map(a => {
            const m = a.match || {}
            const revoked = !!a.revoked_at
            return (
              <Row
                key={a.id}
                stripe={false}
                title={`${slotLabel(a.slot)} · ${a.name}`}
                status={revoked
                  ? <StatusPill tone="neutral">{t('manage.approvals.revoked')}</StatusPill>
                  : <StatusPill tone="done">{t('manage.approvals.active')}</StatusPill>}
                meta={<>
                  <span className="font-mono tabular-nums">ID {a.short_id}</span>
                  <span className="tabular-nums">{formatApprovalTime(a.approved_at)}</span>
                  {a.email && <span>{a.email}</span>}
                  {(m.game_n || m.home_name) && (
                    <span>{m.game_n ? `#${m.game_n} ` : ''}{m.home_name || '–'} vs {m.away_name || '–'}</span>
                  )}
                </>}
                chips={<>
                  {revoked && (
                    <span className="text-xs text-stone-600">
                      {formatApprovalTime(a.revoked_at)}
                      {a.revoked_reason ? ` · ${t(`manage.approvals.reasons.${a.revoked_reason}`, a.revoked_reason)}` : ''}
                      {a.revoked_by_name ? ` · ${a.revoked_by_name}` : ''}
                    </span>
                  )}
                  {a.requested_by_name && <span className="text-xs text-stone-500">{t('manage.approvals.requestedBy', { name: a.requested_by_name })}</span>}
                  {(a.ip_hash8 || a.device_hash8) && (
                    <span className="font-mono text-[11px] text-stone-400">{t('manage.approvals.hashes', { ip: a.ip_hash8 || '–', device: a.device_hash8 || '–' })}</span>
                  )}
                </>}
              />
            )
          })}
        </RowList>
      ) : null}
    </div>
  )
}
