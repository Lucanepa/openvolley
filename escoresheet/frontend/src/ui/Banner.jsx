// Inline banners, notices and the floating connection banner, ported from svrz_rc.
//
//   Banner          — page-level status strip with icon (+ optional action).
//                     danger App.tsx:9212-9218, warning App.tsx:6845-6855,
//                     info App.tsx:6858-6873, neutral App.tsx:6769-6770.
//   Notice          — a plain tinted sentence under a form/list (no icon).
//                     AdminConsole.tsx:1729-1736.
//   FieldNote       — the 11px amber note under one row or field.
//                     AdminConsole.tsx:5184-5187.
//   Callout         — sky "read this first" panel with a title. App.tsx:9416-9424.
//   ModalStrip      — full-bleed warning strip under a modal header. App.tsx:6445-6450.
//   ConnectionBanner— floating pill at the top for network state. ConnectionBanner.tsx:35-61.
import { AlertTriangle, CircleCheck, History, Info, ShieldAlert, SignalLow, WifiOff } from 'lucide-react';
import { cn } from './cn.js';
import { FOCUS_RING } from './Button.jsx';
import { BANNER, BANNER_BASE, NOTICE } from './tones.js';

const BANNER_TONE = {
  danger: {
    box: 'flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs font-medium text-red-800',
    action: 'shrink-0 rounded border border-red-300 bg-white px-2 py-0.5 font-semibold text-red-700 hover:bg-red-100',
    icon: ShieldAlert,
  },
  warning: {
    box: 'flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900',
    action: 'shrink-0 rounded border border-amber-300 bg-white px-2 py-0.5 font-semibold text-amber-800 hover:bg-amber-100',
    icon: AlertTriangle,
  },
  info: {
    box: 'flex items-center gap-2 rounded-lg border border-sky-300 bg-sky-50 px-3 py-2 text-xs font-medium text-sky-800',
    action: 'inline-flex items-center gap-1 rounded-md border border-sky-300 bg-white px-2 py-1 font-semibold text-sky-700 hover:bg-sky-100 disabled:opacity-50',
    icon: Info,
  },
  neutral: {
    box: 'flex items-start gap-2 rounded-lg border border-stone-300 bg-stone-50 px-3 py-2 text-xs font-medium text-stone-700',
    action: 'shrink-0 rounded border border-stone-300 bg-white px-2 py-0.5 font-semibold text-stone-700 hover:bg-stone-100',
    icon: Info,
  },
};

/**
 * <Banner tone="danger" icon={CloudOff} action={{ label: 'Als Datei sichern', onClick }}>
 *   Entwürfe können auf diesem Gerät nicht gespeichert werden.
 * </Banner>
 */
export function Banner({ tone = 'info', icon, action, className, children, ...rest }) {
  const t = BANNER_TONE[tone] ?? BANNER_TONE.info;
  const Icon = icon === null ? null : (icon ?? t.icon);
  return (
    <div className={cn(t.box, className)} {...rest}>
      {Icon && <Icon size={14} className={cn('shrink-0', tone !== 'info' && 'mt-0.5')} />}
      <span className="flex-1">{children}</span>
      {action && (
        <button type="button" onClick={action.onClick} disabled={action.disabled} className={cn(t.action, FOCUS_RING)}>
          {action.icon}
          {action.label}
        </button>
      )}
    </div>
  );
}

// NOTICE strips (AdminConsole.tsx:1729-1736, BudgetCard.tsx:212, App.tsx:6858)
// live in tones.js: error · warning · success · info.

/**
 * The result line of an action, shown where the action was taken. Callers add
 * the spacing (`mt-2` under a form, `mb-3` above a list). AdminConsole.tsx:1729-1736.
 * role="alert" for errors so a screen reader hears the failure once.
 */
export function Notice({ tone = 'error', className, children }) {
  if (!children) return null;
  return (
    <p role={tone === 'error' ? 'alert' : undefined} className={cn(NOTICE[tone] ?? NOTICE.error, className)}>
      {children}
    </p>
  );
}

/** Small amber note attached to one row/field. AdminConsole.tsx:5184-5187. */
export function FieldNote({ icon: Icon = AlertTriangle, className, children }) {
  return (
    <p className={cn('mt-1.5 flex items-start gap-1.5 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] leading-snug text-amber-800', className)}>
      <Icon size={12} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/** "Read this before you start" panel. App.tsx:9416-9424. */
export function Callout({ icon: Icon = Info, title, className, children, ...rest }) {
  return (
    <div className={cn('mb-6 rounded-lg border border-sky-200 bg-sky-50/60 p-3 no-print', className)} {...rest}>
      <div className="flex items-start gap-2">
        <Icon size={16} className="text-sky-700 shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          {title && <div className="text-sm font-semibold text-stone-800">{title}</div>}
          <div className="text-xs text-stone-600 mt-0.5">{children}</div>
        </div>
      </div>
    </div>
  );
}

/** Full-bleed strip directly under a sectioned modal's header. App.tsx:6445-6450. */
export function ModalStrip({ icon: Icon = Info, children }) {
  return (
    <div className="px-5 py-2.5 bg-amber-50 border-b border-amber-200 text-[12px] text-amber-800 font-medium flex items-center gap-2">
      <Icon size={14} className="shrink-0" />
      {children}
    </div>
  );
}

const CONNECTION_ICON = { slow: SignalLow, stale: History, unreachable: WifiOff, offline: WifiOff, ok: CircleCheck };

const CONNECTION_TEXT = {
  slow: {
    DE: 'Langsames Netz – der Server antwortet über deine Verbindung gerade kaum. Die App wartet weiter.',
    EN: 'Slow network – your connection is barely reaching the server. The app keeps waiting.',
  },
  stale: {
    DE: 'Keine Antwort über dein Netz – du siehst die zuletzt geladenen Daten.',
    EN: 'No answer over your network – showing the last-loaded data.',
  },
  unreachable: {
    DE: 'Keine Verbindung zum Server – bitte WLAN oder Mobilnetz prüfen.',
    EN: 'No connection to the server – please check Wi-Fi or mobile data.',
  },
  offline: {
    DE: 'Offline – dein Gerät hat gerade kein Netz.',
    EN: 'Offline – your device has no network right now.',
  },
};

/**
 * Floating, pointer-transparent pill at the top of every route.
 * ConnectionBanner.tsx:1-62. The text names the CONNECTION, never the app.
 * state: 'ok' | 'slow' | 'stale' | 'unreachable' | 'offline'  ('ok' renders nothing)
 * `messages` overrides the copy: { slow: { DE, EN }, ... }; `children` overrides it outright.
 */
export function ConnectionBanner({ state, lang = 'DE', messages, children }) {
  if (!state || state === 'ok') return null;
  const Icon = CONNECTION_ICON[state] ?? WifiOff;
  const severe = state === 'unreachable' || state === 'offline';
  const text = children ?? (messages?.[state] ?? CONNECTION_TEXT[state])?.[lang] ?? '';
  return (
    // Above the page, not in its flow: it comes and goes with every slow
    // request and must neither shift layout nor swallow a tap on the header.
    <div
      className="no-print fixed inset-x-0 top-0 z-[70] flex justify-center px-3 pointer-events-none"
      style={{ paddingTop: 'calc(0.5rem + env(safe-area-inset-top, 0px))' }}
    >
      <div
        role="status"
        aria-live="polite"
        data-testid="connection-banner"
        data-state={state}
        className={cn(BANNER_BASE, severe ? BANNER.severe : BANNER.mild)}
      >
        <Icon size={14} className="mt-px shrink-0" />
        <span>{text}</span>
      </div>
    </div>
  );
}

export default Banner;
