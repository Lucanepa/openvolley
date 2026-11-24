#!/usr/bin/env node
/**
 * Copies the manifest of the recorded support videos into the app as
 * src/components/help/helpVideos.js: each recorded section's video title,
 * length, picture size and subtitle languages. The "?" panel shows a
 * section's video only when it is listed there, with only those subtitle
 * tracks, in a box of the video's own shape. The files themselves go to the
 * website (openvolley.app/support/videos).
 *
 * Usage, after recording (~/.cache/openvolley/support-videos/tools):
 *   node scripts/import-help-videos.mjs                # ~/.cache/openvolley/support-videos/manifest.json
 *   node scripts/import-help-videos.mjs path/to/manifest.json
 *
 * Exits 1, writing nothing, when an entry is not a help section, lacks a
 * title or a length, or a file is not named as the website serves it
 * (<id>.mp4, <id>.jpg, <id>.<lang>.vtt). The picture size is the manifest's
 * width and height, else ffprobe's of the mp4 next to the manifest; without
 * either the panel draws a 16:9 box.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SECTION_IDS, VIDEO_LANGUAGES } from '../src/components/help/helpSections.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(__dirname, '..', 'src/components/help/helpVideos.js')
const DEFAULT_MANIFEST = path.join(os.homedir(), '.cache', 'openvolley', 'support-videos', 'manifest.json')
const LANGUAGES = VIDEO_LANGUAGES.map(v => v.lang)

const manifestFile = path.resolve(process.argv[2] || DEFAULT_MANIFEST)
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))

/** { width, height } of the video: the manifest's, else ffprobe's; null when neither has it. */
function pictureSize(entry) {
  if (Number(entry.width) > 0 && Number(entry.height) > 0) return { width: Number(entry.width), height: Number(entry.height) }
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height',
      '-of', 'csv=p=0', path.join(path.dirname(manifestFile), entry.file)], { encoding: 'utf8' })
    const [width, height] = out.trim().split(',').map(Number)
    if (width > 0 && height > 0) return { width, height }
  } catch { /* no ffprobe or no file */ }
  console.warn(`${entry.id}: no picture size (a 16:9 box)`)
  return null
}

const problems = []
const byId = new Map()
for (const entry of Array.isArray(manifest) ? manifest : []) {
  const id = entry?.id
  if (!SECTION_IDS.includes(id)) { problems.push(`${id}: not a help section`); continue }
  if (byId.has(id)) problems.push(`${id}: listed twice`)
  if (entry.file !== `${id}.mp4`) problems.push(`${id}: file ${entry.file}, not ${id}.mp4`)
  if (entry.poster !== `${id}.jpg`) problems.push(`${id}: poster ${entry.poster}, not ${id}.jpg`)
  if (!(Number(entry.durationSec) > 0)) problems.push(`${id}: no length`)
  for (const lng of LANGUAGES) {
    if (typeof entry.title?.[lng] !== 'string' || !entry.title[lng].trim()) problems.push(`${id}: no ${lng} title`)
  }
  const languages = LANGUAGES.filter(lng => entry.tracks?.[lng])
  for (const [lng, file] of Object.entries(entry.tracks || {})) {
    if (!LANGUAGES.includes(lng)) problems.push(`${id}: subtitles in ${lng}, which the app has no track for`)
    else if (file !== `${id}.${lng}.vtt`) problems.push(`${id}: subtitles ${file}, not ${id}.${lng}.vtt`)
  }
  byId.set(id, {
    title: Object.fromEntries(LANGUAGES.map(lng => [lng, String(entry.title?.[lng] || '').trim()])),
    durationSec: Math.round(Number(entry.durationSec) * 10) / 10,
    size: pictureSize(entry),
    languages,
    appVersion: entry.appVersion,
    recordedAt: entry.recordedAt
  })
}
if (!byId.size) problems.push('no videos in the manifest')
if (problems.length) {
  console.error(`${manifestFile}:\n  ${problems.join('\n  ')}`)
  process.exit(1)
}

// single quotes as in the app's code; double where the text has an apostrophe
const str = (s) => (/'/.test(s) && !/["\\]/.test(s) ? JSON.stringify(String(s)) : `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`)
const key = (s) => (/^[a-z_$][\w$]*$/i.test(s) ? s : str(s))
const ids = SECTION_IDS.filter(id => byId.has(id))
const videos = ids.map(id => byId.get(id))
const versions = [...new Set(videos.map(v => v.appVersion).filter(Boolean))].join(', ')
const days = videos.map(v => v.recordedAt).filter(Boolean).sort()
const day = (iso) => iso && new Date(iso).toISOString().slice(0, 10).split('-').reverse().join('.')
const recorded = [versions && `OpenVolley ${versions}`, day(days.at(-1))].filter(Boolean).join(', ')

const lines = ids.map(id => {
  const v = byId.get(id)
  const title = LANGUAGES.map(lng => `${lng}: ${str(v.title[lng])}`).join(', ')
  const size = v.size ? `width: ${v.size.width}, height: ${v.size.height}, ` : ''
  return `  ${key(id)}: { title: { ${title} }, durationSec: ${v.durationSec}, ${size}languages: [${v.languages.map(str).join(', ')}] }`
})

const out = `// The help's recorded videos (helpSections.js sectionVideo), one per section:
// the title in each language, the length in seconds, the picture size and
// the subtitle languages. A section that is not listed has no video yet and
// the panel shows none. The files are on openvolley.app/support/videos.
// Written by scripts/import-help-videos.mjs from the recorder's manifest${recorded ? `\n// (${recorded})` : ''}; do not edit by hand. Plain data: node reads it too.

export const HELP_VIDEOS = {
${lines.join(',\n')}
}
`
fs.writeFileSync(OUT, out)
const missing = SECTION_IDS.filter(id => !byId.has(id))
console.log(`${OUT}: ${ids.length} videos${missing.length ? `, none yet for ${missing.join(', ')}` : ''}`)
