import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Camera, Image as ImageIcon, RotateCw, ScanText } from 'lucide-react'
import KitModal from '../manage/KitModal'
import { Button, Banner, ProgressBar } from '../../ui'
import { fieldIssues, importedRosterOf } from '../../domain/importedRoster'
import { canvasBlob, guessCorners, loadPhoto, rotateCorners, scanPage } from '../../utils/rosterPhoto/scan'
import { withSavedTeamNames } from '../../utils/rosterPhoto/savedTeamNames'
import PhotoCropStep from './PhotoCropStep'
import RosterConfirmStep from './RosterConfirmStep'

/**
 * "Photo of the list" in Match Setup (docs/roster-photo-spec.md, plan A):
 * a photo of an Einsatzliste (taken now, or a picture on the device), its
 * corners set, the page read on this device (utils/rosterPhoto), the rows
 * shown to correct, and only on "Use" handed to onApply (MatchSetup
 * applyImportedRoster: the PDF import's own way). Cancel at any step changes
 * nothing. The photo stays in memory only; the dialog lets go of it on close.
 *
 * Steps: source → (loading) → crop → reading → confirm, or error.
 */
export default function RosterPhotoImport ({ side, teamLabel, savedTeam = null, disabled = false, onApply }) {
  const { t } = useTranslation()
  const [step, setStep] = useState(null)
  const [photo, setPhoto] = useState(null) // { canvas, url }
  const [corners, setCorners] = useState(null)
  const [progress, setProgress] = useState({ share: 0, phase: 'prepare' })
  const [roster, setRoster] = useState(null)
  const [error, setError] = useState(null)
  const cameraRef = useRef(null)
  const fileRef = useRef(null)
  const readingRef = useRef(null) // the AbortController of the reading under way

  const dropPhoto = () => setPhoto((prev) => { if (prev?.url) URL.revokeObjectURL(prev.url); return null })
  const close = () => {
    readingRef.current?.abort()
    readingRef.current = null
    dropPhoto()
    setRoster(null)
    setError(null)
    setStep(null)
  }
  useEffect(() => () => { readingRef.current?.abort() }, [])
  useEffect(() => () => { if (photo?.url) URL.revokeObjectURL(photo.url) }, [photo])

  const onFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setStep('loading')
    try {
      const canvas = await loadPhoto(file)
      const url = URL.createObjectURL(await canvasBlob(canvas, 'image/jpeg', 0.85))
      dropPhoto()
      setPhoto({ canvas, url })
      setCorners(guessCorners(canvas))
      setStep('crop')
    } catch (err) {
      console.warn('[RosterPhoto] photo not opened:', err?.message)
      setError('photo-unreadable')
      setStep('error')
    }
  }

  const read = async () => {
    const controller = new AbortController()
    readingRef.current?.abort()
    readingRef.current = controller
    setStep('reading')
    setProgress({ share: 0, phase: 'prepare' })
    // let the dialog show the reading step before the page's pixels keep the device busy
    await new Promise((resolve) => setTimeout(resolve, 40))
    try {
      const page = scanPage(photo.canvas, corners)
      const { readRosterPhoto } = await import('../../utils/rosterPhoto/ocr')
      const result = await readRosterPhoto(page, {
        signal: controller.signal,
        onProgress: (share, status) => {
          if (controller.signal.aborted) return
          setProgress(status.startsWith('recognizing') ? { share, phase: 'read' } : { share: 0, phase: 'prepare' })
        }
      })
      if (controller.signal.aborted) return
      setRoster(withSavedTeamNames(result, savedTeam))
      setStep('confirm')
    } catch (err) {
      if (controller.signal.aborted || err?.code === 'ocr-cancelled') return
      console.warn('[RosterPhoto] reading failed:', err?.code || err?.message)
      setError(err?.code || 'ocr-load')
      setStep('error')
    } finally {
      if (readingRef.current === controller) readingRef.current = null
    }
  }

  const issues = useMemo(() => (roster ? fieldIssues(roster) : null), [roster])
  const apply = () => {
    const clean = importedRosterOf(roster, 'ocr')
    close()
    onApply?.(clean)
  }

  const takePhoto = () => cameraRef.current?.click()
  const choosePicture = () => fileRef.current?.click()

  const footer = {
    source: <Button variant="secondary" size="lg" onClick={close}>{t('common.cancel', 'Cancel')}</Button>,
    loading: <Button variant="secondary" size="lg" onClick={close}>{t('common.cancel', 'Cancel')}</Button>,
    crop: (
      <>
        <Button variant="secondary" size="lg" onClick={() => setStep('source')} data-testid="roster-photo-another">{t('rosterPhoto.crop.another')}</Button>
        <Button variant="secondary" size="lg" icon={RotateCw} onClick={() => setCorners((c) => rotateCorners(c, 1))} data-testid="roster-photo-turn">{t('rosterPhoto.crop.turn')}</Button>
        <Button variant="primary" size="lg" icon={ScanText} onClick={read} data-testid="roster-photo-read">{t('rosterPhoto.crop.read')}</Button>
      </>
    ),
    reading: <Button variant="secondary" size="lg" onClick={close} data-testid="roster-photo-cancel">{t('common.cancel', 'Cancel')}</Button>,
    confirm: (
      <>
        <Button variant="secondary" size="lg" onClick={close} data-testid="roster-photo-cancel">{t('common.cancel', 'Cancel')}</Button>
        <Button variant="positive" size="lg" disabled={!roster?.players?.length || issues?.blocking} onClick={apply} data-testid="roster-photo-apply">
          {t('rosterPhoto.confirm.apply', { count: roster?.players?.length || 0 })}
        </Button>
      </>
    ),
    error: (
      <>
        <Button variant="secondary" size="lg" onClick={close}>{t('common.close', 'Close')}</Button>
        {photo && error !== 'photo-unreadable' && <Button variant="secondary" size="lg" onClick={() => setStep('crop')} data-testid="roster-photo-retry">{t('rosterPhoto.error.retry')}</Button>}
        <Button variant="primary" size="lg" onClick={() => setStep('source')}>{t('rosterPhoto.crop.another')}</Button>
      </>
    )
  }
  const description = {
    source: t('rosterPhoto.source.description'),
    crop: t('rosterPhoto.crop.description'),
    confirm: t('rosterPhoto.confirm.description')
  }

  return (
    <>
      {/* capture: the camera at once on a phone or tablet (a file picker on a desktop) */}
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" onChange={onFile} className="hidden" data-testid={`roster-photo-camera-${side}`} />
      <input ref={fileRef} type="file" accept="image/*" onChange={onFile} className="hidden" data-testid={`roster-photo-file-${side}`} />
      <Button
        variant="secondary"
        size="xl"
        icon={<Camera size={16} aria-hidden />}
        onClick={() => setStep('source')}
        disabled={disabled}
        className="w-full"
        data-help-id="setup-photo-import"
        data-testid={`roster-photo-${side}`}
      >
        {t('rosterPhoto.button')}
      </Button>
      <KitModal
        open={step !== null}
        onClose={close}
        decision
        dismissible={false}
        layout="sections"
        size="xl"
        className={step === 'crop' || step === 'confirm' ? 'max-w-4xl' : undefined}
        title={t('rosterPhoto.title', { team: teamLabel || '' })}
        description={description[step]}
        icon={Camera}
        closeLabel={t('common.close', 'Close')}
        footer={footer[step]}
      >
        {step === 'source' && (
          <div className="space-y-3" data-testid="roster-photo-source">
            <ul className="m-0 list-disc space-y-1 pl-5 text-sm text-stone-700">
              <li>{t('rosterPhoto.source.tipFlat')}</li>
              <li>{t('rosterPhoto.source.tipLight')}</li>
              <li>{t('rosterPhoto.source.tipWhole')}</li>
            </ul>
            <div className="grid gap-2 sm:grid-cols-2">
              <Button variant="primary" size="xl" icon={Camera} onClick={takePhoto} data-testid="roster-photo-take">{t('rosterPhoto.source.take')}</Button>
              <Button variant="secondary" size="xl" icon={ImageIcon} onClick={choosePicture} data-testid="roster-photo-choose">{t('rosterPhoto.source.choose')}</Button>
            </div>
            <p className="m-0 text-xs text-stone-500">{t('rosterPhoto.source.private')}</p>
          </div>
        )}
        {step === 'loading' && <p className="m-0 text-sm text-stone-600">{t('rosterPhoto.loading')}</p>}
        {step === 'crop' && photo && corners && (
          <PhotoCropStep url={photo.url} width={photo.canvas.width} height={photo.canvas.height} corners={corners} onChange={setCorners} />
        )}
        {step === 'reading' && (
          <div className="space-y-2" data-testid="roster-photo-reading">
            <p className="m-0 text-sm font-medium text-stone-800">
              {progress.phase === 'read' ? t('rosterPhoto.reading.read', { percent: Math.round(progress.share * 100) }) : t('rosterPhoto.reading.prepare')}
            </p>
            <ProgressBar value={progress.phase === 'read' ? progress.share * 100 : 0} max={100} label={t('rosterPhoto.reading.prepare')} />
            <p className="m-0 text-xs text-stone-500">{t('rosterPhoto.source.private')}</p>
          </div>
        )}
        {step === 'confirm' && roster && issues && (
          <RosterConfirmStep roster={roster} issues={issues} onChange={setRoster} />
        )}
        {step === 'error' && (
          <Banner tone="danger" data-testid="roster-photo-error" data-code={error}>{t(`rosterPhoto.error.${error}`, t('rosterPhoto.error.ocr-load'))}</Banner>
        )}
      </KitModal>
    </>
  )
}
