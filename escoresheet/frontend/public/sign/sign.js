/*
 * Sign on phone, the phone's page (docs/qr-signing-spec.md 6). Opened from the
 * QR code: /sign#k=<token>. The token goes to sessionStorage and leaves the
 * address bar at once (no screenshot or shared tab carries it), then
 * POST /api/sign/open names the slot and the match, the signer draws and
 * POST /api/sign/submit sends the pen strokes (never an image) in pad
 * coordinates: x 0..4000, y 0..pad.h, integers. The scoring device draws them.
 * No cookies, no localStorage, no fonts, no external request.
 */
(function () {
  'use strict'

  var W = 4000
  var MAX_STROKES = 300
  var MAX_STROKE_POINTS = 1000
  var MAX_POINTS = 4000
  var MIN_STEP = 8 // units between kept points
  var MIN_INK = 0.06 * W
  var KEY = 'ov_sign_k'
  var TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

  var STR = {
    en: {
      title: 'Sign as {role}', captainOf: 'captain of {team}', coachOf: 'coach of {team}', scorer: 'scorer',
      asstScorer: 'assistant scorer', ref1: '1st referee', ref2: '2nd referee', team: 'Team {l}', match: 'Match #{n}',
      hint: 'Sign here', clear: 'Clear', done: 'Done', pad: 'Signature pad', loading: 'Opening…', sending: 'Sending…',
      sent: 'Signature sent. You can close this page.', sendFailed: 'Couldn’t send. Check the connection and tap Done again.',
      openFailed: 'Can’t reach the scoring device. Check the connection; trying again…',
      expired: 'This link has expired. Ask for a new QR code.', used: 'This link was already used.',
      cancelled: 'Signing was cancelled on the scoring device.', invalid: 'This link is not valid.', full: 'The pad is full. Tap Done, or Clear to start again.'
    },
    de: {
      title: 'Unterschreiben als {role}', captainOf: 'Captain von {team}', coachOf: 'Coach von {team}', scorer: 'Schreiber/in',
      asstScorer: 'Hilfsschreiber/in', ref1: '1. Schiedsrichter/in', ref2: '2. Schiedsrichter/in', team: 'Team {l}', match: 'Spiel #{n}',
      hint: 'Hier unterschreiben', clear: 'Löschen', done: 'Fertig', pad: 'Unterschriftsfeld', loading: 'Wird geöffnet…', sending: 'Wird gesendet…',
      sent: 'Unterschrift gesendet. Du kannst diese Seite schließen.', sendFailed: 'Senden fehlgeschlagen. Verbindung prüfen und nochmals auf Fertig tippen.',
      openFailed: 'Das Gerät des Schreibers ist nicht erreichbar. Verbindung prüfen; neuer Versuch…',
      expired: 'Dieser Link ist abgelaufen. Nach einem neuen QR-Code fragen.', used: 'Dieser Link wurde schon verwendet.',
      cancelled: 'Das Unterschreiben wurde am Schreibergerät abgebrochen.', invalid: 'Dieser Link ist ungültig.', full: 'Das Feld ist voll. Auf Fertig tippen oder Löschen, um neu zu beginnen.'
    },
    'de-CH': {
      title: 'Underschriibe als {role}', captainOf: 'Captain vo {team}', coachOf: 'Coach vo {team}', scorer: 'Schriiber/in',
      asstScorer: 'Hilfsschriiber/in', ref1: '1. Schiri', ref2: '2. Schiri', team: 'Team {l}', match: 'Spiel #{n}',
      hint: 'Da underschriibe', clear: 'Lösche', done: 'Fertig', pad: 'Underschriftsfäld', loading: 'Wird ufgmacht…', sending: 'Wird gschickt…',
      sent: 'Underschrift gschickt. Du chasch die Siite zuemache.', sendFailed: 'Schicke hät nöd klappt. Verbindig prüefe und nomal uf Fertig tippe.',
      openFailed: 'S Grät vom Schriiber isch nöd erreichbar. Verbindig prüefe; neue Versuech…',
      expired: 'De Link isch abgloffe. Nach emne neue QR-Code fröge.', used: 'De Link isch scho bruucht worde.',
      cancelled: 'S Underschriibe isch am Schriibergrät abbroche worde.', invalid: 'De Link isch nöd gültig.', full: 'S Fäld isch voll. Uf Fertig tippe oder Lösche, zum neu afange.'
    },
    fr: {
      title: 'Signer comme {role}', captainOf: 'capitaine de {team}', coachOf: 'entraîneur de {team}', scorer: 'marqueur',
      asstScorer: 'marqueur assistant', ref1: '1er arbitre', ref2: '2e arbitre', team: 'l’équipe {l}', match: 'Match n° {n}',
      hint: 'Signer ici', clear: 'Effacer', done: 'Terminé', pad: 'Zone de signature', loading: 'Ouverture…', sending: 'Envoi…',
      sent: 'Signature envoyée. Vous pouvez fermer cette page.', sendFailed: 'Échec de l’envoi. Vérifiez la connexion et touchez Terminé à nouveau.',
      openFailed: 'Appareil du marqueur injoignable. Vérifiez la connexion ; nouvel essai…',
      expired: 'Ce lien a expiré. Demandez un nouveau code QR.', used: 'Ce lien a déjà été utilisé.',
      cancelled: 'La signature a été annulée sur l’appareil du marqueur.', invalid: 'Ce lien n’est pas valide.', full: 'La zone est pleine. Touchez Terminé, ou Effacer pour recommencer.'
    },
    it: {
      title: 'Firma come {role}', captainOf: 'capitano di {team}', coachOf: 'allenatore di {team}', scorer: 'segnapunti',
      asstScorer: 'segnapunti assistente', ref1: '1° arbitro', ref2: '2° arbitro', team: 'squadra {l}', match: 'Partita n. {n}',
      hint: 'Firma qui', clear: 'Cancella', done: 'Fatto', pad: 'Area firma', loading: 'Apertura…', sending: 'Invio…',
      sent: 'Firma inviata. Puoi chiudere questa pagina.', sendFailed: 'Invio non riuscito. Controlla la connessione e tocca di nuovo Fatto.',
      openFailed: 'Dispositivo del segnapunti non raggiungibile. Controlla la connessione; nuovo tentativo…',
      expired: 'Questo link è scaduto. Chiedi un nuovo codice QR.', used: 'Questo link è già stato usato.',
      cancelled: 'La firma è stata annullata sul dispositivo del segnapunti.', invalid: 'Questo link non è valido.', full: 'L’area è piena. Tocca Fatto, o Cancella per ricominciare.'
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
  var canvas = $('pad')
  var ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null
  var browserLang = pickLang((navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language]) || [])
  var lang = browserLang || 'en'
  var S = STR[lang]
  var token = null
  var padH = 0
  var strokes = [] // [[x0, y0, x1, y1, ...], ...] in pad units
  var points = 0
  var current = null
  var activePointer = null
  var full = false
  var view = { w: 0, h: 0, s: 1, ox: 0, oy: 0, dpr: 1 }
  var state = 'loading'
  var openTries = 0
  var lost = false // a Done without an answer: it may have arrived

  function fmt(text, vars) {
    return String(text).replace(/\{(\w+)\}/g, function (_, k) { return vars && vars[k] != null ? vars[k] : '' })
  }

  function storage(fn) {
    try { return fn(window.sessionStorage) } catch (e) { return null }
  }

  // The app the session names (open's `app`; the cloud backend sets it from the
  // match's sport): its name and mark instead of OpenVolley's. Known names only.
  var APP_NAMES = { beach: 'OpenBeach' }
  var app = null

  function applyApp(name) {
    if (!name || !Object.prototype.hasOwnProperty.call(APP_NAMES, name)) return
    app = name
    var marks = document.querySelectorAll('.brand')
    for (var i = 0; i < marks.length; i++) marks[i].hidden = marks[i].getAttribute('data-app') !== name
    document.title = APP_NAMES[name]
  }

  function setStatus(text, tone) {
    var el = $('status')
    el.textContent = text || ''
    el.className = 'status' + (tone ? ' ' + tone : '')
  }

  function applyStrings() {
    document.documentElement.lang = lang
    $('clear').textContent = S.clear
    $('done').textContent = S.done
    $('hint').textContent = S.hint
    canvas.setAttribute('aria-label', S.pad)
  }

  function setState(next, text) {
    state = next
    page.setAttribute('data-state', next)
    var end = { done: '✓', expired: '!', used: '!', cancelled: '!', invalid: '!' }
    if (end[next]) {
      $('end').hidden = false
      $('endIcon').textContent = end[next]
      $('endText').textContent = text
      // Said by the live region (screen readers), shown by the end card
      setStatus(text, 'sr')
      storage(function (s) { s.removeItem(KEY) })
    } else {
      $('end').hidden = true
    }
    updateButtons()
  }

  // --- Context ------------------------------------------------------------

  function roleText(slot, c) {
    var teamName = function () {
      if (c.teamLabel) return fmt(S.team, { l: c.teamLabel })
      return (c.teamSide && c[c.teamSide]) || ''
    }
    if (/^captain/.test(slot)) return fmt(S.captainOf, { team: teamName() })
    if (/^coach/.test(slot)) return fmt(S.coachOf, { team: teamName() })
    return { scorer: S.scorer, 'asst-scorer': S.asstScorer, ref1: S.ref1, ref2: S.ref2 }[slot] || ''
  }

  function showContext(slot, c) {
    c = c || {}
    if (!browserLang && STR[c.lang]) {
      lang = c.lang
      S = STR[lang]
      applyStrings()
    }
    // textContent only: the context is the scoring device's text
    $('title').textContent = fmt(S.title, { role: roleText(slot, c) })
    $('teams').textContent = c.home && c.away ? c.home + ' – ' + c.away : ''
    var meta = []
    if (c.matchNo) meta.push(fmt(S.match, { n: c.matchNo }))
    if (c.when) meta.push(c.when)
    $('meta').textContent = meta.join(' · ')
    $('name').textContent = c.name || ''
  }

  // --- The pad --------------------------------------------------------------

  function layout() {
    var wrap = $('padwrap')
    var w = wrap.clientWidth || canvas.getBoundingClientRect().width || 0
    if (!w) return
    var vh = window.innerHeight || 640
    var landscape = (window.innerWidth || w) > vh
    var h = landscape ? Math.min(0.33 * w, 0.6 * vh) : Math.max(180, Math.min(0.55 * w, 0.45 * vh))
    // Landscape: the whole page fits the screen (the page around the pad measured)
    var rest = page.getBoundingClientRect().height - canvas.getBoundingClientRect().height
    if (landscape && rest > 0) h = Math.min(h, Math.max(120, vh - rest))
    h = Math.round(h)
    // The pad's units follow its shape until the first stroke, then stay: a
    // later rotation only changes the view
    if (!padH || !strokes.length) padH = Math.max(1000, Math.min(4000, Math.round(W * h / w)))
    var dpr = window.devicePixelRatio || 1
    canvas.style.height = h + 'px'
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    var s = Math.min(w / W, h / padH)
    view = { w: w, h: h, s: s, ox: (w - W * s) / 2, oy: (h - padH * s) / 2, dpr: dpr }
    redraw()
  }

  function redraw() {
    if (!ctx) return
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0)
    ctx.clearRect(0, 0, view.w, view.h)
    // Rotated after the first stroke: grey outside the pad, where nothing draws
    if (view.ox > 1 || view.oy > 1) {
      ctx.fillStyle = '#e7e5e4'
      ctx.fillRect(0, 0, view.w, view.h)
      ctx.clearRect(view.ox, view.oy, W * view.s, padH * view.s)
    }
    // A faint baseline at 70 % of the pad
    ctx.strokeStyle = '#e7e5e4'
    ctx.lineWidth = 1
    ctx.beginPath()
    var by = view.oy + 0.7 * padH * view.s
    ctx.moveTo(view.ox + 0.04 * W * view.s, by)
    ctx.lineTo(view.ox + 0.96 * W * view.s, by)
    ctx.stroke()
    ctx.strokeStyle = '#000000'
    ctx.fillStyle = '#000000'
    ctx.lineWidth = 4
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (var i = 0; i < strokes.length; i++) drawStroke(strokes[i])
  }

  function px(x) { return view.ox + x * view.s }
  function py(y) { return view.oy + y * view.s }

  function drawStroke(s) {
    if (!ctx || !s.length) return
    ctx.beginPath()
    if (s.length === 2) {
      ctx.arc(px(s[0]), py(s[1]), 2, 0, Math.PI * 2)
      ctx.fill()
      return
    }
    ctx.moveTo(px(s[0]), py(s[1]))
    for (var i = 2; i < s.length; i += 2) ctx.lineTo(px(s[i]), py(s[i + 1]))
    ctx.stroke()
  }

  function toPad(e) {
    var r = canvas.getBoundingClientRect()
    var x = Math.round((e.clientX - r.left - view.ox) / view.s)
    var y = Math.round((e.clientY - r.top - view.oy) / view.s)
    return [Math.max(0, Math.min(W, x)), Math.max(0, Math.min(padH, y))]
  }

  function addPoint(p) {
    if (!current) return
    var n = current.length
    if (n >= 2) {
      var dx = p[0] - current[n - 2]
      var dy = p[1] - current[n - 1]
      if (dx * dx + dy * dy < MIN_STEP * MIN_STEP) return
    }
    if (points >= MAX_POINTS || current.length / 2 >= MAX_STROKE_POINTS) {
      endStroke()
      reachFull()
      return
    }
    current.push(p[0], p[1])
    points++
    if (ctx && current.length >= 4) {
      ctx.beginPath()
      ctx.moveTo(px(current[current.length - 4]), py(current[current.length - 3]))
      ctx.lineTo(px(p[0]), py(p[1]))
      ctx.stroke()
    }
  }

  function reachFull() {
    full = true
    setStatus(S.full, 'warn')
  }

  function canDraw() {
    return (state === 'ready' || state === 'failed') && !full
  }

  function onDown(e) {
    if (!canDraw() || activePointer !== null) return
    if (e.button != null && e.button > 0) return
    if (strokes.length >= MAX_STROKES || points >= MAX_POINTS) { reachFull(); return }
    activePointer = e.pointerId
    try { canvas.setPointerCapture(e.pointerId) } catch (err) { /* not supported */ }
    if (e.preventDefault) e.preventDefault()
    current = []
    strokes.push(current)
    $('hint').hidden = true
    addPoint(toPad(e))
    redraw()
  }

  function onMove(e) {
    if (e.pointerId !== activePointer || !current) return
    if (e.preventDefault) e.preventDefault()
    var list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null
    if (!list || !list.length) list = [e]
    for (var i = 0; i < list.length && current; i++) addPoint(toPad(list[i]))
  }

  function endStroke() {
    if (current && current.length === 0) strokes.pop()
    current = null
    activePointer = null
    updateButtons()
  }

  function onUp(e) {
    if (e.pointerId !== activePointer) return
    endStroke()
  }

  /** The relays' ink rule: enough line drawn (lone taps do not count). */
  function inkOk() {
    var ink = 0
    for (var i = 0; i < strokes.length; i++) {
      var s = strokes[i]
      for (var j = 2; j < s.length; j += 2) ink += Math.sqrt(Math.pow(s[j] - s[j - 2], 2) + Math.pow(s[j + 1] - s[j - 1], 2))
    }
    return ink >= MIN_INK
  }

  function updateButtons() {
    var drawing = state === 'ready' || state === 'failed'
    $('done').disabled = !drawing || !inkOk()
    $('clear').disabled = !drawing || strokes.length === 0
  }

  function clearPad() {
    strokes = []
    points = 0
    current = null
    activePointer = null
    full = false
    $('hint').hidden = false
    if (state === 'ready') setStatus('')
    redraw()
    updateButtons()
  }

  // --- The server -----------------------------------------------------------

  function post(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer'
    }).then(function (res) {
      return res.json().catch(function () { return {} }).then(function (json) { return { status: res.status, json: json || {} } })
    })
  }

  function endFor(r) {
    var code = r.json && r.json.code
    if (r.status === 410) return ['expired', S.expired]
    if (code === 'OV_SIGN_USED') return ['used', S.used]
    if (code === 'OV_SIGN_CANCELLED') return ['cancelled', S.cancelled]
    if (r.status === 404) return ['invalid', S.invalid]
    return null
  }

  function open() {
    post('/api/sign/open', { k: token }).then(function (r) {
      if (r.status === 200 && r.json.ok) {
        applyApp(r.json.app)
        showContext(r.json.slot, r.json.context)
        setState('ready')
        setStatus('')
        return
      }
      var end = endFor(r)
      if (end) return setState(end[0], end[1])
      retryOpen()
    }, retryOpen)
  }

  // Keeps trying for as long as a link can live (10 min), then says so
  function retryOpen() {
    setStatus(S.openFailed, 'warn')
    if (++openTries <= 60) setTimeout(open, Math.min(3000 * openTries, 10000))
    else setState('expired', S.expired)
  }

  function submit() {
    if ($('done').disabled) return
    var sent = strokes.filter(function (s) { return s.length >= 2 })
    setState('sending')
    setStatus(S.sending)
    post('/api/sign/submit', { k: token, pad: { w: W, h: padH }, strokes: sent }).then(function (r) {
      if (r.status === 200 && r.json.ok) return setState('done', S.sent)
      // An earlier Done arrived and only its answer was lost
      if (lost && r.json.code === 'OV_SIGN_USED') return setState('done', S.sent)
      var end = endFor(r)
      if (end) return setState(end[0], end[1])
      failed(r.status >= 500)
    }, function () { failed(true) })
  }

  // Network or server trouble: the strokes stay, Done again
  function failed(maybeArrived) {
    if (maybeArrived) lost = true
    setState('failed')
    setStatus(S.sendFailed, 'error')
  }

  // --- Boot -----------------------------------------------------------------

  function boot() {
    applyStrings()
    setStatus(S.loading)
    var m = /(?:^#|&)k=([^&]+)/.exec(location.hash || '')
    var fromHash = m ? decodeURIComponent(m[1]) : null
    if (fromHash) {
      storage(function (s) { s.setItem(KEY, fromHash) })
      // The token leaves the address bar (history, screenshots, a shared tab)
      try { history.replaceState(null, '', location.pathname + location.search) } catch (e) { /* old browser */ }
    }
    token = fromHash || storage(function (s) { return s.getItem(KEY) })
    layout()
    window.addEventListener('resize', layout)
    window.addEventListener('orientationchange', layout)
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onUp)
    $('clear').addEventListener('click', clearPad)
    $('done').addEventListener('click', submit)
    if (!token || !TOKEN_RE.test(token)) return setState('invalid', S.invalid)
    open()
  }

  // For the tests (src/utils/__tests__/signPage.test.js): read-only views
  window.__ovSignPage = {
    get state() { return state },
    get lang() { return lang },
    get app() { return app },
    get strokes() { return strokes },
    get pad() { return { w: W, h: padH } },
    get points() { return points },
    layout: layout
  }

  boot()
})()
