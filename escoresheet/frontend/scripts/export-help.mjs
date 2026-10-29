#!/usr/bin/env node
/**
 * Exports the in-app help (src/components/help/helpSections.js) for the
 * website's support page (openvolley.app/support), which is organised by the
 * same sections: every section's title, its questions and answers, its video
 * and the screens of the app that show it, in English, German, French and
 * Italian (de-CH is left out: the website has no Swiss German), resolved from
 * the app's locale files.
 *
 * Usage:
 *   node scripts/export-help.mjs                 # ~/.cache/openvolley/support-help-export.json
 *   node scripts/export-help.mjs --out help.json
 *
 * Exits 1, writing nothing, when a text is missing in one of the languages.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HELP_SCREENS, HELP_SECTIONS, SUPPORT_PAGE, VIDEO_BASE, screensForSection, sectionVideo, supportPageUrl } from '../src/components/help/helpSections.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FRONTEND_DIR = path.join(__dirname, '..')
const LANGUAGES = ['en', 'de', 'fr', 'it']
const DEFAULT_OUT = path.join(os.homedir(), '.cache', 'openvolley', 'support-help-export.json')

const outArg = process.argv.indexOf('--out')
const outFile = path.resolve(outArg >= 0 && process.argv[outArg + 1] ? process.argv[outArg + 1] : DEFAULT_OUT)

const locales = Object.fromEntries(LANGUAGES.map(lng => [
  lng,
  JSON.parse(fs.readFileSync(path.join(FRONTEND_DIR, 'src/i18n/locales', `${lng}.json`), 'utf8'))
]))
const version = JSON.parse(fs.readFileSync(path.join(FRONTEND_DIR, 'package.json'), 'utf8')).version

const missing = []
const get = (obj, key) => key.split('.').reduce((o, k) => (o == null ? o : o[k]), obj)
/** { en, de, fr, it } of an i18n key */
function texts(key) {
  return Object.fromEntries(LANGUAGES.map(lng => {
    const value = get(locales[lng], key)
    if (typeof value !== 'string' || !value.trim()) missing.push(`${lng}: ${key}`)
    return [lng, value ?? null]
  }))
}

// contextHelp.home.q_createMatch -> createMatch (unique within its section)
const faqId = (questionKey) => questionKey.split('.').pop().replace(/^q_/, '')

const screens = Object.fromEntries(Object.entries(HELP_SCREENS).map(([id, screen]) => [id, {
  app: screen.app,
  name: texts(screen.nameKey),
  sections: screen.sections
}]))

const sections = HELP_SECTIONS.map(section => {
  const video = sectionVideo(section.video)
  return {
    id: section.id,
    url: supportPageUrl(section.id),
    title: texts(section.titleKey),
    video: {
      id: section.video,
      mp4: video.src,
      poster: video.poster,
      subtitles: Object.fromEntries(video.tracks.map(track => [track.lang, track.src]))
    },
    screens: screensForSection(section.id).map(id => ({ id, app: HELP_SCREENS[id].app, name: screens[id].name })),
    faq: section.faq.map(item => ({
      id: faqId(item.questionKey),
      question: texts(item.questionKey),
      answer: texts(item.answerKey)
    }))
  }
})

if (missing.length) {
  console.error(`Missing texts (${missing.length}):\n  ${missing.join('\n  ')}`)
  process.exit(1)
}

const out = {
  generatedAt: new Date().toISOString(),
  appVersion: version,
  languages: LANGUAGES,
  supportPage: SUPPORT_PAGE,
  videoBase: VIDEO_BASE,
  sections,
  screens
}
fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(outFile, `${JSON.stringify(out, null, 2)}\n`)
const questions = sections.reduce((n, s) => n + s.faq.length, 0)
console.log(`${outFile}: ${sections.length} sections, ${questions} questions, ${Object.keys(screens).length} screens, ${LANGUAGES.join(' ')}`)
