import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  getBackendUrl, getBackendOverride, setBackendOverride, clearBackendOverride, learnRelayWsPort,
  isAllowedBackendUrl, isDefaultBackendUrl, normalizeServerAddress, linkServerState, confirmLinkServer, defaultBackendUrl, isDevBuildWithoutBackend
} from '../utils/backendConfig'
import { GlobeIcon, SatelliteDishIcon } from './icons'
import { ChevronLeft, Loader2 } from 'lucide-react'
import { Button, cn, FOCUS_RING, NOTICE } from '../ui'
import ContextualHelpPanel from './help/ContextualHelpPanel'
import { HeaderHelpButton } from './help/HelpButton.jsx'
import { HEADER_BTN, HEADER_HIT } from './chromeClasses'
import { scorerReturnUrl, returnToScorer } from '../utils/scorerReturn'

const LAST_SERVER_KEY = 'openvolley_last_server'

const hostOf = (url) => {
  try { return new URL(url).host } catch { return null }
}

/**
 * ServerConnectionScreen — shown before PIN/match selection in Referee, Bench, Livescore apps.
 * Lets user choose between online (cloud) or local server, or type an IP.
 *
 * A link's ?server= naming another server than this page's (linkServerState
 * 'ask') is asked first, naming its host; once confirmed it is used by this
 * page in this tab only (confirmLinkServer), never stored for the scorer,
 * nor offered as "Last used" later. Only an address the app will use
 * (isAllowedBackendUrl, or the page's own default) is ever requested.
 *
 * @param {Object} props
 * @param {function} props.onConnected - Called when server is confirmed reachable, with { serverUrl }
 * @param {boolean} [props.skipIfAutoConnect] - If true and URL params have server/match, skip this screen
 * @param {string} [props.helpScreen] - The app's help screen (referee, bench, livescore): a "?" in the
 *   corner opens its help panel on Connecting tablets
 */
export default function ServerConnectionScreen({ onConnected, skipIfAutoConnect = true, helpScreen }) {
  const { t } = useTranslation()
  const [helpOpen, setHelpOpen] = useState(false)
  const [mode, setMode] = useState('online') // 'online' | 'local'
  const [localAddress, setLocalAddress] = useState('')
  const [status, setStatus] = useState('idle') // 'idle' | 'checking' | 'connected' | 'failed'
  const [errorMsg, setErrorMsg] = useState(null)
  const [lastServer, setLastServer] = useState(null)
  // A link's ?server= waiting for the user's yes (its URL)
  const [linkServer, setLinkServer] = useState(null)
  // A dashboard opened from the scorer's Home menu on this device: the way
  // back before there is a header (utils/scorerReturn.js)
  const [backToScorer] = useState(() => !!scorerReturnUrl())

  // Load last used server from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem(LAST_SERVER_KEY)
      if (saved) setLastServer(JSON.parse(saved))
    } catch { /* ignore */ }
  }, [])

  const notAllowedMsg = t('connection.notAllowed', "This address can't be used. Enter the server's IP address on the hall network (for example 192.168.1.42:5173), a name ending in .local, or an https:// address on openvolley.app.")

  // Check URL params for auto-connect (server param): the page's own server
  // connects at once, another one only after the question below, a refused
  // one never (not even its /health)
  useEffect(() => {
    if (!skipIfAutoConnect) return
    const params = new URLSearchParams(window.location.search)
    const serverParam = params.get('server')
    if (!serverParam) return
    const { state, url } = linkServerState(serverParam)
    if (state === 'known') {
      connectToServer(url, { auto: true, fromLink: true })
    } else if (state === 'ask') {
      setLinkServer(url)
    } else {
      setStatus('failed')
      setErrorMsg(notAllowedMsg)
    }
  }, [skipIfAutoConnect]) // eslint-disable-line react-hooks/exhaustive-deps

  const saveLastServer = useCallback((url, label) => {
    try {
      localStorage.setItem(LAST_SERVER_KEY, JSON.stringify({ url, label, timestamp: Date.now() }))
    } catch { /* ignore */ }
  }, [])

  /**
   * @param {string} url
   * @param {{ auto?: boolean, fromLink?: boolean }} [opts] fromLink: a link's
   *   server, kept for this page in this tab; else the device's choice
   */
  const connectToServer = useCallback(async (url, { auto = false, fromLink = false } = {}) => {
    setStatus('checking')
    setErrorMsg(null)

    // Normalize URL (a bare address: http:// on the hall network, else https://)
    const serverUrl = normalizeServerAddress(url)

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

    // Only an address the app then uses: asked before any request, so the
    // screen never says Connected for one setBackendOverride would drop. The
    // page's own server is one, whatever its address (a venue relay on a
    // plain host name): the page uses it with no override.
    const allowed = isAllowedBackendUrl(serverUrl)
    if (!allowed && !isDefaultBackendUrl(serverUrl)) {
      setStatus('failed')
      setErrorMsg(notAllowedMsg)
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
        // A desktop relay takes its WebSocket on another port than the page
        // (5173 / 8080): ask it which, before the views connect.
        await learnRelayWsPort(serverUrl)
        if (fromLink) confirmLinkServer(serverUrl)
        else if (allowed) setBackendOverride(serverUrl)
        else clearBackendOverride()
        // Connected only to the server the page then really uses (storage
        // blocked: the default would stay)
        if (normalizeServerAddress(getBackendUrl() || '') !== serverUrl) {
          setStatus('failed')
          setErrorMsg(t('connection.notKept', 'This browser could not keep the server address. Allow this site to store data, then try again.'))
          return
        }
        setStatus('connected')
        setLinkServer(null)
        // A link's server is for this tab only: "Last used" (localStorage,
        // reconnected with setBackendOverride) would hand it to later visits
        // and to the scorer page
        if (!fromLink) {
          const label = serverUrl.includes('openvolley.app') ? 'Cloud' : 'Local'
          saveLastServer(serverUrl, label)
        }
        // Brief delay to show connected state
        setTimeout(() => {
          onConnected({ serverUrl })
        }, auto ? 0 : 400)
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
  }, [onConnected, saveLastServer, notAllowedMsg, t])

  const handleOnlineConnect = useCallback(() => {
    // Clear any override — use default backend
    clearBackendOverride()
    const defaultUrl = getBackendUrl()
    if (defaultUrl) {
      connectToServer(defaultUrl)
    } else {
      setStatus('failed')
      // A dev build never uses the production backend (backendConfig.isDevBuild)
      setErrorMsg(isDevBuildWithoutBackend()
        ? t('connection.noTestBackend', 'No test backend configured')
        : t('connection.noBackendConfigured', 'No backend server configured'))
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

  // Status indicator (kit notice tones: sky = pending, green = ok, red = failed)
  const renderStatus = () => {
    if (status === 'idle') return null

    return (
      <div className="mt-4" aria-live="polite">
        {status === 'checking' && (
          <div className={cn(NOTICE.info, 'justify-center text-sm')}>
            <Loader2 size={14} className="animate-spin" aria-hidden="true" />
            {t('connection.checking', 'Connecting...')}
          </div>
        )}
        {status === 'connected' && (
          <div className={cn(NOTICE.success, 'text-center text-sm font-medium')}>
            {t('connection.connectedSuccess', 'Connected!')}
          </div>
        )}
        {status === 'failed' && (
          <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-700">
            <span>{errorMsg}</span>
            <button
              type="button"
              onClick={() => setStatus('idle')}
              className={cn('inline-flex h-9 shrink-0 items-center rounded-lg border border-red-200 bg-white px-3 text-xs font-medium text-red-700 transition-colors hover:bg-red-50', FOCUS_RING)}
            >
              {t('connection.retry', 'Retry')}
            </button>
          </div>
        )}
      </div>
    )
  }

  // The default the "Online" option connects to (a dev build: its test backend)
  const onlineHost = hostOf(defaultBackendUrl()) ||
    (isDevBuildWithoutBackend() ? t('connection.noTestBackend', 'No test backend configured') : 'backend.openvolley.app')

  const optionCls = (on) => cn(
    'w-full rounded-xl border p-4 text-left transition-colors',
    on ? 'border-slate-900 bg-white ring-1 ring-slate-900' : 'border-stone-200 bg-white hover:bg-stone-50'
  )

  return (
    <div className="ov-kit relative min-h-screen bg-gradient-to-br from-stone-100 via-stone-50 to-stone-100 flex items-center justify-center p-4">
      {backToScorer && (
        <div className="absolute left-3 top-3">
          <button
            type="button"
            onClick={() => returnToScorer()}
            data-testid="dashboard-scorer-button"
            aria-label={t('dashboards.backToScorer', 'Back to scorer')}
            title={t('dashboards.backToScorer', 'Back to scorer')}
            className={cn(HEADER_BTN, HEADER_HIT, 'gap-1 bg-white pl-1.5 pr-2.5')}
          >
            <ChevronLeft size={16} aria-hidden="true" />
            <span>{t('dashboards.scorer', 'Scorer')}</span>
          </button>
        </div>
      )}
      {/* The "?" where the app's header has it, before there is a header */}
      {helpScreen && (
        <>
          <div className="absolute right-3 top-3">
            <HeaderHelpButton onClick={() => setHelpOpen(prev => !prev)} pressed={helpOpen} />
          </div>
          <ContextualHelpPanel open={helpOpen} onClose={() => setHelpOpen(false)} screen={helpScreen} openSection="connections" />
        </>
      )}
      <div className="w-full max-w-sm">
        <div className="relative overflow-hidden rounded-3xl border border-stone-200/70 bg-white p-6 shadow-card-lg sm:p-8">
          <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-red-600 to-red-500" />
          <h2 className="text-center text-xl font-bold tracking-tight text-stone-900">
            {t('connection.connectToServer', 'Connect to server')}
          </h2>
          <p className="mt-1 mb-6 text-center text-sm text-stone-500">
            {t('connection.selectServerMode', 'Choose how to connect')}
          </p>

          {/* A link's server: named, and used only after a yes */}
          {linkServer ? (
            <div data-testid="link-server-confirm" className="rounded-xl border border-amber-200 bg-amber-50 p-4">
              <p className="text-sm font-semibold text-stone-900">
                {t('connection.linkServerTitle', 'This link connects to another server')}
              </p>
              <p className="mt-2 break-all font-mono text-sm text-stone-800" data-testid="link-server-host">
                {hostOf(linkServer) || linkServer}
              </p>
              <p className="mt-2 text-xs text-stone-600">
                {t('connection.linkServerHint', 'Continue only if the scorer gave you this link. This page then uses that server until the tab is closed.')}
              </p>
              <div className="mt-4 flex flex-col gap-2">
                <Button
                  variant="primary"
                  size="xl"
                  block
                  onClick={() => connectToServer(linkServer, { fromLink: true })}
                  disabled={status === 'checking'}
                >
                  {t('connection.linkServerConnect', 'Connect to this server')}
                </Button>
                <Button
                  variant="secondary"
                  size="xl"
                  block
                  onClick={() => { setLinkServer(null); setStatus('idle') }}
                  disabled={status === 'checking'}
                >
                  {t('connection.linkServerDecline', 'Choose the server myself')}
                </Button>
              </div>
            </div>
          ) : (
            <>
              {/* Online (automatic) */}
              <button
                type="button"
                onClick={handleOnlineConnect}
                disabled={status === 'checking'}
                className={cn(optionCls(mode === 'online'), 'mb-3 flex min-h-16 items-center gap-4 disabled:cursor-wait', FOCUS_RING)}
              >
                <span className="shrink-0 text-stone-500"><GlobeIcon size={26} /></span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-stone-900">
                    {t('connection.onlineAutomatic', 'Online (automatic)')}
                  </span>
                  <span className="mt-0.5 block text-xs text-stone-500">
                    {onlineHost}
                  </span>
                </span>
              </button>

              {/* Local server */}
              <div className={optionCls(mode === 'local')}>
                <div className="mb-3 flex items-center gap-4">
                  <span className="shrink-0 text-stone-500"><SatelliteDishIcon size={26} /></span>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-stone-900">
                      {t('connection.localServer', 'Local server')}
                    </div>
                    <div className="mt-0.5 text-xs text-stone-500">
                      {t('connection.enterIPAddress', 'Enter IP address')}
                    </div>
                  </div>
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    aria-label={t('connection.enterIPAddress', 'Enter IP address')}
                    value={localAddress}
                    onChange={(e) => { setLocalAddress(e.target.value); setMode('local') }}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleLocalConnect() }}
                    placeholder="192.168.1.42:5173"
                    className="h-11 min-w-0 flex-1 rounded-xl border border-stone-200 bg-white px-3 font-mono text-sm text-stone-800 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-red-700/20 focus:border-red-700/40"
                  />
                  <Button
                    variant="primary"
                    size="xl"
                    onClick={handleLocalConnect}
                    disabled={!localAddress.trim() || status === 'checking'}
                    className="shrink-0"
                  >
                    {t('connection.connect', 'Connect')}
                  </Button>
                </div>
              </div>

              {/* Last used server */}
              {lastServer && (
                <button
                  type="button"
                  onClick={handleLastServerConnect}
                  disabled={status === 'checking'}
                  className={cn('mt-3 inline-flex min-h-11 w-full items-center justify-center gap-1 rounded-lg px-3 text-center text-xs text-stone-500 underline decoration-stone-300 underline-offset-2 transition-colors hover:text-stone-800 disabled:cursor-wait', FOCUS_RING)}
                >
                  {t('connection.lastUsed', 'Last used')}: {lastServer.label || lastServer.url}
                  {lastServer.url !== (getBackendOverride() || getBackendUrl()) && (
                    <span className="ml-2 text-stone-400">
                      ({new URL(lastServer.url).host})
                    </span>
                  )}
                </button>
              )}
            </>
          )}

          {/* Status indicator */}
          {renderStatus()}
        </div>
      </div>
    </div>
  )
}
