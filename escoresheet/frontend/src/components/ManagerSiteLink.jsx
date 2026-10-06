import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLink } from 'lucide-react'
import { consoleHeaderBtn } from '../ui'
import { managerSiteUrl } from '../utils/managerSite'

/**
 * "Open manager.openvolley.app" in the header of the in-app manage console.
 * Web only: the desktop and Android apps (and the venue LAN server) keep the
 * console in-app and draw nothing here.
 */
export default function ManagerSiteLink() {
  const { t } = useTranslation()
  const url = useMemo(() => managerSiteUrl(), [])
  if (!url) return null
  const host = new URL(url).host
  const label = t('managerSite.openManager', { host })
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className={consoleHeaderBtn} aria-label={label} title={label} data-testid="manager-site-link">
      <ExternalLink size={14} aria-hidden />
      <span className="hidden sm:inline">{host}</span>
    </a>
  )
}
