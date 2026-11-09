import { TabletIcon } from '../icons'
import { Button } from '../../ui/Button.jsx'
import { isNativeApp } from '../../utils/backendConfig'

/**
 * A phone or tablet held sideways on the referee dashboard: the mirror of the
 * scorer's "Please rotate your device" notice (Scoreboard.jsx), which asks
 * for landscape. Shown instead of the dashboard (Referee.jsx); the
 * dashboard's state stays, so turning the device upright brings back the
 * score, a running time-out and an open scoresheet as they were.
 *
 * The fullscreen button: in fullscreen a browser on Android grants the
 * portrait lock (referee/upright.js), so the screen turns upright by itself.
 * Not in the Android app, which locks natively, nor where the browser has no
 * fullscreen (iPhone).
 */
export default function TurnUprightNotice({ t }) {
  const canFullscreen = !isNativeApp()
    && typeof document !== 'undefined'
    && typeof document.documentElement?.requestFullscreen === 'function'
    && !document.fullscreenElement
  return (
    <div
      role="alert"
      data-testid="referee-turn-upright"
      className="ov-kit"
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgb(28 25 23)',
        zIndex: 99999,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        textAlign: 'center'
      }}
    >
      <div className="turn-upright-icon" style={{ marginBottom: '24px', color: '#ffffff' }}>
        <TabletIcon size={64} />
      </div>
      {/* The scorer's icon turns from upright to sideways; this one back */}
      <style>{`
        .turn-upright-icon { animation: turnUpright 1.5s ease-in-out infinite; }
        @keyframes turnUpright {
          0%, 100% { transform: rotate(-90deg); }
          50% { transform: rotate(0deg); }
        }
        @media (prefers-reduced-motion: reduce) {
          .turn-upright-icon { animation: none; }
        }
      `}</style>
      <h2 style={{ fontSize: '24px', fontWeight: 700, color: '#ffffff', margin: '0 0 16px' }}>
        {t('refereeDashboard.upright.title', 'Please hold the device upright')}
      </h2>
      <p style={{ fontSize: '16px', color: '#e7e5e4', maxWidth: '420px', lineHeight: 1.5, margin: 0 }}>
        {t('refereeDashboard.upright.body', 'The referee dashboard is made for portrait. Turn the tablet or phone upright to continue: the score, time-outs and countdowns keep going.')}
      </p>
      {canFullscreen && (
        <>
          <Button
            variant="secondary"
            size="xl"
            className="mt-6"
            onClick={() => { document.documentElement.requestFullscreen().catch(() => { }) }}
          >
            <span aria-hidden>⛶</span>
            <span>{t('refereeDashboard.upright.fullscreen', 'Enter fullscreen')}</span>
          </Button>
          <p style={{ fontSize: '12px', color: '#d6d3d1', maxWidth: '320px', lineHeight: 1.4, margin: '12px 0 0' }}>
            {t('refereeDashboard.upright.fullscreenHint', 'On Android, fullscreen keeps the screen upright however the device is held.')}
          </p>
        </>
      )}
    </div>
  )
}
