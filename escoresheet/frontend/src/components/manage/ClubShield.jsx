import { useTranslation } from 'react-i18next'
import { Shield, ShieldCheck } from 'lucide-react'
import { cn } from '../../ui'

/**
 * A roster row's shield (owner 2026-11-10: "Those from the club/recognized/
 * linked -> green shield. Those added manually -> gray shield, but can be
 * linked lately in case"): green, the person is in a list uploaded from
 * VolleyManager (the same licence number, or the same name and date of
 * birth); gray, typed by hand, also when kept in the club's lists by hand
 * (`manual`: green once an upload has the licence number).
 *
 * `person`: the club person (clubPersonOf) or null. `fill`: what the club
 * adds to the row (clubFillOf); with `onFill` the green shield fills it in.
 * `onLink`: the gray shield opens the club picker for the row. Without the
 * handler a shield is only shown.
 */
export default function ClubShield({ person, fill = {}, onLink = null, onFill = null, className }) {
  const { t } = useTranslation()
  const base = 'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md'
  // p-0 and a transparent background over the scorer app's global button
  // rule (Match Setup), which padded the icon down to a dot at 800 px
  const button = 'bg-transparent p-0 transition-colors hover:bg-stone-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60'
  const plain = { padding: 0 }
  if (person && !person.manual) {
    const fields = Object.keys(fill)
    const label = fields.length
      ? t('clubPlayers.shield.fill', { fields: fields.map((f) => t(`clubPlayers.shield.fields.${f}`)).join(', ') })
      : t('clubPlayers.shield.club', { number: person.sv_number })
    if (fields.length && onFill) {
      return (
        <button type="button" onClick={onFill} aria-label={label} title={label} style={plain} className={cn(base, button, 'relative text-emerald-600', className)} data-testid="club-shield" data-shield="fill">
          <ShieldCheck size={18} className="shrink-0" aria-hidden />
          <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-amber-500 ring-2 ring-white" aria-hidden />
        </button>
      )
    }
    return (
      <span role="img" aria-label={label} title={label} className={cn(base, 'text-emerald-600', className)} data-testid="club-shield" data-shield="club">
        <ShieldCheck size={18} className="shrink-0" aria-hidden />
      </span>
    )
  }
  // in the club's lists by hand, or not there at all
  const kept = !!person
  const label = kept
    ? t(onLink ? 'clubPlayers.shield.manualLink' : 'clubPlayers.shield.manual')
    : t(onLink ? 'clubPlayers.shield.handLink' : 'clubPlayers.shield.hand')
  const state = kept ? 'manual' : 'hand'
  if (onLink) {
    return (
      <button type="button" onClick={onLink} aria-label={label} title={label} style={plain} className={cn(base, button, 'text-stone-400 hover:text-stone-600', className)} data-testid="club-shield" data-shield={state}>
        <Shield size={18} className="shrink-0" aria-hidden />
      </button>
    )
  }
  return (
    <span role="img" aria-label={label} title={label} className={cn(base, 'text-stone-400', className)} data-testid="club-shield" data-shield={state}>
      <Shield size={18} className="shrink-0" aria-hidden />
    </span>
  )
}
