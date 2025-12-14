import { useState, useEffect, useCallback } from 'react'
import Modal from '../Modal'
import {
  getLocalIP,
  getServerStatus,
  getConnectionCount,
  generateQRCodeUrl,
  copyToClipboard,
  buildAppUrls,
  buildWebSocketUrl,
  getCloudBackendUrl,
  buildCloudUrls
} from '../../utils/networkInfo'

export default function ConnectionSetupModal({
  open,
  onClose,
  matchId,
  refereePin,
  homeTeamPin,
  awayTeamPin,
  gameNumber
}) {
  const [connectionMode, setConnectionMode] = useState('lan') // 'lan' | 'internet'
  const [step, setStep] = useState(1)
  const [localIP, setLocalIP] = useState(null)
  const [serverStatus, setServerStatus] = useState({ running: false })
  const [connectionCount, setConnectionCount] = useState({ totalClients: 0 })
  const [loading, setLoading] = useState(true)
  const [copyFeedback, setCopyFeedback] = useState(null)

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
      } catch (err) {
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

  // Build URLs
  const lanUrls = localIP ? buildAppUrls(localIP, port, protocol) : null
  const wsUrl = localIP ? buildWebSocketUrl(localIP, 8080, protocol === 'https') : null
  const cloudUrls = cloudBackendUrl ? buildCloudUrls(cloudBackendUrl) : null

  // Current URLs based on mode
  const currentUrls = connectionMode === 'lan' ? lanUrls : cloudUrls
  const refereeUrl = currentUrls?.referee || ''
  const benchUrl = currentUrls?.bench || ''

  const renderModeSelector = () => (
    <div style={{ marginBottom: 24 }}>
      <p style={{ fontSize: 14, color: 'rgba(255,255,255,0.7)', marginBottom: 16, textAlign: 'center' }}>
        Choose how devices will connect:
      </p>
      <div style={{ display: 'flex', gap: 16, justifyContent: 'center' }}>
        <button
          onClick={() => { setConnectionMode('lan'); setStep(1) }}
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
          <div style={{ fontWeight: 600, fontSize: 16 }}>LAN</div>
          <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>Same WiFi Network</div>
        </button>

        <button
          onClick={() => { setConnectionMode('internet'); setStep(1) }}
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
          <div style={{ fontWeight: 600, fontSize: 16 }}>Internet</div>
          <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>
            {cloudBackendUrl ? 'Cloud Relay' : 'Not Configured'}
          </div>
        </button>
      </div>
    </div>
  )

  const renderLANSetup = () => (
    <div>
      {/* Server Status */}
      <div style={{
        background: 'rgba(255,255,255,0.05)',
        borderRadius: 8,
        padding: 16,
        marginBottom: 20
      }}>
        <h4 style={{ margin: '0 0 12px 0', fontSize: 14, fontWeight: 600 }}>
          Local Network Address
        </h4>
        {loading ? (
          <p style={{ color: 'rgba(255,255,255,0.5)' }}>Detecting network...</p>
        ) : localIP ? (
          <div style={{ fontFamily: 'monospace', fontSize: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <span>IP Address:</span>
              <span style={{ color: 'var(--accent)' }}>{localIP}:{port}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <span>WebSocket:</span>
              <span style={{ color: 'var(--accent)' }}>{wsUrl}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>Status:</span>
              <span style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                color: serverStatus.running ? '#22c55e' : '#ef4444'
              }}>
                <span style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: serverStatus.running ? '#22c55e' : '#ef4444'
                }} />
                {serverStatus.running ? 'Running' : 'Not Running'}
              </span>
            </div>
          </div>
        ) : (
          <p style={{ color: '#ef4444' }}>
            Could not detect local IP. Make sure you're connected to a WiFi network.
          </p>
        )}
      </div>

      {/* Referee Connection */}
      {localIP && (
        <div style={{
          background: 'rgba(255,255,255,0.05)',
          borderRadius: 8,
          padding: 16,
          marginBottom: 20
        }}>
          <h4 style={{ margin: '0 0 12px 0', fontSize: 14, fontWeight: 600 }}>
            Connect Referee Device
          </h4>
          <ol style={{ margin: 0, paddingLeft: 20, fontSize: 14, lineHeight: 1.8 }}>
            <li>Open browser on Referee Dashboard/phone</li>
            <li>
              Go to: <code style={{ background: 'rgba(0,0,0,0.3)', padding: '2px 6px', borderRadius: 4 }}>
                {refereeUrl}
              </code>
              <button
                onClick={() => handleCopy(refereeUrl, 'Referee URL')}
                style={{
                  marginLeft: 8,
                  padding: '2px 8px',
                  fontSize: 12,
                  background: copyFeedback === 'Referee URL' ? '#22c55e' : 'rgba(255,255,255,0.1)',
                  border: 'none',
                  borderRadius: 4,
                  color: '#fff',
                  cursor: 'pointer'
                }}
              >
                {copyFeedback === 'Referee URL' ? 'Copied!' : 'Copy'}
              </button>
            </li>
            <li>
              Enter PIN: <code style={{
                background: 'rgba(var(--accent-rgb),0.2)',
                padding: '2px 8px',
                borderRadius: 4,
                color: 'var(--accent)',
                fontWeight: 600,
                fontSize: 16
              }}>
                {refereePin || '------'}
              </code>
              {refereePin && (
                <button
                  onClick={() => handleCopy(refereePin, 'Referee PIN')}
                  style={{
                    marginLeft: 8,
                    padding: '2px 8px',
                    fontSize: 12,
                    background: copyFeedback === 'Referee PIN' ? '#22c55e' : 'rgba(255,255,255,0.1)',
                    border: 'none',
                    borderRadius: 4,
                    color: '#fff',
                    cursor: 'pointer'
                  }}
                >
                  {copyFeedback === 'Referee PIN' ? 'Copied!' : 'Copy'}
                </button>
              )}
            </li>
          </ol>

          {/* QR Code */}
          <div style={{ marginTop: 16, textAlign: 'center' }}>
            <img
              src={generateQRCodeUrl(refereeUrl, 150)}
              alt="Referee QR Code"
              style={{ background: '#fff', padding: 8, borderRadius: 8 }}
            />
            <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginTop: 8 }}>
              Scan to open referee page
            </p>
          </div>
        </div>
      )}

      {/* Bench Connection */}
      {localIP && (homeTeamPin || awayTeamPin) && (
        <div style={{
          background: 'rgba(255,255,255,0.05)',
          borderRadius: 8,
          padding: 16,
          marginBottom: 20
        }}>
          <h4 style={{ margin: '0 0 12px 0', fontSize: 14, fontWeight: 600 }}>
            Connect Bench Devices
          </h4>
          <ol style={{ margin: 0, paddingLeft: 20, fontSize: 14, lineHeight: 1.8 }}>
            <li>Open browser on bench tablet/phone</li>
            <li>
              Go to: <code style={{ background: 'rgba(0,0,0,0.3)', padding: '2px 6px', borderRadius: 4 }}>
                {benchUrl}
              </code>
              <button
                onClick={() => handleCopy(benchUrl, 'Bench URL')}
                style={{
                  marginLeft: 8,
                  padding: '2px 8px',
                  fontSize: 12,
                  background: copyFeedback === 'Bench URL' ? '#22c55e' : 'rgba(255,255,255,0.1)',
                  border: 'none',
                  borderRadius: 4,
                  color: '#fff',
                  cursor: 'pointer'
                }}
              >
                {copyFeedback === 'Bench URL' ? 'Copied!' : 'Copy'}
              </button>
            </li>
            <li>Select team and enter PIN:</li>
          </ol>

          <div style={{ display: 'flex', gap: 16, marginTop: 12 }}>
            {homeTeamPin && (
              <div style={{ flex: 1, textAlign: 'center' }}>
                <div style={{ fontSize: 12, marginBottom: 4 }}>Home Team PIN</div>
                <code style={{
                  display: 'block',
                  background: 'rgba(59, 130, 246, 0.2)',
                  padding: '8px 12px',
                  borderRadius: 6,
                  color: '#3b82f6',
                  fontWeight: 600,
                  fontSize: 18
                }}>
                  {homeTeamPin}
                </code>
                <button
                  onClick={() => handleCopy(homeTeamPin, 'Home PIN')}
                  style={{
                    marginTop: 8,
                    padding: '4px 12px',
                    fontSize: 12,
                    background: copyFeedback === 'Home PIN' ? '#22c55e' : 'rgba(255,255,255,0.1)',
                    border: 'none',
                    borderRadius: 4,
                    color: '#fff',
                    cursor: 'pointer'
                  }}
                >
                  {copyFeedback === 'Home PIN' ? 'Copied!' : 'Copy'}
                </button>
              </div>
            )}
            {awayTeamPin && (
              <div style={{ flex: 1, textAlign: 'center' }}>
                <div style={{ fontSize: 12, marginBottom: 4 }}>Away Team PIN</div>
                <code style={{
                  display: 'block',
                  background: 'rgba(239, 68, 68, 0.2)',
                  padding: '8px 12px',
                  borderRadius: 6,
                  color: '#ef4444',
                  fontWeight: 600,
                  fontSize: 18
                }}>
                  {awayTeamPin}
                </code>
                <button
                  onClick={() => handleCopy(awayTeamPin, 'Away PIN')}
                  style={{
                    marginTop: 8,
                    padding: '4px 12px',
                    fontSize: 12,
                    background: copyFeedback === 'Away PIN' ? '#22c55e' : 'rgba(255,255,255,0.1)',
                    border: 'none',
                    borderRadius: 4,
                    color: '#fff',
                    cursor: 'pointer'
                  }}
                >
                  {copyFeedback === 'Away PIN' ? 'Copied!' : 'Copy'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Connected Devices */}
      <div style={{
        background: 'rgba(255,255,255,0.05)',
        borderRadius: 8,
        padding: 16
      }}>
        <h4 style={{ margin: '0 0 12px 0', fontSize: 14, fontWeight: 600 }}>
          Connected Devices
        </h4>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          padding: 16,
          background: 'rgba(0,0,0,0.2)',
          borderRadius: 8
        }}>
          <span style={{
            fontSize: 32,
            fontWeight: 700,
            color: connectionCount.totalClients > 0 ? '#22c55e' : 'rgba(255,255,255,0.3)'
          }}>
            {connectionCount.totalClients}
          </span>
          <span style={{ fontSize: 14, color: 'rgba(255,255,255,0.6)' }}>
            {connectionCount.totalClients === 1 ? 'device' : 'devices'} connected
          </span>
        </div>
        {matchId && connectionCount.matchSubscriptions && (
          <div style={{ marginTop: 8, fontSize: 12, color: 'rgba(255,255,255,0.5)', textAlign: 'center' }}>
            {connectionCount.matchSubscriptions[matchId] || 0} watching this match
          </div>
        )}
      </div>
    </div>
  )

  const renderInternetSetup = () => (
    <div>
      {/* Cloud Server Status */}
      <div style={{
        background: 'rgba(255,255,255,0.05)',
        borderRadius: 8,
        padding: 16,
        marginBottom: 20
      }}>
        <h4 style={{ margin: '0 0 12px 0', fontSize: 14, fontWeight: 600 }}>
          Cloud Backend
        </h4>
        {cloudBackendUrl ? (
          <div style={{ fontFamily: 'monospace', fontSize: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
              <span>URL:</span>
              <span style={{ color: 'var(--accent)', wordBreak: 'break-all' }}>{cloudBackendUrl}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>Status:</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#22c55e' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e' }} />
                Configured
              </span>
            </div>
          </div>
        ) : (
          <p style={{ color: '#ef4444' }}>
            No cloud backend configured. Set VITE_BACKEND_URL environment variable.
          </p>
        )}
      </div>

      {/* Share Connection Info */}
      {cloudUrls && (
        <>
          <div style={{
            background: 'rgba(255,255,255,0.05)',
            borderRadius: 8,
            padding: 16,
            marginBottom: 20
          }}>
            <h4 style={{ margin: '0 0 12px 0', fontSize: 14, fontWeight: 600 }}>
              Share with Remote Devices
            </h4>

            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, marginBottom: 4 }}>Referee URL:</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <code style={{
                  flex: 1,
                  background: 'rgba(0,0,0,0.3)',
                  padding: '8px 12px',
                  borderRadius: 6,
                  fontSize: 12,
                  wordBreak: 'break-all'
                }}>
                  {cloudUrls.referee}
                </code>
                <button
                  onClick={() => handleCopy(cloudUrls.referee, 'Cloud Referee URL')}
                  style={{
                    padding: '8px 12px',
                    fontSize: 12,
                    background: copyFeedback === 'Cloud Referee URL' ? '#22c55e' : 'rgba(255,255,255,0.1)',
                    border: 'none',
                    borderRadius: 4,
                    color: '#fff',
                    cursor: 'pointer',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {copyFeedback === 'Cloud Referee URL' ? 'Copied!' : 'Copy'}
                </button>
              </div>
            </div>

            {refereePin && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ fontSize: 14 }}>Game PIN:</span>
                <code style={{
                  background: 'rgba(var(--accent-rgb),0.2)',
                  padding: '8px 16px',
                  borderRadius: 6,
                  color: 'var(--accent)',
                  fontWeight: 600,
                  fontSize: 20
                }}>
                  {refereePin}
                </code>
                <button
                  onClick={() => handleCopy(refereePin, 'Cloud PIN')}
                  style={{
                    padding: '8px 12px',
                    fontSize: 12,
                    background: copyFeedback === 'Cloud PIN' ? '#22c55e' : 'rgba(255,255,255,0.1)',
                    border: 'none',
                    borderRadius: 4,
                    color: '#fff',
                    cursor: 'pointer'
                  }}
                >
                  {copyFeedback === 'Cloud PIN' ? 'Copied!' : 'Copy'}
                </button>
              </div>
            )}

            {/* QR Code */}
            <div style={{ marginTop: 16, textAlign: 'center' }}>
              <img
                src={generateQRCodeUrl(cloudUrls.referee, 150)}
                alt="Cloud QR Code"
                style={{ background: '#fff', padding: 8, borderRadius: 8 }}
              />
              <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginTop: 8 }}>
                Scan to open referee page
              </p>
            </div>
          </div>

          {/* Connected Devices */}
          <div style={{
            background: 'rgba(255,255,255,0.05)',
            borderRadius: 8,
            padding: 16
          }}>
            <h4 style={{ margin: '0 0 12px 0', fontSize: 14, fontWeight: 600 }}>
              Connected Devices
            </h4>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              padding: 16,
              background: 'rgba(0,0,0,0.2)',
              borderRadius: 8
            }}>
              <span style={{
                fontSize: 32,
                fontWeight: 700,
                color: connectionCount.totalClients > 0 ? '#22c55e' : 'rgba(255,255,255,0.3)'
              }}>
                {connectionCount.totalClients}
              </span>
              <span style={{ fontSize: 14, color: 'rgba(255,255,255,0.6)' }}>
                {connectionCount.totalClients === 1 ? 'device' : 'devices'} connected
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  )

  return (
    <Modal
      title="Connection Setup"
      open={open}
      onClose={onClose}
      width={500}
    >
      <div style={{ padding: '8px 0' }}>
        {renderModeSelector()}

        {connectionMode === 'lan' && renderLANSetup()}
        {connectionMode === 'internet' && renderInternetSetup()}
      </div>
    </Modal>
  )
}
