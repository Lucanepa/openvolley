/**
 * One address, strictly: one @, a dot in the domain, and nothing an address
 * list or a display name could be read from (no comma, semicolon, angle or
 * round brackets, quotes, backslash, colon or white space). nodemailer reads
 * a recipient as an RFC 5322 list, so "a@b.ch,x" or "x<a@b.ch>" would be
 * delivered to a@b.ch under another spelling (another account, another
 * rate-limit key). Used by sign-up, sign-in and every stored or mailed
 * address (lib/auth.js, finalMail.js, approvals.js, clubs.js, contact.js).
 */
export const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/

/** True for one plain address of at most 254 characters. */
export function isEmailAddress(s) {
  return typeof s === 'string' && s.length <= 254 && EMAIL_RE.test(s)
}
