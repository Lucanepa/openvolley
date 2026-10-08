import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Switch, cn } from '../ui'
import { db } from '../db/db'
import { diagnosticsState, setDiagnosticsEnabled, exportDiagnostics } from './index'

const BTN_OUTLINE = 'inline-flex h-11 items-center justify-center gap-1.5 rounded-lg border border-stone-300 bg-white px-4 text-sm font-medium text-stone-700 hover:bg-stone-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60 focus-visible:ring-offset-1'

/**
 * Options > Logs > Diagnostics mode: the switch (this device) and the export
 * (desktop: the log folder with diagnostics-<date>.jsonl; elsewhere a .jsonl
 * download of the stored lines). A row of the options' settings list.
 */
export default function DiagnosticsSection({ showAlert, testIdPrefix = 'options' }) {
  const { t } = useTranslation()
  const [state, setState] = useState(diagnosticsState)
  const [busy, setBusy] = useState(false)
  const forced = state.on && (state.source === 'url' || state.source === 'env')
  const fileSink = state.sink === 'file' || (!state.sink && typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__)

  const toggle = async (next) => {
    setBusy(true)
    try {
      setState(await setDiagnosticsEnabled(next, { db }))
    } finally {
      setBusy(false)
    }
  }

  const onExport = async () => {
    try {
      const result = await exportDiagnostics()
      if (result === 'empty') showAlert?.(t('options.diagnosticsEmpty'), 'info')
      else if (!result) showAlert?.(t('options.diagnosticsExportFailed'), 'error')
    } catch (err) {
      console.error('[Options] diagnostics export failed:', err)
      showAlert?.(t('options.diagnosticsExportFailed'), 'error')
    }
  }

  return (
    <div className="flex min-h-12 shrink-0 flex-col items-stretch gap-3 py-3" data-testid={`${testIdPrefix}-diagnostics`}>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div id={`${testIdPrefix}-diagnostics-title`} className="text-sm font-semibold text-stone-900">{t('options.diagnosticsMode')}</div>
          <p className="mt-0.5 text-xs text-stone-500">{t('options.diagnosticsModeInfo')}</p>
          {forced && (
            <p className="mt-1 text-xs font-medium text-amber-700">
              {t(state.source === 'env' ? 'options.diagnosticsOnByEnv' : 'options.diagnosticsOnByLink')}
            </p>
          )}
        </div>
        <Switch
          size="lg"
          checked={state.on}
          disabled={busy || forced}
          onCheckedChange={toggle}
          aria-labelledby={`${testIdPrefix}-diagnostics-title`}
          className={cn('shrink-0', state.on && 'bg-slate-900')}
          data-testid={`${testIdPrefix}-diagnostics-switch`}
        />
      </div>
      <button type="button" onClick={onExport} className={cn(BTN_OUTLINE, 'w-full')} data-testid={`${testIdPrefix}-diagnostics-export`}>
        {fileSink ? t('options.openLogFolder') : t('options.exportDiagnostics')}
      </button>
    </div>
  )
}
