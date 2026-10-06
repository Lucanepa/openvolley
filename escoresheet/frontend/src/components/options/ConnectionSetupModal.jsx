import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { QRCodeSVG } from 'qrcode.react'
import Modal from '../Modal'
import QRCodeModal, { buildConnectionUrl } from '../QRCodeModal'
import {
  getLocalIP,
  getServerStatus,
  copyToClipboard,
  buildAppUrls,
  buildWebSocketUrl,
  getCloudBackendUrl,
  buildCloudUrls
} from '../../utils/networkInfo'
import { db } from '../../db/db'
import { useRelayTablets } from '../../hooks/useRealtimeConnection'
import { getLocalServerStatusUrl } from '../../utils/backendConfig'
import { relayMatchKey } from '../../utils/serverDataSync'
import { SignalIcon, GlobeIcon } from '../icons'
import { Loader2, QrCode } from 'lucide-react'
import { cn, FOCUS_RING, Switch } from '../../ui'

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
        // A static deployment has no local server to ask (its /api/* is the SPA)
        const [ip, status] = await Promise.all([
          getLocalIP(),
          getLocalServerStatusUrl() ? getServerStatus() : Promise.resolve({ running: false })
        ])
        setLocalIP(ip)
        setServerStatus(status)
      } catch (err) {
        console.error('Error loading network info:', err)
      } finally {
        setLoading(false)
      }
    }

    loadNetworkInfo()
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

  // The match's relay key (its seed key) for the QR code / link: the tablet
  // preselects that match and still asks for its PIN. Never the Dexie id,
  // which every device's first match shares.
  const relayKey = relayMatchKey(match) || matchSeedKey || null
  const seedKey = relayKey

  // Devices on this match: the relay the tablets use (cloud backend or LAN
  // server), asked by the seed key the tablets subscribe with. It used to ask
  // window.location, which on a static deployment is the SPA, not the relay.
  const relayTablets = useRelayTablets(open && relayKey ? String(relayKey) : null, match, { enabled: open, intervalMs: 5000 })
  const devicesOnMatch = relayTablets.connections?.dashboardClients ?? relayTablets.watchers
  const watchingMatch = relayTablets.connections?.matchSubscriptions?.[String(relayKey)] ?? relayTablets.watchers

  // Kit recipes: selectable option card (chosen = slate ring), small outline button.
  const optionCls = (on) => cn(
    'flex-1 max-w-[220px] rounded-xl border px-4 py-4 text-center transition-colors disabled:cursor-not-allowed disabled:opacity-50',
    on ? 'border-slate-900 bg-white ring-1 ring-slate-900' : 'border-stone-200 bg-white hover:bg-stone-50',
    FOCUS_RING
  )
  const smallBtn = (done) => cn(
    'inline-flex h-11 items-center justify-center rounded-lg border px-3.5 text-xs font-medium transition-colors',
    done ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-stone-300 bg-white text-stone-700 hover:bg-stone-50',
    FOCUS_RING
  )

  const renderModeSelector = () => (
    <div className="mb-5">
      <p className="mb-3 text-center text-sm text-stone-500">
        {t('connection.chooseConnection')}
      </p>
      <div className="flex justify-center gap-3">
        <button
          type="button"
          aria-pressed={connectionMode === 'lan'}
          onClick={() => setConnectionMode('lan')}
          className={optionCls(connectionMode === 'lan')}
        >
          <div className="mb-2 flex justify-center text-stone-500"><SignalIcon size={28} /></div>
          <div className="text-sm font-semibold text-stone-900">{t('connectionSetup.lan', 'LAN')}</div>
          <div className="mt-0.5 text-xs text-stone-500">{t('connection.sameWifi')}</div>
        </button>

        <button
          type="button"
          aria-pressed={connectionMode === 'internet'}
          onClick={() => setConnectionMode('internet')}
          className={optionCls(connectionMode === 'internet')}
          disabled={!cloudBackendUrl}
        >
          <div className="mb-2 flex justify-center text-stone-500"><GlobeIcon size={28} /></div>
          <div className="text-sm font-semibold text-stone-900">{t('connectionSetup.internet', 'Internet')}</div>
          <div className="mt-0.5 text-xs text-stone-500">
            {cloudBackendUrl ? t('connection.cloudRelay') : t('connection.notConfigured')}
          </div>
        </button>
      </div>
    </div>
  )

  // Reusable connection row component for each role. `color` is the role's
  // identity colour; it stays on the 2px rail only.
  const renderConnectionRow = (role, label, pin, color, { enabled, dbField, syncField, pinSyncField } = {}) => {
    const url = buildConnectionUrl(role, seedKey)
    const hasToggle = dbField != null

    return (
      <div key={role} className={cn('flex items-stretch gap-3 py-3 transition-opacity', enabled === false && 'opacity-60')}>
        <span className="w-[2px] shrink-0 self-stretch rounded-full" style={{ background: enabled === false ? '#e7e5e4' : color }} />
        <div className="min-w-0 flex-1">
          <div className={cn('flex min-h-11 items-center justify-between gap-3', enabled !== false && 'mb-2')}>
            <div className="flex items-center gap-3">
              {hasToggle && (
                // Opens over the scoreboard: "on" is slate-900, never brand red (R4).
                // lg track plus an 8px invisible halo = a 44px courtside hit area (R12).
                <Switch
                  size="lg"
                  checked={!!enabled}
                  aria-label={label}
                  onCheckedChange={() => handleToggleConnection(dbField, syncField, pinSyncField, !enabled)}
                  className={cn("before:absolute before:-inset-2 before:content-['']", enabled && 'bg-slate-900')}
                />
              )}
              <h4 className="text-sm font-semibold text-stone-900">{label}</h4>
            </div>
            {enabled !== false && (
              <button
                type="button"
                onClick={() => setShowQRModal(role)}
                className={smallBtn(false)}
              >
                <QrCode size={14} aria-hidden="true" className="mr-1.5 text-stone-400" />
                {t('connection.showQR', 'Show QR')}
              </button>
            )}
          </div>

          {enabled !== false && (
            <>
              {/* PIN display */}
              {pin && (
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-xs text-stone-500">PIN:</span>
                  <code className="rounded border border-stone-200 bg-stone-50 px-2 py-0.5 font-mono text-base font-semibold tracking-[0.3em] text-stone-900">
                    {pin}
                  </code>
                  <button
                    type="button"
                    onClick={() => handleCopy(pin, `${role}-pin`)}
                    className={smallBtn(copyFeedback === `${role}-pin`)}
                  >
                    {copyFeedback === `${role}-pin` ? t('options.copied') : t('options.copy')}
                  </button>
                </div>
              )}

              {/* Inline small QR code + URL */}
              {url && (
                <div className="flex items-center gap-3">
                  <div className="shrink-0 rounded-md border border-stone-200 bg-white p-1">
                    <QRCodeSVG value={url} size={60} level="L" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <code className="block break-all font-mono text-[11px] leading-snug text-stone-500">
                      {url}
                    </code>
                    <button
                      type="button"
                      onClick={() => handleCopy(url, `${role}-url`)}
                      className={cn(smallBtn(copyFeedback === `${role}-url`), 'mt-1.5')}
                    >
                      {copyFeedback === `${role}-url` ? t('options.copied') : t('options.copyUrl', 'Copy URL')}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    )
  }

  const statusDot = (ok) => (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-sans text-[11px] font-medium', ok ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800')}>
      <span className={cn('h-2 w-2 rounded-full', ok ? 'bg-emerald-500' : 'bg-red-500')} />
      {ok === 'configured' ? t('connection.configured') : ok ? t('options.running') : t('options.notRunning')}
    </span>
  )

  const renderNetworkInfo = () => (
    <div className="mb-5 rounded-xl border border-stone-200/70 bg-stone-50/60 p-4">
      <h4 className="mb-3 text-[11px] font-bold uppercase tracking-wider text-stone-500">
        {connectionMode === 'lan'
          ? t('connection.localNetworkAddress')
          : t('connection.cloudBackend')}
      </h4>
      {connectionMode === 'lan' ? (
        loading ? (
          <p className="flex items-center gap-2 text-sm text-stone-500">
            <Loader2 size={14} className="animate-spin text-stone-400" aria-hidden="true" />
            {t('connection.detectingNetwork')}
          </p>
        ) : localIP ? (
          <div className="space-y-2 font-mono text-sm text-stone-700">
            <div className="flex justify-between gap-3">
              <span className="font-sans text-stone-500">{t('connection.ipAddress')}:</span>
              <span className="text-stone-900">{localIP}:{port}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="font-sans text-stone-500">WebSocket:</span>
              <span className="break-all text-stone-900">{wsUrl}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="font-sans text-stone-500">{t('connection.status')}:</span>
              {statusDot(!!serverStatus.running)}
            </div>
          </div>
        ) : (
          <p role="alert" className="text-sm font-medium text-red-700">{t('connection.couldNotDetectIP')}</p>
        )
      ) : (
        cloudBackendUrl ? (
          <div className="space-y-2 font-mono text-sm text-stone-700">
            <div className="flex flex-wrap justify-between gap-2">
              <span className="font-sans text-stone-500">URL:</span>
              <span className="break-all text-stone-900">{cloudBackendUrl}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="font-sans text-stone-500">{t('connection.status')}:</span>
              {statusDot('configured')}
            </div>
          </div>
        ) : (
          <p role="alert" className="text-sm font-medium text-red-700">{t('connection.noCloudBackend')}</p>
        )
      )}
    </div>
  )

  const renderConnections = () => (
    <div className="divide-y divide-stone-100">
      {renderConnectionRow('referee', t('connection.role.referee', 'Referee dashboard'), refereePin, '#3b82f6', {
        enabled: match?.refereeConnectionEnabled === true,
        dbField: 'refereeConnectionEnabled',
        syncField: 'referee_enabled',
        pinSyncField: 'referee'
      })}
      {renderConnectionRow('bench_home', t('connection.role.bench_home', 'Home bench'), homeTeamPin, '#10b981', {
        enabled: match?.homeTeamConnectionEnabled === true,
        dbField: 'homeTeamConnectionEnabled',
        syncField: 'home_bench_enabled',
        pinSyncField: 'bench_home'
      })}
      {renderConnectionRow('bench_away', t('connection.role.bench_away', 'Away bench'), awayTeamPin, '#ef4444', {
        enabled: match?.awayTeamConnectionEnabled === true,
        dbField: 'awayTeamConnectionEnabled',
        syncField: 'away_bench_enabled',
        pinSyncField: 'bench_away'
      })}
      {renderConnectionRow('livescore', t('connection.role.livescore', 'Livescore'), null, '#8b5cf6')}
    </div>
  )

  const renderConnectedDevices = () => (
    <div className="mt-3 rounded-xl border border-stone-200/70 bg-stone-50/60 p-4">
      <div className="flex items-center justify-center gap-2">
        <span className={cn('text-2xl font-bold tabular-nums', devicesOnMatch > 0 ? 'text-emerald-600' : 'text-stone-400')}>
          {devicesOnMatch}
        </span>
        <span className="text-sm text-stone-600">
          {devicesOnMatch === 1 ? t('connection.deviceConnected') : t('connection.devicesConnected')}
        </span>
      </div>
      {relayKey && relayTablets.connections && (
        <div className="mt-2 text-center text-xs text-stone-500">
          {t('connection.watchingThisMatch', { count: watchingMatch || 0 })}
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
        <div className="ov-kit py-2">
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
