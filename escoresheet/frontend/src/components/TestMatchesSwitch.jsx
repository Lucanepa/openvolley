import { FlaskConical, ListChecks } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '../ui/Button.jsx'

/**
 * The referee and bench pickers list the real games; a rehearsal (test) match
 * is listed apart, on this switch.
 */
export default function TestMatchesSwitch({ showTest, onChange }) {
  const { t } = useTranslation()
  return (
    <div className="mb-3 flex justify-center">
      <Button
        variant="ghost"
        size="md"
        icon={showTest ? ListChecks : FlaskConical}
        onClick={() => onChange(!showTest)}
        data-testid="test-matches-switch"
      >
        {showTest ? t('testMatches.back', 'Switch to real games') : t('testMatches.show', 'Switch to test matches')}
      </Button>
    </div>
  )
}
