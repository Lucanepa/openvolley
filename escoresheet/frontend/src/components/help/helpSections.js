// The help of the app, per section: one source for the in-app "?" panel
// (ContextualHelpPanel) and for openvolley.app/support, which is organised by
// the same sections (scripts/export-help.mjs writes this file's texts out for
// the website). Plain data (and helpVideos.js, data too): node reads it too.
//
// A section: its FAQ (question / answer i18n keys under contextHelp.*, with
// an optional helpId for "Show me", SpotlightOverlay, and its tooltip key),
// its video (the section id; helpVideos.js lists the recorded ones) and the
// screens that show it. A screen lists its sections, the main one first.

import { HELP_VIDEOS } from './helpVideos.js'

export const SUPPORT_PAGE = 'https://openvolley.app/support'
// <id>.mp4, the poster <id>.jpg and the subtitles <id>.<lang>.vtt
export const VIDEO_BASE = 'https://openvolley.app/support/videos'
// Subtitle tracks of every video, each labelled in its own language
export const VIDEO_LANGUAGES = [
  { lang: 'en', label: 'English' },
  { lang: 'de', label: 'Deutsch' },
  { lang: 'fr', label: 'Français' },
  { lang: 'it', label: 'Italiano' }
]

/** One question: contextHelp.<ns>.q_<name> / a_<name>, tip_<name> with a helpId. */
const q = (ns, name, helpId = null) => ({
  questionKey: `contextHelp.${ns}.q_${name}`,
  answerKey: `contextHelp.${ns}.a_${name}`,
  helpId,
  tooltipKey: helpId ? `contextHelp.${ns}.tip_${name}` : null
})

const section = (id, faq) => ({
  id,
  titleKey: `contextHelp.sections.${id.replace(/-(\w)/g, (_, c) => c.toUpperCase())}`,
  video: id,
  faq
})

export const HELP_SECTIONS = [
  section('home', [
    q('home', 'createMatch', 'home-new-match-button'),
    q('home', 'officialVsTest'),
    q('home', 'continueMatch', 'home-continue-button'),
    q('home', 'backgroundHome'),
    q('home', 'matchStates'),
    q('home', 'deleteMatch', 'home-delete-button'),
    q('home', 'cleanUp'),
    q('home', 'restoreMatch', 'home-restore-button'),
    q('home', 'settings'),
    q('home', 'tool'),
    q('home', 'dashboards'),
    q('home', 'gamePin')
  ]),
  section('setup', [
    q('matchSetup', 'loadSchedule'),
    q('matchSetup', 'matchInfo', 'setup-match-info-card'),
    q('matchSetup', 'officials'),
    q('matchSetup', 'teamColors', 'setup-home-team-card'),
    q('matchSetup', 'teamContact'),
    q('matchSetup', 'pins'),
    q('matchSetup', 'backups'),
    q('matchSetup', 'proceed', 'setup-proceed-cointoss'),
    q('matchSetup', 'afterCoinToss')
  ]),
  // The rosters of Match setup (its "Edit roster"): own section since 3.2.5, setup had 18 questions
  section('rosters', [
    q('matchSetup', 'addPlayers', 'setup-add-player'),
    q('matchSetup', 'importPdf', 'setup-pdf-import'),
    q('matchSetup', 'rosterUpload'),
    q('matchSetup', 'sentRoster'),
    q('matchSetup', 'liberos', 'setup-libero-toggle'),
    q('matchSetup', 'captain', 'setup-captain-toggle'),
    q('matchSetup', 'benchOfficials', 'setup-bench-officials'),
    q('matchSetup', 'rosterSignatures'),
    q('matchSetup', 'clubPlayers')
  ]),
  section('coin-toss', [
    q('coinToss', 'record', 'cointoss-team-selector'),
    q('coinToss', 'sides', 'cointoss-side-selector'),
    q('coinToss', 'serve', 'cointoss-serve-selector'),
    q('coinToss', 'signatures'),
    q('coinToss', 'start', 'cointoss-confirm-button'),
    q('coinToss', 'lineups'),
    q('coinToss', 'gameCaptain'),
    q('coinToss', 'mistake')
  ]),
  section('scoring', [
    q('scoreboard', 'lineup', 'scoreboard-court-left'),
    q('scoreboard', 'coveredLineup'),
    q('scoreboard', 'startRally', 'scoreboard-start-rally'),
    q('scoreboard', 'missingSignature'),
    q('scoreboard', 'awardPoint', 'scoreboard-point-left'),
    q('scoring', 'doubleTap'),
    q('scoring', 'serveRotation'),
    q('scoreboard', 'undo', 'scoreboard-undo'),
    q('scoreboard', 'changeDecision', 'scoreboard-undo'),
    q('scoring', 'scoreDisplay'),
    q('scoreboard', 'shortcuts'),
    q('scoring', 'phone')
  ]),
  section('subs-timeouts', [
    q('scoreboard', 'timeout', 'scoreboard-timeout-left'),
    q('scoreboard', 'substitution', 'scoreboard-court-left'),
    q('subsTimeouts', 'subLimit'),
    q('subsTimeouts', 'injury'),
    q('scoreboard', 'libero', 'scoreboard-bench-left'),
    q('subsTimeouts', 'liberoOut'),
    q('subsTimeouts', 'liberoUnable'),
    q('subsTimeouts', 'captainRing'),
    q('subsTimeouts', 'gameCaptain'),
    q('subsTimeouts', 'benchRequests'),
    q('subsTimeouts', 'requestWarning')
  ]),
  section('sanctions', [
    q('scoreboard', 'sanction', 'scoreboard-court-right'),
    q('sanctions', 'teamSanctions'),
    q('sanctions', 'ladder'),
    q('sanctions', 'penaltyPoint'),
    q('sanctions', 'expulsion'),
    q('sanctions', 'warningOnce'),
    q('sanctions', 'fixSanction'),
    q('sanctions', 'lateRequest')
  ]),
  section('set-end', [
    q('scoreboard', 'setEnd', 'scoreboard-set-display'),
    q('setEnd', 'interval'),
    q('setEnd', 'nextSet'),
    q('scoreboard', 'set5', 'scoreboard-set-display'),
    q('setEnd', 'courtSwitch'),
    q('setEnd', 'syncAtSetEnd'),
    q('setEnd', 'matchEnd')
  ]),
  section('match-end', [
    q('matchEnd', 'reviewResults', 'matchend-results-table'),
    q('matchEnd', 'signatures', 'matchend-signatures'),
    q('matchEnd', 'signOnPhone'),
    q('matchEnd', 'approveWithPin'),
    q('matchEnd', 'approve'),
    q('matchEnd', 'pdfFailed'),
    q('matchEnd', 'exportPdf', 'matchend-export-pdf'),
    q('matchEnd', 'downloadJson', 'matchend-export-json'),
    q('matchEnd', 'closeMatch'),
    q('matchEnd', 'reopenSet', 'matchend-reopen-set'),
    q('matchEnd', 'finalMail'),
    q('matchEnd', 'remarksSignature')
  ]),
  section('corrections', [
    q('manualAdjustments', 'whereCorrections'),
    q('manualAdjustments', 'goBack'),
    q('manualAdjustments', 'editMatchInfo'),
    q('manualAdjustments', 'missedPoint'),
    q('manualAdjustments', 'editScores', 'manual-corrections-tab'),
    q('manualAdjustments', 'editEvents', 'manual-corrections-tab'),
    q('manualAdjustments', 'serveSidesLineup'),
    q('manualAdjustments', 'editTeams', 'manual-teams-tab'),
    q('manualAdjustments', 'saveChanges', 'manual-save-button'),
    q('manualAdjustments', 'signaturesCleared'),
    q('manualAdjustments', 'editRoster')
  ]),
  section('connections', [
    q('connections', 'how'),
    q('connections', 'whichWay'),
    q('connections', 'desktopNeeded'),
    q('connections', 'pageNotLoading'),
    q('connections', 'noInternet'),
    q('connections', 'pin'),
    q('connections', 'hallServer'),
    q('connections', 'hallNetwork'),
    q('connections', 'internetTablets'),
    q('connections', 'testMatch'),
    q('connections', 'connectToServer'),
    q('connections', 'status')
  ]),
  section('referee', [
    q('referee', 'open'),
    q('referee', 'noGames'),
    q('referee', 'view'),
    q('referee', 'shows'),
    q('referee', 'recorded'),
    q('referee', 'offline'),
    q('referee', 'screen'),
    q('referee', 'bell'),
    q('referee', 'scoresheet'),
    q('referee', 'benchRequests'),
    q('referee', 'awaiting'),
    q('referee', 'upright')
  ]),
  section('bench', [
    q('bench', 'open'),
    q('bench', 'shows'),
    q('bench', 'requests'),
    q('bench', 'lineup'),
    q('bench', 'status'),
    q('bench', 'grey'),
    q('bench', 'invalidPin'),
    q('bench', 'outage'),
    q('bench', 'roster')
  ]),
  section('livescore', [
    q('livescore', 'open'),
    q('livescore', 'shows'),
    q('livescore', 'notListed'),
    q('livescore', 'bigScreen'),
    q('livescore', 'stale'),
    q('livescore', 'ledBoard')
  ]),
  section('handover', [
    q('handover', 'continueOther'),
    q('handover', 'gamePin'),
    q('handover', 'oldDevice'),
    q('handover', 'takeBack'),
    q('handover', 'backups'),
    q('handover', 'restoreFile'),
    q('handover', 'restoreRefused'),
    q('handover', 'lostPins')
  ]),
  section('sync-offline', [
    q('syncOffline', 'offlineScoring'),
    q('syncOffline', 'switch'),
    q('syncOffline', 'status'),
    q('syncOffline', 'unsent'),
    q('syncOffline', 'signIn'),
    q('syncOffline', 'closedServer'),
    q('syncOffline', 'movedDevice'),
    q('syncOffline', 'refused'),
    q('syncOffline', 'testMatch')
  ]),
  section('install-updates', [
    q('installUpdates', 'appOrBrowser'),
    q('installUpdates', 'download'),
    q('installUpdates', 'windows'),
    q('installUpdates', 'macos'),
    q('installUpdates', 'android'),
    q('installUpdates', 'desktopUpdates'),
    q('installUpdates', 'webUpdate'),
    q('installUpdates', 'updateNeeded')
  ]),
  // The Global tool (utils/toolMode.js): shown only while the device uses it
  section('global', [
    q('global', 'what'),
    q('global', 'switch'),
    q('global', 'match', 'home-global-match-button'),
    q('global', 'importGames'),
    q('global', 'importRosters'),
    q('global', 'stored'),
    q('global', 'rules'),
    q('global', 'nextToName'),
    q('global', 'backupCode'),
    q('global', 'restore'),
    q('global', 'language')
  ]),
  // The manager console (manager.openvolley.app, and Admin in the app)
  section('club-manager', [
    q('clubManager', 'where'),
    q('clubManager', 'noTab'),
    q('clubManager', 'contact'),
    q('clubManager', 'members'),
    q('clubManager', 'inviteCodes'),
    q('clubManager', 'otherManagers'),
    q('clubManager', 'bell'),
    q('clubManager', 'myTeams'),
    q('clubManager', 'missingTeam')
  ]),
  section('team-links', [
    q('teamLinks', 'what'),
    q('teamLinks', 'create'),
    q('teamLinks', 'once'),
    q('teamLinks', 'limits'),
    q('teamLinks', 'who'),
    q('teamLinks', 'open'),
    q('teamLinks', 'otherAccount')
  ]),
  section('requests', [
    q('requests', 'what'),
    q('requests', 'where'),
    q('requests', 'approve'),
    q('requests', 'propose'),
    q('requests', 'emailFirst'),
    q('requests', 'waiting')
  ]),
  section('team-manager', [
    q('teamManager', 'squad'),
    q('teamManager', 'games'),
    q('teamManager', 'prepare'),
    q('teamManager', 'rules'),
    q('teamManager', 'einsatzliste'),
    q('teamManager', 'signatures'),
    q('teamManager', 'status'),
    q('teamManager', 'change'),
    q('teamManager', 'hall'),
    q('teamManager', 'privacy')
  ]),
  section('club-licences', [
    q('clubLicences', 'what'),
    q('clubLicences', 'upload'),
    q('clubLicences', 'kept'),
    q('clubLicences', 'shields'),
    q('clubLicences', 'addFromClub'),
    q('clubLicences', 'gender'),
    q('clubLicences', 'delete')
  ]),
  section('club-api', [
    q('clubApi', 'what'),
    q('clubApi', 'create'),
    q('clubApi', 'scopes'),
    q('clubApi', 'once'),
    q('clubApi', 'revoke')
  ]),
  section('manager-accounts', [
    q('managerAccounts', 'oneAccount'),
    q('managerAccounts', 'whoSees'),
    q('managerAccounts', 'allSet'),
    q('managerAccounts', 'inviteCode'),
    q('managerAccounts', 'approve'),
    q('managerAccounts', 'club'),
    q('managerAccounts', 'savedTeams')
  ])
]

// Sections only for one tool (utils/toolMode.js): listed on their screens
// only while the device uses that tool, and then first
export const TOOL_SECTIONS = { global: 'global' }

export const SECTION_IDS = HELP_SECTIONS.map(s => s.id)

/**
 * Every screen with a "?" (or a help button in its dialog): the app it
 * belongs to, its name and its sections, the main one first. The scorer app
 * names its pages as App's currentPage does (home, matchSetup, coinToss,
 * scoreboard, matchEnd, manualAdjustments); its dialogs open the panel with
 * their own screen (helpEvents.js openHelp).
 */
export const HELP_SCREENS = {
  home: { app: 'scorer', nameKey: 'contextHelp.pageNames.home', sections: ['home', 'global', 'handover', 'sync-offline', 'install-updates'] },
  matchSetup: { app: 'scorer', nameKey: 'contextHelp.pageNames.matchSetup', sections: ['setup', 'rosters', 'global', 'connections'] },
  coinToss: { app: 'scorer', nameKey: 'contextHelp.pageNames.coinToss', sections: ['coin-toss'] },
  scoreboard: { app: 'scorer', nameKey: 'contextHelp.pageNames.scoreboard', sections: ['scoring', 'subs-timeouts', 'sanctions', 'set-end', 'corrections', 'sync-offline'] },
  matchEnd: { app: 'scorer', nameKey: 'contextHelp.pageNames.matchEnd', sections: ['match-end', 'corrections'] },
  // the Corrections page at the match end (it covers the header: its own help button)
  manualAdjustments: { app: 'scorer', nameKey: 'contextHelp.pageNames.manualAdjustments', sections: ['corrections', 'match-end'] },
  // Match › Corrections during the match (Scoreboard)
  liveCorrections: { app: 'scorer', nameKey: 'contextHelp.pageNames.manualAdjustments', sections: ['corrections', 'scoring', 'sanctions'] },
  // Connect tablets (ConnectTabletsModal: header menu, Options)
  connectTablets: { app: 'scorer', nameKey: 'contextHelp.pageNames.connectTablets', sections: ['connections', 'referee', 'bench', 'livescore'] },
  // Restore match and its Restore preview (App)
  restore: { app: 'scorer', nameKey: 'contextHelp.pageNames.restore', sections: ['handover', 'global', 'sync-offline'] },
  // Scored on another device, with Take back scoring here (ScorerMovedModal)
  takeBack: { app: 'scorer', nameKey: 'contextHelp.pageNames.takeBack', sections: ['handover', 'sync-offline'] },
  // Closed on the server (ClosedOnServerModal)
  closedCopy: { app: 'scorer', nameKey: 'contextHelp.pageNames.closedCopy', sections: ['sync-offline', 'handover'] },
  // RefereeApp (game and PIN) and Referee (the match)
  referee: { app: 'referee', nameKey: 'contextHelp.pageNames.referee', sections: ['referee', 'connections'] },
  bench: { app: 'bench', nameKey: 'contextHelp.pageNames.bench', sections: ['bench', 'connections'] },
  livescore: { app: 'livescore', nameKey: 'contextHelp.pageNames.livescore', sections: ['livescore', 'connections'] },
  // The manager console (ManageConsole: manageHelpScreen picks one by the open page)
  manageMyClub: { app: 'manager', nameKey: 'contextHelp.pageNames.manager', sections: ['club-manager', 'requests', 'team-links', 'club-licences', 'club-api', 'team-manager', 'manager-accounts'] },
  manageMyClubTeams: { app: 'manager', nameKey: 'contextHelp.pageNames.manager', sections: ['team-links', 'club-manager', 'team-manager', 'requests'] },
  manageMyClubLicences: { app: 'manager', nameKey: 'contextHelp.pageNames.manager', sections: ['club-licences', 'club-manager'] },
  manageMyClubApi: { app: 'manager', nameKey: 'contextHelp.pageNames.manager', sections: ['club-api', 'club-manager'] },
  manageMyClubRequests: { app: 'manager', nameKey: 'contextHelp.pageNames.manager', sections: ['requests', 'club-manager'] },
  manageMyTeams: { app: 'manager', nameKey: 'contextHelp.pageNames.manager', sections: ['team-manager', 'team-links', 'requests', 'club-licences'] },
  manageAdmin: { app: 'manager', nameKey: 'contextHelp.pageNames.manager', sections: ['manager-accounts', 'requests', 'club-manager', 'team-links'] }
}

/** The console's help screen for its open tab and My club part (ManageConsole). */
export function manageHelpScreen(tab, part = '') {
  if (tab === 'myclub') {
    return { teams: 'manageMyClubTeams', licences: 'manageMyClubLicences', api: 'manageMyClubApi', requests: 'manageMyClubRequests' }[part] || 'manageMyClub'
  }
  if (tab === 'myteams') return 'manageMyTeams'
  return 'manageAdmin'
}

/** The section with this id, or null. */
export function helpSection(id) {
  return HELP_SECTIONS.find(s => s.id === id) || null
}

/**
 * The sections a screen shows, the main one first ([] for an unknown screen).
 * A tool's own section (TOOL_SECTIONS) only while the device uses that tool
 * (toolMode, utils/toolMode.js), and then first; every section without one.
 */
export function sectionsForScreen(screen, { toolMode } = {}) {
  const ids = HELP_SCREENS[screen]?.sections || []
  if (toolMode === undefined) return ids.map(helpSection).filter(Boolean)
  const own = ids.filter(id => TOOL_SECTIONS[id] && TOOL_SECTIONS[id] === toolMode)
  const rest = ids.filter(id => !TOOL_SECTIONS[id])
  return [...own, ...rest].map(helpSection).filter(Boolean)
}

/** The screens that show a section, its main screen first. */
export function screensForSection(id) {
  const screens = Object.keys(HELP_SCREENS).filter(screen => HELP_SCREENS[screen].sections.includes(id))
  const rank = (screen) => HELP_SCREENS[screen].sections.indexOf(id)
  return screens.sort((a, b) => rank(a) - rank(b))
}

/**
 * The video of a section, null while it has none (helpVideos.js): the file,
 * its poster, its title in each language, its length and picture size (null
 * when unknown), and a subtitle track per language it was recorded with.
 */
export function sectionVideo(id) {
  const recorded = Object.prototype.hasOwnProperty.call(HELP_VIDEOS, id) ? HELP_VIDEOS[id] : null
  if (!recorded) return null
  const base = `${VIDEO_BASE}/${encodeURIComponent(id)}`
  return {
    src: `${base}.mp4`,
    poster: `${base}.jpg`,
    title: recorded.title,
    durationSec: recorded.durationSec,
    width: recorded.width || null,
    height: recorded.height || null,
    tracks: VIDEO_LANGUAGES
      .filter(({ lang }) => recorded.languages.includes(lang))
      .map(({ lang, label }) => ({ lang, label, src: `${base}.${lang}.vtt` }))
  }
}

// The languages of openvolley.app/support (?lang=)
export const SUPPORT_PAGE_LANGUAGES = ['de', 'en', 'fr', 'it']

/**
 * The section on openvolley.app/support, in the app's language when the
 * website has it: supportPageUrl('scoring', 'de-CH') is
 * https://openvolley.app/support?lang=de#scoring (de-CH reads German); a
 * language the website lacks, or none, leaves ?lang= out.
 */
export function supportPageUrl(id, lng) {
  const base = String(lng || '').split('-')[0].toLowerCase()
  const query = SUPPORT_PAGE_LANGUAGES.includes(base) ? `?lang=${base}` : ''
  return `${SUPPORT_PAGE}${query}#${encodeURIComponent(id)}`
}

/** The subtitle language for the app's language: de-CH reads the German track. */
export function videoLanguage(lng) {
  const base = String(lng || 'en').split('-')[0]
  return VIDEO_LANGUAGES.some(v => v.lang === base) ? base : 'en'
}
