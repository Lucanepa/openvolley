(function () {
  // This page's errors go to the error tracker (POST /api/errors on the same
  // origin, lib/errorTracker.js; privacy policy 1.22 section 5): the message
  // and the place in the script, the browser and system by name, never a
  // value from the screen. At most 5 per page load.
  var reported = 0;
  function reportError(msg, file, line, col) {
    if (reported >= 5 || !window.JSON || !window.XMLHttpRequest) return;
    reported++;
    try {
      var ua = String(navigator.userAgent || '');
      var m = function (re) { var r = ua.match(re); return r ? r[1] : null; };
      var os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Tizen/.test(ua) ? 'Tizen' : /Web0S|webOS/.test(ua) ? 'webOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux|X11/.test(ua) ? 'Linux' : null;
      var browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrom(e|ium)\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : null;
      var version = m(/Edg\/([\d.]+)/) || m(/Firefox\/([\d.]+)/) || m(/Chrom(?:e|ium)\/([\d.]+)/) || m(/Version\/([\d.]+)/);
      var uid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) { var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });
      var where = file ? String(file).replace(/^[a-z]+:\/\/[^/]+/i, '').split('?')[0] + ':' + (line || 0) + ':' + (col || 0) : null;
      var w = window.innerWidth, h = window.innerHeight;
      var event = {
        uid: uid, client_ts: new Date().toISOString(), kind: 'js.error', level: 'error', product: 'openvolley', tool: 'tv',
        platform: 'web', runs_as: 'tab', os_name: os, browser: browser, browser_version: version ? String(version).slice(0, 24) : null,
        viewport: w && h ? w + 'x' + h : null, lang: /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(navigator.language || '') ? navigator.language : null,
        online: typeof navigator.onLine === 'boolean' ? navigator.onLine : null, view: '/tv', message: String(msg || 'error').slice(0, 500),
        frames: where ? [where.slice(0, 200)] : []
      };
      var x = new XMLHttpRequest();
      x.open('POST', '/api/errors', true);
      x.setRequestHeader('Content-Type', 'application/json');
      x.send(JSON.stringify({ events: [event] }));
    } catch (e) { /* reporting never breaks the screen */ }
  }
  window.onerror = function (msg, file, line, col) { reportError(msg, file, line, col); };
  var L = {
    en: { live: 'Live', empty: 'No game is live yet. The scores appear here as soon as a game starts.', lost: 'Connection lost, retrying', fin: 'Final', to: 'Timeout', br: 'Set break', set: 'Set ' },
    de: { live: 'Live', empty: 'Noch kein Spiel l\u00e4uft. Die Spielst\u00e4nde erscheinen hier, sobald ein Spiel beginnt.', lost: 'Verbindung unterbrochen, neuer Versuch', fin: 'Beendet', to: 'Auszeit', br: 'Satzpause', set: 'Satz ' },
    fr: { live: 'En direct', empty: 'Aucun match en cours. Les scores apparaissent ici d\u00e8s qu\u2019un match commence.', lost: 'Connexion perdue, nouvel essai', fin: 'Termin\u00e9', to: 'Temps-mort', br: 'Pause entre les sets', set: 'Set ' },
    it: { live: 'Live', empty: 'Nessuna partita in corso. I punteggi appaiono qui appena inizia una partita.', lost: 'Connessione persa, nuovo tentativo', fin: 'Finita', to: 'Time-out', br: 'Pausa tra i set', set: 'Set ' }
  };
  var lang = String(navigator.language || 'en').slice(0, 2).toLowerCase();
  var T = L[lang] || L.en;
  var code = document.body.getAttribute('data-code') || '';
  // what to poll and what to show at the top: the page says it (a live screen,
  // one court of it, or one league game); older pages only had the code
  var src = document.body.getAttribute('data-src') || ('/api/global/live/' + code);
  var label = document.body.getAttribute('data-label') || (code.slice(0, 4) + ' ' + code.slice(4));
  var box = document.getElementById('courts');
  var state = document.getElementById('state');
  document.getElementById('title').appendChild(document.createTextNode(''));
  document.getElementById('title').firstChild.nodeValue = T.live;
  document.getElementById('code').appendChild(document.createTextNode(label));
  var last = null;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.appendChild(document.createTextNode(String(text)));
    return e;
  }
  function safeColor(c) { return /^#[0-9a-fA-F]{3,8}$/.test(c || '') ? c : '#78716c'; }

  function teamRow(c, side) {
    var t = c[side] || {};
    var other = side === 'home' ? 'away' : 'home';
    var row = el('div', 'row');
    var bar = el('div', 'bar');
    bar.style.background = safeColor(t.color);
    row.appendChild(bar);
    row.appendChild(el('div', 'nm', t.name || t.short || '-'));
    // beside the name, not in it: a long name's ellipsis would hide it
    if (c.serving === side && !c.ended) row.appendChild(el('span', 'sv'));
    var ps = el('div', 'ps');
    var sets = c.sets || [];
    for (var i = 0; i < sets.length; i++) {
      ps.appendChild(el('i', sets[i][side] > sets[i][other] ? 'w' : '', sets[i][side]));
    }
    row.appendChild(ps);
    row.appendChild(el('div', 'sw', (c.setsWon || {})[side] || 0));
    row.appendChild(el('div', 'pt', c.ended ? '' : ((c.points || {})[side] || 0)));
    return row;
  }

  function statusOf(c) {
    if (c.ended) return T.fin;
    if (c.timeout) return T.to;
    if (c.interval) return T.br;
    // a best-of-3 decider is stored as set 5 (a server before 26.11.6 sent it so)
    return c.currentSet ? T.set + (c.bestOf === 3 && c.currentSet === 5 ? 3 : c.currentSet) : '';
  }

  function render(courts) {
    while (box.firstChild) box.removeChild(box.firstChild);
    if (!courts || !courts.length) { box.appendChild(el('div', '', T.empty)).id = 'empty'; return; }
    var n = courts.length;
    var W = window.innerWidth || document.documentElement.clientWidth;
    var H = (window.innerHeight || document.documentElement.clientHeight) * 0.94;
    // the columns that give each court the biggest numbers
    var best = 1, bestSize = 0;
    for (var cols = 1; cols <= Math.min(n, 4); cols++) {
      var rows = Math.ceil(n / cols);
      // a card is about 10.5 em wide (a long name gets an ellipsis) and 3.6 em high
      var size = Math.min(W / cols / 10.5, H / rows / 3.6);
      if (size > bestSize) { bestSize = size; best = cols; }
    }
    var rowsN = Math.ceil(n / best);
    for (var k = 0; k < n; k++) {
      var c = courts[k];
      var card = el('div', 'card');
      card.style.width = (100 / best) + '%';
      card.style.height = Math.floor(H / rowsN) + 'px';
      card.style.fontSize = Math.floor(bestSize) + 'px';
      var inner = el('div', 'in');
      var head = el('div', 'head');
      var where = [];
      if (c.hall) where.push(c.hall);
      if (c.gameNumber) where.push('#' + c.gameNumber);
      head.appendChild(el('div', 'h', where.join(' \u00b7 ')));
      head.appendChild(el('div', c.ended ? 'st end' : 'st', statusOf(c)));
      inner.appendChild(head);
      inner.appendChild(teamRow(c, 'home'));
      inner.appendChild(teamRow(c, 'away'));
      card.appendChild(inner);
      box.appendChild(card);
    }
  }

  function load() {
    var x = new XMLHttpRequest();
    x.open('GET', src + (src.indexOf('?') < 0 ? '?' : '&') + '_=' + new Date().getTime(), true);
    x.timeout = 10000;
    x.onreadystatechange = function () {
      if (x.readyState !== 4) return;
      var ok = false;
      if (x.status === 200) {
        try {
          var body = JSON.parse(x.responseText);
          if (body && body.data) { last = body.data.courts || []; render(last); ok = true; }
        } catch (e) { ok = false; }
      }
      state.firstChild ? (state.firstChild.nodeValue = ok ? '' : T.lost) : state.appendChild(document.createTextNode(ok ? '' : T.lost));
      setTimeout(load, 5000);
    };
    x.send();
  }
  window.onresize = function () { if (last) render(last); };
  load();
  // a new version of the page after a long day
  setTimeout(function () { location.reload(); }, 6 * 60 * 60 * 1000);
})();
