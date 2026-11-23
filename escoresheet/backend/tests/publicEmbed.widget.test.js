/**
 * The club website widget (<ov-livescore>, lib/publicEmbed.js) on the public
 * live snapshot (lib/publicApi.js publicLive), audit round 3:
 *   LOG-12  the set history was printed Team A first under rows that are home
 *           first: mirrored whenever Team A is the away team;
 *   LOG-23  the serve dot never showed: `serving` was the live row's side
 *           (left / right), the widget compares it with A / B (the API's own
 *           words, docs/public-api.md).
 *
 *   cd escoresheet/backend && node --test tests/publicEmbed.widget.test.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { publicLive } from '../lib/publicApi.js'
import { LIVESCORE_JS } from '../lib/publicEmbed.js'

function widget() {
  const make = (tag) => ({ tag, className: '', textContent: '', children: [], appendChild(c) { this.children.push(c); return c } })
  let Live = null
  const g = {
    customElements: { get: () => undefined, define: (_n, c) => { Live = c } },
    document: { createElement: make, currentScript: null },
    HTMLElement: function () {},
    window: {}
  }
  new Function('customElements', 'document', 'HTMLElement', 'window', LIVESCORE_JS)(g.customElements, g.document, g.HTMLElement, g.window)
  return (data) => Live.prototype._card.call({}, data)
}
const find = (node, cls, out = []) => {
  if (node.className === cls) out.push(node)
  for (const c of node.children || []) find(c, cls, out)
  return out
}

// Away is Team A (it won the coin toss); home won set 1 25:20, away set 2 25:22
const row = (over = {}) => ({
  external_id: 'm1', status: 'live', match_status: 'in_progress', current_set: 3, best_of: 5,
  home_team: { name: 'Home Club' }, away_team: { name: 'Away Club' },
  team_a_name: 'Away Club', team_b_name: 'Home Club', sets_won_a: 1, sets_won_b: 1, points_a: 4, points_b: 7,
  side_a: 'right', serving_team: 'left',
  set_results: [{ set: 1, home: 25, away: 20, a: 20, b: 25 }, { set: 2, home: 22, away: 25, a: 25, b: 22 }],
  ...over
})

describe('the widget card', () => {
  it('prints the set history in the rows\' order, home first, also when Team A is away (LOG-12)', () => {
    const data = publicLive(row())
    assert.equal(data.homeIs, 'B')
    const card = widget()(data)
    const rows = find(card, 'r')
    assert.deepEqual(rows.map((r) => find(r, 'n')[0].textContent), ['Home Club', 'Away Club'])
    assert.equal(find(card, 'hist')[0].textContent, '25-20   22-25')
    // home is Team A: as before
    const asA = publicLive(row({ team_a_name: 'Home Club', team_b_name: 'Away Club', set_results: [{ set: 1, home: 25, away: 20, a: 25, b: 20 }] }))
    assert.equal(find(widget()(asA), 'hist')[0].textContent, '25-20')
  })

  it('shows who serves: serving is "A" / "B" from the serving side and side_a (LOG-23)', () => {
    // left serves, Team A (away) stands right: Team B (home) serves
    const data = publicLive(row())
    assert.equal(data.serving, 'B')
    const dots = find(widget()(data), 'r').map((r) => r.children[0].className)
    assert.deepEqual(dots, ['d s', 'd']) // home row first
    assert.equal(publicLive(row({ serving_team: 'right' })).serving, 'A')
    assert.equal(publicLive(row({ side_a: null })).serving, null)
    assert.equal(publicLive(row({ serving_team: 'A' })).serving, 'A') // an older row's own letter
  })
})
