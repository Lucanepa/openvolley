/*
 * Pair a phone, the phone's page (docs/phone-keyboard-spec.md). Opened from
 * the QR code (/pair#k=<token>) or at /pair with the short code typed in. The
 * token leaves the address bar at once; POST /api/pair/join answers this
 * phone's own secret, kept in sessionStorage only. Then:
 *   POST /api/pair/poll  (long-poll) the text field selected on the scoring
 *                        device: its label, kind and current text
 *   POST /api/pair/input what is typed here (the field's whole text, so the
 *                        phone's autocorrect and word suggestions just work),
 *                        and the Previous / Next field / Enter keys
 * One request in flight at a time; a newer text replaces an unsent one.
 * No cookies, no localStorage, no fonts, no external request.
 */
(function () {
  'use strict'

  var KEY_P = 'ov_pair_p'
  var KEY_N = 'ov_pair_n'
  var KEY_C = 'ov_pair_ctx'
  var TOKEN_RE = /[#&]k=([A-Za-z0-9_-]{43})(?:&|$)/
  var SEND_DELAY_MS = 60
  var QUIET_MS = 700 // the tablet's text does not overwrite what was typed this recently
  var RETRY_MS = 2000

  var STR = {
    en: {
      joinTitle: 'Pair with the scoring device', joinHint: 'Type the code the tablet shows under the QR code.', code: 'Code',
      connect: 'Connect', connecting: 'Connecting…', match: 'Match #{n}', connected: 'Connected', reconnecting: 'Reconnecting…',
      typingInto: 'Typing into', noField: 'Tap a text field on the tablet', noFieldHint: 'What you type here appears in the selected field there.',
      field: 'Text field', prev: 'Previous', next: 'Next field', enter: 'Enter', tooLong: 'That is more than this field takes.',
      slow: 'Too fast – sending in a moment…', unreachable: 'Can’t reach the scoring device. Check the connection; trying again…',
      badCode: 'This code is not valid. Check it on the tablet.', invalid: 'This link or code is not valid.',
      used: 'Another phone is already paired with this tablet.', closed: 'The tablet ended the pairing. You can close this page.',
      expired: 'This pairing has ended. Pair again from the tablet.', again: 'Pair again', count: '{n} / {max}'
    },
    de: {
      joinTitle: 'Mit dem Schreibergerät verbinden', joinHint: 'Gib den Code ein, den das Tablet unter dem QR-Code zeigt.', code: 'Code',
      connect: 'Verbinden', connecting: 'Wird verbunden…', match: 'Spiel #{n}', connected: 'Verbunden', reconnecting: 'Neu verbinden…',
      typingInto: 'Du schreibst in', noField: 'Tippe auf dem Tablet in ein Textfeld', noFieldHint: 'Was du hier schreibst, erscheint dort im gewählten Feld.',
      field: 'Textfeld', prev: 'Zurück', next: 'Nächstes Feld', enter: 'Enter', tooLong: 'Das ist mehr, als dieses Feld fasst.',
      slow: 'Zu schnell – wird gleich gesendet…', unreachable: 'Das Schreibergerät ist nicht erreichbar. Prüfe die Verbindung; neuer Versuch…',
      badCode: 'Dieser Code ist ungültig. Prüfe ihn auf dem Tablet.', invalid: 'Dieser Link oder Code ist ungültig.',
      used: 'Mit diesem Tablet ist schon ein anderes Handy verbunden.', closed: 'Das Tablet hat die Verbindung beendet. Du kannst diese Seite schliessen.',
      expired: 'Diese Verbindung ist abgelaufen. Verbinde dich neu über das Tablet.', again: 'Neu verbinden', count: '{n} / {max}'
    },
    'de-CH': {
      joinTitle: 'Mit em Schriibergrät verbinde', joinHint: 'Gib de Code ii, wo s Tablet under em QR-Code zeigt.', code: 'Code',
      connect: 'Verbinde', connecting: 'Wird verbunde…', match: 'Spiel #{n}', connected: 'Verbunde', reconnecting: 'Neu verbinde…',
      typingInto: 'Du schriibsch in', noField: 'Tipp uf em Tablet in es Textfäld', noFieldHint: 'Was du da schriibsch, chunnt det im gwählte Fäld.',
      field: 'Textfäld', prev: 'Zrugg', next: 'Nächscht Fäld', enter: 'Enter', tooLong: 'Das isch meh, als das Fäld fasst.',
      slow: 'Z schnäll – wird grad gschickt…', unreachable: 'S Schriibergrät isch nöd erreichbar. Prüef d Verbindig; neue Versuech…',
      badCode: 'De Code isch ungültig. Prüef en uf em Tablet.', invalid: 'De Link oder Code isch ungültig.',
      used: 'Mit dem Tablet isch scho es anders Handy verbunde.', closed: 'S Tablet hät d Verbindig beändet. Du chasch die Siite zuemache.',
      expired: 'Die Verbindig isch abgloffe. Verbind di neu übers Tablet.', again: 'Neu verbinde', count: '{n} / {max}'
    },
    fr: {
      joinTitle: 'Connecter à l’appareil du marqueur', joinHint: 'Tape le code que la tablette affiche sous le code QR.', code: 'Code',
      connect: 'Connecter', connecting: 'Connexion…', match: 'Match n° {n}', connected: 'Connecté', reconnecting: 'Reconnexion…',
      typingInto: 'Tu écris dans', noField: 'Touche un champ de texte sur la tablette', noFieldHint: 'Ce que tu écris ici apparaît dans le champ choisi là-bas.',
      field: 'Champ de texte', prev: 'Précédent', next: 'Champ suivant', enter: 'Entrée', tooLong: 'C’est plus que ce que ce champ accepte.',
      slow: 'Trop rapide – envoi dans un instant…', unreachable: 'Appareil du marqueur injoignable. Vérifie la connexion ; nouvel essai…',
      badCode: 'Ce code n’est pas valide. Vérifie-le sur la tablette.', invalid: 'Ce lien ou ce code n’est pas valide.',
      used: 'Un autre téléphone est déjà connecté à cette tablette.', closed: 'La tablette a mis fin à la connexion. Tu peux fermer cette page.',
      expired: 'Cette connexion a expiré. Reconnecte-toi depuis la tablette.', again: 'Reconnecter', count: '{n} / {max}'
    },
    it: {
      joinTitle: 'Collega al dispositivo del segnapunti', joinHint: 'Digita il codice che il tablet mostra sotto il codice QR.', code: 'Codice',
      connect: 'Collega', connecting: 'Collegamento…', match: 'Partita n. {n}', connected: 'Collegato', reconnecting: 'Ricollegamento…',
      typingInto: 'Stai scrivendo in', noField: 'Tocca un campo di testo sul tablet', noFieldHint: 'Quello che scrivi qui appare nel campo scelto là.',
      field: 'Campo di testo', prev: 'Indietro', next: 'Campo successivo', enter: 'Invio', tooLong: 'È più di quanto questo campo accetta.',
      slow: 'Troppo veloce – invio tra un attimo…', unreachable: 'Dispositivo del segnapunti non raggiungibile. Controlla la connessione; nuovo tentativo…',
      badCode: 'Questo codice non è valido. Controllalo sul tablet.', invalid: 'Questo link o codice non è valido.',
      used: 'Un altro telefono è già collegato a questo tablet.', closed: 'Il tablet ha chiuso il collegamento. Puoi chiudere questa pagina.',
      expired: 'Questo collegamento è scaduto. Ricollegati dal tablet.', again: 'Ricollega', count: '{n} / {max}'
    }
  }

  /** The first browser language we have: de-CH (and Swiss German), other de-* -> de, fr, it, en. */
  function pickLang(list) {
    for (var i = 0; i < list.length; i++) {
      var l = String(list[i] || '').toLowerCase()
      if (l === 'de-ch' || l === 'gsw' || l.indexOf('gsw-') === 0) return 'de-CH'
      var base = l.split('-')[0]
      if (base === 'de' || base === 'fr' || base === 'it' || base === 'en') return base
    }
    return null
  }

  var $ = function (id) { return document.getElementById(id) }
  var page = document.querySelector('.page')
  var ta = $('text')
  var browserLang = pickLang((navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language]) || [])
  var lang = browserLang || 'en'
  var S = STR[lang]
  var APP_NAMES = { beach: 'OpenBeach' }

  var phone = null
  var v = null // version of the field state we hold
  var field = null // { id, label, kind, text, maxLength } | null
  var applied = 0 // the scoring device's last applied input
  var lastSent = 0 // our last input it took
  var inflight = false
  var dirty = false
  var actions = []
  var lastTypedAt = 0
  var ended = false
  var flushTimer = null
  var known = '' // the field's text as the scoring device has it, as far as this phone knows (the base of the next input)

  function fmt(text, vars) {
    return String(text).replace(/\{(\w+)\}/g, function (_, k) { return vars && vars[k] != null ? vars[k] : '' })
  }
  function storage(fn) { try { return fn(window.sessionStorage) } catch (e) { return null } }
  // FNV-1a over the UTF-16 code units, 8 hex: the scoring device's utils/phonePair/merge.js textHash
  function textHash(text) {
    var h = 0x811c9dc5
    var s = String(text)
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
    return ('0000000' + h.toString(16)).slice(-8)
  }
  function cps(s) { return Array.from(s).length }

  function setStatus(text, tone) {
    var el = $('status')
    el.textContent = text || ''
    el.className = 'status' + (tone ? ' ' + tone : '')
  }

  function applyStrings() {
    document.documentElement.lang = lang
    $('joinTitle').textContent = S.joinTitle
    $('joinHint').textContent = S.joinHint
    $('codeLabel').textContent = S.code
    $('joinBtn').textContent = S.connect
    $('fieldCaption').textContent = S.typingInto
    $('prev').textContent = S.prev
    $('next').textContent = S.next
    $('enter').textContent = S.enter
    $('again').textContent = S.again
  }

  function applyApp(name) {
    if (!name || !Object.prototype.hasOwnProperty.call(APP_NAMES, name)) return
    var marks = document.querySelectorAll('.brand')
    for (var i = 0; i < marks.length; i++) marks[i].hidden = marks[i].getAttribute('data-app') !== name
    document.title = APP_NAMES[name]
  }

  function applyContext(ctx) {
    if (!ctx) return
    if (!browserLang && ctx.lang && STR[ctx.lang]) { lang = ctx.lang; S = STR[lang]; applyStrings() }
    var parts = []
    if (ctx.matchNo) parts.push(fmt(S.match, { n: ctx.matchNo }))
    if (ctx.home && ctx.away) parts.push(ctx.home + ' – ' + ctx.away)
    if (ctx.when) parts.push(ctx.when)
    $('match').textContent = parts.join(' · ')
  }

  function show(state) {
    page.setAttribute('data-state', state)
    $('join').hidden = state !== 'join'
    $('type').hidden = state !== 'paired'
    $('end').hidden = state !== 'ended'
  }

  function end(kind) {
    ended = true
    phone = null
    storage(function (s) { s.removeItem(KEY_P); s.removeItem(KEY_N); s.removeItem(KEY_C) })
    $('endText').textContent = S[kind] || S.invalid
    $('again').hidden = false
    setStatus('')
    show('ended')
  }

  function setConnected(on) {
    var pill = $('conn')
    pill.textContent = on ? S.connected : S.reconnecting
    pill.className = 'pill' + (on ? '' : ' off')
  }

  function api(path, body) {
    return fetch('/api/pair/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer'
    }).then(function (res) {
      return res.json().catch(function () { return {} }).then(function (json) {
        return { status: res.status, body: json || {}, retry: Number(res.headers.get('Retry-After')) || 0 }
      })
    })
  }

  var END_OF = { OV_PAIR_NOT_FOUND: 'invalid', OV_PAIR_USED: 'used', OV_PAIR_CANCELLED: 'closed', OV_PAIR_EXPIRED: 'expired' }

  // --- join ------------------------------------------------------------------

  function join(body, fromLink, tries) {
    setStatus(S.connecting)
    $('joinBtn').disabled = true
    api('join', body).then(function (r) {
      $('joinBtn').disabled = false
      if (r.status === 200 && r.body.ok && r.body.phone) {
        phone = r.body.phone
        storage(function (s) { s.setItem(KEY_P, phone); s.setItem(KEY_N, '0'); s.setItem(KEY_C, JSON.stringify({ c: r.body.context || null, app: r.body.app || null })) })
        applyApp(r.body.app)
        applyContext(r.body.context)
        enterPaired()
        return
      }
      var code = r.body && r.body.code
      if (code === 'OV_PAIR_RATE_LIMITED') { setStatus(S.slow, 'warn'); return }
      if (!fromLink && code === 'OV_PAIR_NOT_FOUND') { setStatus(S.badCode, 'error'); show('join'); return }
      end(END_OF[code] || 'invalid')
    }, function () {
      $('joinBtn').disabled = false
      setStatus(S.unreachable, 'warn')
      if (fromLink && (tries || 0) < 5) setTimeout(function () { join(body, true, (tries || 0) + 1) }, RETRY_MS)
      else if (!fromLink) show('join')
    })
  }

  $('joinForm').addEventListener('submit', function (e) {
    e.preventDefault()
    var code = $('code').value.toUpperCase().replace(/[\s-]/g, '')
    if (code.length !== 8) { setStatus(S.badCode, 'error'); return }
    join({ code: code }, false)
  })
  $('again').addEventListener('click', function () {
    ended = false
    $('again').hidden = true
    $('match').textContent = ''
    setStatus('')
    show('join')
  })

  // --- paired ------------------------------------------------------------------

  function enterPaired() {
    ended = false
    v = null
    field = null
    setStatus('')
    setConnected(true)
    show('paired')
    renderField(null)
    pollLoop()
  }

  function renderField(f) {
    $('fieldLabel').textContent = f ? (f.label || S.field) : S.noField
    $('fieldCaption').hidden = !f
    ta.disabled = !f
    ta.placeholder = f ? '' : S.noFieldHint
    ta.setAttribute('data-kind', f ? f.kind : 'line')
    ta.setAttribute('aria-label', f ? (f.label || S.field) : S.noField)
    $('prev').disabled = !f
    $('next').disabled = !f
    $('enter').hidden = !f || f.kind !== 'line'
    renderCount()
  }

  function renderCount() {
    var el = $('count')
    if (!field) { el.textContent = ''; return }
    var n = cps(ta.value)
    el.textContent = field.maxLength < 8000 || n > field.maxLength * 0.8 ? fmt(S.count, { n: n, max: field.maxLength }) : ''
  }

  function setText(text) {
    var atEnd = ta.selectionStart === ta.value.length
    var pos = ta.selectionStart
    ta.value = text
    var p = atEnd ? text.length : Math.min(pos, text.length)
    try { ta.setSelectionRange(p, p) } catch (e) { /* not focused */ }
  }

  function applyRemote(b) {
    v = b.v
    applied = b.applied || 0
    var f = b.field
    if (!f) {
      field = null
      ta.value = ''
      renderField(null)
      return
    }
    if (!field || field.id !== f.id) {
      field = f
      dirty = false
      actions = []
      ta.value = f.text || ''
      known = ta.value
      renderField(f)
      if (document.activeElement === ta || document.hasFocus()) {
        try { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length) } catch (e) { /* ignore */ }
      }
      return
    }
    field = f
    renderField(f)
    adopt()
  }

  // The scoring device's text into this page, unless this phone is typing or
  // waits for its own text to arrive there: then again once it is quiet
  var adoptTimer = null
  function adopt() {
    if (adoptTimer) { clearTimeout(adoptTimer); adoptTimer = null }
    if (!field) return
    var wait = QUIET_MS - (Date.now() - lastTypedAt)
    if (inflight || dirty || applied < lastSent || wait > 0) {
      adoptTimer = setTimeout(adopt, Math.max(wait, 150))
      return
    }
    if (ta.value !== field.text) setText(field.text || '')
    known = field.text || ''
    renderCount()
  }

  function pollLoop() {
    if (!phone || ended) return
    var body = { phone: phone }
    if (v != null) body.known = v
    api('poll', body).then(function (r) {
      if (ended) return
      if (r.status === 200 && r.body.ok) {
        if (r.body.state === 'closed' || r.body.state === 'expired') { end(r.body.state); return }
        setConnected(true)
        applyRemote(r.body)
        pollLoop()
        return
      }
      if (r.status === 404) { end('invalid'); return }
      setConnected(false)
      setTimeout(pollLoop, r.status === 429 ? Math.max(1, r.retry) * 1000 : RETRY_MS)
    }, function () {
      setConnected(false)
      setTimeout(pollLoop, RETRY_MS)
    })
  }

  function nextN() {
    var stored = Number(storage(function (s) { return s.getItem(KEY_N) })) || 0
    var n = Math.max(stored, lastSent) + 1
    storage(function (s) { s.setItem(KEY_N, String(n)) })
    return n
  }

  function scheduleFlush(ms) {
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = setTimeout(function () { flushTimer = null; flush() }, ms)
  }

  function flush() {
    if (inflight || !phone || !field || ended) return
    if (!dirty && !actions.length) return
    var body = { phone: phone, n: nextN(), field: field.id }
    var sentText = dirty
    if (dirty) { body.text = ta.value; body.base = textHash(known); dirty = false }
    var action = actions.length ? actions.shift() : null
    if (action) body.action = action
    inflight = true
    api('input', body).then(function (r) {
      inflight = false
      if (r.status === 200 && r.body.ok) {
        lastSent = body.n
        if (sentText) known = body.text
        if (!$('status').classList.contains('error')) setStatus('')
      } else {
        var code = r.body && r.body.code
        if (END_OF[code] && code !== 'OV_PAIR_NOT_FOUND') { end(END_OF[code]); return }
        if (r.status === 404) { end('invalid'); return }
        if (code === 'OV_PAIR_TEXT_TOO_LONG') setStatus(S.tooLong, 'error')
        else if (code === 'OV_PAIR_RATE_LIMITED') {
          if (sentText) dirty = true
          if (action) actions.unshift(action)
          setStatus(S.slow, 'warn')
          scheduleFlush(Math.max(1, r.retry) * 1000)
          return
        }
        // OV_PAIR_STALE / OV_PAIR_NO_FIELD: another field is selected now; the poll brings it
      }
      if (dirty || actions.length) flush()
    }, function () {
      inflight = false
      if (sentText) dirty = true
      if (action) actions.unshift(action)
      setConnected(false)
      setStatus(S.unreachable, 'warn')
      scheduleFlush(RETRY_MS)
    })
  }

  ta.addEventListener('input', function () {
    if (!field) return
    lastTypedAt = Date.now()
    if (cps(ta.value) > field.maxLength) {
      setText(Array.from(ta.value).slice(0, field.maxLength).join(''))
      setStatus(S.tooLong, 'error')
    } else if ($('status').classList.contains('error')) setStatus('')
    dirty = true
    renderCount()
    scheduleFlush(SEND_DELAY_MS)
  })
  ta.addEventListener('keydown', function (e) {
    // a one-line field: Enter is the tablet's Enter, not a new line
    if (e.key === 'Enter' && field && field.kind === 'line' && !e.isComposing) {
      e.preventDefault()
      actions.push('enter')
      scheduleFlush(0)
    }
  })
  function key(id, action) {
    var b = $(id)
    // keep the phone's keyboard open: the button never takes the focus
    b.addEventListener('pointerdown', function (e) { if (document.activeElement === ta) e.preventDefault() })
    b.addEventListener('click', function () {
      if (!field) return
      actions.push(action)
      scheduleFlush(0)
    })
  }
  key('prev', 'prev')
  key('next', 'next')
  key('enter', 'enter')

  // --- boot --------------------------------------------------------------------

  applyStrings()
  var m = TOKEN_RE.exec(location.hash || '')
  if (location.hash) {
    try { history.replaceState(null, '', location.pathname + location.search) } catch (e) { /* ignore */ }
  }
  var stored = storage(function (s) { return s.getItem(KEY_P) })
  if (m) {
    show('loading')
    join({ k: m[1] }, true)
  } else if (stored && /^[A-Za-z0-9_-]{43}$/.test(stored)) {
    phone = stored
    var kept = null
    try { kept = JSON.parse(storage(function (s) { return s.getItem(KEY_C) }) || 'null') } catch (e) { kept = null }
    if (kept) { applyApp(kept.app); applyContext(kept.c) }
    enterPaired()
  } else {
    show('join')
  }
})()
