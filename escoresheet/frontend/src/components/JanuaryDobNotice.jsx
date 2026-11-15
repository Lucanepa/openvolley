import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import { Banner } from '../ui'
import { januaryFirstDobs } from '../domain/januaryFirstDob'

/**
 * Match setup's roster editor: the team's players and bench officials born on
 * 1 January (domain/januaryFirstDob), often a placeholder or a bad import. A
 * note, never a block; the coin toss does not ask about them (owner
 * 2026-11-15). Only where the column holds dates of birth (a Global match may
 * use ID numbers or text: idMode).
 */
export default function JanuaryDobNotice({ roster, bench, idMode = 'dob' }) {
  const { t } = useTranslation()
  if (idMode !== 'dob') return null
  const people = januaryFirstDobs(roster, bench)
  if (!people.length) return null
  const list = people.map(p => `${p.name} (${p.dob})`).join(', ')
  return (
    <div data-testid="january-dob-notice">
      <Banner tone="warning" icon={AlertTriangle}>
        {t('roster.januaryDob', { count: people.length, list })}
      </Banner>
    </div>
  )
}
