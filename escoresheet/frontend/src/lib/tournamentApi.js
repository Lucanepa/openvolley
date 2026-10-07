/**
 * OpenBeach tournaments (backend lib/beachTournaments.js, plan phase T1).
 * One function per endpoint; every one resolves to { data, error, status }
 * and never throws. The server checks every beach role.
 */

import { apiRequest } from './apiClient'
import { errorKeyOf } from './accountApi'

const enc = encodeURIComponent

export const tournamentApi = {
  list() { return apiRequest('GET', '/api/beach/tournaments') },
  get(id) { return apiRequest('GET', `/api/beach/tournaments/${enc(id)}`) },
  create(body) { return apiRequest('POST', '/api/beach/tournaments', body) },
  update(id, body) { return apiRequest('PATCH', `/api/beach/tournaments/${enc(id)}`, body) },
  remove(id) { return apiRequest('DELETE', `/api/beach/tournaments/${enc(id)}`) },
  addManager(id, email) { return apiRequest('POST', `/api/beach/tournaments/${enc(id)}/managers`, { email }) },
  removeManager(id, userId) { return apiRequest('DELETE', `/api/beach/tournaments/${enc(id)}/managers/${enc(userId)}`) },
  putCourts(id, courts) { return apiRequest('PUT', `/api/beach/tournaments/${enc(id)}/courts`, { courts }) },
  createDraw(id, body) { return apiRequest('POST', `/api/beach/tournaments/${enc(id)}/draws`, body) },
  schedule(id, body) { return apiRequest('POST', `/api/beach/tournaments/${enc(id)}/schedule`, body) },
  updateDraw(drawId, body) { return apiRequest('PATCH', `/api/beach/draws/${enc(drawId)}`, body) },
  removeDraw(drawId) { return apiRequest('DELETE', `/api/beach/draws/${enc(drawId)}`) },
  addEntry(drawId, body) { return apiRequest('POST', `/api/beach/draws/${enc(drawId)}/entries`, body) },
  putSeeds(drawId, order) { return apiRequest('PUT', `/api/beach/draws/${enc(drawId)}/seeds`, { order }) },
  generate(drawId, { dryRun = false } = {}) { return apiRequest('POST', `/api/beach/draws/${enc(drawId)}/generate`, { dryRun }) },
  resetBracket(drawId) { return apiRequest('DELETE', `/api/beach/draws/${enc(drawId)}/bracket`) },
  ranking(drawId) { return apiRequest('GET', `/api/beach/draws/${enc(drawId)}/ranking`) },
  updateEntry(entryId, body) { return apiRequest('PATCH', `/api/beach/entries/${enc(entryId)}`, body) },
  removeEntry(entryId) { return apiRequest('DELETE', `/api/beach/entries/${enc(entryId)}`) },
  updateMatch(matchId, body) { return apiRequest('PATCH', `/api/beach/tmatches/${enc(matchId)}`, body) },
  enterResult(matchId, body) { return apiRequest('POST', `/api/beach/tmatches/${enc(matchId)}/result`, body) },
  withdrawResult(matchId) { return apiRequest('DELETE', `/api/beach/tmatches/${enc(matchId)}/result`) }
}

const CODES = {
  OV_BRACKET_LOCKED: 'tournaments.errors.bracketLocked',
  OV_DRAW_STARTED: 'tournaments.errors.drawStarted',
  OV_DRAW_DRAWN: 'tournaments.errors.drawDrawn',
  OV_SLUG_TAKEN: 'tournaments.errors.slugTaken',
  OV_DRAW_SIZE: 'tournaments.errors.drawSize',
  OV_ENTRY_EXISTS: 'tournaments.errors.entryExists',
  OV_MATCH_NOT_READY: 'tournaments.errors.notReady',
  OV_MATCH_BEGUN: 'tournaments.errors.matchBegun',
  OV_NO_COURTS: 'tournaments.errors.noCourts',
  OV_SLOT_CONFLICT: 'tournaments.errors.slotConflict',
  OV_RESULT_CHANGED: 'tournaments.errors.resultChanged',
  OV_NOT_FOUND: 'tournaments.errors.notFound'
}

/** The i18n key of a tournament API error (the console's keys for everything else). */
export function tournamentErrorKey(error) {
  if (!error) return null
  return CODES[error.code] || errorKeyOf(error)
}
