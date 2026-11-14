import { useTranslation } from 'react-i18next'
import Modal from './Modal'
import { setToolMode } from '../utils/toolMode'

/**
 * First open on a device: Swiss or Global. Cannot be dismissed without a
 * choice; Options changes it later while no match is on the device.
 */
export default function ToolModeChooser({ open }) {
  const { t } = useTranslation()
  const choose = (mode) => setToolMode(mode)
  const card = 'flex w-full flex-col gap-1 rounded-xl border border-stone-200 bg-white p-4 text-left transition-colors hover:bg-stone-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500'
  return (
    <Modal open={open} onClose={() => {}} hideCloseButton width={480} title={t('toolChooser.title', 'How do you use OpenVolley?')}>
      <div className="ov-kit space-y-3" data-testid="tool-chooser">
        <button type="button" className={card} data-testid="tool-chooser-swiss" onClick={() => choose('swiss')}>
          <span className="text-base font-semibold text-stone-900">{t('home.tool.swiss', 'Swiss')}</span>
          <span className="text-sm text-stone-600">{t('toolChooser.swissBody', 'Swiss league games: sign-in, game list, Einsatzliste, club rosters and the cloud.')}</span>
        </button>
        <button type="button" className={card} data-testid="tool-chooser-global" onClick={() => choose('global')}>
          <span className="text-base font-semibold text-stone-900">{t('home.tool.global', 'Global')}</span>
          <span className="text-sm text-stone-600">{t('toolChooser.globalBody', 'Any tournament or friendly: no sign-in, rosters and games from Excel. Teams and players stay on this device.')}</span>
        </button>
        <p className="m-0 text-xs text-stone-500">{t('toolChooser.later', 'You can change this later in Options, as long as no match is on this device.')}</p>
      </div>
    </Modal>
  )
}
