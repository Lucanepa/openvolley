import { Fragment } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../ui/cn.js'
import { LEGAL_DOCS, legalUrl } from './legalUrls'

/**
 * Links to the legal pages on openvolley.app in the reader's language
 * (de/de-CH -> German, fr, it, everything else English); English is binding.
 * External links open in the browser (desktop app: the system browser via
 * the new-window handler; Android: the WebView hands other hosts to the
 * browser), like the source-code link in Options.
 */

export const LEGAL_LINK_CLASS = 'whitespace-nowrap underline decoration-stone-300 underline-offset-2 transition-colors hover:text-stone-800 hover:decoration-stone-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60 focus-visible:ring-offset-1 rounded-sm'

/** The language of the open app, also where tests mock useTranslation without i18n. */
function useLegalLanguage() {
  const { i18n } = useTranslation()
  return i18n?.resolvedLanguage || i18n?.language || 'en'
}

export function LegalLink({ doc, className, children }) {
  const { t } = useTranslation()
  const lng = useLegalLanguage()
  return (
    <a href={legalUrl(doc, lng)} target="_blank" rel="noopener noreferrer" className={cn(LEGAL_LINK_CLASS, className)}>
      {children ?? t(`legal.${doc}`)}
    </a>
  )
}

/**
 * "Made by Swiss referees": who makes OpenVolley (owner 2026-11-10), a quiet
 * line under the home logo and above the legal links. No club is named: the
 * apps belong to no club.
 */
export function MadeBy({ className, ...rest }) {
  const { t } = useTranslation()
  return <p data-testid="made-by" className={className} {...rest}>{t('brand.madeBy')}</p>
}

/**
 * "Made by Swiss referees", then on its own line
 * "Privacy policy · Terms of use · Legal notice · Open-source notice".
 * docs: which pages, in that order (default all four).
 * madeBy: the "Made by Swiss referees" line above the links (default on, so
 * every app's footer and menu carries it).
 */
export default function LegalLinks({ docs = LEGAL_DOCS, madeBy = true, className, linkClassName, ...rest }) {
  const { t } = useTranslation()
  return (
    <div className={cn('text-xs leading-relaxed text-stone-500', className)} {...rest}>
      {madeBy && <MadeBy />}
      <nav aria-label={t('legal.nav')} data-testid="legal-links">
        {docs.map((doc, i) => (
          <Fragment key={doc}>
            {i > 0 && <span aria-hidden="true"> · </span>}
            <LegalLink doc={doc} className={linkClassName} />
          </Fragment>
        ))}
      </nav>
    </div>
  )
}

/**
 * A translated sentence with <terms>…</terms> and <privacy>…</privacy>
 * marks, e.g. "By creating an account you accept the <terms>terms of
 * use</terms> and the <privacy>privacy policy</privacy>." The marked words
 * become links; the rest stays text (no HTML is ever parsed).
 */
export function LegalSentence({ i18nKey, className, ...rest }) {
  const { t } = useTranslation()
  const text = String(t(i18nKey))
  const parts = []
  const re = /<(terms|privacy|impressum|opensource)>(.*?)<\/\1>/g
  let last = 0
  let m
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    parts.push(<LegalLink key={m.index} doc={m[1]}>{m[2]}</LegalLink>)
    last = re.lastIndex
  }
  if (last < text.length) parts.push(text.slice(last))
  return <p className={className} {...rest}>{parts}</p>
}
