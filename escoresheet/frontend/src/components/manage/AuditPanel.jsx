import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { admin } from '../../lib/accountApi'
import { plainRole } from '../../lib/access'
import { useOnline, OfflineBanner, PanelHead, personName, useErrorText, useKitLang } from './common'
import { RowList, Row, DateRail, EmptyInset, SkeletonRows, Notice, Button, dayLabel, timeLabel, weekdayLabel } from '../../ui'

const PAGE = 50

const APPROVAL_ACTIONS = new Set(['match.approve', 'match.approval_revoke', 'match.approval_void'])
// The entries about one club (db/018, db/020): the club's name leads their line
const CLUB_ACTIONS = new Set(['club.create', 'club.update', 'club.delete', 'club.managers', 'club.contact', 'club.member_remove'])

/** "club_rule.set" -> "Club rule set": an action this build has no label for yet reads as words, never as a code. */
export function readableAction(action) {
  const words = String(action ?? '').replace(/[._]+/g, ' ').trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : ''
}

/**
 * An audit entry's title: manage.audit.actions.<the action, "." as "_">
 * (club.managers -> club_managers), else readableAction().
 */
export function auditActionLabel(action, t = null) {
  const fallback = readableAction(action)
  return t ? t(`manage.audit.actions.${String(action ?? '').replace(/\./g, '_')}`, fallback) : fallback
}

/**
 * A short, human line for an audit entry's details (never the whole JSON).
 * The second argument is `{ roleLabel, t }` (or `t` alone):
 * - `roleLabel` names a role (OpenBeach's console: "Scorer" for beach:scorer,
 *   as everywhere else there); without it roles show as stored;
 * - `t` words the approval entries ("1st referee · ID 6F1C2A9B") and the
 *   switches, counts and clubs of the others.
 * `entry.club_name` is the club of details.club_id as the backend lists it
 * (GET /api/admin/audit): a club entry, an invite code of a club.
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
  // An account an admin deleted (or a sign-up rejected): no name or address
  // is kept, only its roles, the official matches that stay, its short id
  if (entry?.action === 'account.delete' || entry?.action === 'account.reject') {
    const roles = Array.isArray(d.roles) ? d.roles : []
    parts.push(roles.length ? roles.map(role).join(', ') : tr('manage.audit.noRole', 'No role'))
    if (Number.isFinite(d.matches_kept) && d.matches_kept > 0) parts.push(tr('manage.audit.matchesKept', `${d.matches_kept} matches kept`, { count: d.matches_kept }))
    if (typeof d.account_id === 'string') parts.push(`ID ${d.account_id.slice(0, 8)}`)
    return parts.join(' · ')
  }
  if (entry?.action === 'approval_pin.locked') {
    if (Number.isFinite(d.failures)) parts.push(tr('manage.approvals.wrongPins', `${d.failures} wrong PINs`, { failures: d.failures }))
    if (d.disabled) parts.push(tr('manage.approvals.blocked', 'blocked'))
    return parts.join(' · ')
  }
  const club = entry?.club_name ? String(entry.club_name) : null
  if (CLUB_ACTIONS.has(entry?.action)) {
    // club.delete (and a renamed club.update) carries the name itself
    const name = club || (d.name ? String(d.name) : null)
    if (name) parts.push(name)
    if (Array.isArray(d.after)) parts.push(tr('manage.clubs.managersCount', `${d.after.length} managers`, { count: d.after.length }))
    if (Number.isFinite(d.scorers)) parts.push(tr('manage.clubs.scorers', `Scorers: ${d.scorers}`, { count: d.scorers }))
    return parts.join(' · ')
  }
  if (entry?.action === 'account.clubs') {
    // an admin's whole list (names), or the club of an invite code (club_name)
    if (Array.isArray(d.names)) parts.push(d.names.length ? d.names.map(String).join(', ') : tr('manage.invites.noClub', 'No club'))
    else if (club) parts.push(`+ ${club}`)
    return parts.join(' · ')
  }
  if (entry?.action === 'club_rule.set' && typeof d.enabled === 'boolean') {
    return d.enabled ? tr('manage.clubs.ruleIsOn', 'The club rule is on') : tr('manage.clubs.ruleIsOff', 'The club rule is off')
  }
  if (entry?.action === 'settings.final_email' && typeof d.send_final_email === 'boolean') {
    return d.send_final_email
      ? tr('manage.settings.finalEmailIsOn', 'Final scoresheets are now sent by email')
      : tr('manage.settings.finalEmailIsOff', 'Final scoresheets are no longer sent')
  }
  if (entry?.action === 'match.final_mail') {
    if (d.game_n) parts.push(`#${d.game_n}`)
    if (Number.isFinite(d.recipients)) parts.push(tr('manage.audit.recipients', `${d.recipients} recipients`, { count: d.recipients }))
    if (d.corrected) parts.push(tr('manage.audit.corrected', 'corrected'))
    return parts.join(' · ')
  }
  if (entry?.action === 'activity.delete') {
    // the match id or the account (the entry's target) whose rows went
    if (d.match) parts.push(String(d.match))
    if (Number.isFinite(d.rows)) parts.push(tr('manage.audit.rows', `${d.rows} entries`, { count: d.rows }))
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
  // invite.create / invite.redeem of a club's code
  if (club) parts.push(club)
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
                  title={auditActionLabel(e.action, t)}
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
