import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { admin } from '../../lib/accountApi'
import { plainRole } from '../../lib/access'
import { useOnline, OfflineBanner, PanelHead, personName, useErrorText, useKitLang } from './common'
import { RowList, Row, DateRail, EmptyInset, SkeletonRows, Notice, Button, dayLabel, timeLabel, weekdayLabel } from '../../ui'

const PAGE = 50

const APPROVAL_ACTIONS = new Set(['match.approve', 'match.approval_revoke', 'match.approval_void'])

/**
 * A short, human line for an audit entry's details (never the whole JSON).
 * The second argument is `{ roleLabel, t }` (or `t` alone):
 * - `roleLabel` names a role (OpenBeach's console: "Scorer" for beach:scorer,
 *   as everywhere else there); without it roles show as stored;
 * - `t` words the approval entries ("1st referee · ID 6F1C2A9B").
 */
export function auditDetailsLine(entry, opts = {}) {
  const { roleLabel, t = null } = typeof opts === 'function' ? { t: opts } : (opts || {})
  const d = entry?.details || {}
  const role = (r) => (roleLabel ? roleLabel(String(r)) : String(r))
  const parts = []
  const tr = (key, fallback, opts) => (t ? t(key, { defaultValue: fallback, ...opts }) : fallback)
  if (APPROVAL_ACTIONS.has(entry?.action)) {
    if (d.slot) parts.push(tr(`manage.approvals.slots.${d.slot}`, d.slot))
    if (d.short_id) parts.push(`ID ${d.short_id}`)
    if (d.game_n) parts.push(`#${d.game_n}`)
    if (Number.isFinite(d.count)) parts.push(`× ${d.count}`)
    if (d.reason) parts.push(tr(`manage.approvals.reasons.${d.reason}`, String(d.reason)))
    return parts.join(' · ')
  }
  if (entry?.action === 'approval_pin.locked') {
    if (Number.isFinite(d.failures)) parts.push(tr('manage.approvals.wrongPins', `${d.failures} wrong PINs`, { failures: d.failures }))
    if (d.disabled) parts.push(tr('manage.approvals.blocked', 'blocked'))
    return parts.join(' · ')
  }
  if (Array.isArray(d.added) && d.added.length) parts.push(`+ ${d.added.map(role).join(', ')}`)
  if (Array.isArray(d.removed) && d.removed.length) parts.push(`− ${d.removed.map(role).join(', ')}`)
  if (d.game_n) parts.push(`#${d.game_n}`)
  // OpenBeach tournaments (tournament.*): the match code, the tournament, the pair
  if (d.code) parts.push(String(d.code))
  if (d.title) parts.push(String(d.title))
  if (d.category) parts.push(String(d.category))
  if (d.name) parts.push(String(d.name))
  if (d.label) parts.push(String(d.label))
  if (d.role && !d.added) parts.push(role(d.role))
  if (d.via) parts.push(String(d.via))
  if (d.email) parts.push(String(d.email))
  if (d.reason) parts.push(`“${String(d.reason).slice(0, 120)}”`)
  return parts.join(' · ')
}

/** The audit log, newest first, paged by id (admins). `app` 'beach': OpenBeach's entries only. */
export default function AuditPanel({ app }) {
  const { t } = useTranslation()
  const lang = useKitLang()
  const online = useOnline()
  const errorText = useErrorText()
  const [entries, setEntries] = useState([])
  const [next, setNext] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  // OpenBeach's console names its roles plainly (beach:scorer -> "Scorer")
  const roleLabel = app === 'beach' ? (r) => t(`access.roles.${plainRole(r)}`, plainRole(r)) : undefined

  const load = async (before = null) => {
    setLoading(true)
    const res = await admin.listAudit({ limit: PAGE, before: before ?? undefined, ...(app ? { app } : {}) })
    setLoading(false)
    if (res.error) {
      setError(res.error)
      return
    }
    setError(null)
    const page = res.data?.entries || []
    setEntries(prev => (before ? [...prev, ...page] : page))
    setNext(res.data?.next_before ?? null)
  }

  useEffect(() => {
    if (online) load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online])

  return (
    <section>
      <PanelHead title={t('manage.tabs.audit')} />
      <OfflineBanner online={online} />
      {error && <Notice className="mb-3">{errorText(error)}</Notice>}
      {loading && !entries.length ? (
        <SkeletonRows rows={6} pill={false} />
      ) : entries.length === 0 ? (
        <EmptyInset>{t('manage.audit.empty')}</EmptyInset>
      ) : (
        <>
          <RowList>
            {entries.map(e => {
              const actor = personName(e.actor_name, '', e.actor_email)
              const target = personName(e.target_name, '', e.target_email)
              const details = auditDetailsLine(e, { roleLabel, t })
              return (
                <Row
                  key={e.id}
                  leading={<DateRail weekday={weekdayLabel(e.at, lang)} date={dayLabel(e.at)} time={timeLabel(e.at)} />}
                  title={t(`manage.audit.actions.${String(e.action).replace(/\./g, '_')}`, e.action)}
                  meta={<>
                    {actor && <span>{actor}</span>}
                    {target && target !== actor && <span>→ {target}</span>}
                    {details && <span className="break-words">{details}</span>}
                  </>}
                />
              )
            })}
          </RowList>
          {next !== null && (
            <div className="mt-3 flex justify-center">
              <Button variant="secondary" loading={loading} disabled={!online || loading} onClick={() => load(next)}>{t('manage.audit.loadMore')}</Button>
            </div>
          )}
        </>
      )}
    </section>
  )
}
