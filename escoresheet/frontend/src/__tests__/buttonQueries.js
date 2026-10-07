/**
 * Cheap button lookups for tests that poll a large screen.
 *
 * Testing Library's *ByRole('button', { name }) works out each candidate's
 * visibility and accessible name with jsdom's getComputedStyle. jsdom drops its
 * style cache on every DOM change, so on a page like MatchEnd (16 buttons with
 * icon subtrees) a single getByRole costs about 60 ms after each render, against
 * under 1 ms for this lookup. waitFor and findBy* run their query again after
 * every DOM mutation and every 50 ms, so on a loaded machine one step can run
 * past findBy's 1000 ms window, and the steps together past the 5 s test
 * timeout. That made the tests that query this way fail now and then in the
 * full parallel run.
 *
 * getButton matches what getByRole('button', { name }) matches in these tests:
 * a <button> or [role="button"] whose aria-label (or else its text) equals
 * `name` (a string, after trimming and collapsing whitespace) or matches it (a
 * RegExp). It skips anything inside [hidden] or [aria-hidden="true"].
 * It throws unless exactly one matches, as getBy* does.
 */
import { waitFor } from '@testing-library/react'

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

function nameOf(el) {
  const label = el.getAttribute('aria-label')
  return label != null ? norm(label) : norm(el.textContent)
}

export function queryAllButtons(name, container = document.body) {
  const matches = (text) => (name instanceof RegExp ? name.test(text) : text === norm(name))
  return [...container.querySelectorAll('button, [role="button"]')]
    .filter(el => !el.closest('[hidden], [aria-hidden="true"]'))
    .filter(el => matches(nameOf(el)))
}

export function getButton(name, container = document.body) {
  const found = queryAllButtons(name, container)
  if (found.length !== 1) {
    throw new Error(`Expected one button named ${name}, found ${found.length}`)
  }
  return found[0]
}

export function findButton(name, { container = document.body, ...waitOptions } = {}) {
  return waitFor(() => getButton(name, container), waitOptions)
}
