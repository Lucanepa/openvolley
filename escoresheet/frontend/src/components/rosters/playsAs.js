/**
 * The choices of a bench official's "Plays as" (domain/playerOfficials), for
 * the roster editors (Match setup, Edit home / away roster): '' automatic
 * (the player found by licence or name, none when nobody is), 'none' not a
 * player, then every player of the team by number ("#7 Fischer").
 * @param {Array} players the team's players ({ number, lastName })
 * @param {Function} t i18next
 * @returns {Array<{ value: string, label: string }>}
 */
export function playsAsOptions(players, t) {
  const sorted = [...(players || [])]
    .filter(p => p && p.number !== '' && p.number !== null && p.number !== undefined)
    .sort((a, b) => (Number(a.number) || 0) - (Number(b.number) || 0))
  return [
    { value: '', label: '–' },
    { value: 'none', label: t('matchSetup.playsAsNone', 'Not a player') },
    ...sorted.map(p => ({ value: String(p.number), label: `#${p.number}${p.lastName ? ` ${p.lastName}` : ''}` }))
  ]
}
