import { useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from './Modal'
import { getApiUrl } from '../utils/backendConfig'
import { useScaledLayout } from '../hooks/useScaledLayout'

const CONTACT_TYPES = ['support', 'feedback', 'request']

const AREAS = [
  'mainPage',
  'header',
  'options',
  'matchSetup',
  'coinToss',
  'scoreboard',
  'approval',
  'escoresheet',
  'refereeDashboard',
  'benchDashboard',
  'livescore',
  'uploadRoster'
]

const SUPPORT_TYPES = ['bug', 'help']

const SEVERITY_LEVELS = [
  { value: 1, label: 'severity1' },
  { value: 2, label: 'severity2' },
  { value: 3, label: 'severity3' },
  { value: 4, label: 'severity4' }
]

function Dropdown({ label, value, onChange, options, placeholder, t, translationPrefix, required = false, scaleFactor = 1 }) {
  return (
    <div style={{ marginBottom: `${Math.round(16 * scaleFactor)}px` }}>
      <label style={{
        display: 'block',
        marginBottom: `${Math.round(6 * scaleFactor)}px`,
        fontSize: `${Math.round(14 * scaleFactor)}px`,
        fontWeight: 600,
        color: 'var(--text)'
      }}>
        {label}{required && <span style={{ color: '#ef4444', marginLeft: `${Math.round(4 * scaleFactor)}px` }}>*</span>}
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        style={{
          width: '100%',
          padding: `${Math.round(10 * scaleFactor)}px ${Math.round(12 * scaleFactor)}px`,
          fontSize: `${Math.round(14 * scaleFactor)}px`,
          background: 'var(--panel)',
          border: '1px solid var(--border)',
          borderRadius: `${Math.round(8 * scaleFactor)}px`,
          color: 'var(--text)',
          cursor: 'pointer',
          appearance: 'none',
          backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='white'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M19 9l-7 7-7-7'%3E%3C/path%3E%3C/svg%3E")`,
          backgroundRepeat: 'no-repeat',
          backgroundPosition: `right ${Math.round(10 * scaleFactor)}px center`,
          backgroundSize: `${Math.round(16 * scaleFactor)}px`
        }}
      >
        <option value="" style={{ background: 'var(--panel)' }}>{placeholder}</option>
        {options.map(opt => (
          <option key={typeof opt === 'object' ? opt.value : opt} value={typeof opt === 'object' ? opt.value : opt} style={{ background: 'var(--panel)' }}>
            {typeof opt === 'object'
              ? (translationPrefix ? t(`${translationPrefix}.${opt.label}`) : opt.label)
              : (translationPrefix ? t(`${translationPrefix}.${opt}`) : opt)
            }
          </option>
        ))}
      </select>
    </div>
  )
}

function TextArea({ label, value, onChange, placeholder, rows = 4, required = false, scaleFactor = 1 }) {
  return (
    <div style={{ marginBottom: `${Math.round(16 * scaleFactor)}px` }}>
      <label style={{
        display: 'block',
        marginBottom: `${Math.round(6 * scaleFactor)}px`,
        fontSize: `${Math.round(14 * scaleFactor)}px`,
        fontWeight: 600,
        color: 'var(--text)'
      }}>
        {label}{required && <span style={{ color: '#ef4444', marginLeft: `${Math.round(4 * scaleFactor)}px` }}>*</span>}
      </label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        rows={rows}
        style={{
          width: '100%',
          padding: `${Math.round(10 * scaleFactor)}px ${Math.round(12 * scaleFactor)}px`,
          fontSize: `${Math.round(14 * scaleFactor)}px`,
          background: 'var(--panel)',
          border: '1px solid var(--border)',
          borderRadius: `${Math.round(8 * scaleFactor)}px`,
          color: 'var(--text)',
          resize: 'vertical',
          fontFamily: 'inherit',
          boxSizing: 'border-box'
        }}
      />
    </div>
  )
}

function TextInput({ label, value, onChange, placeholder, type = 'text', required = false, scaleFactor = 1 }) {
  return (
    <div style={{ marginBottom: `${Math.round(16 * scaleFactor)}px` }}>
      <label style={{
        display: 'block',
        marginBottom: `${Math.round(6 * scaleFactor)}px`,
        fontSize: `${Math.round(14 * scaleFactor)}px`,
        fontWeight: 600,
        color: 'var(--text)'
      }}>
        {label}{required && <span style={{ color: '#ef4444', marginLeft: `${Math.round(4 * scaleFactor)}px` }}>*</span>}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        style={{
          width: '100%',
          padding: `${Math.round(10 * scaleFactor)}px ${Math.round(12 * scaleFactor)}px`,
          fontSize: `${Math.round(14 * scaleFactor)}px`,
          background: 'var(--panel)',
          border: '1px solid var(--border)',
          borderRadius: `${Math.round(8 * scaleFactor)}px`,
          color: 'var(--text)',
          boxSizing: 'border-box'
        }}
      />
    </div>
  )
}

function FileAttachment({ label, files, onFilesChange, t, scaleFactor = 1 }) {
  const fileInputRef = useRef(null)

  const handleFileSelect = (e) => {
    const newFiles = Array.from(e.target.files)
    onFilesChange([...files, ...newFiles])
  }

  const removeFile = (index) => {
    const newFiles = files.filter((_, i) => i !== index)
    onFilesChange(newFiles)
  }

  const formatFileSize = (bytes) => {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  }

  return (
    <div style={{ marginBottom: `${Math.round(16 * scaleFactor)}px` }}>
      <label style={{
        display: 'block',
        marginBottom: `${Math.round(6 * scaleFactor)}px`,
        fontSize: `${Math.round(14 * scaleFactor)}px`,
        fontWeight: 600,
        color: 'var(--text)'
      }}>
        {label}
      </label>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        onChange={handleFileSelect}
        aria-label={label}
        style={{ display: 'none' }}
        accept="image/*,.json,.txt,.log,.pdf,.csv"
      />
      <button
        onClick={() => fileInputRef.current?.click()}
        style={{
          padding: `${Math.round(10 * scaleFactor)}px ${Math.round(16 * scaleFactor)}px`,
          fontSize: `${Math.round(14 * scaleFactor)}px`,
          background: 'var(--panel)',
          border: '1px dashed var(--border)',
          borderRadius: `${Math.round(8 * scaleFactor)}px`,
          color: 'var(--text)',
          cursor: 'pointer',
          width: '100%',
          textAlign: 'center'
        }}
      >
        {t('supportFeedback.attachFiles')}
      </button>
      {files.length > 0 && (
        <div style={{ marginTop: `${Math.round(8 * scaleFactor)}px`, display: 'flex', flexDirection: 'column', gap: `${Math.round(4 * scaleFactor)}px` }}>
          {files.map((file, index) => (
            <div key={index} style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: `${Math.round(6 * scaleFactor)}px ${Math.round(10 * scaleFactor)}px`,
              background: 'var(--panel-2)',
              borderRadius: `${Math.round(6 * scaleFactor)}px`,
              fontSize: `${Math.round(12 * scaleFactor)}px`
            }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                {file.name} ({formatFileSize(file.size)})
              </span>
              <button
                onClick={() => removeFile(index)}
                aria-label={`${t('common.remove', 'Remove')} ${file.name}`}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#ef4444',
                  cursor: 'pointer',
                  padding: `${Math.round(2 * scaleFactor)}px ${Math.round(6 * scaleFactor)}px`,
                  fontSize: `${Math.round(14 * scaleFactor)}px`
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function SupportFeedbackModal({ open, onClose, currentPage = 'mainPage' }) {
  const { t } = useTranslation()
  const { scaleFactor } = useScaledLayout()
  const [contactType, setContactType] = useState('')
  const [area, setArea] = useState(currentPage)
  const [supportType, setSupportType] = useState('')
  const [severity, setSeverity] = useState('')
  const [comments, setComments] = useState('')
  const [email, setEmail] = useState('')
  const [files, setFiles] = useState([])
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState(null)

  const resetForm = () => {
    setContactType('')
    setArea(currentPage)
    setSupportType('')
    setSeverity('')
    setComments('')
    setEmail('')
    setFiles([])
    setSent(false)
    setError(null)
  }

  const handleClose = () => {
    resetForm()
    onClose()
  }

  const handleSubmit = async () => {
    if (!contactType || !area || !email || !comments) {
      setError(t('supportFeedback.fillRequired'))
      return
    }

    if (contactType === 'support' && !supportType) {
      setError(t('supportFeedback.fillRequired'))
      return
    }

    if (contactType === 'support' && supportType === 'bug' && !severity) {
      setError(t('supportFeedback.fillRequired'))
      return
    }

    setSending(true)
    setError(null)

    try {
      // Prepare form data
      const formData = new FormData()
      formData.append('contactType', contactType)
      formData.append('area', area)
      formData.append('supportType', supportType)
      formData.append('severity', severity)
      formData.append('comments', comments)
      formData.append('email', email)
      formData.append('userAgent', navigator.userAgent)
      formData.append('url', window.location.href)
      formData.append('timestamp', new Date().toISOString())

      // Add files
      files.forEach((file, index) => {
        formData.append(`file_${index}`, file)
      })

      const apiUrl = getApiUrl('/api/contact')

      if (apiUrl) {
        const response = await fetch(apiUrl, {
          method: 'POST',
          body: formData
        })

        if (!response.ok) {
          throw new Error('Failed to send message')
        }
      } else {
        // Fallback: create mailto link with the data
        const subject = `[${contactType.toUpperCase()}] ${t(`supportFeedback.areas.${area}`)}${supportType ? ` - ${t(`supportFeedback.supportTypes.${supportType}`)}` : ''}`
        const body = `
Contact Type: ${t(`supportFeedback.types.${contactType}`)}
Area: ${t(`supportFeedback.areas.${area}`)}
${supportType ? `Support Type: ${t(`supportFeedback.supportTypes.${supportType}`)}\n` : ''}${severity ? `Severity: ${t(`supportFeedback.severities.severity${severity}`)}\n` : ''}
From: ${email}
URL: ${window.location.href}
User Agent: ${navigator.userAgent}

Comments:
${comments}

${files.length > 0 ? `\nNote: ${files.length} file(s) were selected but cannot be attached via mailto. Please reply to this email to receive them.` : ''}
`.trim()

        const mailto = `mailto:volleyball@lucanepa.com?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
        window.open(mailto, '_blank')
      }

      setSent(true)
    } catch (err) {
      console.error('Error sending feedback:', err)
      setError(t('supportFeedback.sendError'))
    } finally {
      setSending(false)
    }
  }

  if (!open) return null

  // Show success message
  if (sent) {
    const successMessage = contactType === 'support'
      ? t('supportFeedback.thankYouSupport')
      : contactType === 'feedback'
        ? t('supportFeedback.thankYouFeedback')
        : t('supportFeedback.thankYouRequest')

    return (
      <Modal open={true} title="" onClose={handleClose} width={450} hideCloseButton={true}>
        <div style={{
          position: 'sticky',
          top: 0,
          background: 'var(--panel)',
          borderBottom: '1px solid var(--border)',
          padding: `${Math.round(12 * scaleFactor)}px ${Math.round(24 * scaleFactor)}px`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          zIndex: 10
        }}>
          <h2 style={{ margin: 0, fontSize: `${Math.round(18 * scaleFactor)}px`, fontWeight: 600, color: '#22c55e' }}>
            {t('supportFeedback.sent')}
          </h2>
          <button
            onClick={handleClose}
            aria-label={t('common.close', 'Close')}
            style={{
              width: `${Math.round(32 * scaleFactor)}px`,
              height: `${Math.round(32 * scaleFactor)}px`,
              borderRadius: `${Math.round(6 * scaleFactor)}px`,
              border: 'none',
              background: 'var(--panel)',
              color: 'var(--text)',
              fontSize: `${Math.round(18 * scaleFactor)}px`,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            ×
          </button>
        </div>
        <div style={{ padding: `${Math.round(24 * scaleFactor)}px`, textAlign: 'center' }}>
          <div style={{ fontSize: `${Math.round(48 * scaleFactor)}px`, marginBottom: `${Math.round(16 * scaleFactor)}px` }}>✓</div>
          <p style={{ fontSize: `${Math.round(16 * scaleFactor)}px`, color: 'var(--text)', marginBottom: `${Math.round(24 * scaleFactor)}px` }}>
            {successMessage}
          </p>
          <button
            onClick={handleClose}
            style={{
              padding: `${Math.round(12 * scaleFactor)}px ${Math.round(24 * scaleFactor)}px`,
              fontSize: `${Math.round(14 * scaleFactor)}px`,
              fontWeight: 600,
              background: '#22c55e',
              color: '#fff',
              border: 'none',
              borderRadius: `${Math.round(8 * scaleFactor)}px`,
              cursor: 'pointer'
            }}
          >
            {t('common.close')}
          </button>
        </div>
      </Modal>
    )
  }

  // Show whether to display comments field
  const showComments = contactType && (
    contactType !== 'support' ||
    supportType === 'help' ||
    (supportType === 'bug' && severity)
  )

  return (
    <Modal open={true} title="" onClose={handleClose} width={450} hideCloseButton={true}>
      {/* Sticky Header */}
      <div style={{
        position: 'sticky',
        top: 0,
        background: 'var(--panel)',
        borderBottom: '1px solid var(--border)',
        padding: `${Math.round(12 * scaleFactor)}px ${Math.round(24 * scaleFactor)}px`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        zIndex: 10
      }}>
        <h2 style={{ margin: 0, fontSize: `${Math.round(18 * scaleFactor)}px`, fontWeight: 600 }}>
          {t('supportFeedback.title')}
        </h2>
        <button
          onClick={handleClose}
          aria-label={t('common.close', 'Close')}
          style={{
            width: `${Math.round(32 * scaleFactor)}px`,
            height: `${Math.round(32 * scaleFactor)}px`,
            borderRadius: `${Math.round(6 * scaleFactor)}px`,
            border: 'none',
            background: 'var(--panel)',
            color: 'var(--text)',
            fontSize: `${Math.round(18 * scaleFactor)}px`,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          ×
        </button>
      </div>

      {/* Content */}
      <div style={{ padding: `${Math.round(24 * scaleFactor)}px`, maxHeight: `calc(80vh - ${Math.round(60 * scaleFactor)}px)`, overflowY: 'auto' }}>
        {/* Contact Type */}
        <Dropdown
          label={t('supportFeedback.contactTypeLabel')}
          value={contactType}
          onChange={setContactType}
          options={CONTACT_TYPES}
          placeholder={t('supportFeedback.selectType')}
          t={t}
          translationPrefix="supportFeedback.types"
          required={true}
          scaleFactor={scaleFactor}
        />

        {/* Area (only after type is selected) */}
        {contactType && (
          <Dropdown
            label={t('supportFeedback.areaLabel')}
            value={area}
            onChange={setArea}
            options={AREAS}
            placeholder={t('supportFeedback.selectArea')}
            t={t}
            translationPrefix="supportFeedback.areas"
            required={true}
            scaleFactor={scaleFactor}
          />
        )}

        {/* Support Type (only for support, after area is selected) */}
        {contactType === 'support' && area && (
          <Dropdown
            label={t('supportFeedback.supportTypeLabel')}
            value={supportType}
            onChange={setSupportType}
            options={SUPPORT_TYPES}
            placeholder={t('supportFeedback.selectSupportType')}
            t={t}
            translationPrefix="supportFeedback.supportTypes"
            required={true}
            scaleFactor={scaleFactor}
          />
        )}

        {/* Severity (only for support -> bug) */}
        {contactType === 'support' && supportType === 'bug' && (
          <Dropdown
            label={t('supportFeedback.severityLabel')}
            value={severity}
            onChange={setSeverity}
            options={SEVERITY_LEVELS}
            placeholder={t('supportFeedback.selectSeverity')}
            t={t}
            translationPrefix="supportFeedback.severities"
            required={true}
            scaleFactor={scaleFactor}
          />
        )}

        {/* Comments */}
        {showComments && (
          <TextArea
            label={t('supportFeedback.commentsLabel')}
            value={comments}
            onChange={setComments}
            placeholder={t('supportFeedback.commentsPlaceholder')}
            rows={5}
            required={true}
            scaleFactor={scaleFactor}
          />
        )}

        {/* File Attachment */}
        {showComments && (
          <FileAttachment
            label={t('supportFeedback.attachmentsLabel')}
            files={files}
            onFilesChange={setFiles}
            t={t}
            scaleFactor={scaleFactor}
          />
        )}

        {/* Email */}
        {showComments && (
          <TextInput
            label={t('supportFeedback.emailLabel')}
            value={email}
            onChange={setEmail}
            placeholder={t('supportFeedback.emailPlaceholder')}
            type="email"
            required={true}
            scaleFactor={scaleFactor}
          />
        )}

        {/* Error message */}
        {error && (
          <div style={{
            padding: `${Math.round(10 * scaleFactor)}px ${Math.round(12 * scaleFactor)}px`,
            background: 'rgba(239, 68, 68, 0.2)',
            border: '1px solid rgba(239, 68, 68, 0.4)',
            borderRadius: `${Math.round(8 * scaleFactor)}px`,
            color: '#ef4444',
            fontSize: `${Math.round(14 * scaleFactor)}px`,
            marginBottom: `${Math.round(16 * scaleFactor)}px`
          }}>
            {error}
          </div>
        )}

        {/* Submit Button */}
        {showComments && (
          <button
            onClick={handleSubmit}
            disabled={sending}
            style={{
              width: '100%',
              padding: `${Math.round(14 * scaleFactor)}px ${Math.round(24 * scaleFactor)}px`,
              fontSize: `${Math.round(16 * scaleFactor)}px`,
              fontWeight: 600,
              background: sending ? 'rgba(34, 197, 94, 0.5)' : 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)',
              color: '#fff',
              border: 'none',
              borderRadius: `${Math.round(8 * scaleFactor)}px`,
              cursor: sending ? 'not-allowed' : 'pointer',
              transition: 'transform 0.2s, box-shadow 0.2s'
            }}
          >
            {sending ? t('supportFeedback.sending') : t('supportFeedback.send')}
          </button>
        )}
      </div>
    </Modal>
  )
}
