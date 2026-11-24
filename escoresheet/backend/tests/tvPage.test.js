// Tests for lib/tvPage.js (the live page any screen can open, smart TVs included).
//   cd escoresheet/backend && node --test tests/tvPage.test.js
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { tvPageHtml, tvEntryHtml, TV_JS } from '../lib/tvPage.js'

describe('tvPage', () => {
  it('the page names its code, loads only /tv/tv.js and has no inline script (CSP script-src self)', () => {
    const html = tvPageHtml('ABCD2345')
    assert.match(html, /data-code="ABCD2345"/)
    assert.match(html, /<script src="\/tv\/tv\.js"><\/script>/)
    assert.equal((html.match(/<script/g) || []).length, 1)
    assert.equal(/<script>[^<]/.test(html), false)
    assert.equal(tvPageHtml('AB"><x').includes('"><x'), false) // whatever is passed, nothing breaks out
  })

  it('the page CSS needs no grid and no custom properties (old TV engines)', () => {
    const html = tvPageHtml('ABCD2345')
    assert.equal(/display:\s*grid|var\(--/.test(html), false)
  })

  it('the script is ES5: no arrow functions, template literals, let/const, classes, spread, fetch or promises', () => {
    new vm.Script(TV_JS) // it parses
    const code = TV_JS.replace(/'(?:[^'\\]|\\.)*'/g, "''") // ignore string contents
    for (const [what, re] of [['arrow', /=>/], ['template literal', /`/], ['let', /\blet\s/], ['const', /\bconst\s/], ['class', /\bclass\s/], ['spread', /\.\.\./], ['fetch', /\bfetch\(/], ['Promise', /\bPromise\b/], ['async', /\basync\b/], ['for-of', /\bfor\s*\([^)]*\bof\b/]]) {
      assert.equal(re.test(code), false, what)
    }
  })

  it('the script reads its data from the same origin only, from what the page names', () => {
    assert.match(TV_JS, /x\.open\('GET', src \+/)
    assert.match(TV_JS, /getAttribute\('data-src'\)/)
    assert.equal(/https?:\/\//.test(TV_JS), false)
  })
})

describe('tvEntryHtml', () => {
  it('is a plain GET form to /tv/go: no script at all (any TV browser)', () => {
    const html = tvEntryHtml()
    assert.match(html, /<form action="\/tv\/go" method="get">/)
    assert.match(html, /<input name="code"/)
    assert.equal(/<script/.test(html), false)
    assert.equal(html.includes('{{ERROR}}'), false)
    assert.equal(html.includes('class="err"'), false)
    assert.match(tvEntryHtml({ wrong: true }), /class="err"/)
  })
})

describe('tvPageHtml: one court, one game', () => {
  it('names what to poll and what to show', () => {
    assert.match(tvPageHtml({ code: 'ABCD2345', screen: 2 }), /data-src="\/api\/global\/live\/ABCD2345\?screen=2" data-label="ABCD 2345 \u00b7 2"/)
    assert.match(tvPageHtml({ game: '4242' }), /data-src="\/api\/global\/live\/game\/4242" data-label="#4242"/)
    assert.match(tvPageHtml('ABCD2345'), /data-src="\/api\/global\/live\/ABCD2345" data-label="ABCD 2345"/)
    assert.equal(tvPageHtml({ game: '42"><x' }).includes('"><x'), false)
    assert.equal(/\{\{[A-Z]+\}\}/.test(tvPageHtml({ code: 'ABCD2345' })), false)
  })

  it('the entry form also takes a game number and an optional court', () => {
    const html = tvEntryHtml()
    assert.match(html, /<input name="court"/)
    assert.match(html, /game number/)
  })
})
