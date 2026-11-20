import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import { Banner } from '../ui'
import { januaryFirstDobs } from '../domain/januaryFirstDob'

/**
 * Match setup's roster editor: the team's players and bench officials born on
 * 1 January (domain/januaryFirstDob), often a placeholder or a bad import. A
 * note, never a block; the coin toss does not ask about them (owner
 * 2026-11-15). Where the column may hold dates of birth: a Swiss match
 * ('licence': a licence number, or a date the scorer typed; only the dates
 * can be 01.01.) and a Global match on birthdates; not where a Global match
 * uses ID numbers or text (idMode).
 */
export default function JanuaryDobNotice({ roster, bench, idMode = 'dob' }) {
  const { t } = useTranslation()
  if (idMode !== 'dob' && idMode !== 'licence') return null
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
