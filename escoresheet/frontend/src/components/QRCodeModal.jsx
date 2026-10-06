import { useTranslation } from 'react-i18next'
import { QRCodeSVG } from 'qrcode.react'
import { getBackendUrl } from '../utils/backendConfig'
import { copyToClipboard } from '../utils/networkInfo'
import { matchTeamNames } from '../utils/serverDataSync'
import { useState } from 'react'
import { cn, FOCUS_RING } from '../ui'

const ROLE_LABELS = {
  referee: 'Referee dashboard',
  bench_home: 'Home bench',
  bench_away: 'Away bench',
  livescore: 'Livescore'
}

const ROLE_COLORS = {
  referee: '#3b82f6',
  bench_home: '#10b981',
  bench_away: '#ef4444',
  livescore: '#8b5cf6'
}

const ROLE_SUBDOMAINS = {
  referee: 'referee',
  bench_home: 'bench',
  bench_away: 'bench',
  livescore: 'livescore'
}

/**
 * Where the tablet app for a role lives when the tablets use the cloud backend:
 * next to the scorer's own deployment. The scorer on dev-app.openvolley.app
 * links dev-referee / dev-bench / dev-livescore, app.openvolley.app links the
 * production sites; a Cloudflare Pages build of the scorer
 * (<branch>.openvolley-app.pages.dev, or openvolley-app.pages.dev) links the
 * same build of the tablet projects (<branch>.openvolley-referee.pages.dev
 * ...); a per-deployment hash URL (<8 hex>.openvolley-app.pages.dev) links
 * the tablet projects' production build. A scorer page anywhere else (local dev, desktop app) links production.
 * @param {string} role - 'referee' | 'bench_home' | 'bench_away' | 'livescore'
 * @param {string} [hostname] - the scorer page's hostname
 */
export function cloudTabletBase(role, hostname = typeof window !== 'undefined' ? window.location.hostname : '') {
  const sub = ROLE_SUBDOMAINS[role]
  if (!sub) return null
  let prefix = ''
  const host = String(hostname || '').toLowerCase()
  const pages = host.match(/^(?:([a-z0-9-]+)\.)?openvolley-app\.pages\.dev$/)
  if (pages) {
    // A per-deployment URL (<8 hex>.openvolley-app.pages.dev): that hash
    // exists only in the scorer's project, so link the tablets' production build
    const label = pages[1] && !/^[0-9a-f]{8}$/.test(pages[1]) ? `${pages[1]}.` : ''
    return `https://${label}openvolley-${sub}.pages.dev`
  }
  if (host.endsWith('.openvolley.app')) {
    const label = host.slice(0, -'.openvolley.app'.length)
    // <prefix>app.openvolley.app -> <prefix><sub>.openvolley.app ('dev-app' -> 'dev-')
    if (!label.includes('.') && label.endsWith('app')) prefix = label.slice(0, -'app'.length)
  }
  return `https://${prefix}${sub}.openvolley.app`
}

/**
 * Build the connection URL for a specific role
 */
function buildConnectionUrl(role, matchSeedKey) {
  const backendUrl = getBackendUrl()
  if (!backendUrl) return null

  const isCloud = backendUrl.includes('openvolley.app')

  if (isCloud) {
    const base = cloudTabletBase(role)
    const params = new URLSearchParams()
    params.set('server', backendUrl)
    if (matchSeedKey) params.set('match', matchSeedKey)
    if (role === 'bench_home') params.set('team', 'home')
    if (role === 'bench_away') params.set('team', 'away')
    return `${base}?${params.toString()}`
  }

  // Local server — serves the frontend apps directly
  const paths = {
    referee: '/referee',
    bench_home: '/bench',
    bench_away: '/bench',
    livescore: '/livescore'
  }
  const params = new URLSearchParams()
  if (matchSeedKey) params.set('match', matchSeedKey)
  if (role === 'bench_home') params.set('team', 'home')
  if (role === 'bench_away') params.set('team', 'away')
  const queryStr = params.toString()
  return `${backendUrl}${paths[role]}${queryStr ? '?' + queryStr : ''}`
}

/**
 * Full-screen QR code modal for a specific role
 * @param {Object} props
 * @param {string} props.role - 'referee' | 'bench_home' | 'bench_away' | 'livescore'
 * @param {Object} props.match - Match object
 * @param {string} props.matchSeedKey - Match seed_key / external_id
 * @param {function} props.onClose - Close handler
 */
export default function QRCodeModal({ role, match, matchSeedKey, onClose }) {
  const { t } = useTranslation()
  const [copyFeedback, setCopyFeedback] = useState(false)

  const url = buildConnectionUrl(role, matchSeedKey)
  // The scorer's Dexie match stores homeName/awayName
  const teamNames = matchTeamNames(match)
  const color = ROLE_COLORS[role] || '#fff'
  const label = t(`connection.role.${role}`, ROLE_LABELS[role] || role)

  // Get PIN if applicable
  const pinMap = {
    referee: match?.refereePin || match?.connection_pins?.referee,
    bench_home: match?.homeTeamPin || match?.connection_pins?.bench_home,
    bench_away: match?.awayTeamPin || match?.connection_pins?.bench_away,
    livescore: null
  }
  const pin = pinMap[role]

  const handleCopy = async () => {
    if (!url) return
    const result = await copyToClipboard(url)
    if (result.success) {
      setCopyFeedback(true)
      setTimeout(() => setCopyFeedback(false), 2000)
    }
  }
  return (
    <div
      className="ov-kit fixed inset-0 flex flex-col items-center justify-center bg-stone-900/60 p-6 backdrop-blur-sm"
      style={{ zIndex: 2000, pointerEvents: 'auto' }}
      onClick={(e) => { e.stopPropagation(); onClose() }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="qr-modal-title"
        className="w-full max-w-[420px] rounded-2xl bg-white p-6 text-center shadow-2xl sm:p-8"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Role label; the role colour rides on a small rule above it */}
        <span className="mx-auto mb-3 block h-1 w-10 rounded-full" style={{ background: color }} aria-hidden="true" />
        <h2 id="qr-modal-title" className="text-xl font-bold tracking-tight text-stone-900">
          {label}
        </h2>

        {/* Match info */}
        {match && (
          <p className="mt-1 mb-5 text-sm text-stone-500">
            {teamNames.home || 'Home'} vs {teamNames.away || 'Away'}
          </p>
        )}

        {/* QR Code */}
        {url ? (
          <div className="mb-4 inline-block rounded-xl border border-stone-200 bg-white p-4">
            <QRCodeSVG value={url} size={280} level="M" />
          </div>
        ) : (
          <p role="alert" className="my-6 text-sm font-medium text-red-700">
            {t('connection.noBackendConfigured', 'No backend server configured')}
          </p>
        )}

        {/* URL text */}
        {url && (
          <div className="mb-4">
            <p className="mb-2 break-all font-mono text-xs text-stone-500">
              {url}
            </p>
            <button
              type="button"
              onClick={handleCopy}
              className={cn(
                'inline-flex h-11 items-center justify-center rounded-lg border px-3.5 text-xs font-medium transition-colors',
                copyFeedback ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-stone-300 bg-white text-stone-700 hover:bg-stone-50',
                FOCUS_RING
              )}
            >
              {copyFeedback ? t('options.copied', 'Copied!') : t('options.copyUrl', 'Copy URL')}
            </button>
          </div>
        )}

        {/* PIN */}
        {pin && (
          <div className="mb-4">
            <span className="text-sm text-stone-500">PIN: </span>
            <span className="font-mono text-3xl font-bold tracking-[0.3em] text-stone-900">
              {pin}
            </span>
          </div>
        )}

        {/* Instructions */}
        <p className="mb-5 text-sm text-stone-500">
          {t('connection.scanWithPhone', 'Scan with phone or tablet camera to connect directly')}
        </p>

        {/* Close button */}
        <button
          type="button"
          onClick={onClose}
          className={cn('inline-flex h-11 min-w-32 items-center justify-center rounded-lg bg-slate-900 px-6 text-sm font-medium text-white transition-colors hover:bg-slate-800', FOCUS_RING)}
        >
          {t('modal.close', 'Close')}
        </button>
      </div>
    </div>
  )
}

// Export URL builder for use by other components
export { buildConnectionUrl }
