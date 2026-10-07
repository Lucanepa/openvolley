import {
  Users, RectangleVertical, ScrollText, NotebookPen, ClipboardList,
  Wrench, UserPen, KeyRound, Download, Settings, OctagonX
} from 'lucide-react'

/**
 * The scorer's "Match" menu (scoreboard toolbar, and the action sheet of the
 * legacy phone layout), grouped instead of one flat list. Most used first,
 * the destructive "Stop the match" alone at the end:
 *
 *   Match info      rosters, sanctions and results, action log, remarks, match setup
 *   Corrections     manual changes, edit home / away roster
 *   Devices & data  PINs, download game data
 *   Settings        options
 *   End of match    stop the match (red; it opens its own confirmation)
 *
 * `actions` holds the handlers (the Scoreboard's own setters); a missing
 * handler drops its row (openMatchSetup only exists when the page offers it).
 * Each item carries a lucide icon component in `Icon`; `column` places the
 * section in the two-column toolbar dropdown.
 *
 * @param {Function} t i18next t
 * @param {Record<string, Function|undefined>} actions
 * @returns {Array<{ key: string, title: string, column: number, danger?: boolean,
 *   items: Array<{ key: string, Icon: any, label: string, onClick: Function, danger?: boolean }> }>}
 */
export function matchMenuSections(t, actions) {
  const row = (key, Icon, label, action, extra = {}) => (action ? [{ key, Icon, label, onClick: action, ...extra }] : [])
  const sections = [
    {
      key: 'info',
      column: 0,
      title: t('scoreboard.menu.sections.matchInfo', 'Match info'),
      items: [
        ...row('rosters', Users, t('scoreboard.showRosters', 'Show rosters'), actions.showRosters),
        ...row('sanctions', RectangleVertical, t('scoreboard.menu.showSanctionsResults', 'Show sanctions and results'), actions.showSanctions),
        ...row('action-log', ScrollText, t('scoreboard.menu.showActionLog', 'Show action log'), actions.showActionLog),
        ...row('remarks', NotebookPen, t('scoreboard.menu.openRemarksRecording', 'Open remarks recording'), actions.openRemarks),
        ...row('match-setup', ClipboardList, t('scoreboard.menu.showMatchSetup', 'Show match setup'), actions.openMatchSetup)
      ]
    },
    {
      key: 'corrections',
      column: 0,
      title: t('scoreboard.menu.sections.corrections', 'Corrections'),
      items: [
        ...row('manual', Wrench, t('corrections.title', 'Corrections'), actions.manualChanges),
        ...row('edit-roster-home', UserPen, t('scoreboard.reopenRoster.menuHome', 'Edit home roster'), actions.editRosterHome),
        ...row('edit-roster-away', UserPen, t('scoreboard.reopenRoster.menuAway', 'Edit away roster'), actions.editRosterAway)
      ]
    },
    {
      key: 'devices',
      column: 1,
      title: t('scoreboard.menu.sections.devicesData', 'Devices and data'),
      items: [
        ...row('pins', KeyRound, t('scoreboard.menu.showPins', 'Show PINs'), actions.showPins),
        ...row('export', Download, t('scoreboard.menu.downloadGameData', 'Download game data (JSON)'), actions.downloadGameData)
      ]
    },
    {
      key: 'settings',
      column: 1,
      title: t('scoreboard.menu.sections.settings', 'Settings'),
      items: [
        ...row('options', Settings, t('scoreboard.menu.options', 'Options'), actions.options)
      ]
    },
    {
      key: 'end',
      column: 1,
      danger: true,
      title: t('scoreboard.menu.sections.endOfMatch', 'End of match'),
      items: [
        ...row('stop-match', OctagonX, t('scoreboard.menu.stopMatch', 'Stop the match'), actions.stopMatch, { danger: true })
      ]
    }
  ]
  return sections.filter(s => s.items.length > 0)
}

/** The sections for MenuList: the icon drawn as an element at the row's size. */
export function toMenuListSections(sections) {
  return sections.map(section => ({
    ...section,
    items: section.items.map(({ Icon, ...item }) => ({ ...item, icon: <Icon size={16} strokeWidth={2} /> }))
  }))
}
