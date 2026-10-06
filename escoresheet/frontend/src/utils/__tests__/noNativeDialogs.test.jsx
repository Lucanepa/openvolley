// window.confirm / window.alert must not be used anywhere in the app.
//
// In the desktop app tauri-plugin-dialog replaces both with IPC calls that no
// capability allows: alert() shows nothing, and confirm() returns a Promise,
// which is truthy, so `if (confirm('Delete?'))` deleted without asking. Every
// question goes through src/utils/askConfirm.js (the in-app dialog) instead.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { act, render, screen, fireEvent } from '@testing-library/react'
import { UiHost } from '../../ui/UiHost.jsx'
import { askConfirm } from '../askConfirm.js'

const frontend = resolve(__dirname, '../../..')
const ROOTS = ['src', 'scoresheet_pdf']
const HELPER = 'src/utils/askConfirm.js'

function sourceFiles(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__' || name === 'dist') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(jsx?|tsx?|mjs)$/.test(name) && !/\.test\.(jsx?|tsx?)$/.test(name)) out.push(full)
  }
  return out
}

// Comments may talk about confirm (…) freely. Block comments keep their line
// breaks so offender line numbers stay right; a `//` comment needs whitespace
// (or the line start) before it, so 'http://…' in a string is not cut.
function withoutComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n')
}

// A call of the global confirm/alert: bare `confirm(`, `window.confirm(`,
// `globalThis.alert (`, `self.confirm(`… but not `x.confirm(`, `onConfirm(`,
// `confirmDialog(` or `handleAlert(`.
const NATIVE_DIALOG = /(?:^|[^\w$.])(?:(?:window|globalThis|self)\s*\.\s*)?(?:confirm|alert)\s*\(/

describe('no native confirm()/alert() in the app', () => {
  it('the pattern catches the forms that broke and spares the safe ones', () => {
    for (const bad of ['if (confirm(t("x"))) {', 'window.confirm("x")', 'const ok = window.confirm(', 'alert("x")', ' globalThis.alert ("x")', 'self.confirm(1)']) {
      expect(NATIVE_DIALOG.test(bad), bad).toBe(true)
    }
    for (const ok of ['await askConfirm({ title })', 'confirmDialog({ title })', 'onConfirm()', 'handleAlert(x)', 'dialog.confirm(x)', 'showAlert(x)']) {
      expect(NATIVE_DIALOG.test(ok), ok).toBe(false)
    }
  })

  it('comments do not count, code after them on the next line does', () => {
    const lines = withoutComments('/* confirm (x)\n alert(y) */\nfoo() // confirm (z)\nconfirm(1)').split('\n')
    expect(lines.map((l) => NATIVE_DIALOG.test(l))).toEqual([false, false, false, true])
  })

  it('every source file outside the helper is free of them', () => {
    const offenders = []
    for (const root of ROOTS) {
      for (const file of sourceFiles(resolve(frontend, root))) {
        const rel = relative(frontend, file)
        if (rel === HELPER) continue
        withoutComments(readFileSync(file, 'utf8')).split('\n').forEach((line, i) => {
          if (NATIVE_DIALOG.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`)
        })
      }
    }
    expect(offenders, 'use `await askConfirm({...})` from src/utils/askConfirm.js, or showAlert/toast').toEqual([])
  })

  // `if (askConfirm(...))` would be the same bug again: a Promise is truthy.
  it('every askConfirm() call is awaited', () => {
    const unawaited = []
    for (const root of ROOTS) {
      for (const file of sourceFiles(resolve(frontend, root))) {
        const rel = relative(frontend, file)
        if (rel === HELPER) continue
        withoutComments(readFileSync(file, 'utf8')).split('\n').forEach((line, i) => {
          for (const m of line.matchAll(/(\S*\s*)\baskConfirm\s*\(/g)) {
            if (!/(^|[^\w$])await\s*$/.test(m[1])) unawaited.push(`${rel}:${i + 1}: ${line.trim()}`)
          }
        })
      }
    }
    expect(unawaited).toEqual([])
  })
})

describe('askConfirm', () => {
  it('waits for the user and answers true only on the confirm button', async () => {
    render(<UiHost />)
    let answer = 'pending'
    await act(async () => {
      askConfirm({ title: 'Delete this point event?', confirmLabel: 'Delete', tone: 'danger' }).then((a) => { answer = a })
    })
    expect(answer).toBe('pending')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Delete this point event?')).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByText('Delete')) })
    expect(answer).toBe(true)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('answers false on cancel, with translated default labels', async () => {
    render(<UiHost />)
    let answer = 'pending'
    await act(async () => {
      askConfirm({ title: 'Continue?', message: 'line one\nline two' }).then((a) => { answer = a })
    })
    expect(screen.getByTestId('confirm-accept').textContent).not.toBe('')
    expect(screen.getByTestId('confirm-message').className).toContain('whitespace-pre-line')
    await act(async () => { fireEvent.click(screen.getByTestId('confirm-cancel')) })
    expect(answer).toBe(false)
  })
})
