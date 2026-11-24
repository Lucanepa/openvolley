// The disc a player shows under the mouse while dragged (HTML5 drag and drop).
// The browser snapshots the drag image as the element's square border box
// (Chromium / WebView2 and WebKitGTK alike) and cuts off anything painted
// outside it. A box-shadow round the disc therefore filled the corners of
// that square and the disc sat on a grey box: no shadow here, and the box is
// exactly the circle, so its corners stay transparent.

const SIZE = 50

/**
 * Sets a round drag image with the player's number, held at its centre.
 * @param {DragEvent} e - the dragstart event
 * @param {string|number} label - the player's number
 * @param {{ bg: string, text: string, ring?: string|null, textShadow?: string }} colors
 */
export function setPlayerDragImage(e, label, { bg, text, ring = null, textShadow } = {}) {
  if (typeof e?.dataTransfer?.setDragImage !== 'function') return
  const disc = document.createElement('div')
  disc.textContent = String(label)
  // in the DOM at dragstart (WebKit snapshots a rendered node), off screen
  Object.assign(disc.style, {
    position: 'fixed',
    top: '-1000px',
    left: '-1000px',
    boxSizing: 'border-box',
    width: `${SIZE}px`,
    height: `${SIZE}px`,
    borderRadius: '50%',
    background: bg,
    color: text,
    fontSize: '20px',
    fontWeight: '700',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none',
    border: ring ? `2px solid ${ring}` : '',
    textShadow: textShadow || '',
  })
  document.body.appendChild(disc)
  e.dataTransfer.setDragImage(disc, SIZE / 2, SIZE / 2)
  // the snapshot is taken once dragstart returns
  setTimeout(() => disc.remove(), 0)
}
