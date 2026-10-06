import { useTranslation } from 'react-i18next'
import { KeyRound } from 'lucide-react'
import KitModal from '../manage/KitModal'
import InviteCodeForm from './InviteCodeForm'

/** The invite-code form in a dialog (user menu "Enter invite code"). */
export default function RedeemInviteModal({ open, onClose }) {
  const { t } = useTranslation()
  return (
    <KitModal open={open} onClose={onClose} decision title={t('manage.menuInviteCode')} icon={KeyRound} closeLabel={t('common.close', 'Close')}>
      <p className="mb-3 text-sm text-stone-600">{t('access.pendingBody')}</p>
      <InviteCodeForm autoFocus onRedeemed={() => onClose?.()} />
    </KitModal>
  )
}
