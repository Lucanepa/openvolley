import { useState, useEffect, useRef } from 'react'
import { MENU_PANEL, MENU_TITLE, MENU_ROW, MENU_ROW_DANGER, MENU_SEP, MENU_ICON, itemTone } from './chromeClasses'
import { cn } from '../ui/cn.js'

export default function MenuList({
  items = [],
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

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (showMenu && menuRef.current && !menuRef.current.contains(e.target) && 
          buttonRef.current && !buttonRef.current.contains(e.target)) {
        setShowMenu(false)
      }
    }

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') setShowMenu(false)
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

  const getPositionStyle = () => {
    // Will be set dynamically via useEffect
    return {}
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
          {menuTitle && (
            <div className={MENU_TITLE}>
              {menuTitle}
            </div>
          )}
          {items.map((item, index) => {
            if (item.separator) {
              return <div key={`separator-${index}`} role="separator" className={MENU_SEP} />
            }

            // Callers colour a row through item.style (e.g. red "Stop the Match");
            // a known legacy hex becomes the kit tone, anything else stays inline.
            const { color, ...itemStyle } = item.style || {}
            const tone = itemTone(color)
            const danger = tone.className === 'text-red-600'

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
                style={{ ...itemStyle, ...(tone.style || {}) }}
              >
                {item.icon && <span className={cn(MENU_ICON, danger && 'text-red-500')} aria-hidden="true">{item.icon}</span>}
                <span className="min-w-0 flex-1">{item.label}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
