import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Switch } from '../ui'
import { db } from '../db/db'
import { exportMatchData } from '../utils/backupManager'
import {
  deleteGlobalCloud, formatOrganizerCode, isOrganizerCode, newOrganizerCode, normalizeOrganizerCode,
  organizerUrl, saveGlobalCloud, savesToGlobalCloud, setGlobalShare, shareUrl
} from '../utils/globalCloudDb'
import { copyToClipboard } from '../utils/networkInfo'

/**
 * Match setup of a Global match: "Save in the cloud" (utils/globalCloudDb).
 * Off by default. On: the match is also kept readable in the database (no
 * account; its backup code finds it, its referee PIN guards it), with a share
 * link the scorer turns on and off, an optional tournament code for the
 * organizer's list, and "Delete from the cloud".
 */
export default function GlobalCloudPanel({ match }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState(null)
  const [typed, setTyped] = useState('')
  const [copied, setCopied] = useState(null)
  if (match?.global !== true) return null
  const on = match.cloud === true
  const hasPin = /^[0-9]{4,8}$/.test(String(match.refereePin || ''))
  const link = shareUrl(match.cloudShareToken)
  const org = isOrganizerCode(match.globalOrganizer) ? match.globalOrganizer : null

  const saveNow = async (changes = {}) => {
    const data = await exportMatchData(match.id)
    if (!data?.match) return { ok: false }
    return saveGlobalCloud({ ...data, match: { ...data.match, ...changes } }, { database: db })
  }
  const run = async (fn) => {
    setBusy(true)
    setProblem(null)
    try {
      const r = await fn()
      if (r && r.ok === false) setProblem(r.reason === 'offline' ? t('globalCloud.offline') : r.reason === 'OV_GLOBAL_PIN' ? t('globalCloud.pinRefused') : t('globalCloud.failed'))
    } finally { setBusy(false) }
  }
  const switchOn = (value) => run(async () => {
    if (!value) {
      await db.matches.update(match.id, { cloud: false })
      return { ok: true }
    }
    await db.matches.update(match.id, { cloud: true })
    return saveNow({ cloud: true })
  })
  const share = (value) => run(async () => {
    const saved = await saveNow()
    if (!saved.ok) return saved
    const r = await setGlobalShare(match, value)
    if (r.ok) await db.matches.update(match.id, { cloudShareToken: r.shareToken })
    return r
  })
  const setOrganizer = (code) => run(async () => {
    await db.matches.update(match.id, { globalOrganizer: code })
    return saveNow({ globalOrganizer: code })
  })
  const removeCloud = () => run(async () => {
    const r = await deleteGlobalCloud(match)
    if (r.ok) await db.matches.update(match.id, { cloud: false, cloudShareToken: null })
    return r
  })
  const copy = async (what, text) => { setCopied((await copyToClipboard(text))?.success === true ? what : null) }

  return (
    <div className="ov-kit mb-3 rounded-xl border border-stone-200 bg-white p-3" data-testid="global-cloud-panel">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-stone-900">{t('globalCloud.title')}</div>
          <p className="mt-0.5 text-xs leading-relaxed text-stone-500">{t('globalCloud.intro')}</p>
        </div>
        <Switch
          checked={on}
          disabled={busy || !hasPin}
          onCheckedChange={switchOn}
          aria-label={t('globalCloud.title')}
          data-testid="global-cloud-switch"
        />
      </div>
      {!hasPin && <p className="mt-2 text-xs text-amber-700">{t('globalCloud.needsPin')}</p>}
      {on && savesToGlobalCloud(match) && (
        <div className="mt-3 flex flex-col gap-3 border-t border-stone-100 pt-3">
          {/* Share link */}
          <div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-stone-800">{t('globalCloud.share')}</span>
              <Switch checked={!!link} disabled={busy} onCheckedChange={share} aria-label={t('globalCloud.share')} data-testid="global-cloud-share" />
            </div>
            {link && (
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <code className="break-all rounded-md bg-stone-100 px-2 py-1 text-xs" data-testid="global-cloud-share-url">{link}</code>
                <Button variant="secondary" size="sm" onClick={() => copy('share', link)}>{copied === 'share' ? t('globalCloud.copied') : t('globalCloud.copy')}</Button>
              </div>
            )}
            <p className="mt-1 text-xs text-stone-500">{t('globalCloud.shareHint')}</p>
          </div>
          {/* Tournament code: the organizer's list */}
          <div>
            <div className="text-sm text-stone-800">{t('globalCloud.organizer')}</div>
            {org ? (
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <code className="rounded-md bg-stone-100 px-2 py-1 font-mono text-sm tracking-wider" data-testid="global-cloud-organizer">{formatOrganizerCode(org)}</code>
                <Button variant="secondary" size="sm" onClick={() => copy('org', organizerUrl(org))}>{copied === 'org' ? t('globalCloud.copied') : t('globalCloud.copyOrganizerLink')}</Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => setOrganizer(null)}>{t('globalCloud.removeOrganizer')}</Button>
              </div>
            ) : (
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <Button variant="secondary" size="sm" disabled={busy} data-testid="global-cloud-organizer-new" onClick={() => setOrganizer(newOrganizerCode())}>{t('globalCloud.newOrganizer')}</Button>
                <input
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  placeholder="ABCDE 23456"
                  aria-label={t('globalCloud.organizer')}
                  data-testid="global-cloud-organizer-input"
                  className="h-9 w-36 rounded-lg border border-stone-300 px-2 font-mono text-sm uppercase tracking-wider"
                  autoCapitalize="characters"
                  autoComplete="off"
                  spellCheck={false}
                />
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => { const c = normalizeOrganizerCode(typed); if (c) { setTyped(''); setOrganizer(c) } else setProblem(t('globalCloud.badOrganizer')) }}>{t('globalCloud.join')}</Button>
              </div>
            )}
            <p className="mt-1 text-xs text-stone-500">{t('globalCloud.organizerHint')}</p>
          </div>
          <p className="text-xs text-stone-500">{t('globalCloud.otherDevice')}</p>
          <div>
            <Button variant="danger-outline" size="sm" disabled={busy} data-testid="global-cloud-delete" onClick={removeCloud}>{t('globalCloud.delete')}</Button>
          </div>
        </div>
      )}
      {problem && <p role="alert" className="mt-2 text-xs text-red-600">{problem}</p>}
    </div>
  )
}
