import { useEffect, useMemo, useRef } from 'react'
import { EditorView, keymap, placeholder as cmPlaceholder, tooltips } from '@codemirror/view'
import { EditorState, Compartment } from '@codemirror/state'
import { basicSetup } from 'codemirror'
import { sql, PostgreSQL } from '@codemirror/lang-sql'
import { autocompletion, startCompletion } from '@codemirror/autocomplete'
import { makeCompletionSource } from './sqlCompletion'

/*
 * The SQL tab's editor: CodeMirror 6 with Postgres highlighting and the
 * schema-aware completion of ./sqlCompletion.js. Ctrl/Cmd+Enter runs,
 * Ctrl+Space opens the suggestions. A controlled component: `value` from the
 * page, `onChange` on every edit.
 */

function completionExtension(source) {
  return autocompletion({
    activateOnTyping: true,
    defaultKeymap: true,
    maxRenderedOptions: 60,
    icons: false,
    closeOnBlur: true,
    override: [source]
  })
}

export default function CodeMirrorEditor({ value, onChange, onExecute, tables, placeholder, label }) {
  const containerRef = useRef(null)
  const viewRef = useRef(null)
  const externalValueRef = useRef(value)
  const onExecuteRef = useRef(onExecute)
  const onChangeRef = useRef(onChange)
  const completionCompartment = useRef(new Compartment())

  // Latest callbacks for the editor's own handlers (they fire after the commit)
  useEffect(() => {
    onExecuteRef.current = onExecute
    onChangeRef.current = onChange
  })

  const completionSource = useMemo(() => makeCompletionSource(tables), [tables])

  useEffect(() => {
    if (!containerRef.current) return undefined
    const executeKeymap = keymap.of([
      { key: 'Ctrl-Enter', mac: 'Cmd-Enter', run: () => { onExecuteRef.current?.(); return true } },
      { key: 'Ctrl-Space', run: (view) => { startCompletion(view); return true } }
    ])
    const state = EditorState.create({
      doc: value,
      extensions: [
        executeKeymap,
        basicSetup,
        // long SQL wraps: a nested horizontal scroller is unreachable on touch
        EditorView.lineWrapping,
        sql({ dialect: PostgreSQL, upperCaseKeywords: true }),
        // the suggestions are not clipped by the editor's own box
        tooltips({ position: 'fixed' }),
        completionCompartment.current.of(completionExtension(completionSource)),
        cmPlaceholder(placeholder || ''),
        EditorView.contentAttributes.of({ 'aria-label': label || 'SQL' }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const next = update.state.doc.toString()
            externalValueRef.current = next
            onChangeRef.current?.(next)
          }
        }),
        EditorView.theme({
          '&': { fontSize: '13px', height: '100%', backgroundColor: '#fff' },
          '&.cm-focused': { outline: 'none' },
          '.cm-content': { fontFamily: 'ui-monospace, "JetBrains Mono", Menlo, monospace' },
          '.cm-gutters': { borderRight: 'none', backgroundColor: '#fafaf9', color: '#a8a29e' },
          '.cm-scroller': { overflow: 'auto' },
          '.cm-tooltip-autocomplete': { fontFamily: 'ui-monospace, Menlo, monospace', borderRadius: '0.5rem', boxShadow: '0 10px 30px -10px rgb(0 0 0 / 0.35)' },
          '.cm-tooltip-autocomplete > ul': { maxHeight: '16rem' },
          '.cm-tooltip-autocomplete > ul > li': { padding: '3px 8px', display: 'flex', alignItems: 'center', gap: '0.25rem' },
          '.cm-completionLabel': { flex: '0 1 auto', minWidth: 0 },
          '.cm-completionDetail': { color: '#78716c', fontStyle: 'normal', marginLeft: 'auto', paddingLeft: '0.75rem', fontSize: '0.85em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
          '@media (max-width: 767px)': {
            '.cm-tooltip-autocomplete': { maxWidth: 'calc(100vw - 1.5rem)' },
            '.cm-tooltip-autocomplete > ul': { maxHeight: '45vh' },
            '.cm-tooltip-autocomplete > ul > li': { padding: '9px 10px', lineHeight: '1.25' },
            '.cm-completionInfo': { display: 'none' }
          }
        })
      ]
    })
    const view = new EditorView({ state, parent: containerRef.current })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // the schema arrived (or was refreshed): new suggestions at once
  useEffect(() => {
    viewRef.current?.dispatch({ effects: completionCompartment.current.reconfigure(completionExtension(completionSource)) })
  }, [completionSource])

  // a value set from outside (a recent query, a starter SELECT, a fix)
  useEffect(() => {
    const view = viewRef.current
    if (!view || value === externalValueRef.current) return
    externalValueRef.current = value
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
  }, [value])

  return (
    <div
      ref={containerRef}
      data-testid="sql-editor"
      className="h-[220px] max-h-[70vh] min-h-[140px] resize-y overflow-hidden rounded-lg border border-stone-300 bg-white md:h-[260px] [&_.cm-editor]:h-full"
    />
  )
}
