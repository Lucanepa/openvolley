import { useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { MENU_TITLE, MENU_SECTION, MENU_ROW, MENU_ROW_DANGER, MENU_SEP, MENU_ICON, itemTone } from './chromeClasses'
import { cn } from '../ui/cn.js'
import { MenuPopover } from '../ui/MenuPopover.jsx'
import { useMenusAsModal } from '../ui/menuLayout.js'

/**
 * A toolbar dropdown.
 *
 * Either a flat `items` list ({ key, icon, label, onClick, style, danger },
 * { separator: true } or { header: 'Title' }), or `sections`: labelled groups
 * ({ key, title, danger, column, items }) laid out in `columns` (1 or 2)
 * columns (one column on a narrow screen). A section with `danger` sits apart under a
 * hairline and wears the destructive tone (the "End of match" group).
 * Arrow keys / Home / End move between rows, Escape closes and gives the
 * focus back to the button.
 *
 * The panel is the app's MenuPopover (ui/MenuPopover.jsx): a popover under
 * (or, without room, over) the button that never leaves the window, and a
 * centred modal on phones and small tablets.
 */
export default function MenuList({
  items = [],
  sections = null,
  columns = 1,
  position = 'right', // 'left' | 'right' | 'center'
  vertical = 'bottom', // 'bottom' | 'top' - the side the menu prefers (it takes the other one when that has more room)
  buttonLabel = 'Menu',
  buttonTitle = '',
  menuTitle = '',
  buttonStyle = {},
  buttonClassName = '',
  showArrow = true
}) {
  const { t } = useTranslation()
  const [showMenu, setShowMenu] = useState(false)
  const buttonRef = useRef(null)
  // Opened from the keyboard (Enter / Space on the button): the first row takes the focus
  const [openedByKey, setOpenedByKey] = useState(false)
  // As a modal the menu's name is the modal's title
  const asModal = useMenusAsModal()

  const renderRow = (item, index) => {
    // Callers colour a row through item.style (e.g. red "Stop the Match") or
    // item.danger; a known legacy hex becomes the kit tone, anything else stays inline.
    const { color, ...itemStyle } = item.style || {}
    const tone = itemTone(color)
    const danger = item.danger || tone.className === 'text-red-600'

    return (
      <button
        type="button"
        role="menuitem"
        key={item.key || index}
        onClick={() => {
          if (item.onClick) {
            item.onClick()
          }
          setShowMenu(false)
        }}
        className={cn(MENU_ROW, danger ? MENU_ROW_DANGER : tone.className)}
        style={{ ...itemStyle, ...(danger ? {} : (tone.style || {})) }}
      >
        {item.icon && <span className={cn(MENU_ICON, danger && 'text-red-500')} aria-hidden="true">{item.icon}</span>}
        <span className="min-w-0 flex-1">{item.label}</span>
      </button>
    )
  }

  const renderSection = (section) => {
    const titleId = `menu-section-${section.key}`
    return (
      <div
        key={section.key}
        role="group"
        aria-labelledby={section.title ? titleId : undefined}
        data-menu-section={section.key}
        className={cn('flex flex-col', section.danger && 'mt-1 border-t border-stone-100 pt-1')}
      >
        {section.title && (
          <div id={titleId} className={cn(MENU_SECTION, section.danger && 'text-red-600')}>
            {section.title}
          </div>
        )}
        {section.items.map(renderRow)}
      </div>
    )
  }

  const renderSections = () => {
    if (columns <= 1) return sections.map(renderSection)
    // Sections go to their `column` (0-based); the danger section closes the
    // last column. One column on a narrow screen.
    const cols = Array.from({ length: columns }, () => [])
    sections.forEach((section) => {
      const c = Math.min(columns - 1, Math.max(0, section.column ?? 0))
      cols[c].push(section)
    })
    return (
      <div className="grid grid-cols-1 gap-x-1.5 min-[600px]:grid-cols-2">
        {cols.map((list, i) => (
          <div key={i} className={cn('flex min-w-[240px] flex-col', i > 0 && 'min-[600px]:border-l min-[600px]:border-stone-100 min-[600px]:pl-1.5')}>
            {list.map(renderSection)}
          </div>
        ))}
      </div>
    )
  }

  const name = menuTitle || buttonTitle || (typeof buttonLabel === 'string' ? buttonLabel : '')

  return (
    <div style={{ position: 'relative' }}>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={showMenu}
        className={buttonClassName}
        title={buttonTitle || undefined}
        onClick={(e) => {
          e.stopPropagation()
          // detail === 0: a click synthesised by Enter / Space, not a pointer
          setOpenedByKey(!showMenu && e.detail === 0)
          setShowMenu(!showMenu)
        }}
        style={{
          ...buttonStyle,
          cursor: 'pointer',
          transition: 'all 0.2s'
        }}
        onMouseEnter={(e) => {
          if (buttonStyle.background) {
            e.currentTarget.style.opacity = '0.9'
          }
        }}
        onMouseLeave={(e) => {
          if (buttonStyle.background) {
            e.currentTarget.style.opacity = '1'
          }
        }}
      >
        {buttonLabel}
        {showArrow && (
          <span style={{ marginLeft: '6px', fontSize: '10px' }}>
            {showMenu ? '▲' : '▼'}
          </span>
        )}
      </button>

      {/* Menu List: white anchored dropdown, 48 px rows (volleyui menu); a centred modal on small screens */}
      <MenuPopover
        open={showMenu}
        onClose={() => setShowMenu(false)}
        anchorRef={buttonRef}
        label={name || undefined}
        title={name || undefined}
        align={position === 'left' ? 'start' : position === 'center' ? 'center' : 'end'}
        side={vertical === 'top' ? 'top' : 'bottom'}
        autoFocus={openedByKey}
        modalSize={sections && columns > 1 ? 'lg' : 'sm'}
        closeLabel={t('common.close', 'Close')}
        className="min-w-[220px]"
      >
        {/* A grouped menu names its sections instead (the title stays its aria-label) */}
        {menuTitle && !sections && !asModal && (
          <div className={MENU_TITLE}>
            {menuTitle}
          </div>
        )}
        {sections ? renderSections() : items.map((item, index) => {
          if (item.separator) {
            return <div key={`separator-${index}`} role="separator" className={MENU_SEP} />
          }
          if (item.header) {
            return <div key={`header-${index}`} className={MENU_SECTION}>{item.header}</div>
          }
          return renderRow(item, index)
        })}
      </MenuPopover>
    </div>
  )
}
