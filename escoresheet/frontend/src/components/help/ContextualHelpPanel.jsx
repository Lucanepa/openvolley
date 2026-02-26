import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import FAQItem from './FAQItem'
import { helpContent } from './helpContent'

const pageNames = {
  home: 'contextHelp.pageNames.home',
  matchSetup: 'contextHelp.pageNames.matchSetup',
  coinToss: 'contextHelp.pageNames.coinToss',
  scoreboard: 'contextHelp.pageNames.scoreboard',
  matchEnd: 'contextHelp.pageNames.matchEnd',
  manualAdjustments: 'contextHelp.pageNames.manualAdjustments'
}

export default function ContextualHelpPanel({ open, onClose, currentPage, onShowMe }) {
  const { t } = useTranslation()

  const items = helpContent[currentPage] || []
  const pageName = pageNames[currentPage] ? t(pageNames[currentPage]) : currentPage

  // ESC to close
  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  return (
    <>
      {/* Backdrop - only on narrow screens to dismiss */}
      {open && (
        <div
          onClick={onClose}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1000,
            background: 'rgba(0,0,0,0.3)',
            display: window.innerWidth < 500 ? 'block' : 'none'
          }}
        />
      )}

      {/* Panel */}
      <div style={{
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        width: window.innerWidth < 500 ? '100%' : 340,
        zIndex: 1001,
        background: 'rgba(17, 24, 39, 0.97)',
        borderLeft: '1px solid rgba(255,255,255,0.1)',
        transform: open ? 'translateX(0)' : 'translateX(100%)',
        transition: 'transform 0.3s ease-out',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: open ? '-8px 0 32px rgba(0,0,0,0.4)' : 'none'
      }}>
        {/* Header */}
        <div style={{
          padding: '16px 18px',
          borderBottom: '1px solid rgba(255,255,255,0.1)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexShrink: 0
        }}>
          <div>
            <div style={{
              fontSize: 16,
              fontWeight: 700,
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              gap: 8
            }}>
              <span style={{ fontSize: 18 }}>&#x2753;</span>
              {t('contextHelp.helpButton', 'Help')}
            </div>
            <div style={{
              fontSize: 12,
              color: 'rgba(255,255,255,0.5)',
              marginTop: 2
            }}>
              {pageName}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              width: 32,
              height: 32,
              borderRadius: 6,
              background: 'rgba(255,255,255,0.08)',
              border: '1px solid rgba(255,255,255,0.1)',
              color: 'rgba(255,255,255,0.6)',
              fontSize: 16,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            &#x2715;
          </button>
        </div>

        {/* FAQ List */}
        <div style={{
          flex: 1,
          overflowY: 'auto',
          padding: '12px 14px'
        }}>
          {items.length > 0 ? (
            items.map((item, i) => (
              <FAQItem
                key={i}
                questionKey={item.questionKey}
                answerKey={item.answerKey}
                helpId={item.helpId}
                tooltipKey={item.tooltipKey}
                onShowMe={onShowMe}
              />
            ))
          ) : (
            <div style={{
              textAlign: 'center',
              padding: 30,
              color: 'rgba(255,255,255,0.4)',
              fontSize: 13
            }}>
              {t('contextHelp.noHelp', 'No help available for this page.')}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '12px 18px',
          borderTop: '1px solid rgba(255,255,255,0.08)',
          fontSize: 11,
          color: 'rgba(255,255,255,0.3)',
          textAlign: 'center',
          flexShrink: 0
        }}>
          OpenVolley eScoresheet
        </div>
      </div>
    </>
  )
}
