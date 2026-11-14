import { gamesTemplate, rosterTemplate } from '../domain/globalImport'

/** Download the games or the rosters template (an .xlsx made in the browser). */
export async function downloadGlobalTemplate(kind) {
  const codec = await import('../lib/xlsxCodec')
  const bytes = codec.writeWorkbook([kind === 'games' ? gamesTemplate() : rosterTemplate()])
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
  const a = document.createElement('a')
  a.href = url
  a.download = kind === 'games' ? 'openvolley-games.xlsx' : 'openvolley-rosters.xlsx'
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
