import { useState } from 'react'
import { useTranslation } from 'react-i18next'

export default function FAQItem({ questionKey, answerKey, helpId, tooltipKey, onShowMe }) {
  const { t } = useTranslation()
  const [isOpen, setIsOpen] = useState(false)

  return (
    <div style={{
      marginBottom: 8,
      borderRadius: 6,
      overflow: 'hidden',
      background: 'rgba(255,255,255,0.03)'
    }}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        style={{
          width: '100%',
          padding: '12px 14px',
          background: 'transparent',
          border: 'none',
          color: '#60a5fa',
          fontSize: 14,
          textAlign: 'left',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'flex-start',
          gap: 8
        }}
      >
        <span style={{ fontWeight: 700, color: '#3b82f6', flexShrink: 0 }}>Q:</span>
        <span style={{ flex: 1 }}>{t(questionKey)}</span>
        <span style={{ fontSize: 10, opacity: 0.6, flexShrink: 0 }}>{isOpen ? '\u2212' : '+'}</span>
      </button>
      {isOpen && (
        <div style={{
          padding: '0 14px 12px 30px',
          fontSize: 13,
          color: 'rgba(255,255,255,0.8)',
          lineHeight: 1.6,
          animation: 'fade-in 0.2s ease-out'
        }}>
          <span style={{ fontWeight: 600, color: '#22c55e' }}>A: </span>
          {t(answerKey)}

          {helpId && onShowMe && (
            <div style={{ marginTop: 10 }}>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onShowMe(helpId, tooltipKey)
                }}
                style={{
                  padding: '6px 12px',
                  background: 'rgba(59, 130, 246, 0.2)',
                  border: '1px solid rgba(59, 130, 246, 0.4)',
                  borderRadius: 6,
                  color: '#60a5fa',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  transition: 'all 0.2s'
                }}
              >
                <span style={{ fontSize: 14 }}>&#x1F4A1;</span>
                {t('contextHelp.showMe', 'Show me')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
