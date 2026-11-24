// Crash and dead-end screens, ported from svrz_rc.
//
//   ErrorScreen    — the full-screen "something went wrong" card.
//                    ErrorBoundary.tsx:44-60.
//   ErrorBoundary  — class component that records the crash and shows ErrorScreen.
//                    ErrorBoundary.tsx:1-63. Wire `onError` to your logger.
//   UpdateNotice   — "this build is gone, reload" overlay or inline card.
//                    StaleBuildNotice.tsx:1-32.
//   GateMessage    — the centred hero card for "no connection" / blocked states.
//                    AuthGate.tsx:395-410.
import { Component } from 'react';
import { AlertTriangle, RotateCw, X } from 'lucide-react';
import { FOCUS_RING } from './Button.jsx';
import { reloadWithReason } from '../diagnostics/reload';

/** Brand CTA used on every dead-end screen. ErrorBoundary.tsx:51-53, StaleBuildNotice.tsx:15 */
const reloadClass =
  `w-full mt-5 inline-flex items-center justify-center gap-2 bg-red-600 hover:bg-red-700 text-white font-semibold py-2.5 rounded-xl text-sm ${FOCUS_RING}`;
/** Quiet underlined text link under the CTA. ErrorBoundary.tsx:56 */
const quietLinkClass = `w-full mt-2 rounded text-[11px] text-stone-400 hover:text-stone-600 underline ${FOCUS_RING}`;

export function ErrorScreen({
  title = 'Da ist etwas schiefgelaufen',
  body = 'Der Fehler wurde automatisch protokolliert.',
  detail,
  reloadLabel = 'Neu laden',
  onReload = () => reloadWithReason('error-screen'),
  secondary, // { label, onClick }
}) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-stone-50 p-4">
      <div className="w-full max-w-sm bg-white rounded-2xl border border-stone-200 shadow-sm p-6 text-center">
        <AlertTriangle className="h-8 w-8 text-red-600 mx-auto" />
        <h1 className="text-base font-semibold text-stone-900 mt-3">{title}</h1>
        {body && <p className="text-xs text-stone-500 mt-2">{body}</p>}
        {detail && <p className="text-[11px] text-stone-400 mt-1 break-words">{detail}</p>}
        <button type="button" onClick={onReload} className={reloadClass}>
          <RotateCw className="h-4 w-4" /> {reloadLabel}
        </button>
        {secondary && (
          <button type="button" onClick={secondary.onClick} className={quietLinkClass}>
            {secondary.label}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * <ErrorBoundary onError={(error, info) => log(error, info.componentStack)}
 *                getLogText={() => logs.join('\n')}>
 *
 * A render crash otherwise leaves a white screen and no trace. This records it,
 * gives the user a way out (reload) and a way to hand over the evidence (copy log).
 */
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, copied: false };
    this.copyLogs = this.copyLogs.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    this.props.onError?.(error, info);
  }

  async copyLogs() {
    const text = this.props.getLogText ? this.props.getLogText() : String(this.state.error?.stack || this.state.error);
    try { await navigator.clipboard.writeText(text); this.setState({ copied: true }); }
    catch { /* clipboard blocked — the log is on the server anyway */ }
  }

  render() {
    if (!this.state.error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(this.state.error);
    return (
      <ErrorScreen
        detail={this.state.error.message}
        secondary={{ label: this.state.copied ? 'Protokoll kopiert' : 'Protokoll kopieren', onClick: this.copyLogs }}
      />
    );
  }
}

/**
 * A lazy chunk whose build is gone: the reason and the way out.
 * Overlay by default; `inline` where a panel would have been. StaleBuildNotice.tsx:6-31
 */
export function UpdateNotice({ title = 'App-Update', message, onClose, inline, reloadLabel = 'Neu laden', closeLabel = 'Schliessen' }) {
  const body = (
    <div className="w-full max-w-sm rounded-2xl border border-stone-200 bg-white p-5 text-center shadow-sm" data-testid="stale-build">
      <p className="text-sm font-semibold text-stone-900">{title}</p>
      <p className="mt-1.5 text-xs text-stone-600">{message}</p>
      <button
        type="button"
        onClick={() => reloadWithReason('stale-build')}
        className={`mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-red-600 py-2.5 text-sm font-semibold text-white hover:bg-red-700 ${FOCUS_RING}`}
      >
        <RotateCw className="h-4 w-4" /> {reloadLabel}
      </button>
      {onClose && (
        <button type="button" onClick={onClose} className={`mt-2 inline-flex w-full items-center justify-center gap-1 rounded text-[11px] text-stone-400 hover:text-stone-600 underline ${FOCUS_RING}`}>
          <X className="h-3 w-3" /> {closeLabel}
        </button>
      )}
    </div>
  );
  if (inline) return <div className="grid place-items-center p-4">{body}</div>;
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-stone-900/90 p-4 no-print">
      {body}
    </div>
  );
}

/**
 * Centred hero card for a blocked state (no server, link expired, no access).
 * AuthGate.tsx:395-410. `icon` defaults to the warning triangle.
 */
export function GateMessage({ icon: Icon = AlertTriangle, title, body, action, secondary }) {
  return (
    <div className="min-h-screen bg-gradient-to-br from-stone-100 via-stone-50 to-stone-100 flex items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-3xl border border-stone-200/70 bg-white p-8 text-center shadow-card-lg">
        <Icon className="mx-auto h-8 w-8 text-red-600" />
        <p className="mt-3 text-base font-semibold text-stone-900">{title}</p>
        {body && <p className="mt-1.5 text-sm text-stone-600">{body}</p>}
        {action && (
          // AuthGate.tsx:151-152 primaryButtonClass + mt-5
          <button
            type="button"
            onClick={action.onClick}
            className={`w-full inline-flex items-center justify-center gap-2 bg-red-600 hover:bg-red-700 active:scale-[0.99] disabled:bg-stone-300 disabled:cursor-not-allowed text-white font-semibold py-3 rounded-xl text-sm transition-all shadow-sm shadow-red-600/20 mt-5 ${FOCUS_RING}`}
          >
            {action.icon ?? <RotateCw className="h-4 w-4" />} {action.label}
          </button>
        )}
        {secondary && (
          // AuthGate.tsx:409-415
          <button type="button" onClick={secondary.onClick} className={`mt-3 rounded text-xs text-stone-400 underline hover:text-stone-600 ${FOCUS_RING}`}>
            {secondary.label}
          </button>
        )}
      </div>
    </div>
  );
}

export default ErrorBoundary;
