/**
 * Does a sign-up answer ask the user to confirm the address by email first?
 * The self-hosted backend either confirms accounts at sign-up (no mail
 * server) or mails a confirmation link and lets the account sign in at once
 * (email_confirmation: 'sent'). Only a backend that leaves the account
 * unconfirmed AND refuses its sign-in needs the "check your email" step.
 */
export function needsEmailConfirmation(signUpData) {
  const user = signUpData?.user
  if (!user) return false
  // A confirmation link went out but the account may sign in already
  // (backend lib/auth.js: new accounts are not blocked while unconfirmed).
  if (signUpData?.email_confirmation === 'sent') return false
  return !user.email_confirmed_at && !user.confirmed_at
}

/** True when the server mailed a confirmation link for the new account. */
export function confirmationLinkSent(signUpData) {
  return signUpData?.email_confirmation === 'sent'
}
