import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { QRCodeSVG } from 'qrcode.react'
import { Check, Copy, Loader2, QrCode, Tablet } from 'lucide-react'
import { Button, Modal, Notice, cn } from '../ui'
import { getLocalServerStatusUrl } from '../utils/backendConfig'
import { copyToClipboard } from '../utils/networkInfo'

/**
 * The addresses tablets on the same Wi-Fi open (scoretable, referee, bench,
 * livescore), from the local relay's /api/server/status. Shown where a local
 * server serves the page: the desktop app (it replaces the native
 * "Help > Connect a Tablet" menu), a venue box, the dev server.
 * @param {{ ip?: string|null, localIP?: string|null, port?: number|string|null, urls?: Record<string,string> }|null} status
 * @returns {{ key: string, url: string }[]}
 */
export function lanTabletUrls(status) {
  if (!status) return []
  const u = status.urls || {}
  const ip = status.localIP || status.ip || null
  const base = ip && status.port ? `http://${ip}:${status.port}` : null
  const pick = (key, path) => u[`${key}IP`] || u[key] || (base ? `${base}${path}` : null)
  return [
    { key: 'main', url: pick('main', '/') },
    { key: 'referee', url: pick('referee', '/referee') },
    { key: 'bench', url: pick('bench', '/bench') },
    { key: 'livescore', url: pick('livescore', '/livescore') }
  ].filter(r => !!r.url)
}

export default function LanTabletsModal({ open, onClose, fetchImpl = fetch }) {
  const { t } = useTranslation()
  const [state, setState] = useState({ loading: true, status: null, error: false })
  const [copied, setCopied] = useState(null)
  const [qrFor, setQrFor] = useState('referee')

  useEffect(() => {
    if (!open) return undefined
    let cancelled = false
    const url = getLocalServerStatusUrl()
    setState({ loading: true, status: null, error: false })
    if (!url) {
      setState({ loading: false, status: null, error: true })
      return undefined
    }
    fetchImpl(url, { headers: { Accept: 'application/json' } })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(status => { if (!cancelled) setState({ loading: false, status, error: false }) })
      .catch(() => { if (!cancelled) setState({ loading: false, status: null, error: true }) })
    return () => { cancelled = true }
  }, [open, fetchImpl])

  const labels = {
    main: t('lanTablets.scoretable', 'Scoretable'),
    referee: t('lanTablets.referee', 'Referee'),
    bench: t('lanTablets.bench', 'Bench'),
    livescore: t('lanTablets.livescore', 'Livescore')
  }
  const rows = lanTabletUrls(state.status)
  const qrRow = rows.find(r => r.key === qrFor) || rows[0]

  const copy = async (row) => {
    const res = await copyToClipboard(row.url)
    if (res?.success) {
      setCopied(row.key)
      setTimeout(() => setCopied(c => (c === row.key ? null : c)), 2000)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      icon={Tablet}
      title={t('lanTablets.title', 'Connect tablets')}
      description={t('lanTablets.description', 'Tablets on the same Wi-Fi open these addresses in their browser. No internet needed.')}
      closeLabel={t('common.close', 'Close')}
    >
      {state.loading && (
        <div className="flex items-center gap-2 py-6 text-sm text-stone-500" role="status">
          <Loader2 size={16} className="animate-spin" aria-hidden="true" />
          {t('lanTablets.loading', 'Reading the local server…')}
        </div>
      )}

      {!state.loading && (state.error || rows.length === 0) && (
        <Notice tone="warning" className="mt-2">
          {t('lanTablets.unavailable', 'The local server does not answer. Restart the app, then try again.')}
        </Notice>
      )}

      {!state.loading && rows.length > 0 && (
        <div className="mt-2 grid gap-4 sm:grid-cols-[1fr_auto]">
          <div className="divide-y divide-stone-100" data-testid="lan-tablet-urls">
            {rows.map(row => (
              <div key={row.key} className="flex min-h-12 items-center gap-2 py-2">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-stone-900">{labels[row.key]}</div>
                  <div className="truncate font-mono text-xs text-stone-600" title={row.url}>{row.url}</div>
                </div>
                <Button
                  variant={qrRow?.key === row.key ? 'dark' : 'ghost'}
                  size="sm"
                  icon={QrCode}
                  aria-pressed={qrRow?.key === row.key}
                  onClick={() => setQrFor(row.key)}
                >
                  {t('lanTablets.qr', 'QR')}
                </Button>
                <Button variant="ghost" size="sm" icon={copied === row.key ? Check : Copy} onClick={() => copy(row)}>
                  {copied === row.key ? t('lanTablets.copied', 'Copied') : t('lanTablets.copy', 'Copy')}
                </Button>
              </div>
            ))}
          </div>
          {qrRow && (
            <figure className="flex flex-col items-center gap-2 self-start rounded-xl border border-stone-200/70 bg-stone-50/60 p-3">
              <QRCodeSVG value={qrRow.url} size={148} level="M" marginSize={1} />
              <figcaption className={cn('text-xs font-semibold text-stone-700')}>{labels[qrRow.key]}</figcaption>
            </figure>
          )}
        </div>
      )}

      <p className="mt-4 text-xs leading-snug text-stone-500">
        {t('lanTablets.hint', 'The tablet must be on the same Wi-Fi as this computer. The camera (QR roster upload) works on this computer only, not on tablets over plain http.')}
      </p>
    </Modal>
  )
}
