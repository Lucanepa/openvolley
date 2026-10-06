/**
 * Local icon names.
 *
 * These replace the colour-bitmap emoji that used to stand in for UI icons.
 * Emoji are painted by the OS font, so they ignore `color`/`font-weight` and
 * look different on every platform; these inherit `currentColor` and scale
 * with the `size` prop.
 *
 * The icons come from the same packs as wiedisync: lucide-react
 * (https://lucide.dev, ISC) for UI glyphs, @phosphor-icons/react
 * (https://phosphoricons.com, MIT) for the volleyball. This file only keeps
 * the app's names and defaults (16px, inline next to text, aria-hidden), so
 * the call sites did not have to change. New code can import from
 * 'lucide-react' directly.
 *
 * Usage:
 *   <RefreshIcon />                     // 16px, inherits colour
 *   <TrashIcon size={13} />
 *   <VolleyballIcon size={20} style={{ color: '#f59e0b' }} />
 */
import {
  RefreshCw,
  Sun,
  Moon,
  Database,
  SatelliteDish,
  Monitor,
  Trash2,
  Bell,
  Search,
  ZoomIn,
  House,
  FileText,
  Printer,
  Save,
  Download,
  Settings,
  TriangleAlert,
  Timer,
  Smartphone,
  Tablet,
  ClipboardList,
  Globe,
  Signal,
  Wrench,
  ChartBar,
  NotebookPen,
  Speech,
  ArrowLeftRight,
  RectangleVertical
} from 'lucide-react'
import { Volleyball } from '@phosphor-icons/react'

// inline-block + middle keeps the icon on the same line as adjacent text;
// inside a flex row it is blockified anyway, so one default covers both.
const INLINE = { display: 'inline-block', verticalAlign: 'middle', flexShrink: 0 }

function lucide(LucideIcon, name) {
  const Wrapped = ({ size = 16, style, ...rest }) => (
    <LucideIcon size={size} aria-hidden="true" focusable="false" style={{ ...INLINE, ...style }} {...rest} />
  )
  Wrapped.displayName = name
  return Wrapped
}

export const RefreshIcon = lucide(RefreshCw, 'RefreshIcon')
export const SunIcon = lucide(Sun, 'SunIcon')
export const MoonIcon = lucide(Moon, 'MoonIcon')
export const DatabaseIcon = lucide(Database, 'DatabaseIcon')
export const SatelliteDishIcon = lucide(SatelliteDish, 'SatelliteDishIcon')
export const MonitorIcon = lucide(Monitor, 'MonitorIcon')
export const TrashIcon = lucide(Trash2, 'TrashIcon')
export const BellIcon = lucide(Bell, 'BellIcon')
export const SearchIcon = lucide(Search, 'SearchIcon')
export const ZoomInIcon = lucide(ZoomIn, 'ZoomInIcon')
export const HomeIcon = lucide(House, 'HomeIcon')
export const FileTextIcon = lucide(FileText, 'FileTextIcon')
export const PrinterIcon = lucide(Printer, 'PrinterIcon')
export const SaveIcon = lucide(Save, 'SaveIcon')
export const DownloadIcon = lucide(Download, 'DownloadIcon')
export const SettingsIcon = lucide(Settings, 'SettingsIcon')
export const WarningIcon = lucide(TriangleAlert, 'WarningIcon')
export const TimerIcon = lucide(Timer, 'TimerIcon')
export const PhoneIcon = lucide(Smartphone, 'PhoneIcon')
export const TabletIcon = lucide(Tablet, 'TabletIcon')
export const ClipboardIcon = lucide(ClipboardList, 'ClipboardIcon')
export const GlobeIcon = lucide(Globe, 'GlobeIcon')
export const SignalIcon = lucide(Signal, 'SignalIcon')
export const WrenchIcon = lucide(Wrench, 'WrenchIcon')
export const ChartIcon = lucide(ChartBar, 'ChartIcon')
export const NotebookIcon = lucide(NotebookPen, 'NotebookIcon')
export const SpeechIcon = lucide(Speech, 'SpeechIcon')
export const SwitchIcon = lucide(ArrowLeftRight, 'SwitchIcon')

// lucide:rectangle-vertical, filled and without the outline: a referee's card.
// Takes its colour from `currentColor`, so the caller decides yellow or red.
export const CardIcon = ({ size = 16, style, ...rest }) => (
  <RectangleVertical
    size={size}
    fill="currentColor"
    stroke="none"
    aria-hidden="true"
    focusable="false"
    style={{ ...INLINE, ...style }}
    {...rest}
  />
)

// phosphor:volleyball, as wiedisync's VolleyballIcon (src/components/VolleyballIcon.tsx):
// regular weight in currentColor, or the filled gold ball with `filled`.
export const VolleyballIcon = ({ size = 16, filled = false, style, ...rest }) => (
  <Volleyball
    size={size}
    weight={filled ? 'fill' : 'regular'}
    color={filled ? '#FFC832' : 'currentColor'}
    aria-hidden="true"
    focusable="false"
    style={{ ...INLINE, ...style }}
    {...rest}
  />
)
