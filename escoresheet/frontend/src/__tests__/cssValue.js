/**
 * A CSS value as an element's inline style reads it back: `value` set on
 * `property` of a scratch element, then read from the CSS object model.
 *
 * jsdom, like a browser, keeps a value in its own serialised form, and that
 * form moves between versions (jsdom 31: `minmax(0px, 1fr)`,
 * `translate(-300px)` for `translate(-300px, 0px)`, `rgb(255, 255, 255)` for
 * `#fff`, `left top` for `top left`, the animation name last). An assertion on
 * `el.style.x` compares with the expected value put through the same
 * serialisation, so it checks the value the component set, not jsdom's
 * spelling of it:
 *
 *   expect(el.style.transform).toBe(cssValue('transform', 'translate(-300px, 0px) scale(1)'))
 *
 * @param {string} property  a CSS property name, kebab-case (`grid-template-columns`)
 * @param {string} value
 * @returns {string}
 */
export function cssValue(property, value) {
  const el = document.createElement('div')
  el.style.setProperty(property, value)
  return el.style.getPropertyValue(property)
}
