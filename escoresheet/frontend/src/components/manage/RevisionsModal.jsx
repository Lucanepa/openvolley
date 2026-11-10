import { useTranslation } from 'react-i18next'
import { Modal } from '../../ui'
import RevisionsList from './RevisionsList'

/**
 * The corrections of a match in a dialog. Closed matches shows them on the
 * match's own page now (#matches/<match id>, RevisionsList); the dialog stays
 * for a caller that wants them over its list.
 */
export default function RevisionsModal({ match, onClose }) {
  const { t } = useTranslation()
  return (
    <Modal
      open={!!match}
      onClose={onClose}
      layout="sections"
      size="xl"
      title={t('manage.revisions.title', { game: match?.game_n ?? '' })}
      description={t('manage.revisions.description')}
      closeLabel={t('common.close', 'Close')}
    >
      {match && <RevisionsList matchId={match.id} />}
    </Modal>
  )
}
