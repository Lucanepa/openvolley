import { useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from './Modal'
import { getApiUrl } from '../utils/backendConfig'

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

function Dropdown({ label, value, onChange, options, placeholder, t, translationPrefix, required = false }) {
  return (
    <div style={{ marginBottom: '16px' }}>
      <label style={{
        display: 'block',
        marginBottom: '6px',
        fontSize: '14px',
        fontWeight: 600,
        color: 'rgba(255,255,255,0.9)'
      }}>
        {label}{required && <span style={{ color: '#ef4444', marginLeft: '4px' }}>*</span>}
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: '100%',
          padding: '10px 12px',
          fontSize: '14px',
          background: 'rgba(255,255,255,0.1)',
          border: '1px solid rgba(255,255,255,0.2)',
          borderRadius: '8px',
          color: 'var(--text)',
          cursor: 'pointer',
          appearance: 'none',
          backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='white'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M19 9l-7 7-7-7'%3E%3C/path%3E%3C/svg%3E")`,
          backgroundRepeat: 'no-repeat',
          backgroundPosition: 'right 10px center',
          backgroundSize: '16px'
        }}
      >
        <option value="" style={{ background: '#1f2937' }}>{placeholder}</option>
        {options.map(opt => (
          <option key={typeof opt === 'object' ? opt.value : opt} value={typeof opt === 'object' ? opt.value : opt} style={{ background: '#1f2937' }}>
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

function TextArea({ label, value, onChange, placeholder, rows = 4, required = false }) {
  return (
    <div style={{ marginBottom: '16px' }}>
      <label style={{
        display: 'block',
        marginBottom: '6px',
        fontSize: '14px',
        fontWeight: 600,
        color: 'rgba(255,255,255,0.9)'
      }}>
        {label}{required && <span style={{ color: '#ef4444', marginLeft: '4px' }}>*</span>}
      </label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        style={{
          width: '100%',
          padding: '10px 12px',
          fontSize: '14px',
          background: 'rgba(255,255,255,0.1)',
          border: '1px solid rgba(255,255,255,0.2)',
          borderRadius: '8px',
          color: 'var(--text)',
          resize: 'vertical',
          fontFamily: 'inherit',
          boxSizing: 'border-box'
        }}
      />
    </div>
  )
}

function TextInput({ label, value, onChange, placeholder, type = 'text', required = false }) {
  return (
    <div style={{ marginBottom: '16px' }}>
      <label style={{
        display: 'block',
        marginBottom: '6px',
        fontSize: '14px',
        fontWeight: 600,
        color: 'rgba(255,255,255,0.9)'
      }}>
        {label}{required && <span style={{ color: '#ef4444', marginLeft: '4px' }}>*</span>}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          width: '100%',
          padding: '10px 12px',
          fontSize: '14px',
          background: 'rgba(255,255,255,0.1)',
          border: '1px solid rgba(255,255,255,0.2)',
          borderRadius: '8px',
          color: 'var(--text)',
          boxSizing: 'border-box'
        }}
      />
    </div>
  )
}

function FileAttachment({ label, files, onFilesChange, t }) {
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
    <div style={{ marginBottom: '16px' }}>
      <label style={{
        display: 'block',
        marginBottom: '6px',
        fontSize: '14px',
        fontWeight: 600,
        color: 'rgba(255,255,255,0.9)'
      }}>
        {label}
      </label>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        onChange={handleFileSelect}
        style={{ display: 'none' }}
        accept="image/*,.json,.txt,.log,.pdf,.csv"
      />
      <button
        onClick={() => fileInputRef.current?.click()}
        style={{
          padding: '10px 16px',
          fontSize: '14px',
          background: 'rgba(255,255,255,0.1)',
          border: '1px dashed rgba(255,255,255,0.3)',
          borderRadius: '8px',
          color: 'var(--text)',
          cursor: 'pointer',
          width: '100%',
          textAlign: 'center'
        }}
      >
        {t('supportFeedback.attachFiles')}
      </button>
      {files.length > 0 && (
        <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {files.map((file, index) => (
            <div key={index} style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '6px 10px',
              background: 'rgba(255,255,255,0.05)',
              borderRadius: '6px',
              fontSize: '12px'
            }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                {file.name} ({formatFileSize(file.size)})
              </span>
              <button
                onClick={() => removeFile(index)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#ef4444',
                  cursor: 'pointer',
                  padding: '2px 6px',
                  fontSize: '14px'
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
          background: '#1f2937',
          borderBottom: '1px solid rgba(255,255,255,0.1)',
          padding: '12px 24px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          zIndex: 10
        }}>
          <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 600, color: '#22c55e' }}>
            {t('supportFeedback.sent')}
          </h2>
          <button
            onClick={handleClose}
            style={{
              width: '32px',
              height: '32px',
              borderRadius: '6px',
              border: 'none',
              background: 'rgba(255,255,255,0.1)',
              color: 'var(--text)',
              fontSize: '18px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            ×
          </button>
        </div>
        <div style={{ padding: '24px', textAlign: 'center' }}>
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>✓</div>
          <p style={{ fontSize: '16px', color: 'rgba(255,255,255,0.9)', marginBottom: '24px' }}>
            {successMessage}
          </p>
          <button
            onClick={handleClose}
            style={{
              padding: '12px 24px',
              fontSize: '14px',
              fontWeight: 600,
              background: '#22c55e',
              color: '#fff',
              border: 'none',
              borderRadius: '8px',
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
        background: '#1f2937',
        borderBottom: '1px solid rgba(255,255,255,0.1)',
        padding: '12px 24px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        zIndex: 10
      }}>
        <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 600 }}>
          {t('supportFeedback.title')}
        </h2>
        <button
          onClick={handleClose}
          style={{
            width: '32px',
            height: '32px',
            borderRadius: '6px',
            border: 'none',
            background: 'rgba(255,255,255,0.1)',
            color: 'var(--text)',
            fontSize: '18px',
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
      <div style={{ padding: '24px', maxHeight: 'calc(80vh - 60px)', overflowY: 'auto' }}>
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
          />
        )}

        {/* File Attachment */}
        {showComments && (
          <FileAttachment
            label={t('supportFeedback.attachmentsLabel')}
            files={files}
            onFilesChange={setFiles}
            t={t}
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
          />
        )}

        {/* Error message */}
        {error && (
          <div style={{
            padding: '10px 12px',
            background: 'rgba(239, 68, 68, 0.2)',
            border: '1px solid rgba(239, 68, 68, 0.4)',
            borderRadius: '8px',
            color: '#ef4444',
            fontSize: '14px',
            marginBottom: '16px'
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
              padding: '14px 24px',
              fontSize: '16px',
              fontWeight: 600,
              background: sending ? 'rgba(34, 197, 94, 0.5)' : 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)',
              color: '#fff',
              border: 'none',
              borderRadius: '8px',
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
