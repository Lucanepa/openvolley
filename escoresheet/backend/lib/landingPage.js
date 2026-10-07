// The server's status page at '/': where to point each device (QR codes for
// the indoor and beach roles), how many clients and matches are live, and the
// active matches.
//
// Light "Volleyball style" (the app's volleyui look): stone page, white cards
// with a hairline and a soft shadow, Swiss Volley red as the one accent, sentence
// case. Self-contained on purpose: inline CSS, inline SVG icons (lib/icons.js)
// and logo (lib/brandMark.js),
// system fonts, no scripts and nothing fetched from anywhere else, because the
// page is opened on venue LANs with no internet.

import { icon } from './icons.js'
import { brandMark } from './brandMark.js'
import { legalUrl } from './legalLinks.js'

export const INDOOR_ROLES = [
  { key: 'referee', label: 'Referee', path: '/referee', icon: 'whistle' },
  { key: 'bench_home', label: 'Home bench', path: '/bench?team=home', icon: 'house' },
  { key: 'bench_away', label: 'Away bench', path: '/bench?team=away', icon: 'plane' },
  { key: 'roster', label: 'Roster upload', path: '/roster', icon: 'clipboard-list' }
]

export const BEACH_ROLES = [
  { key: 'beach_referee', label: 'Referee', path: '/beach-referee', icon: 'whistle' },
  { key: 'beach_scoreboard', label: 'Scoreboard', path: '/beach-scoreboard', icon: 'tv' }
]

/** Text and attribute values into HTML. Team names come from any scoreboard socket. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// The legal pages on openvolley.app (English, like the page). Opened on a
// venue LAN without internet they simply do not load; nothing else here
// depends on them.
const LEGAL_FOOTER = [
  ['privacy', 'Privacy policy'],
  ['terms', 'Terms of use'],
  ['impressum', 'Legal notice']
].map(([doc, label]) => `<a href="${escapeHtml(legalUrl(doc, 'en'))}">${label}</a>`).join(' · ')

const plural = (n, one, many) => `${n} ${n !== 1 ? many : one}`

const STYLE = `
    :root {
      color-scheme: light;
      --stone-50: #fafaf9; --stone-100: #f5f5f4; --stone-200: #e7e5e4; --stone-300: #d6d3d1;
      --stone-400: #a8a29e; --stone-500: #78716c; --stone-600: #57534e; --stone-700: #44403c;
      --stone-800: #292524; --stone-900: #1c1917; --slate-900: #0f172a;
      --red-600: #e2001a; --red-700: #be0014;
      --green-500: #22c55e; --sky-500: #0ea5e9;
      --hairline: rgb(231 229 228 / 0.7);
      --shadow-card: 0 1px 2px -1px rgb(28 25 23 / 0.06), 0 6px 20px -8px rgb(28 25 23 / 0.12);
    }
    *, *::before, *::after { box-sizing: border-box; }
    * { margin: 0; padding: 0; }
    body {
      font-family: "Inter Variable", "Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      background: linear-gradient(to bottom, var(--stone-50), var(--stone-100)) fixed;
      background-color: var(--stone-100);
      color: var(--stone-800); min-height: 100vh;
      -webkit-font-smoothing: antialiased; line-height: 1.5;
    }
    .page { max-width: 1024px; margin: 0 auto; padding: 24px 16px 40px; }
    @media (min-width: 640px) { .page { padding-top: 32px; } }
    .icon { display: block; flex-shrink: 0; }

    .header { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 12px 16px; margin-bottom: 24px; }
    .title { display: flex; align-items: center; gap: 10px; }
    .title .brand-mark { flex: none; }
    h1 { font-size: 24px; font-weight: 700; letter-spacing: -0.02em; color: var(--stone-900); line-height: 1.2; }
    @media (min-width: 640px) { h1 { font-size: 30px; } }
    .subtitle { margin-top: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; color: var(--stone-500); word-break: break-all; }

    .status { display: flex; flex-wrap: wrap; gap: 8px; }
    .pill {
      display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px;
      border-radius: 9999px; border: 1px solid var(--stone-200); background: #fff;
      font-size: 12px; font-weight: 500; color: var(--stone-600); font-variant-numeric: tabular-nums; white-space: nowrap;
    }
    .dot { width: 8px; height: 8px; border-radius: 9999px; flex-shrink: 0; }
    .dot.green { background: var(--green-500); }
    .dot.sky { background: var(--sky-500); }

    .card { background: #fff; border: 1px solid var(--hairline); border-radius: 16px; box-shadow: var(--shadow-card); }
    .how-to { padding: 16px; margin-bottom: 32px; }
    @media (min-width: 640px) { .how-to { padding: 20px; } }
    .card-heading { display: flex; align-items: center; gap: 6px; font-size: 14px; font-weight: 600; color: var(--stone-700); margin-bottom: 14px; }
    .card-heading .icon { color: var(--stone-400); }
    .steps { list-style: none; display: grid; gap: 12px 24px; }
    @media (min-width: 640px) { .steps { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
    .step { display: flex; gap: 10px; align-items: flex-start; }
    .step-num {
      width: 24px; height: 24px; border-radius: 9999px; background: var(--slate-900); color: #fff;
      display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700;
      font-variant-numeric: tabular-nums; flex-shrink: 0; margin-top: 1px;
    }
    .step-text { font-size: 14px; color: var(--stone-600); }
    .step-text strong { color: var(--stone-900); font-weight: 600; }

    .section { margin-bottom: 32px; }
    .section-head {
      display: flex; align-items: center; gap: 6px; padding-bottom: 8px; margin-bottom: 16px;
      border-bottom: 1.5px solid var(--stone-800);
      font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--stone-800);
    }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 16px; }
    .role { padding: 16px; display: flex; flex-direction: column; align-items: center; text-align: center; }
    .role-head { display: flex; align-items: center; gap: 8px; align-self: stretch; }
    .role-icon {
      width: 36px; height: 36px; border-radius: 12px; display: flex; align-items: center; justify-content: center;
      background: var(--stone-50); border: 1px solid var(--hairline); color: var(--stone-700); flex-shrink: 0;
    }
    .role h3 { font-size: 14px; font-weight: 600; color: var(--stone-900); }
    .qr { margin-top: 14px; padding: 8px; border-radius: 12px; border: 1px solid var(--stone-200); background: #fff; }
    .qr svg { display: block; width: 140px; height: 140px; }
    .url { margin-top: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; color: var(--stone-500); word-break: break-all; }
    .url a:hover { color: var(--red-700); }

    .matches { padding: 4px 16px; }
    .match-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 12px 0; }
    .match-row + .match-row { border-top: 1px solid var(--stone-100); }
    .match-teams { font-size: 14px; font-weight: 600; color: var(--stone-900); min-width: 0; overflow-wrap: anywhere; }
    .match-time { font-size: 12px; color: var(--stone-500); font-variant-numeric: tabular-nums; white-space: nowrap; }

    .footer { margin-top: 8px; font-size: 12px; color: var(--stone-400); text-align: center; }
    .footer p { margin: 0; }
    .footer p + p { margin-top: 4px; }
    .footer a { text-decoration: underline; text-decoration-color: var(--stone-300); text-underline-offset: 2px; }
    a { color: inherit; text-decoration: none; }
    a:hover { text-decoration: underline; }
    a:focus-visible { outline: 2px solid rgb(248 113 113 / 0.6); outline-offset: 2px; border-radius: 4px; }
`

function roleCard(r) {
  const url = escapeHtml(r.url)
  return `
      <div class="card role">
        <div class="role-head">
          <span class="role-icon">${icon(r.icon, { size: 20 })}</span>
          <h3>${escapeHtml(r.label)}</h3>
        </div>
        <div class="qr">${r.svg}</div>
        <div class="url"><a href="${url}">${url}</a></div>
      </div>`
}

function section(title, iconName, roles) {
  return `
  <section class="section">
    <h2 class="section-head">${icon(iconName, { size: 14 })}${escapeHtml(title)}</h2>
    <div class="grid">${roles.map(roleCard).join('')}
    </div>
  </section>`
}

/**
 * @param {object} p
 * @param {string} p.baseUrl        http://<Host header>
 * @param {number} p.clientCount    open sockets
 * @param {number} p.matchCount     active matches
 * @param {Array}  p.indoor         INDOOR_ROLES + { url, svg } (svg: the QR code from `qrcode`)
 * @param {Array}  p.beach          BEACH_ROLES + { url, svg }
 * @param {Array}  p.matches        { home, away, updatedAt }
 * @param {(ts: number) => string} [p.formatTime]
 */
export function renderLandingPage({ baseUrl, clientCount, matchCount, indoor, beach, matches, formatTime = (ts) => new Date(ts).toLocaleTimeString() }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#e2001a">
  <title>OpenVolley Server</title>
  <style>${STYLE}  </style>
</head>
<body>
<main class="page">
  <header class="header">
    <div>
      <div class="title">${brandMark({ size: 32 })}<h1>OpenVolley server</h1></div>
      <p class="subtitle">${escapeHtml(baseUrl)}</p>
    </div>
    <div class="status">
      <span class="pill"><span class="dot green"></span>Server running</span>
      <span class="pill"><span class="dot sky"></span>${plural(clientCount, 'connected client', 'connected clients')}</span>
      <span class="pill"><span class="dot sky"></span>${plural(matchCount, 'active match', 'active matches')}</span>
    </div>
  </header>

  <div class="card how-to">
    <h2 class="card-heading">${icon('smartphone', { size: 16 })}How to connect</h2>
    <ol class="steps">
      <li class="step">
        <span class="step-num">1</span>
        <span class="step-text">Make sure all devices are on the <strong>same Wi-Fi network</strong></span>
      </li>
      <li class="step">
        <span class="step-num">2</span>
        <span class="step-text"><strong>Scan a QR code</strong> below with your phone camera to open the role</span>
      </li>
      <li class="step">
        <span class="step-num">3</span>
        <span class="step-text"><em>Optional:</em> Tap <strong>“Add to Home Screen”</strong> in your browser menu to install as an app</span>
      </li>
    </ol>
  </div>
${section('Indoor volleyball', 'volleyball', indoor)}
${section('Beach volleyball', 'tree-palm', beach)}
${matches.length > 0 ? `
  <section class="section">
    <h2 class="section-head">Active matches</h2>
    <div class="card matches">${matches.map((m) => `
      <div class="match-row">
        <span class="match-teams">${escapeHtml(m.home)} vs ${escapeHtml(m.away)}</span>
        <span class="match-time">${m.updatedAt ? escapeHtml(formatTime(m.updatedAt)) : ''}</span>
      </div>`).join('')}
    </div>
  </section>` : ''}

  <footer class="footer">
    <p>OpenVolley – open-source volleyball scoring</p>
    <p>${LEGAL_FOOTER}</p>
  </footer>
</main>
</body>
</html>`
}
