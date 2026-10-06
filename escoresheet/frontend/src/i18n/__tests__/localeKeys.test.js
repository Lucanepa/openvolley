// Keys added for scorer accounts, the manage console, saved teams and cloud
// blocks (spec 6.9) must exist in every locale the app ships: a key missing
// in one file shows the raw key (or the English fallback) to those users.
import { describe, it, expect } from 'vitest'
import en from '../locales/en.json'
import de from '../locales/de.json'
import deCH from '../locales/de-CH.json'
import fr from '../locales/fr.json'
import it_ from '../locales/it.json'

const LOCALES = { en, de, 'de-CH': deCH, fr, it: it_ }
const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj)

function flatten(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object') flatten(v, key, out)
    else out.push([key, v])
  }
  return out
}

// Every key of these namespaces in English must exist everywhere
const NAMESPACES = ['access', 'manage', 'savedTeams', 'cloudBlock']
const EXTRA_KEYS = [
  'matchSetup.gameTakenTitle',
  'matchSetup.gameTakenBody',
  'matchSetup.continueLocalOnly',
  'matchEnd.reopenAdminOnlyTitle',
  'matchEnd.reopenAdminOnlyBody',
  'matchEnd.reopenNeedsConnection',
  'matchEnd.reopenAdminTitle',
  'matchEnd.reopenAdminBody',
  'matchEnd.reopenReason',
  'matchEnd.reopenCheckFailed',
  'matchEnd.reopenMatch'
]
const SPEC_KEYS = [
  'access.pendingTitle',
  'access.pendingBody',
  'access.inviteCodeLabel',
  'access.inviteCodePlaceholder',
  'access.redeem',
  'access.redeeming',
  'access.redeemed',
  'access.errors.inviteInvalid',
  'access.errors.inviteExpired',
  'access.errors.inviteUsedUp',
  'access.errors.tooManyAttempts',
  'access.errors.offline',
  'access.roles.scorer',
  'access.roles.referee',
  'access.roles.competition_manager',
  'access.roles.admin',
  'access.roles.super_admin',
  'access.roles.pending',
  'access.signUpPendingNote',
  'access.officialMatchLocalOnly',
  'manage.title',
  'manage.backToApp',
  'manage.nav',
  'manage.menuAdmin',
  'manage.menuSavedTeams',
  'manage.menuInviteCode',
  'manage.tabs.accounts',
  'manage.tabs.invites',
  'manage.tabs.games',
  'manage.tabs.matches',
  'manage.tabs.audit',
  'manage.tabs.teams',
  'manage.status.setup',
  'manage.status.live',
  'manage.status.ended',
  'manage.status.approved',
  'manage.status.final',
  'manage.errors.forbidden',
  'manage.errors.generic',
  'manage.errors.offline',
  'manage.accounts.filterPending',
  'manage.accounts.filterAll',
  'manage.accounts.search',
  'manage.accounts.approve',
  'manage.accounts.editRoles',
  'manage.accounts.rolesTitle',
  'manage.accounts.save',
  'manage.accounts.saved',
  'manage.accounts.empty',
  'manage.accounts.emptyPending',
  'manage.accounts.created',
  'manage.accounts.lastSignIn',
  'manage.accounts.neverSignedIn',
  'manage.accounts.selfDemote',
  'manage.accounts.superAdminOnly',
  'manage.invites.new',
  'manage.invites.label',
  'manage.invites.labelHint',
  'manage.invites.club',
  'manage.invites.role',
  'manage.invites.maxUses',
  'manage.invites.maxUsesHint',
  'manage.invites.expires',
  'manage.invites.create',
  'manage.invites.createdTitle',
  'manage.invites.createdOnce',
  'manage.invites.copy',
  'manage.invites.copied',
  'manage.invites.uses',
  'manage.invites.usesUnlimited',
  'manage.invites.revoke',
  'manage.invites.revokeConfirmTitle',
  'manage.invites.revokeConfirmBody',
  'manage.invites.state.active',
  'manage.invites.state.expired',
  'manage.invites.state.used_up',
  'manage.invites.state.revoked',
  'manage.invites.empty',
  'manage.games.from',
  'manage.games.to',
  'manage.games.search',
  'manage.games.notClaimed',
  'manage.games.scoredBy',
  'manage.games.unknownScorer',
  'manage.games.editors',
  'manage.games.addEditor',
  'manage.games.addEditorTitle',
  'manage.games.editorEmail',
  'manage.games.add',
  'manage.games.editorAdded',
  'manage.games.releaseGame',
  'manage.games.releaseConfirmTitle',
  'manage.games.releaseConfirmBody',
  'manage.games.reason',
  'manage.games.empty',
  'manage.matches.filterClosed',
  'manage.matches.filterOpen',
  'manage.matches.filterAll',
  'manage.matches.search',
  'manage.matches.closedAt',
  'manage.matches.closedBy',
  'manage.matches.reopen',
  'manage.matches.reopenTitle',
  'manage.matches.reopenBody',
  'manage.matches.reopenReason',
  'manage.matches.reopened',
  'manage.matches.empty',
  'manage.audit.loadMore',
  'manage.audit.empty',
  'manage.audit.actions.account_roles',
  'manage.audit.actions.invite_create',
  'manage.audit.actions.invite_revoke',
  'manage.audit.actions.invite_redeem',
  'manage.audit.actions.match_claim_game',
  'manage.audit.actions.match_claim_pin',
  'manage.audit.actions.match_game_taken',
  'manage.audit.actions.match_close',
  'manage.audit.actions.match_reopen',
  'manage.audit.actions.match_editor_add',
  'manage.audit.actions.match_release_game',
  'savedTeams.title',
  'savedTeams.competitions',
  'savedTeams.newCompetition',
  'savedTeams.competitionName',
  'savedTeams.season',
  'savedTeams.gender',
  'savedTeams.genderMen',
  'savedTeams.genderWomen',
  'savedTeams.genderMixed',
  'savedTeams.category',
  'savedTeams.categoryHint',
  'savedTeams.vmLeagues',
  'savedTeams.vmLeaguesHint',
  'savedTeams.archived',
  'savedTeams.showArchived',
  'savedTeams.teams',
  'savedTeams.newTeam',
  'savedTeams.teamName',
  'savedTeams.shortName',
  'savedTeams.club',
  'savedTeams.color',
  'savedTeams.svrzTeamName',
  'savedTeams.svrzTeamNameHint',
  'savedTeams.players',
  'savedTeams.staff',
  'savedTeams.addPlayer',
  'savedTeams.addStaff',
  'savedTeams.number',
  'savedTeams.firstName',
  'savedTeams.lastName',
  'savedTeams.dob',
  'savedTeams.license',
  'savedTeams.libero',
  'savedTeams.captain',
  'savedTeams.active',
  'savedTeams.role',
  'savedTeams.saveRoster',
  'savedTeams.rosterSaved',
  'savedTeams.deleteTeam',
  'savedTeams.deleteTeamConfirmTitle',
  'savedTeams.deleteTeamConfirmBody',
  'savedTeams.deleteCompetition',
  'savedTeams.deleteCompetitionConfirmTitle',
  'savedTeams.deleteCompetitionConfirmBody',
  'savedTeams.duplicateTeam',
  'savedTeams.emptyCompetitions',
  'savedTeams.emptyTeams',
  'savedTeams.emptyRoster',
  'savedTeams.errors.duplicateNumber',
  'savedTeams.errors.twoCaptains',
  'savedTeams.errors.lastNameRequired',
  'savedTeams.load',
  'savedTeams.pickerTitle',
  'savedTeams.pickerSearch',
  'savedTeams.pickerCompetition',
  'savedTeams.pickerAll',
  'savedTeams.pickerPlayers',
  'savedTeams.pickerEmpty',
  'savedTeams.pickerOffline',
  'savedTeams.replaceConfirmTitle',
  'savedTeams.replaceConfirmBody',
  'savedTeams.replace',
  'savedTeams.loaded',
  'savedTeams.tooManyLiberos',
  'savedTeams.suggestionTitle',
  'savedTeams.suggestionHome',
  'savedTeams.suggestionAway',
  'savedTeams.loadHome',
  'savedTeams.loadAway',
  'savedTeams.saveToTeam',
  'savedTeams.saveTitle',
  'savedTeams.saveExisting',
  'savedTeams.saveNew',
  'savedTeams.saveConfirmTitle',
  'savedTeams.saveConfirmBody',
  'savedTeams.saved',
  'savedTeams.sport',
  'savedTeams.sportIndoor',
  'savedTeams.sportBeach',
  'savedTeams.beachPlayer',
  'savedTeams.country',
  'savedTeams.countryHint',
  'savedTeams.coach',
  'savedTeams.addCoach',
  'savedTeams.removeCoach',
  'savedTeams.clearPlayer',
  'savedTeams.beachTeamHint',
  'savedTeams.errors.countryFormat',
  'cloudBlock.scorerRequired',
  'cloudBlock.gameTaken',
  'cloudBlock.gameTakenMine',
  'cloudBlock.gameTakenUnknown',
  'cloudBlock.matchClosed',
  'cloudBlock.joinWithPin',
  'matchSetup.gameTakenTitle',
  'matchSetup.gameTakenBody',
  'matchSetup.continueLocalOnly',
  'matchEnd.reopenAdminOnlyTitle',
  'matchEnd.reopenAdminOnlyBody',
  'matchEnd.reopenNeedsConnection',
  'matchEnd.reopenAdminTitle',
  'matchEnd.reopenAdminBody',
  'matchEnd.reopenReason',
  'matchEnd.reopenCheckFailed'
]
const REMOVED = ['unlockPasswordError', 'unlockPasswordPlaceholder', 'unlockPasswordRequired', 'unlockPasswordWrong', 'unlockReopen', 'unlockReopenDescription', 'unlockTooManyAttempts']

const placeholders = (s) => [...String(s).matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map(m => m[1]).sort()

describe('locale keys for accounts, manage, saved teams and cloud blocks', () => {
  const required = [
    ...NAMESPACES.flatMap(ns => flatten(en[ns], ns).map(([k]) => k)),
    ...EXTRA_KEYS
  ]

  it('English has every key of the spec', () => {
    for (const key of SPEC_KEYS) expect(typeof get(en, key), key).toBe('string')
  })

  it.each(Object.keys(LOCALES))('%s has every key as a non-empty string with the same placeholders', (lng) => {
    const missing = []
    for (const key of required) {
      const value = get(LOCALES[lng], key)
      if (typeof value !== 'string' || !value.trim()) missing.push(key)
      else expect(placeholders(value), `${lng} ${key}`).toEqual(placeholders(get(en, key)))
    }
    expect(missing).toEqual([])
  })

  it.each(Object.keys(LOCALES))('%s has none of the removed reopen-password keys', (lng) => {
    for (const k of REMOVED) expect(get(LOCALES[lng], `matchEnd.${k}`), `${lng} matchEnd.${k}`).toBeUndefined()
  })

  it('German uses ss, never ß', () => {
    for (const lng of ['de', 'de-CH']) {
      const offenders = flatten(LOCALES[lng]).filter(([, v]) => String(v).includes('ß')).map(([k]) => k)
      expect(offenders, lng).toEqual([])
    }
  })
})
