import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import ServerConnectionScreen from '../ServerConnectionScreen'
import { getBackendOverride, isNativeApp } from '../../utils/backendConfig'
import { Button, IconButton } from '../../ui'

/**
 * Android app only (Capacitor): the bundled app has no server of its own and
 * opens on the cloud backend. At a venue without internet the scorer points it
 * at the local relay (desktop app, standalone server, venue box) by typing its
 * LAN address — plain http, e.g. 192.168.1.20:5173 for the desktop app (its
 * WebSocket on 8080 is found by itself) or 192.168.1.20:8080 for the venue
 * server — and can open the referee,
 * bench and livescore views bundled in the same app.
 *
 * The choice is the shared backend override (backendConfig), so the referee /
 * bench / livescore pages of the app use the same server. The page reloads
 * after a change so every connection (relay socket, sync, status checks)
 * starts over against the new server.
 */
export default function NativeServerSection() {
  const { t } = useTranslation()
  const [choosing, setChoosing] = useState(false)
  if (!isNativeApp()) return null

  const override = getBackendOverride()
  let current = t('options.nativeServerCloud', 'Cloud (backend.openvolley.app)')
  if (override) {
    try { current = new URL(override).host } catch { current = override }
  }

  const openView = (path) => { window.location.assign(path) }

  return (
    <section className="mb-6">
      <div className="flex items-center justify-between gap-2 border-b-[1.5px] border-stone-800 pb-1.5">
        <h3 className="text-[11px] font-bold uppercase tracking-wider text-stone-800">
          {t('options.nativeServerTitle', 'Server')}
        </h3>
      </div>
      <div className="divide-y divide-stone-100">
        <div className="flex min-h-12 items-center justify-between gap-4 py-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-stone-900">
              {override ? t('options.nativeServerLocal', 'Local server') : t('options.nativeServerOnline', 'Online')}
            </div>
            <div className="truncate font-mono text-xs text-stone-500" data-testid="native-server-current">{current}</div>
          </div>
          <Button variant="secondary" size="lg" onClick={() => setChoosing(true)}>
            {t('options.nativeServerChange', 'Change server')}
          </Button>
        </div>
        <div className="flex min-h-12 flex-wrap items-center justify-between gap-3 py-3">
          <div className="text-sm font-semibold text-stone-900">
            {t('options.nativeOpenView', 'Use this tablet as')}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="lg" onClick={() => openView('/referee/index.html')}>
              {t('connection.role.referee', 'Referee dashboard')}
            </Button>
            <Button variant="secondary" size="lg" onClick={() => openView('/bench/index.html')}>
              {t('options.nativeBench', 'Bench')}
            </Button>
            <Button variant="secondary" size="lg" onClick={() => openView('/livescore/index.html')}>
              {t('connection.role.livescore', 'Livescore')}
            </Button>
          </div>
        </div>
      </div>

      {/* Portal + stopped propagation: the options Modal's backdrop swallows
          touchstart (preventDefault) for everything rendered inside it, which
          would keep the address field from ever getting focus. */}
      {choosing && createPortal(
        <div
          className="fixed inset-0 z-[2000] overflow-y-auto bg-stone-100"
          role="dialog"
          aria-modal="true"
          onClick={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
        >
          <div className="ov-kit absolute right-4 top-4 z-10">
            <IconButton variant="close" icon={X} label={t('options.close')} onClick={() => setChoosing(false)} />
          </div>
          <ServerConnectionScreen
            skipIfAutoConnect={false}
            onConnected={() => window.location.reload()}
          />
        </div>,
        document.body
      )}
    </section>
  )
}
