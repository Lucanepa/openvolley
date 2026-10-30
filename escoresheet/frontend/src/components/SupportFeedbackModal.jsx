import { useState, useRef, useEffect, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from './Modal'
import { getCloudApiUrl } from '../utils/backendConfig'
import { getLiveMatch, onLiveMatchChange } from '../utils/appLifecycle'
import { openAppWindow } from '../utils/openAppWindow'
import { useScaledLayout } from '../hooks/useScaledLayout'
import { Check, ChevronDown, Download, Mail, Paperclip, Send, X } from 'lucide-react'
import { Button, Checkbox, cn, FOCUS_RING, IconButton, Select } from '../ui'
import {
  CONTACT_AREAS, FILE_ACCEPT, MAX_FILES, MAX_FILES_MB, buildContactForm, checkFiles, collectDiagnostics,
  contactAreaOf, contactMailto, downloadDiagnosticsFile, isContactEmail, isScoringMatchHere
} from '../utils/supportContact'

const CONTACT_TYPES = ['support', 'feedback', 'request']

// The help's section ids (utils/supportContact.js) and 'other'
const AREAS = CONTACT_AREAS

const SUPPORT_TYPES = ['bug', 'help']

const SEVERITY_LEVELS = [
  { value: 1, label: 'severity1' },
  { value: 2, label: 'severity2' },
  { value: 3, label: 'severity3' },
  { value: 4, label: 'severity4' }
]

// Kit form recipes (svrz page form): form-tone label, h-11 controls, no
// asterisks (the submit check names missing fields), kit focus ring.
// The legacy Modal's panel as a flex column: the header stays put and only the
// content scrolls (one scroller, no 80vh guess inside the panel's 85vh)
const ONE_SCROLLER = { display: 'flex', flexDirection: 'column', overflow: 'hidden' }
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

// Picked files are checked at once (count, size, kind: checkFiles); a refused
// pick keeps the files chosen before and says why.
function FileAttachment({ label, files, onFilesChange, onReject, t, scaleFactor = 1 }) {
  const fileInputRef = useRef(null)

  const handleFileSelect = (e) => {
    const newFiles = Array.from(e.target.files || [])
    // the same file can be picked again after removing it
    e.target.value = ''
    if (newFiles.length === 0) return
    const next = [...files, ...newFiles]
    const problem = checkFiles(next)
    if (problem) {
      onReject(problem)
      return
    }
    onReject(null)
    onFilesChange(next)
  }

  const removeFile = (index) => {
    const newFiles = files.filter((_, i) => i !== index)
    onReject(null)
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
        accept={FILE_ACCEPT}
      />
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        disabled={files.length >= MAX_FILES}
        className={cn('inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-stone-300 bg-stone-50 px-4 text-sm font-medium text-stone-600 transition-colors hover:bg-stone-100 disabled:cursor-default disabled:opacity-50', FOCUS_RING)}
      >
        <Paperclip size={16} aria-hidden="true" className="text-stone-400" />
        {t('supportFeedback.attachFiles')}
      </button>
      <p className="mt-1 text-xs text-stone-500">{t('supportFeedback.attachmentsHint', { max: MAX_FILES, mb: MAX_FILES_MB })}</p>
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

// The answer codes of POST /api/contact the user can fix in the form
const FIXABLE = new Set(['invalid_email', 'too_many_files', 'files_too_large', 'file_type'])

// "Include diagnostics" starts ticked for these contact types (a bug report
// and a question); feedback and requests start unticked
const DIAGNOSTICS_BY_DEFAULT = new Set(['support'])

function sizeText(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** The diagnostics report of this device now (utils/diagnosticsCollect, loaded when needed). */
async function makeReport(opts) {
  const { createDiagnosticsReport } = await import('../utils/diagnosticsCollect')
  return createDiagnosticsReport(opts)
}

/**
 * Support & feedback: sends the message with its attachments to the support
 * mailbox (POST /api/contact; utils/supportContact.js), or opens a mailto
 * without a backend, offline, or when sending failed.
 *
 * @param {object} props
 * @param {string} [props.area]        a help section id ('scoring', ...): the "?" panel passes its screen's
 * @param {string} [props.currentPage] older area / page names ('mainPage', 'options', 'scoreboard', ...), mapped
 * @param {string|number|null} [props.gameNumber] the match the diagnostics name (default: the open match)
 * @param {(opts: object) => Promise<object>} [props.createReport] the diagnostics report (tests)
 */
export default function SupportFeedbackModal({ open, onClose, area: areaProp, currentPage = 'mainPage', gameNumber, createReport = makeReport }) {
  const { t, i18n } = useTranslation()
  const { scaleFactor } = useScaledLayout()
  const initialArea = contactAreaOf(areaProp) || contactAreaOf(currentPage)
  const [contactType, setContactType] = useState('')
  const [area, setArea] = useState(initialArea)
  const [supportType, setSupportType] = useState('')
  const [severity, setSeverity] = useState('')
  const [comments, setComments] = useState('')
  const [email, setEmail] = useState('')
  const [files, setFiles] = useState([])
  // "A match is running right now" (the backend makes it P1): ticked by
  // itself while this device scores an official match in progress, and it
  // follows that until the user ticks or unticks it
  const liveMatch = useSyncExternalStore(onLiveMatchChange, getLiveMatch, getLiveMatch)
  const scoringHere = isScoringMatchHere(liveMatch)
  const [matchRunning, setMatchRunning] = useState(scoringHere)
  const [matchRunningSetByUser, setMatchRunningSetByUser] = useState(false)
  // "Include diagnostics": ticked by itself for support, unticked for
  // feedback and requests, until the user ticks or unticks it
  const [includeDiagnostics, setIncludeDiagnostics] = useState(false)
  const [diagnosticsSetByUser, setDiagnosticsSetByUser] = useState(false)
  // What "Show what is sent" shows is what is sent: one report, made when the
  // box is ticked (and shown); unticked and ticked again, a new one
  const [report, setReport] = useState(null)
  const [reportState, setReportState] = useState('idle') // idle | loading | ready | failed
  const [showReport, setShowReport] = useState(false)
  const reportJob = useRef(null)
  // The short JSON of older versions: sent only when the report could not be made
  const [diagnostics, setDiagnostics] = useState(null)
  const [sending, setSending] = useState(false)
  // 'server': in the support inbox; 'mailto': handed to the email app
  const [sent, setSent] = useState(null)
  const [error, setError] = useState(null)
  const [offerMailto, setOfferMailto] = useState(false)

  // The dialog stays mounted between openings: each opening starts on the
  // area of the screen it was opened from
  useEffect(() => {
    if (open) setArea(initialArea)
  }, [open, initialArea])

  useEffect(() => {
    if (open && !matchRunningSetByUser) setMatchRunning(scoringHere)
  }, [open, scoringHere, matchRunningSetByUser])

  useEffect(() => {
    if (!diagnosticsSetByUser) setIncludeDiagnostics(DIAGNOSTICS_BY_DEFAULT.has(contactType))
  }, [contactType, diagnosticsSetByUser])

  // The form has reached the message (and the diagnostics box)
  const showComments = !!contactType && (
    contactType !== 'support' ||
    supportType === 'help' ||
    (supportType === 'bug' && !!severity)
  )

  // Ticked and shown: the report is made (once; ticked again, a new one)
  useEffect(() => {
    if (open && showComments && includeDiagnostics && reportState === 'idle') prepareReport()
  }, [open, showComments, includeDiagnostics, reportState]) // eslint-disable-line react-hooks/exhaustive-deps

  const resetForm = () => {
    setContactType('')
    setArea(initialArea)
    setSupportType('')
    setSeverity('')
    setComments('')
    setEmail('')
    setFiles([])
    setMatchRunning(scoringHere)
    setMatchRunningSetByUser(false)
    setIncludeDiagnostics(false)
    setDiagnosticsSetByUser(false)
    forgetReport()
    setSent(null)
    setError(null)
    setOfferMailto(false)
  }

  const handleClose = () => {
    resetForm()
    onClose()
  }

  const fileProblemText = (problem) => {
    if (problem.code === 'file_type') return t('supportFeedback.fileType', { name: problem.name || '' })
    if (problem.code === 'too_many_files') return t('supportFeedback.tooManyFiles', { max: MAX_FILES })
    if (problem.code === 'files_too_large') return t('supportFeedback.filesTooLarge', { mb: MAX_FILES_MB })
    return t('supportFeedback.sendError')
  }

  function forgetReport() {
    reportJob.current = null
    setReport(null)
    setReportState('idle')
    setShowReport(false)
    setDiagnostics(null)
  }

  // The report, once: resolves with it, or null when it could not be made
  // (the short JSON is sent then, and shown instead)
  const prepareReport = () => {
    if (reportJob.current) return reportJob.current
    const job = Promise.resolve()
      .then(() => createReport({ gameNumber, language: i18n?.language || '' }))
      .then((r) => {
        if (reportJob.current !== job) return null
        if (!r?.text) throw new Error('empty report')
        setReport(r)
        setReportState('ready')
        return r
      })
      .catch((err) => {
        if (reportJob.current !== job) return null
        console.warn('[Support] diagnostics report not made:', err?.message)
        setDiagnostics(collectDiagnostics({ gameNumber }))
        setReportState('failed')
        return null
      })
    reportJob.current = job
    setReportState('loading')
    return job
  }

  const toggleDiagnostics = (on) => {
    setDiagnosticsSetByUser(true)
    setIncludeDiagnostics(on)
    if (!on) forgetReport()
  }

  const toggleMatchRunning = (on) => {
    setMatchRunningSetByUser(true)
    setMatchRunning(on)
  }

  // What goes with the message as diagnostics: the report (made now when it
  // is still on its way), or the short JSON when it could not be made
  const settledDiagnostics = () => ({
    diagnosticsReport: includeDiagnostics && reportState === 'ready' ? report : null,
    diagnostics: includeDiagnostics && reportState === 'failed' ? diagnostics : null
  })
  const diagnosticsToSend = async () => {
    if (!includeDiagnostics) return { diagnosticsReport: null, diagnostics: null }
    const r = reportState === 'ready' && report ? report : await prepareReport()
    return r ? { diagnosticsReport: r, diagnostics: null } : { diagnosticsReport: null, diagnostics: diagnostics || collectDiagnostics({ gameNumber }) }
  }

  const request = (diag = settledDiagnostics()) => ({
    contactType,
    area,
    // what the form shows for the type: a severity picked for a bug and left
    // behind by switching to a question or to feedback is not sent
    supportType: contactType === 'support' ? supportType : '',
    severity: contactType === 'support' && supportType === 'bug' ? severity : '',
    matchRunning,
    email,
    comments,
    files,
    ...diag,
    language: i18n?.language || ''
  })

  const openMailto = (diag) => {
    const v = request(diag)
    const labels = {
      type: t(`supportFeedback.types.${contactType}`),
      area: t(`supportFeedback.areas.${area}`),
      supportType: v.supportType ? t(`supportFeedback.supportTypes.${v.supportType}`) : '',
      severity: v.severity ? t(`supportFeedback.severities.severity${v.severity}`) : ''
    }
    openAppWindow(contactMailto(v, labels))
    setSent('mailto')
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

    if (!isContactEmail(email)) {
      setError(t('supportFeedback.invalidEmail'))
      return
    }

    const fileProblem = checkFiles(files)
    if (fileProblem) {
      setError(fileProblemText(fileProblem))
      return
    }

    const apiUrl = getCloudApiUrl('/api/contact')
    if (!apiUrl) {
      // No backend to send to (a desktop window without the cloud): the email
      // app, and "Download diagnostics" on the next screen
      openMailto(await diagnosticsToSend())
      return
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setError(t('supportFeedback.offline'))
      setOfferMailto(true)
      return
    }

    setSending(true)
    setError(null)
    setOfferMailto(false)

    try {
      const diag = await diagnosticsToSend()
      const response = await fetch(apiUrl, {
        method: 'POST',
        body: buildContactForm(request(diag))
      })
      if (!response.ok) {
        let answer = null
        try { answer = await response.json() } catch { /* not JSON */ }
        const code = answer?.code || null
        if (FIXABLE.has(code)) {
          setError(code === 'invalid_email' ? t('supportFeedback.invalidEmail') : fileProblemText({ code, name: answer.file }))
          return
        }
        throw new Error(`contact: HTTP ${response.status}${code ? ` ${code}` : ''}`)
      }
      setSent('server')
    } catch (err) {
      console.error('Error sending feedback:', err)
      setError(t('supportFeedback.sendError'))
      setOfferMailto(true)
    } finally {
      setSending(false)
    }
  }

  if (!open) return null

  const header = (title, tone) => (
    <div className="flex shrink-0 items-center justify-between gap-3 border-b border-stone-200/70 bg-white px-2 pb-3 sm:px-4">
      <h2 className={cn('text-lg font-bold', tone || 'text-stone-900')}>
        {title}
      </h2>
      <IconButton variant="close" icon={X} label={t('common.close', 'Close')} onClick={handleClose} />
    </div>
  )

  // Show success message
  if (sent) {
    const successMessage = sent === 'mailto'
      ? t('supportFeedback.mailtoOpened')
      : contactType === 'support'
        ? t('supportFeedback.thankYouSupport')
        : contactType === 'feedback'
          ? t('supportFeedback.thankYouFeedback')
          : t('supportFeedback.thankYouRequest')
    const followUp = sent === 'mailto'
      ? (files.length > 0 ? t('supportFeedback.mailtoAttach') : null)
      : t('supportFeedback.replyTo', { email: email.trim() })
    // The email cannot carry the diagnostics file: it is downloaded to attach by hand
    const reportToAttach = sent === 'mailto' && includeDiagnostics && report ? report : null

    return (
      <Modal open={true} title="" onClose={handleClose} width={450} hideCloseButton={true}>
        <div className="ov-kit">
          {header(sent === 'mailto' ? t('supportFeedback.mailtoTitle') : t('supportFeedback.sent'), 'text-stone-900')}
          <div className="px-2 py-6 text-center sm:px-4">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-green-50 text-green-600">
              {sent === 'mailto'
                ? <Mail size={26} strokeWidth={2.25} aria-hidden="true" />
                : <Check size={26} strokeWidth={2.25} aria-hidden="true" />}
            </div>
            <p role="status" className={cn('text-base text-stone-700', followUp || reportToAttach ? 'mb-2' : 'mb-6')}>
              {successMessage}
            </p>
            {followUp && <p className={cn('text-sm text-stone-500', reportToAttach ? 'mb-2' : 'mb-6')}>{followUp}</p>}
            {reportToAttach && (
              <>
                <p className="mb-3 text-sm text-stone-500">{t('supportFeedback.mailtoAttachDiagnostics')}</p>
                <Button variant="secondary" size="lg" icon={Download} onClick={() => downloadDiagnosticsFile(reportToAttach)} className="mb-6">
                  {t('supportFeedback.downloadDiagnostics')}
                </Button>
              </>
            )}
            <Button variant="dark" size="xl" onClick={handleClose} className="min-w-32 rounded-lg font-medium">
              {t('common.close')}
            </Button>
          </div>
        </div>
      </Modal>
    )
  }

  return (
    <Modal open={true} title="" onClose={handleClose} width={450} hideCloseButton={true} panelStyle={ONE_SCROLLER}>
      <div className="ov-kit flex min-h-0 flex-1 flex-col">
      {/* Header: stays in view, only the content below scrolls */}
      {header(t('supportFeedback.title'))}

      {/* Content */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-4 pb-2 sm:px-4">
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

        {/* A match running: every type, as soon as one is chosen */}
        {contactType && (
          <div className="mb-4">
            <Checkbox
              label={t('supportFeedback.matchRunning')}
              checked={matchRunning}
              onChange={(e) => toggleMatchRunning(e.target.checked)}
            />
          </div>
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
            onReject={(problem) => setError(problem ? fileProblemText(problem) : null)}
            t={t}
            scaleFactor={scaleFactor}
          />
        )}

        {/* Diagnostics: ticked for support, unticked for feedback and
            requests; "Show what is sent" shows exactly the file that goes */}
        {showComments && (
          <div className="mb-4">
            <Checkbox
              label={t('supportFeedback.includeDiagnostics')}
              hint={t('supportFeedback.diagnosticsHint')}
              checked={includeDiagnostics}
              onChange={(e) => toggleDiagnostics(e.target.checked)}
            />
            {includeDiagnostics && reportState === 'loading' && (
              <p role="status" className="mt-2 text-xs text-stone-500">{t('supportFeedback.diagnosticsPreparing')}</p>
            )}
            {includeDiagnostics && reportState === 'ready' && report && (
              <div className="mt-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <button
                    type="button"
                    aria-expanded={showReport}
                    aria-controls="support-diagnostics-preview"
                    onClick={() => setShowReport((v) => !v)}
                    className={cn('inline-flex h-9 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-stone-700 hover:bg-stone-100', FOCUS_RING)}
                  >
                    <ChevronDown size={16} aria-hidden="true" className={cn('transition-transform', showReport && 'rotate-180')} />
                    {showReport ? t('supportFeedback.hideDiagnostics') : t('supportFeedback.showDiagnostics')}
                  </button>
                  <span className="text-xs tabular-nums text-stone-500">
                    {t('supportFeedback.diagnosticsSize', { size: sizeText(report.bytes), lines: report.lines })}
                  </span>
                </div>
                {showReport && (
                  <pre
                    id="support-diagnostics-preview"
                    aria-label={t('supportFeedback.diagnosticsPreview')}
                    tabIndex={0}
                    className="mt-2 max-h-72 overflow-auto whitespace-pre rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 font-mono text-[11px] leading-snug text-stone-700"
                  >
                    {report.text}
                  </pre>
                )}
              </div>
            )}
            {includeDiagnostics && reportState === 'failed' && diagnostics && (
              <>
                <p className="mt-2 text-xs text-stone-500">{t('supportFeedback.diagnosticsFailed')}</p>
                <pre
                  aria-label={t('supportFeedback.diagnosticsPreview')}
                  className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 font-mono text-[11px] leading-snug text-stone-700"
                >
                  {JSON.stringify(diagnostics, null, 2)}
                </pre>
              </>
            )}
          </div>
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

        {/* Sending failed or offline: the same message by email, and the
            diagnostics file to attach to it by hand */}
        {showComments && offerMailto && (
          <>
            <Button variant="secondary" size="lg" block icon={Mail} onClick={() => openMailto()} className="mb-3">
              {t('supportFeedback.sendByEmail')}
            </Button>
            {includeDiagnostics && report && (
              <Button variant="secondary" size="lg" block icon={Download} onClick={() => downloadDiagnosticsFile(report)} className="mb-3">
                {t('supportFeedback.downloadDiagnostics')}
              </Button>
            )}
          </>
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
