/**
 * Changing a post-match signature after it was collected (MatchEnd "Re-sign"
 * and "Clear"). Pure: no React, no Dexie, no network.
 *
 * Every change is written to the match row at once and queued for the cloud
 * as the match's full `signatures` object: the server REPLACES that JSONB
 * column on update (it is not in pgQuery mergeJsonColumns), so the pre-match
 * coach and captain signatures travel along and are never wiped.
 *
 * An account approval is bound to the result and the team names (db/011
 * result_key and its void trigger), not to the drawn image: re-signing or
 * clearing keeps a valid approval. A stale one is dropped when a new
 * signature is drawn, as before (MatchEnd handleSaveSignature).
 */

/** The server keys of the post-match signatures, by match-row field. */
export const POST_MATCH_SIGNATURE_KEYS = Object.freeze({
  homePostGameCaptainSignature: 'home_captain_post_game',
  awayPostGameCaptainSignature: 'away_captain_post_game',
  asstScorerSignature: 'asst_scorer',
  scorerSignature: 'scorer',
  ref2Signature: 'ref2',
  ref1Signature: 'ref1'
})

/** The server keys of the pre-match signatures (MatchSetup's sync job). */
const PRE_MATCH_SIGNATURE_KEYS = Object.freeze({
  homeCoachSignature: 'home_coach',
  homeCaptainSignature: 'home_captain',
  awayCoachSignature: 'away_coach',
  awayCaptainSignature: 'away_captain'
})

/**
 * Re-sign and Clear are closed once the result is approved or the match is
 * closed: the signatures then belong to an approved sheet. "Reopen match"
 * opens them again.
 */
export function signatureEditLocked(match, { isApproved = false } = {}) {
  if (isApproved || !match) return !!isApproved
  return match.approved === true || !!match.closed_at || match.status === 'approved' || match.status === 'final'
}

/**
 * The match's `signatures` JSONB as the server stores it: the four pre-match
 * signatures ('' when missing, as MatchSetup sends them) and the six
 * post-match ones (null when missing or cleared).
 */
export function signaturesPayload(match) {
  const m = match || {}
  const out = {}
  for (const [field, key] of Object.entries(PRE_MATCH_SIGNATURE_KEYS)) out[key] = m[field] || ''
  for (const [field, key] of Object.entries(POST_MATCH_SIGNATURE_KEYS)) out[key] = m[field] || null
  return out
}

/**
 * The sync-queue job that sends the signatures of `match` (the row AFTER the
 * change), or null when the match does not sync: no seed_key, or a test match
 * (as MatchSetup and the approval job, which never send test signatures).
 */
export function signaturesSyncJob(match, now = new Date()) {
  if (!match?.seed_key || match.test) return null
  return {
    resource: 'match',
    action: 'update',
    payload: { id: match.seed_key, signatures: signaturesPayload(match) },
    ts: now.toISOString(),
    status: 'queued'
  }
}
