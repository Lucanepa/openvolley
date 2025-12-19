import { useState, useEffect, useRef } from 'react'

export default function MenuList({
  items = [],
  position = 'right', // 'left' | 'right' | 'center'
  buttonLabel = 'Menu',
  buttonTitle = '',
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

    if (showMenu) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => {
        document.removeEventListener('mousedown', handleClickOutside)
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
          if (position === 'right') {
            menu.style.right = `${window.innerWidth - buttonRect.right}px`
            menu.style.left = 'auto'
            menu.style.top = `${buttonRect.bottom + 4}px`
          } else if (position === 'left') {
            menu.style.left = `${buttonRect.left}px`
            menu.style.right = 'auto'
            menu.style.top = `${buttonRect.bottom + 4}px`
          } else {
            // center
            menu.style.left = `${buttonRect.left + (buttonRect.width / 2)}px`
            menu.style.right = 'auto'
            menu.style.top = `${buttonRect.bottom + 4}px`
            menu.style.transform = 'translateX(-50%)'
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
  }, [showMenu, position])

  const getPositionStyle = () => {
    // Will be set dynamically via useEffect
    return {}
  }

  return (
    <div style={{ position: 'relative' }}>
      <button
        ref={buttonRef}
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
      
      {/* Menu List */}
      {showMenu && (
        <div
          ref={menuRef}
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            ...getPositionStyle(),
            background: 'rgb(0, 0, 0)',
            border: '1px solid rgba(255, 255, 255, 0.2)',
            borderRadius: '6px',
            padding: '8px',
            width: 'auto',
            minWidth: '200px',
            zIndex: 1000,
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)'
          }}
        >
          {items.map((item, index) => {
            if (item.separator) {
              return (
                <div
                  key={`separator-${index}`}
                  style={{
                    height: '1px',
                    background: 'rgba(255, 255, 255, 0.1)',
                    margin: '8px 0'
                  }}
                />
              )
            }

            return (
              <div
                key={item.key || index}
                onClick={() => {
                  if (item.onClick) {
                    item.onClick()
                  }
                  setShowMenu(false)
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '8px 12px',
                  marginBottom: index < items.length - 1 ? '4px' : '0',
                  fontSize: '13px',
                  background: 'rgba(255, 255, 255, 0.05)',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                  ...(item.style || {})
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'
                  e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.2)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'
                  e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)'
                }}
              >
                {item.icon && <span style={{ fontSize: '16px' }}>{item.icon}</span>}
                <span>{item.label}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
