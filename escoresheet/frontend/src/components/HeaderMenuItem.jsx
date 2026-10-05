import { ChevronRight } from 'lucide-react'
import { cn } from '../ui/cn.js'
import { SwitchTrack } from '../ui/Switch.jsx'
import {
  MENU_ROW, MENU_ROW_ON, MENU_ROW_DANGER, MENU_INFO_ROW, MENU_ICON, MENU_COUNT, STATUS_TONES,
  itemTone, itemStatusTone
} from './chromeClasses'

/**
 * One row of the SimpleHeader / DashboardHeader dropdown.
 *
 * item: { icon, label, onClick, active, color, toggle, badge, disabled, keepOpen,
 *         submenu, info, status: { tone, word } }
 *
 * A row with nothing to do (`info`, or `disabled` without an onClick: the TEST
 * MODE flag, the Server / WebSocket / Database status) is drawn as a static
 * info row at full opacity in its 700/800 tone, with a dot and a word for a
 * status. The chosen row of a choice list (`active`) is inverted slate-900,
 * the same as the chosen language.
 */
export default function HeaderMenuItem({ item, onClose }) {
  if (item.info || (item.disabled && !item.onClick)) {
    const tone = STATUS_TONES[item.status?.tone || itemStatusTone(item.color)] || STATUS_TONES.neutral
    return (
      <div className={MENU_INFO_ROW}>
        {item.icon && <span className={cn(MENU_ICON, tone.text)}>{item.icon}</span>}
        <span className={cn('flex-1', item.status ? 'text-stone-700' : tone.text)}>{item.label}</span>
        {item.status && (
          <span className={cn('inline-flex shrink-0 items-center gap-1.5 text-xs font-semibold', tone.text)}>
            <span aria-hidden="true" className={cn('h-2 w-2 rounded-full', tone.dot)} />
            {item.status.word}
          </span>
        )}
      </div>
    )
  }

  const tone = itemTone(item.color)
  const danger = tone.className === 'text-red-600'
  const on = !!item.active

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        if (!item.disabled && item.onClick) {
          item.onClick()
        }
        if (!item.keepOpen) {
          onClose()
        }
      }}
      disabled={item.disabled}
      aria-pressed={item.active !== undefined ? on : undefined}
      className={cn(
        MENU_ROW,
        on ? MENU_ROW_ON : danger ? MENU_ROW_DANGER : tone.className
      )}
      style={on ? undefined : tone.style}
    >
      {item.icon && <span className={cn(MENU_ICON, on ? 'text-white' : (tone.className || 'text-stone-400'))}>{item.icon}</span>}
      <span className="flex-1">{item.label}</span>

      {/* Badge */}
      {item.badge && (
        <span className={MENU_COUNT}>
          {item.badge}
        </span>
      )}

      {/* Toggle switch: on/off that applies immediately (kit Switch look) */}
      {item.toggle !== undefined && (
        <SwitchTrack checked={!!item.toggle} className={item.toggle ? 'bg-emerald-500' : undefined} />
      )}

      {/* Submenu arrow */}
      {item.submenu && (
        <ChevronRight size={14} aria-hidden="true" className={on ? 'text-white' : 'text-stone-400'} />
      )}
    </button>
  )
}
