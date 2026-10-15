import { BookOpenText, Moon, Sun } from 'lucide-react'
import { setTheme } from '../utils/theme'

/**
 * The colour theme in a header menu (SimpleHeader / DashboardHeader items):
 * a section head and one row per choice, the chosen one inverted. The menu
 * stays open, so the change shows behind it.
 * @param {Function} t i18next t
 * @param {'light'|'dark'|'eink'} theme the current one (useTheme)
 */
export function themeMenuItems(t, theme) {
  return [
    { header: t('options.theme') },
    { icon: <Sun size={14} aria-hidden="true" />, label: t('options.themeLight'), onClick: () => setTheme('light'), active: theme === 'light', keepOpen: true },
    { icon: <Moon size={14} aria-hidden="true" />, label: t('options.themeDark'), onClick: () => setTheme('dark'), active: theme === 'dark', keepOpen: true },
    { icon: <BookOpenText size={14} aria-hidden="true" />, label: t('options.themeEink'), onClick: () => setTheme('eink'), active: theme === 'eink', keepOpen: true }
  ]
}
