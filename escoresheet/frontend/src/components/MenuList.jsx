import { useState, useEffect, useRef } from 'react'
import { MENU_PANEL, MENU_TITLE, MENU_SECTION, MENU_ROW, MENU_ROW_DANGER, MENU_SEP, MENU_ICON, itemTone } from './chromeClasses'
import { cn } from '../ui/cn.js'

/** Keys that move the focus between the rows of an open menu. */
const NAV_KEYS = ['ArrowDown', 'ArrowUp', 'Home', 'End']

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
 */
export default function MenuList({
  items = [],
  sections = null,
  columns = 1,
  position = 'right', // 'left' | 'right' | 'center'
  vertical = 'bottom', // 'bottom' | 'top' - whether menu opens above or below the button
  buttonLabel = 'Menu',
  buttonTitle = '',
  menuTitle = '',
  buttonStyle = {},
  buttonClassName = '',
  showArrow = true
}) {
  const [showMenu, setShowMenu] = useState(false)
  const menuRef = useRef(null)
  const buttonRef = useRef(null)
  // Opened from the keyboard (Enter / Space on the button): the first row takes the focus
  const openedByKeyRef = useRef(false)

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (showMenu && menuRef.current && !menuRef.current.contains(e.target) && 
          buttonRef.current && !buttonRef.current.contains(e.target)) {
        setShowMenu(false)
      }
    }

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        setShowMenu(false)
        if (menuRef.current?.contains(document.activeElement)) buttonRef.current?.focus()
        return
      }
      if (!NAV_KEYS.includes(e.key) || !menuRef.current) return
      const rows = [...menuRef.current.querySelectorAll('[role="menuitem"]:not([disabled])')]
      if (!rows.length) return
      e.preventDefault()
      const at = rows.indexOf(document.activeElement)
      let next = 0
      if (e.key === 'End') next = rows.length - 1
      else if (e.key === 'ArrowDown') next = at < 0 ? 0 : (at + 1) % rows.length
      else if (e.key === 'ArrowUp') next = at < 0 ? rows.length - 1 : (at - 1 + rows.length) % rows.length
      rows[next].focus()
    }

    if (showMenu) {
      document.addEventListener('mousedown', handleClickOutside)
      document.addEventListener('keydown', handleKeyDown)
      return () => {
        document.removeEventListener('mousedown', handleClickOutside)
        document.removeEventListener('keydown', handleKeyDown)
      }
    }
  }, [showMenu])

  // Position menu dynamically
  useEffect(() => {
    if (showMenu && buttonRef.current && menuRef.current) {
      const updatePosition = () => {
        const buttonRect = buttonRef.current.getBoundingClientRect()
        const menu = menuRef.current
        
        requestAnimationFrame(() => {
          // Horizontal positioning
          if (position === 'right') {
            menu.style.right = `${window.innerWidth - buttonRect.right}px`
            menu.style.left = 'auto'
          } else if (position === 'left') {
            menu.style.left = `${buttonRect.left}px`
            menu.style.right = 'auto'
          } else {
            // center
            menu.style.left = `${buttonRect.left + (buttonRect.width / 2)}px`
            menu.style.right = 'auto'
            menu.style.transform = 'translateX(-50%)'
          }

          // Vertical positioning
          if (vertical === 'top') {
            menu.style.bottom = `${window.innerHeight - buttonRect.top + 4}px`
            menu.style.top = 'auto'
          } else {
            menu.style.top = `${buttonRect.bottom + 4}px`
            menu.style.bottom = 'auto'
          }

          // Clamp to viewport bounds
          const MARGIN = 8
          const menuRect = menu.getBoundingClientRect()
          if (menuRect.right > window.innerWidth - MARGIN) {
            if (menu.style.left !== 'auto') {
              menu.style.left = `${parseFloat(menu.style.left) - (menuRect.right - (window.innerWidth - MARGIN))}px`
            } else {
              menu.style.right = `${parseFloat(menu.style.right) + (menuRect.right - (window.innerWidth - MARGIN))}px`
            }
          }
          if (menuRect.left < MARGIN) {
            menu.style.left = `${MARGIN}px`
            menu.style.right = 'auto'
          }
          if (menuRect.bottom > window.innerHeight - MARGIN) {
            menu.style.bottom = `${MARGIN}px`
            menu.style.top = 'auto'
          }
          if (menuRect.top < MARGIN) {
            menu.style.top = `${MARGIN}px`
            menu.style.bottom = 'auto'
          }
        })
      }

      updatePosition()
      window.addEventListener('scroll', updatePosition, true)
      window.addEventListener('resize', updatePosition)

      return () => {
        window.removeEventListener('scroll', updatePosition, true)
        window.removeEventListener('resize', updatePosition)
      }
    }
  }, [showMenu, position, vertical])

  // Opened with Enter / Space: put the focus on the first row, so the arrow keys work at once
  useEffect(() => {
    if (!showMenu || !openedByKeyRef.current) return
    openedByKeyRef.current = false
    menuRef.current?.querySelector('[role="menuitem"]:not([disabled])')?.focus()
  }, [showMenu])

  const getPositionStyle = () => {
    // Will be set dynamically via useEffect
    return {}
  }

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
          openedByKeyRef.current = !showMenu && e.detail === 0
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
      
      {/* Menu List: white anchored dropdown, 48 px rows (volleyui menu) */}
      {showMenu && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={menuTitle || undefined}
          onClick={(e) => e.stopPropagation()}
          className={cn('ov-kit fixed', MENU_PANEL, 'min-w-[220px] max-h-[calc(100vh-16px)] overflow-y-auto')}
          style={{ ...getPositionStyle(), zIndex: 1000 }}
        >
          {/* A grouped menu names its sections instead (the title stays its aria-label) */}
          {menuTitle && !sections && (
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
        </div>
      )}
    </div>
  )
}
