/**
 * Does a sign-up answer ask the user to confirm the address by email first?
 * The self-hosted backend confirms accounts at sign-up (email_confirmed_at is
 * set, no mail is sent), so the user can sign in at once. Only a backend that
 * leaves the account unconfirmed needs the "check your email" step.
 */
export function needsEmailConfirmation(signUpData) {
  const user = signUpData?.user
  if (!user) return false
  return !user.email_confirmed_at && !user.confirmed_at
}
