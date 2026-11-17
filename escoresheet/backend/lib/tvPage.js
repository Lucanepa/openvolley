/**
 * The Global tool's live page for TVs, as a page any screen can open
 * (owner 2026-11-17): GET /tv/<code> and its script GET /tv/tv.js.
 *
 * The livescore site's page (livescore.openvolley.app/?t=<code>) is a React
 * app for browsers of 2022 and later. Smart TV browsers (Samsung Tizen, LG
 * webOS, older Android TV and Fire TV) often run far older engines, and a TV
 * remote makes a long URL a chore. So the server that holds the scores serves
 * this page itself:
 *
 *   - short URL: openvolley.app/tv/<code> (a redirect to the backend) or, at a
 *     venue without internet, http://<venue relay>/tv/<code>: the same server
 *     code runs there with its own live store, fed by the local relay;
 *   - plain HTML, CSS without grid or variables, and ES5 JavaScript (no arrow
 *     functions, no let/const, no fetch, no promises): XMLHttpRequest every
 *     5 s to /api/global/live/<code> on the same origin;
 *   - big, high-contrast numbers that fill the screen for 1 to 12 courts,
 *     the page language from the TV's language (de, fr, it, else en);
 *   - no cookies, no storage, nothing typed in; a reload every 6 hours picks
 *     up a new version of the page.
 *
 * The CSP of the backend allows scripts from 'self' only, so the script is a
 * file of its own (TV_JS), not inline.
 */

/** The page for one code (the caller has checked it: isLiveCode). */
export function tvPageHtml(code) {
  const c = String(code).replace(/[^A-Z0-9]/g, '')
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="robots" content="noindex">' +
    '<title>OpenVolley Live</title>' +
    '<style>' +
    'html,body{margin:0;height:100%;background:#0c0a09;color:#fafaf9;font-family:Helvetica,Arial,sans-serif;overflow:hidden;cursor:none}' +
    '#top{height:6vh;display:-webkit-box;display:-webkit-flex;display:flex;-webkit-box-align:center;-webkit-align-items:center;align-items:center;padding:0 2vw;font-size:3vh}' +
    '#top b{-webkit-box-flex:1;-webkit-flex:1;flex:1}' +
    '#code{color:#a8a29e;letter-spacing:.15em;font-family:monospace}' +
    '#state{color:#fbbf24;margin-left:2vw}' +
    '#courts{height:94vh;display:-webkit-box;display:-webkit-flex;display:flex;-webkit-flex-wrap:wrap;flex-wrap:wrap;-webkit-align-content:flex-start;align-content:flex-start}' +
    '.card{box-sizing:border-box;padding:.35em;overflow:hidden}' +
    '.in{background:#1c1917;border-radius:.3em;height:100%;box-sizing:border-box;padding:.3em .5em;overflow:hidden;display:-webkit-box;display:-webkit-flex;display:flex;-webkit-box-orient:vertical;-webkit-flex-direction:column;flex-direction:column;-webkit-box-pack:center;-webkit-justify-content:center;justify-content:center}' +
    '.head{display:-webkit-box;display:-webkit-flex;display:flex;font-size:.4em;color:#a8a29e;height:1.5em;line-height:1.5em}' +
    '.head .h{-webkit-box-flex:1;-webkit-flex:1;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.st{color:#34d399;font-weight:bold;margin-left:.6em}.st.end{color:#e7e5e4}' +
    '.row{display:-webkit-box;display:-webkit-flex;display:flex;-webkit-box-align:center;-webkit-align-items:center;align-items:center;height:1.3em}' +
    '.bar{width:.18em;height:1.1em;border-radius:.1em;margin-right:.35em;background:#78716c}' +
    '.nm{-webkit-box-flex:1;-webkit-flex:1;flex:1;min-width:0;font-size:.55em;font-weight:bold;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.sv{display:inline-block;width:.26em;height:.26em;border-radius:50%;background:#fbbf24;margin:0 .1em 0 .25em;-webkit-flex-shrink:0;flex-shrink:0}' +
    '.ps{font-size:.32em;color:#a8a29e;margin:0 .5em;font-family:monospace;white-space:nowrap}' +
    '.ps i{font-style:normal;margin-left:.5em}.ps i.w{color:#fafaf9;font-weight:bold}' +
    '.sw{font-size:.6em;color:#a8a29e;width:1.1em;text-align:center;font-weight:bold}' +
    '.pt{font-size:1em;font-weight:bold;width:1.45em;text-align:right;font-family:monospace}' +
    '#empty{font-size:4vh;color:#a8a29e;text-align:center;width:100%;padding-top:35vh}' +
    '</style></head><body data-code="' + c + '">' +
    '<div id="top"><b id="title">Live</b><span id="code"></span><span id="state"></span></div>' +
    '<div id="courts"><div id="empty">…</div></div>' +
    '<script src="/tv/tv.js"></script></body></html>'
}

// ES5 only: this runs on TV browsers that know nothing newer (tests/tvPage.test.js checks it)
export const TV_JS = `(function () {
  var L = {
    en: { live: 'Live', empty: 'No game is live yet. The scores appear here as soon as a game starts.', lost: 'Connection lost, retrying', fin: 'Final', to: 'Timeout', br: 'Set break', set: 'Set ' },
    de: { live: 'Live', empty: 'Noch kein Spiel l\\u00e4uft. Die Spielst\\u00e4nde erscheinen hier, sobald ein Spiel beginnt.', lost: 'Verbindung unterbrochen, neuer Versuch', fin: 'Beendet', to: 'Auszeit', br: 'Satzpause', set: 'Satz ' },
    fr: { live: 'En direct', empty: 'Aucun match en cours. Les scores apparaissent ici d\\u00e8s qu\\u2019un match commence.', lost: 'Connexion perdue, nouvel essai', fin: 'Termin\\u00e9', to: 'Temps mort', br: 'Pause entre les sets', set: 'Set ' },
    it: { live: 'Live', empty: 'Nessuna partita in corso. I punteggi appaiono qui appena inizia una partita.', lost: 'Connessione persa, nuovo tentativo', fin: 'Finita', to: 'Time-out', br: 'Pausa tra i set', set: 'Set ' }
  };
  var lang = String(navigator.language || 'en').slice(0, 2).toLowerCase();
  var T = L[lang] || L.en;
  var code = document.body.getAttribute('data-code') || '';
  var box = document.getElementById('courts');
  var state = document.getElementById('state');
  document.getElementById('title').appendChild(document.createTextNode(''));
  document.getElementById('title').firstChild.nodeValue = T.live;
  document.getElementById('code').appendChild(document.createTextNode(code.slice(0, 4) + ' ' + code.slice(4)));
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
    return c.currentSet ? T.set + c.currentSet : '';
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
      head.appendChild(el('div', 'h', where.join(' \\u00b7 ')));
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
    x.open('GET', '/api/global/live/' + code + '?_=' + new Date().getTime(), true);
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
`
