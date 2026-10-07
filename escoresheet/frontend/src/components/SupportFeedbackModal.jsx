import { useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from './Modal'
import { getCloudApiUrl } from '../utils/backendConfig'
import { openAppWindow } from '../utils/openAppWindow'
import { useScaledLayout } from '../hooks/useScaledLayout'
import { Check, Paperclip, Send, X } from 'lucide-react'
import { Button, cn, FOCUS_RING, IconButton, Select } from '../ui'

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

// Kit form recipes (svrz page form): form-tone label, h-11 controls, no
// asterisks (the submit check names missing fields), kit focus ring.
const LABEL_CLS = 'mb-1.5 block text-sm font-medium text-stone-700'
const CONTROL_CLS = 'w-full rounded-xl border border-stone-300 bg-white px-3 text-base text-stone-800 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-red-500'

function Dropdown({ label, value, onChange, options, placeholder, t, translationPrefix, required = false, scaleFactor = 1 }) {
  return (
    <label className="mb-4 block">
      <span className={LABEL_CLS}>{label}</span>
      <Select
        size="lg"
        block
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        required={required}
        className="border-stone-300 focus:border-stone-300 focus:ring-red-500"
      >
        <option value="">{placeholder}</option>
        {options.map(opt => (
          <option key={typeof opt === 'object' ? opt.value : opt} value={typeof opt === 'object' ? opt.value : opt}>
            {typeof opt === 'object'
              ? (translationPrefix ? t(`${translationPrefix}.${opt.label}`) : opt.label)
              : (translationPrefix ? t(`${translationPrefix}.${opt}`) : opt)
            }
          </option>
        ))}
      </Select>
    </label>
  )
}

function TextArea({ label, value, onChange, placeholder, rows = 4, required = false, scaleFactor = 1 }) {
  return (
    <label className="mb-4 block">
      <span className={LABEL_CLS}>{label}</span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        rows={rows}
        required={required}
        className={cn(CONTROL_CLS, 'resize-y py-2 leading-relaxed')}
      />
    </label>
  )
}

function TextInput({ label, value, onChange, placeholder, type = 'text', required = false, scaleFactor = 1 }) {
  return (
    <label className="mb-4 block">
      <span className={LABEL_CLS}>{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        required={required}
        className={cn(CONTROL_CLS, 'h-11')}
      />
    </label>
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
    <div className="mb-4">
      <div className={LABEL_CLS}>
        {label}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        onChange={handleFileSelect}
        aria-label={label}
        className="hidden"
        accept="image/*,.json,.txt,.log,.pdf,.csv"
      />
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        className={cn('inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-stone-300 bg-stone-50 px-4 text-sm font-medium text-stone-600 transition-colors hover:bg-stone-100', FOCUS_RING)}
      >
        <Paperclip size={16} aria-hidden="true" className="text-stone-400" />
        {t('supportFeedback.attachFiles')}
      </button>
      {files.length > 0 && (
        <div className="mt-2 divide-y divide-stone-100 rounded-lg border border-stone-200">
          {files.map((file, index) => (
            <div key={index} className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs text-stone-700">
              <span className="flex-1 truncate">
                {file.name} <span className="tabular-nums text-stone-500">({formatFileSize(file.size)})</span>
              </span>
              <button
                type="button"
                onClick={() => removeFile(index)}
                aria-label={`${t('common.remove', 'Remove')} ${file.name}`}
                title={`${t('common.remove', 'Remove')} ${file.name}`}
                className={cn('inline-flex h-8 w-8 shrink-0 items-center justify-center rounded text-stone-400 transition-colors hover:bg-red-50 hover:text-red-700', FOCUS_RING)}
              >
                <X size={14} aria-hidden="true" />
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

      const apiUrl = getCloudApiUrl('/api/contact')

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

        const mailto = `mailto:support@openvolley.app?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
        openAppWindow(mailto)
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

  const header = (title, tone) => (
    <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-stone-200/70 bg-white px-2 pb-3 sm:px-4">
      <h2 className={cn('text-lg font-bold', tone || 'text-stone-900')}>
        {title}
      </h2>
      <IconButton variant="close" icon={X} label={t('common.close', 'Close')} onClick={handleClose} />
    </div>
  )

  // Show success message
  if (sent) {
    const successMessage = contactType === 'support'
      ? t('supportFeedback.thankYouSupport')
      : contactType === 'feedback'
        ? t('supportFeedback.thankYouFeedback')
        : t('supportFeedback.thankYouRequest')

    return (
      <Modal open={true} title="" onClose={handleClose} width={450} hideCloseButton={true}>
        <div className="ov-kit">
          {header(t('supportFeedback.sent'), 'text-stone-900')}
          <div className="px-2 py-6 text-center sm:px-4">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-green-50 text-green-600">
              <Check size={26} strokeWidth={2.25} aria-hidden="true" />
            </div>
            <p className="mb-6 text-base text-stone-700">
              {successMessage}
            </p>
            <Button variant="dark" size="xl" onClick={handleClose} className="min-w-32 rounded-lg font-medium">
              {t('common.close')}
            </Button>
          </div>
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
      <div className="ov-kit">
      {/* Sticky Header */}
      {header(t('supportFeedback.title'))}

      {/* Content */}
      <div className="max-h-[calc(80vh-60px)] overflow-y-auto px-2 pt-4 pb-2 sm:px-4">
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
          <p role="alert" className="mb-4 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}

        {/* Submit Button */}
        {showComments && (
          <Button
            variant="primary"
            size="xl"
            block
            onClick={handleSubmit}
            disabled={sending}
            loading={sending}
            icon={Send}
          >
            {sending ? t('supportFeedback.sending') : t('supportFeedback.send')}
          </Button>
        )}
      </div>
      </div>
    </Modal>
  )
}
