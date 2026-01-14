/**
 * Event Capture - Global DOM event listeners for comprehensive logging
 * Captures all user interactions at the document level
 */

import { logUI, throttle, debounce } from './comprehensiveLogger'

// Event configuration with throttle settings
const EVENT_CONFIG = {
  // Mouse events
  click: { capture: true, throttle: 0 },
  dblclick: { capture: true, throttle: 0 },
  contextmenu: { capture: true, throttle: 0 },
  mousedown: { capture: true, throttle: 0 },
  mouseup: { capture: true, throttle: 0 },

  // Touch events
  touchstart: { capture: true, throttle: 0, passive: true },
  touchend: { capture: true, throttle: 0, passive: true },
  touchmove: { capture: true, throttle: 100, passive: true },

  // Keyboard events
  keydown: { capture: true, throttle: 0 },
  keyup: { capture: true, throttle: 0 },

  // Form events
  input: { capture: true, throttle: 200 },
  change: { capture: true, throttle: 0 },
  submit: { capture: true, throttle: 0 },
  focus: { capture: true, throttle: 0 },
  blur: { capture: true, throttle: 0 },

  // Drag events
  dragstart: { capture: true, throttle: 0 },
  dragend: { capture: true, throttle: 0 },
  dragover: { capture: true, throttle: 100 },
  drop: { capture: true, throttle: 0 },

  // Scroll (heavily throttled)
  scroll: { capture: true, throttle: 500, passive: true }
}

// Store active listeners for cleanup
const activeListeners = new Map()

// Values to mask in logs (for privacy)
const SENSITIVE_PATTERNS = [
  /password/i,
  /secret/i,
  /token/i,
  /key/i,
  /pin/i,
  /credential/i
]

/**
 * Check if a field name suggests sensitive data
 */
function isSensitiveField(name) {
  if (!name) return false
  return SENSITIVE_PATTERNS.some(pattern => pattern.test(name))
}

/**
 * Sanitize a value for logging (mask sensitive data)
 */
function sanitizeValue(value, fieldName) {
  if (value === undefined || value === null) return null
  if (isSensitiveField(fieldName)) return '[REDACTED]'
  if (typeof value === 'string' && value.length > 100) {
    return value.substring(0, 100) + '...'
  }
  return value
}

/**
 * Get CSS selector path for an element
 */
function getElementPath(element, maxDepth = 5) {
  if (!element || element === document) return ''

  const parts = []
  let current = element
  let depth = 0

  while (current && current !== document && depth < maxDepth) {
    let selector = current.tagName?.toLowerCase() || ''

    if (current.id) {
      selector += `#${current.id}`
    } else if (current.className && typeof current.className === 'string') {
      const classes = current.className.trim().split(/\s+/).slice(0, 2).join('.')
      if (classes) selector += `.${classes}`
    }

    parts.unshift(selector)
    current = current.parentElement
    depth++
  }

  return parts.join(' > ')
}

/**
 * Extract data attributes from an element
 */
function extractDataAttributes(element) {
  if (!element?.dataset) return {}

  const data = {}
  for (const key of Object.keys(element.dataset)) {
    // Only include common/useful data attributes
    if (key.length < 30 && !isSensitiveField(key)) {
      data[key] = sanitizeValue(element.dataset[key], key)
    }
  }
  return data
}

/**
 * Extract meaningful info from a DOM element
 */
function extractTargetInfo(element) {
  if (!element) return null

  return {
    tagName: element.tagName?.toLowerCase(),
    id: element.id || null,
    className: typeof element.className === 'string'
      ? element.className.substring(0, 100)
      : null,
    name: element.name || null,
    type: element.type || null,
    role: element.getAttribute?.('role') || null,
    ariaLabel: element.getAttribute?.('aria-label') || null,
    textContent: element.textContent?.substring(0, 50)?.trim() || null,
    href: element.tagName === 'A' ? element.href : null,
    path: getElementPath(element),
    dataAttributes: extractDataAttributes(element)
  }
}

/**
 * Get component name from element (looks for React component markers)
 */
function getComponentName(element) {
  if (!element) return 'unknown'

  // Check for data-component attribute
  if (element.dataset?.component) {
    return element.dataset.component
  }

  // Walk up to find closest component marker
  let current = element
  while (current && current !== document) {
    if (current.dataset?.component) {
      return current.dataset.component
    }
    // Check for common React patterns in class names
    if (current.className && typeof current.className === 'string') {
      const match = current.className.match(/([A-Z][a-zA-Z]+)(?:__|_|$)/)
      if (match) return match[1]
    }
    current = current.parentElement
  }

  return 'global'
}

/**
 * Create event handler for a specific event type
 */
function createEventHandler(eventType, config) {
  const handler = (event) => {
    try {
      const target = event.target
      const component = getComponentName(target)
      const targetInfo = extractTargetInfo(target)

      // Build payload based on event type
      const payload = buildEventPayload(eventType, event, target)

      // Log the event
      logUI(eventType, component, eventType, payload, targetInfo)

    } catch (err) {
      // Silent fail - don't break the app due to logging
      console.error('[EventCapture] Error logging event:', err)
    }
  }

  // Apply throttling if configured
  if (config.throttle > 0) {
    return throttle(handler, config.throttle)
  }

  return handler
}

/**
 * Build event payload based on event type
 */
function buildEventPayload(eventType, event, target) {
  const base = {
    timestamp: Date.now()
  }

  switch (eventType) {
    case 'click':
    case 'dblclick':
    case 'contextmenu':
      return {
        ...base,
        button: event.button,
        clientX: Math.round(event.clientX),
        clientY: Math.round(event.clientY),
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey
      }

    case 'mousedown':
    case 'mouseup':
      return {
        ...base,
        button: event.button,
        clientX: Math.round(event.clientX),
        clientY: Math.round(event.clientY)
      }

    case 'touchstart':
    case 'touchend':
      return {
        ...base,
        touches: event.touches?.length || 0,
        changedTouches: event.changedTouches?.length || 0,
        clientX: event.changedTouches?.[0]?.clientX ? Math.round(event.changedTouches[0].clientX) : null,
        clientY: event.changedTouches?.[0]?.clientY ? Math.round(event.changedTouches[0].clientY) : null
      }

    case 'touchmove':
      return {
        ...base,
        touches: event.touches?.length || 0,
        clientX: event.touches?.[0]?.clientX ? Math.round(event.touches[0].clientX) : null,
        clientY: event.touches?.[0]?.clientY ? Math.round(event.touches[0].clientY) : null
      }

    case 'keydown':
    case 'keyup':
      return {
        ...base,
        key: event.key,
        code: event.code,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        repeat: event.repeat
      }

    case 'input':
      return {
        ...base,
        inputType: event.inputType,
        value: sanitizeValue(target?.value, target?.name),
        valueLength: target?.value?.length || 0
      }

    case 'change':
      return {
        ...base,
        value: sanitizeValue(target?.value, target?.name),
        checked: target?.type === 'checkbox' ? target.checked : undefined,
        selectedIndex: target?.selectedIndex
      }

    case 'submit':
      return {
        ...base,
        formId: target?.id,
        formAction: target?.action
      }

    case 'focus':
    case 'blur':
      return {
        ...base
      }

    case 'dragstart':
      return {
        ...base,
        dataTransferTypes: event.dataTransfer?.types ? [...event.dataTransfer.types] : []
      }

    case 'dragend':
      return {
        ...base,
        dropEffect: event.dataTransfer?.dropEffect
      }

    case 'dragover':
      return {
        ...base,
        clientX: Math.round(event.clientX),
        clientY: Math.round(event.clientY)
      }

    case 'drop':
      return {
        ...base,
        clientX: Math.round(event.clientX),
        clientY: Math.round(event.clientY),
        dataTransferTypes: event.dataTransfer?.types ? [...event.dataTransfer.types] : []
      }

    case 'scroll':
      return {
        ...base,
        scrollTop: target?.scrollTop || window.scrollY,
        scrollLeft: target?.scrollLeft || window.scrollX
      }

    default:
      return base
  }
}

/**
 * Install global event capture
 */
export function installGlobalEventCapture() {
  // Don't install twice
  if (activeListeners.size > 0) {
    console.log('[EventCapture] Already installed')
    return
  }

  for (const [eventType, config] of Object.entries(EVENT_CONFIG)) {
    const handler = createEventHandler(eventType, config)

    const options = {
      capture: config.capture,
      passive: config.passive ?? false
    }

    document.addEventListener(eventType, handler, options)
    activeListeners.set(eventType, { handler, options })
  }

  // Also capture unhandled errors
  window.addEventListener('error', handleGlobalError)
  window.addEventListener('unhandledrejection', handleUnhandledRejection)

  console.log('[EventCapture] Global event capture installed')
}

/**
 * Uninstall global event capture
 */
export function uninstallGlobalEventCapture() {
  for (const [eventType, { handler, options }] of activeListeners.entries()) {
    document.removeEventListener(eventType, handler, options)
  }
  activeListeners.clear()

  window.removeEventListener('error', handleGlobalError)
  window.removeEventListener('unhandledrejection', handleUnhandledRejection)

  console.log('[EventCapture] Global event capture uninstalled')
}

/**
 * Handle global errors
 */
function handleGlobalError(event) {
  logUI('error', 'global', 'error', {
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    error: event.error?.stack || event.error?.message
  })
}

/**
 * Handle unhandled promise rejections
 */
function handleUnhandledRejection(event) {
  logUI('error', 'global', 'unhandledrejection', {
    reason: event.reason?.message || String(event.reason),
    stack: event.reason?.stack
  })
}

/**
 * Check if event capture is active
 */
export function isEventCaptureActive() {
  return activeListeners.size > 0
}

/**
 * Get list of captured event types
 */
export function getCapturedEventTypes() {
  return [...activeListeners.keys()]
}
