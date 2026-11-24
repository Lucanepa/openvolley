/**
 * Imported FIRST by every entry (before App and the rest load): the error
 * reporter is listening while the page's other modules are evaluated, so a
 * page that fails to start is reported too. The tool is guessed from the
 * address here; the entry then names it exactly (setErrorTool).
 */
import { installErrorReporter } from './index'

/** The tool of this page by its host or path (the build per subdomain, or the paths of one build). */
export function guessTool(loc = typeof location !== 'undefined' ? location : null) {
  const host = String(loc?.hostname || '')
  const path = String(loc?.pathname || '')
  const sub = host.split('.')[0]
  if (/^manager(-beach)?$/.test(sub) || /manager(-beach)?(\.html)?$/.test(path)) return 'manager'
  for (const [re, tool] of [[/referee/, 'referee'], [/bench/, 'bench'], [/livescore/, 'livescore'], [/scoresheet/, 'scoresheet'], [/dictate/, 'dictate'], [/roster/, 'roster']]) {
    if (re.test(sub) || re.test(path)) return tool
  }
  return 'scorer'
}

const product = /manager-beach/.test(String(typeof location !== 'undefined' ? location.hostname + location.pathname : '')) ? 'openbeach' : 'openvolley'
installErrorReporter({ tool: guessTool(), product })
