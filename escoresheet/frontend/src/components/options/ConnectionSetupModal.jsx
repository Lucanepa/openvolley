import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { QRCodeSVG } from 'qrcode.react'
import Modal from '../Modal'
import QRCodeModal, { buildConnectionUrl } from '../QRCodeModal'
import {
  getLocalIP,
  getServerStatus,
  getConnectionCount,
  copyToClipboard,
  buildAppUrls,
  buildWebSocketUrl,
  getCloudBackendUrl,
  buildCloudUrls
} from '../../utils/networkInfo'
import { db } from '../../db/db'

export default function ConnectionSetupModal({
  open,
  onClose,
  matchId,
  matchSeedKey,
  match,
  refereePin,
  homeTeamPin,
  awayTeamPin,
  gameNumber
}) {
  const { t } = useTranslation()
  const [connectionMode, setConnectionMode] = useState('lan') // 'lan' | 'internet'
  const [localIP, setLocalIP] = useState(null)
  const [serverStatus, setServerStatus] = useState({ running: false })
  const [connectionCount, setConnectionCount] = useState({ totalClients: 0 })
  const [loading, setLoading] = useState(true)
  const [copyFeedback, setCopyFeedback] = useState(null)
  const [showQRModal, setShowQRModal] = useState(null) // 'referee' | 'bench_home' | 'bench_away' | 'livescore' | null

  const port = window.location.port || (window.location.protocol === 'https:' ? '443' : '80')
  const protocol = window.location.protocol.replace(':', '')
  const cloudBackendUrl = getCloudBackendUrl()

  // Load network info on mount
  useEffect(() => {
    if (!open) return

    const loadNetworkInfo = async () => {
      setLoading(true)
      try {
        const [ip, status, connections] = await Promise.all([
          getLocalIP(),
          getServerStatus(),
          getConnectionCount()
        ])
        setLocalIP(ip)
        setServerStatus(status)
        setConnectionCount(connections)
      } catch (err) {
        console.error('Error loading network info:', err)
      } finally {
        setLoading(false)
      }
    }

    loadNetworkInfo()

    // Poll for connection count updates
    const interval = setInterval(async () => {
      try {
        const connections = await getConnectionCount()
        setConnectionCount(connections)
      } catch {
        // Ignore polling errors
      }
    }, 5000)

    return () => clearInterval(interval)
  }, [open])

  // Handle copy with feedback
  const handleCopy = useCallback(async (text, label) => {
    const result = await copyToClipboard(text)
    if (result.success) {
      setCopyFeedback(label)
      setTimeout(() => setCopyFeedback(null), 2000)
    }
  }, [])

  // Toggle connection enabled/disabled for a role
  const handleToggleConnection = useCallback(async (field, syncField, pinField, enabled) => {
    if (!matchId) return
    try {
      await db.matches.update(matchId, { [field]: enabled })
      const m = await db.matches.get(matchId)
      if (m?.seed_key) {
        await db.sync_queue.add({
          resource: 'match',
          action: 'update',
          payload: {
            id: m.seed_key,
            connections: { [syncField]: enabled },
            connection_pins: pinField ? { [pinField]: m?.[pinField === 'referee' ? 'refereePin' : pinField === 'bench_home' ? 'homeTeamPin' : 'awayTeamPin'] || '' } : undefined
          },
          ts: new Date().toISOString(),
          status: 'queued'
        })
      }
    } catch (error) {
      console.error('[ConnectionSetup] Failed to toggle connection:', error)
    }
  }, [matchId])

  // Build URLs
  const lanUrls = localIP ? buildAppUrls(localIP, port, protocol) : null
  const wsUrl = localIP ? buildWebSocketUrl(localIP, 8080, protocol === 'https') : null
  const cloudUrls = cloudBackendUrl ? buildCloudUrls(cloudBackendUrl) : null

  // Current URLs based on mode
  const currentUrls = connectionMode === 'lan' ? lanUrls : cloudUrls

  // Resolve the seed key for QR code URL building
  const seedKey = matchSeedKey || match?.seed_key || match?.externalId || matchId

  const renderModeSelector = () => (
    <div style={{ marginBottom: 24 }}>
      <p style={{ fontSize: 14, color: 'rgba(255,255,255,0.7)', marginBottom: 16, textAlign: 'center' }}>
        {t('connection.chooseConnection')}
      </p>
      <div style={{ display: 'flex', gap: 16, justifyContent: 'center' }}>
        <button
          onClick={() => setConnectionMode('lan')}
          style={{
            flex: 1,
            maxWidth: 200,
            padding: '20px 16px',
            background: connectionMode === 'lan' ? 'var(--accent)' : 'rgba(255,255,255,0.1)',
            color: connectionMode === 'lan' ? '#000' : '#fff',
            border: connectionMode === 'lan' ? 'none' : '1px solid rgba(255,255,255,0.2)',
            borderRadius: 12,
            cursor: 'pointer',
            textAlign: 'center'
          }}
        >
          <div style={{ fontSize: 32, marginBottom: 8 }}>📶</div>
          <div style={{ fontWeight: 600, fontSize: 16 }}>{t('connectionSetup.lan', 'LAN')}</div>
          <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>{t('connection.sameWifi')}</div>
        </button>

        <button
          onClick={() => setConnectionMode('internet')}
          style={{
            flex: 1,
            maxWidth: 200,
            padding: '20px 16px',
            background: connectionMode === 'internet' ? 'var(--accent)' : 'rgba(255,255,255,0.1)',
            color: connectionMode === 'internet' ? '#000' : '#fff',
            border: connectionMode === 'internet' ? 'none' : '1px solid rgba(255,255,255,0.2)',
            borderRadius: 12,
            cursor: 'pointer',
            textAlign: 'center',
            opacity: cloudBackendUrl ? 1 : 0.5
          }}
          disabled={!cloudBackendUrl}
        >
          <div style={{ fontSize: 32, marginBottom: 8 }}>🌐</div>
          <div style={{ fontWeight: 600, fontSize: 16 }}>{t('connectionSetup.internet', 'Internet')}</div>
          <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>
            {cloudBackendUrl ? t('connection.cloudRelay') : t('connection.notConfigured')}
          </div>
        </button>
      </div>
    </div>
  )

  // Reusable connection row component for each role
  const renderConnectionRow = (role, label, pin, color, { enabled, dbField, syncField, pinSyncField } = {}) => {
    const url = buildConnectionUrl(role, seedKey)
    const hasToggle = dbField != null

    return (
      <div key={role} style={{
        background: 'rgba(255,255,255,0.05)',
        borderRadius: 8,
        padding: 16,
        marginBottom: 12,
        borderLeft: `3px solid ${enabled === false ? '#6b7280' : color}`,
        opacity: enabled === false ? 0.6 : 1,
        transition: 'opacity 0.2s, border-color 0.2s'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: enabled === false ? 0 : 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {hasToggle && (
              <div
                role="switch"
                aria-checked={!!enabled}
                tabIndex={0}
                onClick={() => handleToggleConnection(dbField, syncField, pinSyncField, !enabled)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleToggleConnection(dbField, syncField, pinSyncField, !enabled) } }}
                style={{
                  position: 'relative',
                  width: 40,
                  height: 22,
                  background: enabled ? '#22c55e' : '#6b7280',
                  borderRadius: 11,
                  cursor: 'pointer',
                  transition: 'background 0.2s',
                  flexShrink: 0
                }}
              >
                <div style={{
                  position: 'absolute',
                  top: 2,
                  left: enabled ? 20 : 2,
                  width: 18,
                  height: 18,
                  background: '#fff',
                  borderRadius: '50%',
                  transition: 'left 0.2s',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.3)'
                }} />
              </div>
            )}
            <h4 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{label}</h4>
          </div>
          {enabled !== false && (
            <button
              onClick={() => setShowQRModal(role)}
              style={{
                padding: '6px 14px',
                fontSize: 12,
                background: `${color}20`,
                border: `1px solid ${color}40`,
                borderRadius: 6,
                color,
                cursor: 'pointer',
                fontWeight: 600
              }}
            >
              {t('connection.showQR', 'Show QR')}
            </button>
          )}
        </div>

        {enabled !== false && (
          <>
            {/* PIN display */}
            {pin && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>PIN:</span>
                <code style={{
                  background: `${color}15`,
                  padding: '4px 10px',
                  borderRadius: 4,
                  color,
                  fontWeight: 600,
                  fontSize: 16,
                  letterSpacing: 2
                }}>
                  {pin}
                </code>
                <button
                  onClick={() => handleCopy(pin, `${role}-pin`)}
                  style={{
                    padding: '2px 8px',
                    fontSize: 11,
                    background: copyFeedback === `${role}-pin` ? '#22c55e' : 'rgba(255,255,255,0.08)',
                    border: 'none',
                    borderRadius: 4,
                    color: '#fff',
                    cursor: 'pointer'
                  }}
                >
                  {copyFeedback === `${role}-pin` ? t('options.copied') : t('options.copy')}
                </button>
              </div>
            )}

            {/* Inline small QR code + URL */}
            {url && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ background: '#fff', borderRadius: 4, padding: 4, flexShrink: 0 }}>
                  <QRCodeSVG value={url} size={60} level="L" />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <code style={{
                    display: 'block',
                    fontSize: 11,
                    color: 'rgba(255,255,255,0.4)',
                    wordBreak: 'break-all',
                    lineHeight: 1.4
                  }}>
                    {url}
                  </code>
                  <button
                    onClick={() => handleCopy(url, `${role}-url`)}
                    style={{
                      marginTop: 4,
                      padding: '2px 8px',
                      fontSize: 11,
                      background: copyFeedback === `${role}-url` ? '#22c55e' : 'rgba(255,255,255,0.08)',
                      border: 'none',
                      borderRadius: 4,
                      color: '#fff',
                      cursor: 'pointer'
                    }}
                  >
                    {copyFeedback === `${role}-url` ? t('options.copied') : t('options.copyUrl', 'Copy URL')}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    )
  }

  const renderNetworkInfo = () => (
    <div style={{
      background: 'rgba(255,255,255,0.05)',
      borderRadius: 8,
      padding: 16,
      marginBottom: 20
    }}>
      <h4 style={{ margin: '0 0 12px 0', fontSize: 14, fontWeight: 600 }}>
        {connectionMode === 'lan'
          ? t('connection.localNetworkAddress')
          : t('connection.cloudBackend')}
      </h4>
      {connectionMode === 'lan' ? (
        loading ? (
          <p style={{ color: 'rgba(255,255,255,0.5)' }}>{t('connection.detectingNetwork')}</p>
        ) : localIP ? (
          <div style={{ fontFamily: 'monospace', fontSize: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <span>{t('connection.ipAddress')}:</span>
              <span style={{ color: 'var(--accent)' }}>{localIP}:{port}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <span>WebSocket:</span>
              <span style={{ color: 'var(--accent)' }}>{wsUrl}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>{t('connection.status')}:</span>
              <span style={{
                display: 'flex', alignItems: 'center', gap: 6,
                color: serverStatus.running ? '#22c55e' : '#ef4444'
              }}>
                <span style={{
                  width: 8, height: 8, borderRadius: '50%',
                  background: serverStatus.running ? '#22c55e' : '#ef4444'
                }} />
                {serverStatus.running ? t('options.running') : t('options.notRunning')}
              </span>
            </div>
          </div>
        ) : (
          <p style={{ color: '#ef4444' }}>{t('connection.couldNotDetectIP')}</p>
        )
      ) : (
        cloudBackendUrl ? (
          <div style={{ fontFamily: 'monospace', fontSize: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
              <span>URL:</span>
              <span style={{ color: 'var(--accent)', wordBreak: 'break-all' }}>{cloudBackendUrl}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>{t('connection.status')}:</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#22c55e' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e' }} />
                {t('connection.configured')}
              </span>
            </div>
          </div>
        ) : (
          <p style={{ color: '#ef4444' }}>{t('connection.noCloudBackend')}</p>
        )
      )}
    </div>
  )

  const renderConnections = () => (
    <div>
      {renderConnectionRow('referee', t('connection.role.referee', 'Referee Dashboard'), refereePin, '#3b82f6', {
        enabled: match?.refereeConnectionEnabled === true,
        dbField: 'refereeConnectionEnabled',
        syncField: 'referee_enabled',
        pinSyncField: 'referee'
      })}
      {renderConnectionRow('bench_home', t('connection.role.bench_home', 'Home Bench'), homeTeamPin, '#10b981', {
        enabled: match?.homeTeamConnectionEnabled === true,
        dbField: 'homeTeamConnectionEnabled',
        syncField: 'home_bench_enabled',
        pinSyncField: 'bench_home'
      })}
      {renderConnectionRow('bench_away', t('connection.role.bench_away', 'Away Bench'), awayTeamPin, '#ef4444', {
        enabled: match?.awayTeamConnectionEnabled === true,
        dbField: 'awayTeamConnectionEnabled',
        syncField: 'away_bench_enabled',
        pinSyncField: 'bench_away'
      })}
      {renderConnectionRow('livescore', t('connection.role.livescore', 'Livescore'), null, '#8b5cf6')}
    </div>
  )

  const renderConnectedDevices = () => (
    <div style={{
      background: 'rgba(255,255,255,0.05)',
      borderRadius: 8,
      padding: 16,
      marginTop: 8
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        padding: 12, background: 'rgba(0,0,0,0.2)', borderRadius: 8
      }}>
        <span style={{
          fontSize: 28, fontWeight: 700,
          color: connectionCount.totalClients > 0 ? '#22c55e' : 'rgba(255,255,255,0.3)'
        }}>
          {connectionCount.totalClients}
        </span>
        <span style={{ fontSize: 14, color: 'rgba(255,255,255,0.6)' }}>
          {connectionCount.totalClients === 1 ? t('connection.deviceConnected') : t('connection.devicesConnected')}
        </span>
      </div>
      {matchId && connectionCount.matchSubscriptions && (
        <div style={{ marginTop: 8, fontSize: 12, color: 'rgba(255,255,255,0.5)', textAlign: 'center' }}>
          {t('connection.watchingThisMatch', { count: connectionCount.matchSubscriptions[matchId] || 0 })}
        </div>
      )}
    </div>
  )

  return (
    <>
      <Modal
        title={t('connection.title')}
        open={open}
        onClose={onClose}
        width={520}
      >
        <div style={{ padding: '8px 0' }}>
          {renderModeSelector()}
          {renderNetworkInfo()}
          {renderConnections()}
          {renderConnectedDevices()}
        </div>
      </Modal>

      {/* Full-screen QR Code Modal */}
      {showQRModal && (
        <QRCodeModal
          role={showQRModal}
          match={match}
          matchSeedKey={seedKey}
          onClose={() => setShowQRModal(null)}
        />
      )}
    </>
  )
}
