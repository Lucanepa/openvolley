import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ShieldPlus } from 'lucide-react'
import KitModal from './KitModal'
import { Button, Checkbox } from '../../ui'

/**
 * Save asks whether the people typed by hand go into the club's lists too
 * (owner 2026-11-10: "if I add somebody manually, when saving ask if I want to
 * save him/her in the club"). `offer`: handTypedForClub's entries, all ticked
 * at first; `noLicence`: the names that can't go there (no licence number).
 * onSave(keys of the ticked ones, keys of the unticked ones): the roster is
 * saved either way.
 */
export default function ClubOfferModal({ open, ...rest }) {
  if (!open) return null
  return <OfferBody {...rest} />
}

function OfferBody({ offer = [], noLicence = [], clubName = '', busy = false, onCancel, onSave }) {
  const { t } = useTranslation()
  const [ticked, setTicked] = useState(() => new Set(offer.map((o) => o.key)))
  const toggle = (key, on) => setTicked((cur) => {
    const next = new Set(cur)
    if (on) next.add(key)
    else next.delete(key)
    return next
  })
  const save = () => onSave([...ticked], offer.map((o) => o.key).filter((k) => !ticked.has(k)))
  return (
    <KitModal
      open
      onClose={() => { if (!busy) onCancel() }}
      dismissible={!busy}
      icon={ShieldPlus}
      title={t('clubPlayers.offer.title')}
      closeLabel={t('common.close', 'Close')}
      footer={<>
        <Button variant="secondary" size="lg" onClick={onCancel} disabled={busy}>{t('clubPlayers.offer.back')}</Button>
        <Button variant="positive" size="lg" onClick={save} loading={busy} disabled={busy} data-testid="club-offer-save">
          {ticked.size ? t('clubPlayers.offer.saveAdd', { count: ticked.size }) : t('clubPlayers.offer.saveOnly')}
        </Button>
      </>}
    >
      <div className="space-y-3" data-testid="club-offer">
        <p className="text-sm text-stone-600">{t('clubPlayers.offer.body', { club: clubName || t('clubPlayers.offer.theClub') })}</p>
        <ul className="m-0 list-none space-y-2 p-0">
          {offer.map((o) => (
            <li key={o.key} className="rounded-xl border border-stone-200 bg-white px-3 py-2" data-testid="club-offer-row">
              <Checkbox
                checked={ticked.has(o.key)}
                onChange={(e) => toggle(o.key, e.target.checked)}
                label={<span className="font-medium text-stone-900 [overflow-wrap:anywhere]">{o.name}</span>}
                hint={`${t('clubPlayers.licence', { number: o.person.sv_number })} · ${t(`clubPlayers.offer.list.${o.list}`)}`}
              />
            </li>
          ))}
        </ul>
        {noLicence.length > 0 && (
          <p className="text-xs text-stone-500" data-testid="club-offer-no-licence">{t('clubPlayers.offer.noLicence', { names: noLicence.join(', ') })}</p>
        )}
      </div>
    </KitModal>
  )
}
