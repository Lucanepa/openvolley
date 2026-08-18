/**
 * Local icon set.
 *
 * These replace the colour-bitmap emoji that used to stand in for UI icons.
 * Emoji are painted by the OS font, so they ignore `color`/`font-weight` and
 * look different on every platform; these are plain inline SVG that inherit
 * `currentColor` and scale with the `size` prop.
 *
 * Geometry is Lucide (https://lucide.dev, ISC) — 24x24 grid, stroke-width 2,
 * round caps/joins — inlined so the app takes on no new dependency.
 * The source icon name is noted above each component.
 *
 * Usage:
 *   <RefreshIcon />                     // 16px, inherits colour
 *   <TrashIcon size={13} />
 *   <VolleyballIcon size={20} style={{ color: '#f59e0b' }} />
 */

const Icon = ({ size = 16, strokeWidth = 2, style, children, ...rest }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
    // inline-block + middle keeps the icon on the same line as adjacent text;
    // inside a flex row it is blockified anyway, so one default covers both.
    style={{ display: 'inline-block', verticalAlign: 'middle', flexShrink: 0, ...style }}
    {...rest}
  >
    {children}
  </svg>
)

// lucide:refresh-cw
export const RefreshIcon = (props) => (
  <Icon {...props}>
    <path d="M3 12a9 9 0 0 1 9-9a9.75 9.75 0 0 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5m5 4a9 9 0 0 1-9 9a9.75 9.75 0 0 1-6.74-2.74L3 16" />
    <path d="M8 16H3v5" />
  </Icon>
)

// lucide:sun
export const SunIcon = (props) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32l1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
  </Icon>
)

// lucide:moon
export const MoonIcon = (props) => (
  <Icon {...props}>
    <path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401" />
  </Icon>
)

// lucide:database
export const DatabaseIcon = (props) => (
  <Icon {...props}>
    <ellipse cx="12" cy="5" rx="9" ry="3" />
    <path d="M3 5v14a9 3 0 0 0 18 0V5" />
    <path d="M3 12a9 3 0 0 0 18 0" />
  </Icon>
)

// lucide:satellite-dish
export const SatelliteDishIcon = (props) => (
  <Icon {...props}>
    <path d="M4 10a7.31 7.31 0 0 0 10 10Zm5 5l3-3m5 1a6 6 0 0 0-6-6m10 6A10 10 0 0 0 11 3" />
  </Icon>
)

// lucide:monitor
export const MonitorIcon = (props) => (
  <Icon {...props}>
    <rect width="20" height="14" x="2" y="3" rx="2" />
    <path d="M8 21h8m-4-4v4" />
  </Icon>
)

// lucide:trash-2
export const TrashIcon = (props) => (
  <Icon {...props}>
    <path d="M10 11v6m4-6v6m5-11v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </Icon>
)

// lucide:bell
export const BellIcon = (props) => (
  <Icon {...props}>
    <path d="M10.268 21a2 2 0 0 0 3.464 0m-10.47-5.674A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" />
  </Icon>
)

// lucide:search
export const SearchIcon = (props) => (
  <Icon {...props}>
    <path d="m21 21l-4.34-4.34" />
    <circle cx="11" cy="11" r="8" />
  </Icon>
)

// lucide:zoom-in
export const ZoomInIcon = (props) => (
  <Icon {...props}>
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21l-4.35-4.35M11 8v6m-3-3h6" />
  </Icon>
)

// lucide:house
export const HomeIcon = (props) => (
  <Icon {...props}>
    <path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" />
    <path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </Icon>
)

// lucide:file-text
export const FileTextIcon = (props) => (
  <Icon {...props}>
    <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
    <path d="M14 2v5a1 1 0 0 0 1 1h5M10 9H8m8 4H8m8 4H8" />
  </Icon>
)

// lucide:printer
export const PrinterIcon = (props) => (
  <Icon {...props}>
    <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6" />
    <rect width="12" height="8" x="6" y="14" rx="1" />
  </Icon>
)

// lucide:save
export const SaveIcon = (props) => (
  <Icon {...props}>
    <path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
    <path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7M7 3v4a1 1 0 0 0 1 1h7" />
  </Icon>
)

// lucide:download
export const DownloadIcon = (props) => (
  <Icon {...props}>
    <path d="M12 15V3m9 12v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="m7 10l5 5l5-5" />
  </Icon>
)

// lucide:settings
export const SettingsIcon = (props) => (
  <Icon {...props}>
    <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0a2.34 2.34 0 0 0 3.319 1.915a2.34 2.34 0 0 1 2.33 4.033a2.34 2.34 0 0 0 0 3.831a2.34 2.34 0 0 1-2.33 4.033a2.34 2.34 0 0 0-3.319 1.915a2.34 2.34 0 0 1-4.659 0a2.34 2.34 0 0 0-3.32-1.915a2.34 2.34 0 0 1-2.33-4.033a2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
    <circle cx="12" cy="12" r="3" />
  </Icon>
)

// lucide:triangle-alert
export const WarningIcon = (props) => (
  <Icon {...props}>
    <path d="m21.73 18l-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3M12 9v4m0 4h.01" />
  </Icon>
)

// lucide:timer
export const TimerIcon = (props) => (
  <Icon {...props}>
    <path d="M10 2h4m-2 12l3-3" />
    <circle cx="12" cy="14" r="8" />
  </Icon>
)

// lucide:volleyball
export const VolleyballIcon = (props) => (
  <Icon {...props}>
    <path d="M11 7a16 16 20 0 1 10.98 4.362M12 12a13 13 0 0 1-8.66 5m13.49-3.366a16 16 0 0 1-9.267 7.328" />
    <path d="M20.66 17A13 13 0 0 0 12 12a13 13 0 0 1 0-10M8.17 15.366a16 16 0 0 1-1.713-11.69" />
    <circle cx="12" cy="12" r="10" />
  </Icon>
)

// lucide:smartphone
export const PhoneIcon = (props) => (
  <Icon {...props}>
    <rect width="14" height="20" x="5" y="2" rx="2" ry="2" />
    <path d="M12 18h.01" />
  </Icon>
)

// lucide:tablet
export const TabletIcon = (props) => (
  <Icon {...props}>
    <rect width="16" height="20" x="4" y="2" rx="2" ry="2" />
    <path d="M12 18h.01" />
  </Icon>
)

// lucide:clipboard-list
export const ClipboardIcon = (props) => (
  <Icon {...props}>
    <rect width="8" height="4" x="8" y="2" rx="1" ry="1" />
    <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2m4 7h4m-4 5h4m-8-5h.01M8 16h.01" />
  </Icon>
)

// lucide:globe
export const GlobeIcon = (props) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 2a14.5 14.5 0 0 0 0 20a14.5 14.5 0 0 0 0-20M2 12h20" />
  </Icon>
)

// lucide:signal
export const SignalIcon = (props) => (
  <Icon {...props}>
    <path d="M2 20h.01M7 20v-4m5 4v-8m5 8V8m5-4v16" />
  </Icon>
)

// lucide:wrench
export const WrenchIcon = (props) => (
  <Icon {...props}>
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z" />
  </Icon>
)

// lucide:chart-bar
export const ChartIcon = (props) => (
  <Icon {...props}>
    <path d="M3 3v16a2 2 0 0 0 2 2h16M7 16h8m-8-5h12M7 6h3" />
  </Icon>
)

// lucide:notebook-pen
export const NotebookIcon = (props) => (
  <Icon {...props}>
    <path d="M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4M2 6h4m-4 4h4m-4 4h4m-4 4h4" />
    <path d="M21.378 5.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z" />
  </Icon>
)

// lucide:speech
export const SpeechIcon = (props) => (
  <Icon {...props}>
    <path d="M8.8 20v-4.1l1.9.2a2.3 2.3 0 0 0 2.164-2.1V8.3A5.37 5.37 0 0 0 2 8.25c0 2.8.656 3.054 1 4.55a5.8 5.8 0 0 1 .029 2.758L2 20m17.8-2.2a7.5 7.5 0 0 0 .003-10.603M17 15a3.5 3.5 0 0 0-.025-4.975" />
  </Icon>
)

// lucide:arrow-left-right
export const SwitchIcon = (props) => (
  <Icon {...props}>
    <path d="M8 3L4 7l4 4M4 7h16m-4 14l4-4l-4-4m4 4H4" />
  </Icon>
)

// lucide:rectangle-vertical, filled — a referee's card. Takes its colour from
// `currentColor`, so the caller decides yellow or red.
export const CardIcon = ({ size = 16, style, ...rest }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
    focusable="false"
    style={{ display: 'inline-block', verticalAlign: 'middle', flexShrink: 0, ...style }}
    {...rest}
  >
    <rect width="12" height="20" x="6" y="2" rx="2" fill="currentColor" />
  </svg>
)
