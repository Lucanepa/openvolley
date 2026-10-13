// The one way the app asks "are you sure?".
//
// Never call window.confirm / window.alert (or bare confirm() / alert()):
// in the desktop app tauri-plugin-dialog replaces both with IPC calls that no
// capability allows, so alert() shows nothing and confirm() returns a Promise,
// which is truthy and reads as "yes" in `if (confirm(...))`. Destructive
// actions then ran without asking. This helper uses the app's own in-app
// dialog (volleyui confirmDialog, rendered by <UiHost /> in every React root),
// so it looks and behaves the same in the browser, the desktop app and
// Android. Guarded by src/utils/__tests__/noNativeDialogs.test.jsx.
//
// For a message with only an OK button use the AlertContext (showAlert) or a
// toast from src/ui, not window.alert.

// The app's i18next instance (src/i18n/index.js initialises it); imported
// directly so this module has no side effects of its own.
import i18n from 'i18next'
import { confirmDialog } from '../ui/uiStore.js'

/**
 * Ask the user to confirm. ALWAYS await it:
 *
 *   if (!(await askConfirm({ title: t('...'), confirmLabel: t('common.delete'), tone: 'danger' }))) return
 *
 * @param {object} opts
 * @param {string} opts.title          the question (sentence case)
 * @param {import('react').ReactNode} [opts.message]  the consequence; newlines are kept
 * @param {string} [opts.confirmLabel] a verb; defaults to common.confirm
 * @param {string} [opts.cancelLabel]  defaults to common.cancel
 * @param {'danger'|'default'} [opts.tone]
 * @param {AbortSignal} [opts.signal]  aborting it takes the dialog away as a cancel
 * @returns {Promise<boolean>} true only when the user pressed the confirm button
 */
export async function askConfirm({ title, message, confirmLabel, cancelLabel, tone = 'default', signal } = {}) {
  const answer = await confirmDialog({
    title,
    message,
    confirmLabel: confirmLabel ?? i18n.t('common.confirm', 'Confirm'),
    cancelLabel: cancelLabel ?? i18n.t('common.cancel', 'Cancel'),
    tone,
    signal,
  })
  return answer === true
}

/**
 * Ask with a third answer besides confirm and cancel (e.g. the desktop app's
 * close: Hide window / Quit completely / Keep open). ALWAYS await it.
 *
 * @param {object} opts  askConfirm's, plus
 * @param {string} opts.altLabel  the third button (between cancel and confirm)
 * @param {'danger'|'default'} [opts.altTone]
 * @returns {Promise<'confirm'|'alt'|'cancel'>} 'cancel' also for Escape, a
 *   backdrop click and an aborted signal
 */
export async function askChoice({ title, message, confirmLabel, cancelLabel, altLabel, altTone = 'default', tone = 'default', signal } = {}) {
  const answer = await confirmDialog({
    title,
    message,
    confirmLabel: confirmLabel ?? i18n.t('common.confirm', 'Confirm'),
    cancelLabel: cancelLabel ?? i18n.t('common.cancel', 'Cancel'),
    altLabel,
    altTone,
    tone,
    signal,
  })
  if (answer === true) return 'confirm'
  if (answer === 'alt') return 'alt'
  return 'cancel'
}

export default askConfirm
