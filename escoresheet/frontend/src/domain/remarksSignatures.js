/**
 * Signatures in the REMARKS box: an official who is no signature slot of the
 * sheet (a referee coach, a supervisor) signs a remark (SVRZ feedback
 * 2026-11-09: "Unterschrift in Remarks erlauben, z.B. für RC").
 *
 * The match row keeps them as `remarksSignatures`: [{ role, name, image,
 * signedAt }], at most MAX_REMARKS_SIGNATURES. They travel to the server in
 * the match's `signatures` JSONB under `remarks` (domain/signatureEdits) and
 * print in the REMARKS box (scoresheet_pdf FooterSection Remarks). Pure: no
 * React, no Dexie, no network.
 */

export const MAX_REMARKS_SIGNATURES = 3
export const REMARKS_ROLE_MAX = 40
export const REMARKS_NAME_MAX = 80

const text = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')
const isImage = (v) => typeof v === 'string' && v.startsWith('data:image/')

/**
 * The valid entries of a stored or received list (anything else dropped),
 * at most MAX_REMARKS_SIGNATURES.
 * @param {unknown} list
 * @returns {Array<{ role: string, name: string, image: string, signedAt: string|null }>}
 */
export function remarksSignaturesOf(list) {
  if (!Array.isArray(list)) return []
  return list
    .filter(s => s && typeof s === 'object' && isImage(s.image) && text(s.role, REMARKS_ROLE_MAX))
    .slice(0, MAX_REMARKS_SIGNATURES)
    .map(s => ({
      role: text(s.role, REMARKS_ROLE_MAX),
      name: text(s.name, REMARKS_NAME_MAX),
      image: s.image,
      signedAt: typeof s.signedAt === 'string' ? s.signedAt : null
    }))
}

/**
 * The list with one more signature, or null when it cannot take it (full, no
 * role, no image).
 */
export function withRemarksSignature(list, { role, name, image }, now = new Date()) {
  const current = remarksSignaturesOf(list)
  if (current.length >= MAX_REMARKS_SIGNATURES) return null
  const entry = { role: text(role, REMARKS_ROLE_MAX), name: text(name, REMARKS_NAME_MAX), image, signedAt: now.toISOString() }
  if (!entry.role || !isImage(entry.image)) return null
  return [...current, entry]
}

/** The list without the entry at `index`. */
export function withoutRemarksSignature(list, index) {
  return remarksSignaturesOf(list).filter((_, i) => i !== index)
}

/** The caption under a signature: "Referee coach · Anna Muster" (the role alone without a name). */
export function remarksSignatureCaption(entry) {
  return entry?.name ? `${entry.role} · ${entry.name}` : (entry?.role || '')
}
