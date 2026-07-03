import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { getBackendUrl, getBackendOverride, setBackendOverride, clearBackendOverride } from '../utils/backendConfig'

const LAST_SERVER_KEY = 'openvolley_last_server'

/**
 * ServerConnectionScreen — shown before PIN/match selection in Referee, Bench, Livescore apps.
 * Lets user choose between online (cloud) or local server, or type an IP.
 *
 * @param {Object} props
 * @param {function} props.onConnected - Called when server is confirmed reachable, with { serverUrl }
 * @param {boolean} [props.skipIfAutoConnect] - If true and URL params have server/match, skip this screen
 */
export default function ServerConnectionScreen({ onConnected, skipIfAutoConnect = true }) {
  const { t } = useTranslation()
  const [mode, setMode] = useState('online') // 'online' | 'local'
  const [localAddress, setLocalAddress] = useState('')
  const [status, setStatus] = useState('idle') // 'idle' | 'checking' | 'connected' | 'failed'
  const [errorMsg, setErrorMsg] = useState(null)
  const [lastServer, setLastServer] = useState(null)

  // Load last used server from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem(LAST_SERVER_KEY)
      if (saved) setLastServer(JSON.parse(saved))
    } catch { /* ignore */ }
  }, [])

  // Check URL params for auto-connect (server param)
  useEffect(() => {
    if (!skipIfAutoConnect) return
    const params = new URLSearchParams(window.location.search)
    const serverParam = params.get('server')
    if (serverParam) {
      const url = serverParam.startsWith('http') ? serverParam : `https://${serverParam}`
      connectToServer(url, true)
    }
  }, [skipIfAutoConnect]) // eslint-disable-line react-hooks/exhaustive-deps

  const saveLastServer = useCallback((url, label) => {
    try {
      localStorage.setItem(LAST_SERVER_KEY, JSON.stringify({ url, label, timestamp: Date.now() }))
    } catch { /* ignore */ }
  }, [])

  const connectToServer = useCallback(async (url, isAutoConnect = false) => {
    setStatus('checking')
    setErrorMsg(null)

    // Normalize URL
    let serverUrl = url.trim().replace(/\/+$/, '')
    if (!serverUrl.startsWith('http')) {
      serverUrl = `http://${serverUrl}`
    }

    // Validate URL to prevent SSRF / protocol abuse
    try {
      const parsed = new URL(serverUrl)
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        setStatus('failed')
        setErrorMsg(t('connection.invalidUrl', 'Invalid server URL'))
        return
      }
    } catch {
      setStatus('failed')
      setErrorMsg(t('connection.invalidUrl', 'Invalid server URL'))
      return
    }

    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 5000)

      const response = await fetch(`${serverUrl}/health`, {
        method: 'GET',
        signal: controller.signal
      })
      clearTimeout(timeoutId)

      if (response.ok) {
        setStatus('connected')
        setBackendOverride(serverUrl)
        const label = serverUrl.includes('openvolley.app') ? 'Cloud' : 'Local'
        saveLastServer(serverUrl, label)
        // Brief delay to show connected state
        setTimeout(() => {
          onConnected({ serverUrl })
        }, isAutoConnect ? 0 : 400)
      } else {
        setStatus('failed')
        setErrorMsg(t('connection.serverNotResponding', 'Server not responding'))
      }
    } catch (err) {
      setStatus('failed')
      if (err.name === 'AbortError') {
        setErrorMsg(t('connection.connectionTimeout', 'Connection timed out'))
      } else {
        setErrorMsg(t('connection.connectionFailed', 'Could not reach server'))
      }
    }
  }, [onConnected, saveLastServer, t])

  const handleOnlineConnect = useCallback(() => {
    // Clear any override — use default backend
    clearBackendOverride()
    const defaultUrl = getBackendUrl()
    if (defaultUrl) {
      connectToServer(defaultUrl)
    } else {
      setStatus('failed')
      setErrorMsg(t('connection.noBackendConfigured', 'No backend server configured'))
    }
  }, [connectToServer, t])

  const handleLocalConnect = useCallback(() => {
    if (!localAddress.trim()) return
    connectToServer(localAddress)
  }, [localAddress, connectToServer])

  const handleLastServerConnect = useCallback(() => {
    if (lastServer?.url) {
      connectToServer(lastServer.url)
    }
  }, [lastServer, connectToServer])

  // Status indicator
  const renderStatus = () => {
    if (status === 'idle') return null

    const colors = {
      checking: '#f59e0b',
      connected: '#22c55e',
      failed: '#ef4444'
    }

    return (
      <div style={{
        padding: '12px 16px',
        borderRadius: 8,
        background: `${colors[status]}15`,
        border: `1px solid ${colors[status]}40`,
        marginTop: 16,
        textAlign: 'center'
      }}>
        {status === 'checking' && (
          <span style={{ color: colors.checking }}>
            {t('connection.checking', 'Connecting...')}
          </span>
        )}
        {status === 'connected' && (
          <span style={{ color: colors.connected }}>
            {t('connection.connectedSuccess', 'Connected!')}
          </span>
        )}
        {status === 'failed' && (
          <div>
            <span style={{ color: colors.failed }}>{errorMsg}</span>
            <button
              onClick={() => setStatus('idle')}
              style={{
                marginLeft: 12,
                padding: '4px 12px',
                fontSize: 12,
                background: 'var(--panel)',
                border: 'none',
                borderRadius: 4,
                color: 'var(--text)',
                cursor: 'pointer'
              }}
            >
              {t('connection.retry', 'Retry')}
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: 'var(--bg)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
      color: 'var(--text)'
    }}>
      <div style={{ width: '100%', maxWidth: 400 }}>
        <h2 style={{ margin: '0 0 8px', fontSize: 22, fontWeight: 600, textAlign: 'center' }}>
          {t('connection.connectToServer', 'Connect to Server')}
        </h2>
        <p style={{ color: 'var(--muted)', textAlign: 'center', margin: '0 0 32px', fontSize: 14 }}>
          {t('connection.selectServerMode', 'Choose how to connect')}
        </p>

        {/* Online (automatic) */}
        <button
          onClick={handleOnlineConnect}
          disabled={status === 'checking'}
          style={{
            width: '100%',
            padding: '16px 20px',
            background: mode === 'online' ? 'rgba(59, 130, 246, 0.15)' : 'var(--panel-2)',
            border: '1px solid rgba(59, 130, 246, 0.3)',
            borderRadius: 12,
            color: 'var(--text)',
            cursor: status === 'checking' ? 'wait' : 'pointer',
            textAlign: 'left',
            marginBottom: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 16
          }}
        >
          <span style={{ fontSize: 28 }}>🌐</span>
          <div>
            <div style={{ fontWeight: 600, fontSize: 16 }}>
              {t('connection.onlineAutomatic', 'Online (automatic)')}
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
              backend.openvolley.app
            </div>
          </div>
        </button>

        {/* Local server */}
        <div style={{
          padding: '16px 20px',
          background: mode === 'local' ? 'rgba(16, 185, 129, 0.15)' : 'var(--panel-2)',
          border: '1px solid rgba(16, 185, 129, 0.3)',
          borderRadius: 12,
          marginBottom: 12
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 12 }}>
            <span style={{ fontSize: 28 }}>📡</span>
            <div>
              <div style={{ fontWeight: 600, fontSize: 16 }}>
                {t('connection.localServer', 'Local server')}
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                {t('connection.enterIPAddress', 'Enter IP address')}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              aria-label={t('connection.enterIPAddress', 'Enter IP address')}
              value={localAddress}
              onChange={(e) => { setLocalAddress(e.target.value); setMode('local') }}
              onKeyDown={(e) => { if (e.key === 'Enter') handleLocalConnect() }}
              placeholder="192.168.1.42:8080"
              style={{
                flex: 1,
                padding: '10px 14px',
                background: 'var(--panel)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                color: 'var(--text)',
                fontSize: 14,
                fontFamily: 'monospace',
                outline: 'none'
              }}
            />
            <button
              onClick={handleLocalConnect}
              disabled={!localAddress.trim() || status === 'checking'}
              style={{
                padding: '10px 16px',
                background: localAddress.trim() ? '#10b981' : 'var(--border)',
                border: 'none',
                borderRadius: 8,
                color: '#fff',
                cursor: localAddress.trim() ? 'pointer' : 'default',
                fontWeight: 600,
                fontSize: 14,
                opacity: localAddress.trim() ? 1 : 0.5
              }}
            >
              {t('connection.connect', 'Connect')}
            </button>
          </div>
        </div>

        {/* Last used server */}
        {lastServer && (
          <button
            onClick={handleLastServerConnect}
            disabled={status === 'checking'}
            style={{
              width: '100%',
              marginTop: 12,
              padding: '10px 16px',
              background: 'var(--panel-2)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              color: 'var(--muted)',
              cursor: 'pointer',
              textAlign: 'center',
              fontSize: 13
            }}
          >
            {t('connection.lastUsed', 'Last used')}: {lastServer.label || lastServer.url}
            {lastServer.url !== (getBackendOverride() || getBackendUrl()) && (
              <span style={{ marginLeft: 8, color: 'var(--muted)' }}>
                ({new URL(lastServer.url).host})
              </span>
            )}
          </button>
        )}

        {/* Status indicator */}
        {renderStatus()}
      </div>
    </div>
  )
}
