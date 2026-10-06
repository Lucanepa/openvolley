// The one way the app asks for a line of text: window.prompt's replacement.
//
// Like askConfirm.js: an in-app dialog (volleyui confirmDialog with a text
// field, rendered by <UiHost /> in every React root), the same in the browser,
// the desktop app and Android, instead of the native prompt() a webview may
// replace or not show. Guarded by src/utils/__tests__/noNativeDialogs.test.jsx.
//
// Never call it inside a Dexie transaction: awaiting the user there commits
// the transaction early. Ask first, then open the transaction.

// The app's i18next instance (src/i18n/index.js initialises it); imported
// directly so this module has no side effects of its own.
import i18n from 'i18next'
import { confirmDialog } from '../ui/uiStore.js'

/**
 * Ask for a line of text. ALWAYS await it:
 *
 *   const pin = await askText({ title: t('...'), label: t('...') })
 *   if (pin === null) return // cancelled
 *
 * @param {object} opts
 * @param {string} opts.title          what is asked (sentence case)
 * @param {import('react').ReactNode} [opts.message]  more context; newlines are kept
 * @param {string} [opts.label]        the field's label
 * @param {string} [opts.defaultValue] pre-filled text
 * @param {string} [opts.placeholder]
 * @param {string} [opts.type]         input type, 'text' by default
 * @param {string} [opts.inputMode]    e.g. 'numeric'
 * @param {string} [opts.confirmLabel] a verb; defaults to common.ok
 * @param {string} [opts.cancelLabel]  defaults to common.cancel
 * @returns {Promise<string|null>} the typed text (possibly ''), or null on Cancel / Escape / backdrop
 */
export async function askText({
  title, message, label, defaultValue = '', placeholder, type, inputMode, confirmLabel, cancelLabel,
} = {}) {
  const answer = await confirmDialog({
    title,
    message,
    input: { label, defaultValue, placeholder, type, inputMode },
    confirmLabel: confirmLabel ?? i18n.t('common.ok', 'OK'),
    cancelLabel: cancelLabel ?? i18n.t('common.cancel', 'Cancel'),
    tone: 'default',
  })
  return typeof answer === 'string' ? answer : null
}

export default askText
