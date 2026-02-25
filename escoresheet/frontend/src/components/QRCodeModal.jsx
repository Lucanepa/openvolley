import { useTranslation } from 'react-i18next'
import { QRCodeSVG } from 'qrcode.react'
import { getBackendUrl } from '../utils/backendConfig'
import { copyToClipboard } from '../utils/networkInfo'
import { useState } from 'react'

const ROLE_LABELS = {
  referee: 'Referee Dashboard',
  bench_home: 'Home Bench',
  bench_away: 'Away Bench',
  livescore: 'Livescore'
}

const ROLE_COLORS = {
  referee: '#3b82f6',
  bench_home: '#10b981',
  bench_away: '#ef4444',
  livescore: '#8b5cf6'
}

/**
 * Build the connection URL for a specific role
 */
function buildConnectionUrl(role, matchSeedKey) {
  const backendUrl = getBackendUrl()
  if (!backendUrl) return null

  const isCloud = backendUrl.includes('openvolley.app')

  if (isCloud) {
    const baseUrls = {
      referee: 'https://referee.openvolley.app',
      bench_home: 'https://bench.openvolley.app',
      bench_away: 'https://bench.openvolley.app',
      livescore: 'https://livescore.openvolley.app'
    }
    const base = baseUrls[role]
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
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.92)',
        zIndex: 2000,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        pointerEvents: 'auto'
      }}
      onClick={(e) => { e.stopPropagation(); onClose() }}
    >
      <div
        style={{
          background: '#111827',
          borderRadius: 16,
          padding: 32,
          maxWidth: 420,
          width: '100%',
          textAlign: 'center'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Role label */}
        <h2 style={{ margin: '0 0 4px', fontSize: 22, fontWeight: 600, color }}>
          {label}
        </h2>

        {/* Match info */}
        {match && (
          <p style={{ color: 'rgba(255,255,255,0.5)', margin: '0 0 24px', fontSize: 14 }}>
            {match.homeTeamName || match.home_team_name || 'Home'} vs {match.awayTeamName || match.away_team_name || 'Away'}
          </p>
        )}

        {/* QR Code */}
        {url ? (
          <div style={{
            background: '#fff',
            borderRadius: 12,
            padding: 16,
            display: 'inline-block',
            marginBottom: 20
          }}>
            <QRCodeSVG value={url} size={280} level="M" />
          </div>
        ) : (
          <p style={{ color: '#ef4444', margin: '24px 0' }}>
            {t('connection.noBackendConfigured', 'No backend server configured')}
          </p>
        )}

        {/* URL text */}
        {url && (
          <div style={{ marginBottom: 16 }}>
            <p style={{
              fontSize: 12,
              color: 'rgba(255,255,255,0.4)',
              wordBreak: 'break-all',
              margin: '0 0 8px',
              fontFamily: 'monospace'
            }}>
              {url}
            </p>
            <button
              onClick={handleCopy}
              style={{
                padding: '6px 16px',
                fontSize: 12,
                background: copyFeedback ? '#22c55e' : 'rgba(255,255,255,0.1)',
                border: 'none',
                borderRadius: 6,
                color: '#fff',
                cursor: 'pointer'
              }}
            >
              {copyFeedback ? t('options.copied', 'Copied!') : t('options.copyUrl', 'Copy URL')}
            </button>
          </div>
        )}

        {/* PIN */}
        {pin && (
          <div style={{ marginBottom: 20 }}>
            <span style={{ fontSize: 14, color: 'rgba(255,255,255,0.6)' }}>PIN: </span>
            <span style={{
              fontSize: 28,
              fontWeight: 700,
              letterSpacing: 6,
              color
            }}>
              {pin}
            </span>
          </div>
        )}

        {/* Instructions */}
        <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.4)', margin: '0 0 20px' }}>
          {t('connection.scanWithPhone', 'Scan with phone or tablet camera to connect directly')}
        </p>

        {/* Close button */}
        <button
          onClick={onClose}
          style={{
            padding: '10px 32px',
            background: 'rgba(255,255,255,0.1)',
            border: '1px solid rgba(255,255,255,0.2)',
            borderRadius: 8,
            color: '#fff',
            cursor: 'pointer',
            fontSize: 14
          }}
        >
          {t('modal.close', 'Close')}
        </button>
      </div>
    </div>
  )
}

// Export URL builder for use by other components
export { buildConnectionUrl }
