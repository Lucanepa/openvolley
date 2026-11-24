import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { QRCodeSVG } from 'qrcode.react'
import { Check, Copy, Lock, QrCode } from 'lucide-react'
import { Button, Notice, cn } from '../../ui'
import { copyToClipboard } from '../../utils/networkInfo'
import { Disclosure, StatusLine, useRoleLabels } from './parts'
import { formatPin, sinceLabel } from './connectView'

const QR_PX = 168
const PLACEHOLDER = 'flex h-[186px] w-[186px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-stone-300 px-4 text-center text-xs text-stone-500'

/** Copy a link, with "Copied" for two seconds. */
export function CopyLinkButton({ url, className }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    const res = await copyToClipboard(url)
    if (res?.success) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }
  return (
    <Button variant="ghost" size="sm" icon={copied ? Check : Copy} disabled={!url} onClick={copy} className={className}>
      {copied ? t('connectTablets.copied', 'Copied') : t('connectTablets.copyLink', 'Copy link')}
    </Button>
  )
}

function useScanStatusText() {
  const { t } = useTranslation()
  return (s) => ({
    waiting: t('connectTablets.scan.waiting', 'Waiting for the tablet…'),
    connected: sinceLabel(s.since)
      ? t('connectTablets.scan.connected', 'Tablet connected at {{time}} (…{{ip}})', { time: sinceLabel(s.since), ip: s.ipTail || '?' })
      : t('connectTablets.card.connected', 'Connected'),
    many: t('connectTablets.scan.many', '{{count}} tablets entered this PIN', { count: s.count }),
    remote: t('connectTablets.scan.remote', 'Ask them to confirm they are in'),
    unknown: t('connectTablets.card.unknown', 'Live status not available')
  }[s.status] || '')
}

/**
 * Step 3: the picked tablet's code and PIN. The code (and link) only open
 * the right page for this match; the tablet then asks for the PIN, which is
 * shown here big enough to read out and is never in the code.
 *
 * States: off (no code: a tablet scanning now would be told its PIN is
 * wrong), no PIN, no link on this connection, gated (sign in first: the link
 * can be copied, the code waits), and the normal code + PIN + live status.
 */
export function ScanPanel({ role, url, access, status, noUrlText, gateText = null, onLetIn }) {
  const { t } = useTranslation()
  const labels = useRoleLabels()
  const scanStatus = useScanStatusText()
  const name = labels[role] || ''
  const isPublic = role === 'livescore'
  const off = status.status === 'off'
  const noPin = status.status === 'nopin'
  const showActions = !off && !noPin && !!url

  let body
  if (off) {
    body = (
      <>
        <div className={PLACEHOLDER} data-testid="scan-off">
          <Lock size={22} className="text-stone-400" aria-hidden="true" />
          <span>{t('connectTablets.scan.off', '{{role}} is off. A tablet that scans now is told its PIN is wrong.', { role: name })}</span>
        </div>
        {onLetIn && (
          <Button variant="dark" size="sm" onClick={onLetIn}>
            {t('connectTablets.allowRole', 'Let {{role}} in', { role: name })}
          </Button>
        )}
      </>
    )
  } else if (noPin) {
    body = (
      <Notice tone="warning" className="w-full">
        {t('connectTablets.scan.noPin', 'This tablet has no PIN yet. Set one in Match setup › Connections.')}
      </Notice>
    )
  } else if (!url || gateText) {
    body = (
      <div className={PLACEHOLDER} data-testid="scan-no-link">
        <QrCode size={22} className="text-stone-300" aria-hidden="true" />
        <span>{gateText || noUrlText}</span>
      </div>
    )
  } else {
    body = (
      <>
        <figure className="rounded-lg border border-stone-200 bg-white p-2" data-testid="role-qr" data-url={url}>
          <QRCodeSVG value={url} size={QR_PX} level="M" marginSize={1} />
          <figcaption className="sr-only">{name}</figcaption>
        </figure>
        <p className="text-center text-xs leading-snug text-stone-600">
          {isPublic
            ? t('connectTablets.scan.public', 'Scan with any phone or screen. No PIN needed.')
            : t('connectTablets.scan.instruction', 'Scan with the tablet’s camera, then enter this PIN:')}
        </p>
        {!isPublic && access?.pin && (
          <p
            className="font-mono text-3xl font-semibold tracking-wide text-stone-900 tabular-nums"
            data-testid={`pin-${role}`}
            aria-label={`PIN ${String(access.pin).split('').join(' ')}`}
          >
            {formatPin(access.pin)}
          </p>
        )}
      </>
    )
  }

  // No code to scan yet: say nothing unless a tablet is in already
  const seen = status.status === 'connected' || status.status === 'many'
  const liveText = !off && !noPin && !isPublic && !gateText && (url || seen) ? scanStatus(status) : ''

  return (
    <section className="flex flex-col items-center gap-1.5" data-testid="qr-panel" data-role={role} aria-live="polite">
      <p className="self-stretch text-center text-sm font-semibold text-stone-900" data-testid="scan-title">
        {t('connectTablets.scan.title', '{{role}} tablet', { role: name })}
      </p>
      {body}
      {liveText && (
        <StatusLine
          status={status.status}
          testId="scan-status"
          className={cn(status.status === 'connected' ? 'text-emerald-800' : 'text-stone-500')}
        >
          {liveText}
        </StatusLine>
      )}
      {showActions && (
        <div className="flex w-full flex-wrap items-center justify-center gap-x-3 gap-y-1.5">
          <CopyLinkButton url={url} />
          <Disclosure
            key={url}
            label={t('connectTablets.scan.typeAddress', 'Type the address')}
            openLabel={t('connectTablets.scan.hideAddress', 'Hide address')}
            className="contents"
            contentClassName="basis-full"
          >
            <p className="select-all break-all rounded-lg bg-white px-2 py-1.5 text-center font-mono text-[11px] leading-snug text-stone-700" data-testid="scan-url">{url}</p>
            <p className="mt-1 text-center text-[11px] text-stone-400">{t('connectTablets.scan.noPinInLink', 'Links and codes never contain the PIN.')}</p>
          </Disclosure>
        </div>
      )}
    </section>
  )
}
