import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import { Banner } from '../ui'

/**
 * Match Setup (db/024): the roster's players that the club's licence list has
 * with the other gender than the game's (domain/clubPlayers.js
 * clubGenderWarnings). A warning, never a block (owner decision D2: the
 * scorer can adjust anything in the hall).
 */
export default function ClubGenderNotice({ warnings, gender }) {
  const { t } = useTranslation()
  if (!warnings?.length || (gender !== 'm' && gender !== 'f')) return null
  const names = warnings.map((w) => w.name).join(', ')
  return (
    <div data-testid="club-gender-warning">
      <Banner tone="warning" icon={AlertTriangle}>
        {t(gender === 'm' ? 'clubPlayers.warningMen' : 'clubPlayers.warningWomen', { count: warnings.length, names })}
      </Banner>
    </div>
  )
}
