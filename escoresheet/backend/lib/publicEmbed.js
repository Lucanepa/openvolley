/**
 * The embeddable livescore: one <script>, one tag.
 *
 *   <script src="https://backend.openvolley.app/embed/livescore.js" async></script>
 *   <ov-livescore match="MATCH_ID"></ov-livescore>
 *
 * Attributes: match (required), api (default: the origin the script came from),
 * theme ("light" | "dark" | unset = the visitor's setting). The widget draws in
 * a shadow root, so the host page's CSS cannot break it and it cannot break the
 * page. Server-Sent Events, with polling when EventSource is missing or fails.
 * Only text is written with textContent: nothing from the API is parsed as HTML.
 */
export const LIVESCORE_JS = `(function () {
  if (customElements.get('ov-livescore')) return;
  var origin = (function () { try { return new URL(document.currentScript.src).origin; } catch (e) { return ''; } })();
  var CSS = ':host{display:block;font:14px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;--bg:#fff;--fg:#1c1917;--mut:#78716c;--line:#e7e5e4;--acc:#e2001a}' +
    ':host([theme=dark]){--bg:#1c1917;--fg:#fafaf9;--mut:#a8a29e;--line:#44403c}' +
    '@media(prefers-color-scheme:dark){:host(:not([theme=light])){--bg:#1c1917;--fg:#fafaf9;--mut:#a8a29e;--line:#44403c}}' +
    '.c{background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:12px;padding:14px 16px;max-width:420px}' +
    '.h{display:flex;justify-content:space-between;color:var(--mut);font-size:12px;margin-bottom:8px}' +
    '.live{color:var(--acc);font-weight:700}.r{display:flex;align-items:center;gap:8px;padding:6px 0}' +
    '.n{flex:1;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.d{width:8px;height:8px;border-radius:50%;background:transparent}' +
    '.d.s{background:var(--acc)}.sets{font-variant-numeric:tabular-nums;color:var(--mut);min-width:1.2em;text-align:right}' +
    '.p{font-variant-numeric:tabular-nums;font-size:28px;font-weight:700;min-width:1.6em;text-align:right}' +
    '.hist{border-top:1px solid var(--line);margin-top:6px;padding-top:6px;color:var(--mut);font-size:12px;font-variant-numeric:tabular-nums}' +
    '.e{color:var(--mut);padding:8px 0}';
  function el(t, c, x) { var e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; }
  function Live() { return Reflect.construct(HTMLElement, [], Live); }
  Live.prototype = Object.create(HTMLElement.prototype);
  Live.prototype.constructor = Live;
  Object.setPrototypeOf(Live, HTMLElement);
  Live.observedAttributes = ['match', 'api'];
  Live.prototype.connectedCallback = function () {
    if (!this._root) { this._root = this.attachShadow({ mode: 'open' }); var s = el('style'); s.textContent = CSS; this._root.appendChild(s); this._box = el('div', 'c'); this._root.appendChild(this._box); }
    this._start();
  };
  Live.prototype.disconnectedCallback = function () { this._stop(); };
  Live.prototype.attributeChangedCallback = function () { if (this.isConnected && this._root) this._start(); };
  Live.prototype._stop = function () { if (this._es) { this._es.close(); this._es = null; } clearInterval(this._t); this._t = null; };
  Live.prototype._start = function () {
    var self = this; this._stop();
    var id = this.getAttribute('match'); if (!id) { this._msg('Set the match attribute.'); return; }
    var base = (this.getAttribute('api') || origin).replace(/\\/$/, '') + '/api/public/v1/matches/' + encodeURIComponent(id);
    var poll = function () { fetch(base + '/live').then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); }).then(function (d) { self._draw(d); }).catch(function () { self._msg('Score not available.'); }); };
    if (window.EventSource) {
      this._es = new EventSource(base + '/stream');
      this._es.addEventListener('live', function (ev) { try { self._draw(JSON.parse(ev.data)); } catch (e) {} });
      this._es.onerror = function () { if (self._es && self._es.readyState === 2) { self._es = null; poll(); self._t = setInterval(poll, 5000); } };
    } else { poll(); this._t = setInterval(poll, 5000); }
  };
  Live.prototype._msg = function (m) { this._box.textContent = ''; this._box.appendChild(el('div', 'e', m)); };
  Live.prototype._draw = function (d) {
    var b = this._box; b.textContent = '';
    var st = d.status === 'live' ? 'LIVE' : (d.status === 'finished' || d.status === 'ended') ? 'Final' : 'Upcoming';
    var h = el('div', 'h'); h.appendChild(el('span', st === 'LIVE' ? 'live' : '', st)); h.appendChild(el('span', '', d.currentSet ? 'Set ' + d.currentSet : '')); b.appendChild(h);
    ['A', 'B'].forEach(function (k) {
      var t = d.teams[k], r = el('div', 'r');
      r.appendChild(el('span', 'd' + (d.serving && String(d.serving).toUpperCase().charAt(0) === k && st === 'LIVE' ? ' s' : '')));
      r.appendChild(el('span', 'n', t.name));
      r.appendChild(el('span', 'sets', d.score['sets' + k] == null ? '' : d.score['sets' + k]));
      r.appendChild(el('span', 'p', d.score['points' + k] == null ? '' : d.score['points' + k]));
      b.appendChild(r);
    });
    if (d.setResults && d.setResults.length) b.appendChild(el('div', 'hist', d.setResults.map(function (s) { return s.pointsA + '-' + s.pointsB; }).join('   ')));
  };
  customElements.define('ov-livescore', Live);
})();
`
