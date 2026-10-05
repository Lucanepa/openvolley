/**
 * In-memory stand-in for volleymanager.volleyball.ch, served through an
 * injected fetch. No network: every test that touches the VM client uses this.
 *
 *   const vm = createFakeVolleyManager({ games: [...] })
 *   await runVmSync({ fetch: vm.fetch, baseUrl: vm.baseUrl, ... })
 */

export const FAKE_BASE = 'https://vm.test.invalid'
export const FAKE_USER = 'scorer@example.test'
export const FAKE_PASSWORD = 'pw-S3cret!&=+'
export const FAKE_CSRF = 'csrf-0123456789abcdef0123456789abcdef'
export const FAKE_SESSION_1 = 'sess-anon-aaaaaaaaaaaa'
export const FAKE_SESSION_2 = 'sess-auth-bbbbbbbbbbbb'

const USER_FIELD = '__authentication[Neos][Flow][Security][Authentication][Token][UsernamePassword][username]'
const PASS_FIELD = '__authentication[Neos][Flow][Security][Authentication][Token][UsernamePassword][password]'
export const TRUSTED_PROPERTIES = 'a:1:{s:4:"user";i:1;}'

function html(body, { status = 200, cookies = [], headers = {} } = {}) {
  const h = new Headers({ 'content-type': 'text/html; charset=utf-8', ...headers })
  for (const c of cookies) h.append('set-cookie', c)
  return new Response(body, { status, headers: h })
}

function redirect(location, { status = 303, cookies = [] } = {}) {
  const h = new Headers({ location })
  for (const c of cookies) h.append('set-cookie', c)
  return new Response(null, { status, headers: h })
}

function cookieMap(header) {
  const out = {}
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim()
  }
  return out
}

/**
 * @param {object} o
 * @param {object[]} [o.games]           search items (VM JSON shape)
 * @param {string}   [o.password]        the password the fake accepts
 * @param {number}   [o.failSearchAt]    offset whose search call answers 500 forever
 * @param {number}   [o.transient500]    first N requests of any kind answer 503
 * @param {number}   [o.reportTotal]     totalItemsCount to report (default games.length)
 */
export function createFakeVolleyManager({
  games = [],
  password = FAKE_PASSWORD,
  failSearchAt = null,
  transient500 = 0,
  reportTotal = null
} = {}) {
  const calls = []
  let transientLeft = transient500

  async function fetch(url, init = {}) {
    const u = new URL(url)
    const method = (init.method || 'GET').toUpperCase()
    const headers = new Headers(init.headers || {})
    const body = typeof init.body === 'string' ? init.body : ''
    const cookies = cookieMap(headers.get('cookie'))
    calls.push({ method, path: u.pathname + u.search, cookies, body, redirect: init.redirect })
    if (u.origin !== FAKE_BASE) throw new TypeError(`fake VM: unexpected origin ${u.origin}`)
    if (transientLeft > 0) {
      transientLeft--
      return html('busy', { status: 503 })
    }
    const authed = cookies.Neos_Flow_Session === FAKE_SESSION_2

    if (method === 'GET' && u.pathname === '/login') {
      return html(`<html><title>Login</title><form method="post" action="/sportmanager.security/authentication/authenticate">
        <input type="hidden" name="__referrer[@package]" value="SportManager.Security" />
        <input value="${TRUSTED_PROPERTIES.replace(/"/g, '&quot;')}" type="hidden" name="__trustedProperties" />
        <input type="text" name="${USER_FIELD}" value="" />
        <input type="password" name="${PASS_FIELD}" value="" />
        <input type="checkbox" name="rememberMe" value="1" />
        <input type="submit" name="login" value="Anmelden" />
      </form></html>`, { cookies: [`Neos_Flow_Session=${FAKE_SESSION_1}; Path=/; HttpOnly`] })
    }

    if (method === 'POST' && u.pathname === '/sportmanager.security/authentication/authenticate') {
      const form = new URLSearchParams(body)
      const ok = cookies.Neos_Flow_Session === FAKE_SESSION_1 &&
        form.get(USER_FIELD) === FAKE_USER &&
        form.get(PASS_FIELD) === password &&
        form.get('__trustedProperties') === TRUSTED_PROPERTIES
      if (!ok) return redirect('/login', { status: 303 })
      return redirect(`${FAKE_BASE}/dashboard`, {
        status: 303,
        cookies: [
          `Neos_Flow_Session=${FAKE_SESSION_2}; Path=/; HttpOnly`,
          'tracking=gone; Max-Age=0; Path=/'
        ]
      })
    }

    if (method === 'GET' && u.pathname === '/dashboard') {
      return authed ? html('<html><title>Dashboard</title></html>') : redirect('/login')
    }

    if (method === 'GET' && u.pathname === '/indoorvolleyball.refadmin/refereegame/index') {
      if (!authed) return redirect('/login', { status: 302 })
      return html(`<html><body><div id="app" data-csrf-token="${FAKE_CSRF}"></div></body></html>`)
    }

    if (method === 'POST' && u.pathname.startsWith('/api/indoorvolleyball.refadmin/api%5celasticsearchrefereegame/searchForManagingAssociation')) {
      const form = new URLSearchParams(body)
      if (!authed || form.get('__csrfToken') !== FAKE_CSRF) return redirect('/login', { status: 302 })
      const offset = Number(form.get('searchConfiguration[offset]'))
      const limit = Number(form.get('searchConfiguration[limit]'))
      if (failSearchAt != null && offset === failSearchAt) return html('error', { status: 500 })
      const json = JSON.stringify({ totalItemsCount: reportTotal ?? games.length, items: games.slice(offset, offset + limit) })
      return new Response(json, { status: 200, headers: { 'content-type': 'application/json' } })
    }

    return html('not found', { status: 404 })
  }

  return { fetch, calls, baseUrl: FAKE_BASE }
}

/** A VM search item with the fields transformGame reads. */
export function makeGame(n, {
  startingDateTime = '2026-10-10T16:00:00.000Z',
  leagueName = '3. Liga',
  shortName = '3L',
  gender = 'f',
  groupDisplay = 'Gruppe B',
  home = `Home ${n}`,
  away = `Away ${n}`,
  dob1 = '1990-02-24',
  ...extra
} = {}) {
  return {
    game: {
      number: n,
      startingDateTime,
      encounter: { teamHome: { name: home }, teamAway: { name: away } },
      hall: { name: 'Halle Wiedikon', primaryPostalAddress: { city: 'Zürich', combinedAddress: 'Schulstrasse 1, 8003 Zürich', postalCode: '8003' } },
      group: {
        displayName: groupDisplay,
        phase: { name: 'Qualifikation', league: { gender, numberOfWinSets: 'three_win_sets', leagueCategory: { name: leagueName, shortName } } }
      }
    },
    activeRefereeConvocationFirstHeadReferee: {
      indoorAssociationReferee: { indoorReferee: { person: { displayName: 'Muster Anna', firstName: 'Anna', lastName: 'Muster', formattedAndTimezoneIndependentBirthday: dob1 } } }
    },
    activeSecondHeadRefereeName: 'Beispiel Ben',
    activeFirstLinesmanRefereeName: 'Linie Lea',
    isSupervised: true,
    refereeConvocations: [
      { indoorAssociationReferee: { indoorReferee: { person: { displayName: 'Muster Anna' } } } },
      { indoorAssociationReferee: { indoorReferee: { person: { displayName: null } } } }
    ],
    ...extra
  }
}
