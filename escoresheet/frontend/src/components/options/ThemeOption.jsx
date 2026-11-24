import { useTranslation } from 'react-i18next'
import { BookOpenText, Moon, Sun } from 'lucide-react'
import { SegmentedControl } from '../../ui'
import { setTheme, useTheme } from '../../utils/theme'

/**
 * Options → Display mode: the colour theme (light, dark, e-ink). Applies at
 * once and is kept on this device (utils/theme.js). The label row and the
 * strip match the screen mode row above it; `info` is the dialog's own
 * InfoDot. Goes inside the dialog's Row.
 */
export default function ThemeOption({ info }) {
  const { t } = useTranslation()
  const theme = useTheme()
  return (
    <div className="min-w-0 flex-1" data-testid="options-theme">
      <div className="mb-2 flex items-center gap-1.5">
        <div className="text-sm font-semibold text-stone-900">{t('options.theme')}</div>
        {info}
      </div>
      <SegmentedControl
        ariaLabel={t('options.theme')}
        variant="joined"
        size="lg"
        value={theme}
        className="max-w-md"
        options={[
          { value: 'light', label: t('options.themeLight'), icon: Sun },
          { value: 'dark', label: t('options.themeDark'), icon: Moon },
          { value: 'eink', label: t('options.themeEink'), icon: BookOpenText }
        ]}
        onChange={setTheme}
      />
    </div>
  )
}
