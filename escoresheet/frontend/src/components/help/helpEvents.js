// A dialog's help button opens the scorer app's help panel on the dialog's
// own screen (helpSections.js HELP_SCREENS): the panel lives in App, the
// dialogs are opened from several places (header menu, Options, the scoring
// screen), so they ask for it with a window event, as OPEN_RESTORE_EVENT does.

export const OPEN_HELP_EVENT = 'ov:open-help'

/** Opens the help panel on `screen` (App listens). */
export function openHelp(screen, win = typeof window !== 'undefined' ? window : undefined) {
  if (!win || !screen) return
  win.dispatchEvent(new CustomEvent(OPEN_HELP_EVENT, { detail: { screen } }))
}
