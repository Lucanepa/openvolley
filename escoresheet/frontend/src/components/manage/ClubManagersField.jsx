import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Send, X } from 'lucide-react'
import { clubsApi } from '../../lib/accountApi'
import { usePanelData, InlineError, useErrorText } from './common'
import { Button, Field, Input, Select, cn, FOCUS_RING, toast } from '../../ui'

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

/**
 * A club's managers on its page (db/020, db/029; owner 2026-11-11: "managers
 * can be picked from members of that club, and if not, send a link to sign
 * up on the manager. So no random emails only").
 *
 *   picked      the managers as they will be saved: [{ user_id, email, name }]
 *   onChange    the new list (the club page saves it with the club)
 *
 * "Add a manager" lists the accounts linked to the club (its scorers, the
 * managers of its teams, its managers: GET .../manager-candidates). Anyone
 * else gets a club manager link by mail (POST .../manager-invites): it works
 * once for two weeks, and whoever opens it and signs in becomes a manager.
 * The link is shown too, to pass on when the mail does not arrive. A new
 * club has no accounts and no links yet: save it first.
 */
export default function ClubManagersField({ club, picked, onChange, disabled = false }) {
  const { t, i18n } = useTranslation()
  const errorText = useErrorText()
  const clubId = club?.id || null
  const found = usePanelData(() => clubsApi.managerCandidates(clubId), [clubId], { enabled: !!clubId })
  const candidates = found.data?.candidates || []
  const pickedIds = new Set(picked.map((m) => m.user_id))
  const open = candidates.filter((c) => !pickedIds.has(c.id))
  const [email, setEmail] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(null)
  const [error, setError] = useState('')

  const viaText = (via) => (via || []).map((v) => t(`manage.clubs.via.${v}`)).join(', ')
  const add = (id) => {
    const c = candidates.find((x) => x.id === id)
    if (c) onChange([...picked, { user_id: c.id, email: c.email, name: c.name }])
  }
  const remove = (id) => onChange(picked.filter((m) => m.user_id !== id))
  const validEmail = EMAIL_RE.test(email.trim())
  const invite = async () => {
    if (!clubId || !validEmail || sending) return
    setSending(true)
    setError('')
    const res = await clubsApi.inviteManager(clubId, { email: email.trim(), lang: i18n.language })
    setSending(false)
    if (res.error) { setError(errorText(res.error)); return }
    setSent({ email: email.trim(), link: res.data.link, mailed: res.data.mailed === true })
    setEmail('')
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(sent?.link || '')
      toast.success(t('manage.clubs.linkCopied'))
    } catch { /* no clipboard: the link stays selectable */ }
  }

  return (
    <Field label={t('manage.clubs.managers')} hint={t('manage.clubs.managersPickHint')}>
      <div className="space-y-2" data-testid="club-managers">
        {picked.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5" data-testid="club-managers-picked">
            {picked.map((m) => (
              <li key={m.user_id} className="inline-flex max-w-full items-center gap-1 rounded-full border border-stone-200 bg-stone-50 py-0.5 pl-2.5 pr-1 text-xs text-stone-700">
                <span className="truncate" title={m.email}>{m.name ? `${m.name} · ${m.email}` : m.email}</span>
                <button
                  type="button"
                  onClick={() => remove(m.user_id)}
                  disabled={disabled}
                  aria-label={t('manage.clubs.removeManager', { name: m.name || m.email })}
                  className={cn('inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-stone-500 hover:bg-stone-200 hover:text-stone-800', FOCUS_RING)}
                >
                  <X size={12} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-stone-500">{t('manage.clubs.noManagers')}</p>
        )}

        {clubId ? (
          open.length > 0 ? (
            <Select
              size="md"
              block
              value=""
              onChange={(e) => add(e.target.value)}
              disabled={disabled}
              aria-label={t('manage.clubs.addManager')}
              placeholder={t('manage.clubs.addManager')}
              options={open.map((c) => ({ value: c.id, label: `${c.name ? `${c.name} · ${c.email}` : c.email} (${viaText(c.via)})` }))}
              data-testid="club-manager-pick"
            />
          ) : (
            !found.loading && <p className="text-xs text-stone-500">{candidates.length ? t('manage.clubs.allPicked') : t('manage.clubs.noCandidates')}</p>
          )
        ) : (
          <p className="text-xs text-stone-500">{t('manage.clubs.saveFirst')}</p>
        )}

        {clubId && (
          <div className="rounded-lg border border-stone-200 bg-stone-50/60 p-2.5">
            <p className="mb-1.5 text-xs font-medium text-stone-700">{t('manage.clubs.inviteTitle')}</p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                type="email"
                value={email}
                onChange={(e) => { setEmail(e.target.value); setError('') }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); invite() } }}
                placeholder={t('manage.clubs.invitePlaceholder')}
                aria-label={t('manage.clubs.invitePlaceholder')}
                maxLength={254}
                disabled={disabled || sending}
                className="w-full min-w-0 sm:flex-1"
                data-testid="club-manager-invite-email"
              />
              <Button variant="secondary" icon={Send} onClick={invite} loading={sending} disabled={disabled || !validEmail || sending} data-testid="club-manager-invite-send">
                {t('manage.clubs.inviteSend')}
              </Button>
            </div>
            <p className="mt-1.5 text-[11px] text-stone-500">{t('manage.clubs.inviteHint')}</p>
            <InlineError error={error} />
            {sent && (
              <div role="status" className={cn('mt-2 rounded-md border p-2 text-xs', sent.mailed ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-amber-200 bg-amber-50 text-amber-900')} data-testid="club-manager-invite-sent">
                <p>{sent.mailed ? t('manage.clubs.inviteMailed', { email: sent.email }) : t('manage.clubs.inviteNotMailed', { email: sent.email })}</p>
                <div className="mt-1.5 flex items-center gap-2">
                  <code className="min-w-0 flex-1 select-all break-all rounded bg-white px-1.5 py-1 text-[11px] text-stone-700">{sent.link}</code>
                  <Button variant="ghost" size="sm" icon={Copy} onClick={copy}>{t('manage.clubs.copyLink')}</Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </Field>
  )
}
