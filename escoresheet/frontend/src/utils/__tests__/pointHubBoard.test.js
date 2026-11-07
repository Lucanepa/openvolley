import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { installOnScreenKeyboardHelp, isTextField, onPointHubBoard } from '../pointHubBoard'

const field = (tag, type) => {
  const el = document.createElement(tag)
  if (type) el.type = type
  document.body.appendChild(el)
  return el
}
const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 20))))

describe('onPointHubBoard', () => {
  afterEach(() => { delete window.__OV_POINTHUB_BOARD__ })
  it('only with the flag the desktop app sets', () => {
    expect(onPointHubBoard()).toBe(false)
    window.__OV_POINTHUB_BOARD__ = true
    expect(onPointHubBoard()).toBe(true)
  })
})

describe('isTextField', () => {
  afterEach(() => { document.body.innerHTML = '' })
  it('fields typed in, not buttons and switches', () => {
    expect(isTextField(field('input', 'text'))).toBe(true)
    expect(isTextField(field('input', 'email'))).toBe(true)
    expect(isTextField(field('textarea'))).toBe(true)
    expect(isTextField(field('input', 'checkbox'))).toBe(false)
    expect(isTextField(field('button'))).toBe(false)
    expect(isTextField(null)).toBe(false)
  })
})

describe('installOnScreenKeyboardHelp', () => {
  let remove
  beforeEach(() => { remove = installOnScreenKeyboardHelp(window) })
  afterEach(() => {
    remove()
    document.body.innerHTML = ''
  })

  const scrollSpy = (el) => {
    el.scrollIntoView = vi.fn()
    return el.scrollIntoView
  }

  it('the keyboard opening shrinks the window: the focused field comes into view', async () => {
    const input = field('input', 'text')
    const scroll = scrollSpy(input)
    input.focus()
    window.dispatchEvent(new Event('resize'))
    await frames()
    expect(scroll).toHaveBeenCalledWith({ block: 'center', inline: 'nearest' })
  })

  it('a resize with a button focused scrolls nothing', async () => {
    const button = field('button')
    const scroll = scrollSpy(button)
    button.focus()
    window.dispatchEvent(new Event('resize'))
    await frames()
    expect(scroll).not.toHaveBeenCalled()
  })

  it('Enter in a one-line field closes the keyboard', async () => {
    const input = field('input', 'text')
    input.focus()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await frames()
    expect(document.activeElement).not.toBe(input)
  })

  it('Enter that moved on to the next field stays there', async () => {
    const first = field('input', 'text')
    const next = field('input', 'text')
    first.addEventListener('keydown', () => next.focus())
    first.focus()
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await frames()
    expect(document.activeElement).toBe(next)
  })

  it('Enter in a text area is a new line, the keyboard stays', async () => {
    const area = field('textarea')
    area.focus()
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await frames()
    expect(document.activeElement).toBe(area)
  })

  it('other keys leave the field alone', async () => {
    const input = field('input', 'text')
    input.focus()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    await frames()
    expect(document.activeElement).toBe(input)
  })
})
