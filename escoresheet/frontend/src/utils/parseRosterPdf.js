/**
 * Parse roster PDF to extract player and official information
 * Supports Italian, French, English, and German formats
 */

// The pdf.js worker is bundled with the app (emitted as a hashed .mjs asset and
// precached by the service worker), NOT loaded from a CDN: roster import must
// work offline and on a LAN-only venue box, and the backend CSP is script-src 'self'.
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

export const PDF_WORKER_URL = pdfWorkerUrl

export async function parseRosterPdf(file) {
  try {
    // Dynamic import of pdfjs-dist
    const pdfjsLib = await import('pdfjs-dist')

    pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER_URL

    const arrayBuffer = await file.arrayBuffer()
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise

    let fullText = ''
    // Collect all positioned text items for GFL column detection
    const allPositionedItems = []

    // Extract text from all pages
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i)
      const textContent = await page.getTextContent()
      const pageText = textContent.items.map(item => item.str).join(' ')
      fullText += pageText + '\n'

      // Store items with position info (transform[4]=x, transform[5]=y)
      for (const item of textContent.items) {
        if (item.str.trim()) {
          allPositionedItems.push({
            str: item.str.trim(),
            x: item.transform[4],
            y: item.transform[5],
            page: i
          })
        }
      }
    }

    // Build GFL/LFP lookup using x-coordinates from positioned text items
    const gflPlayerNames = buildGflLookup(allPositionedItems)

    // Parse the text to extract player and official data
    const result = parseRosterText(fullText, gflPlayerNames)
    return result
  } catch (error) {
    console.error('Error parsing PDF:', error)
    // Callers prefix "Failed to parse PDF:" themselves
    throw error
  }
}

/**
 * Use PDF x-coordinates to detect which players have an "X" in the GFL column.
 * Returns a Set of "firstName|lastName" strings for players marked as GFL/LFP.
 */
function buildGflLookup(items) {
  const gflPlayerNames = new Set()

  // Find GFL/LAS/JFL/LFP column header by text
  const gflHeader = items.find(item =>
    /^(GFL|LAS|JFL|LFP)$/i.test(item.str)
  )
  if (!gflHeader) return gflPlayerNames

  const gflX = gflHeader.x
  const tolerance = 15 // x-coordinate tolerance in PDF units

  // Find all "X" marks near the GFL column x-position
  const gflMarks = items.filter(item =>
    item.str === 'X' &&
    Math.abs(item.x - gflX) < tolerance
  )

  if (gflMarks.length === 0) return gflPlayerNames

  // For each GFL "X" mark, find the player on the same row (same y-coordinate)
  // by looking for a 5-6 digit SV number at the same y position
  const yTolerance = 3
  for (const mark of gflMarks) {
    // Find the SV number on the same line
    const svNumberItem = items.find(item =>
      /^\d{5,6}$/.test(item.str) &&
      Math.abs(item.y - mark.y) < yTolerance
    )
    if (!svNumberItem) continue

    // Find name items on the same row — items between the SV number x and the GFL column x
    const rowItems = items.filter(item =>
      Math.abs(item.y - mark.y) < yTolerance &&
      item.x > svNumberItem.x &&
      item.x < gflX - tolerance &&
      !/^\d{5,6}$/.test(item.str) && // not SV number
      !/^[MFH]$/.test(item.str) && // not gender
      !/^\d{1,2}[./]\d{1,2}[./]\d{4}$/.test(item.str) && // not date
      !/^(LLR|NLR|LLA|NLA|LLB|NLB|1L|2L|3L|4L)$/i.test(item.str) // not league/club codes
    ).sort((a, b) => a.x - b.x)

    // Typically first 2 text items are firstName, lastName (or lastName, firstName)
    if (rowItems.length >= 2) {
      // Store both orderings since parser may swap them
      const name1 = rowItems[0].str
      const name2 = rowItems[1].str
      gflPlayerNames.add(`${name1}|${name2}`)
      gflPlayerNames.add(`${name2}|${name1}`)
    }
  }

  return gflPlayerNames
}

export function parseRosterText(text, gflPlayerNames = new Set()) {
  const result = {
    players: [],
    coach: null,
    ac1: null,
    ac2: null
  }

  // Removed console.log('[parseRosterText] Raw text (first 1000 chars):', text.substring(0, 1000))

  // Normalize text - remove extra whitespace
  const normalizedText = text.replace(/\s+/g, ' ').trim()
  
  // Removed console.log('[parseRosterText] Normalized text (first 1000 chars):', normalizedText.substring(0, 1000))
  
  // Helper: name word pattern with hyphen and apostrophe support
  // Supports: Jean-Pierre, O'Brien, D'Angelo, Müller, François
  // Pattern breakdown:
  //   - Capital letter (including accented: Ä, Ö, Ü, etc.)
  //   - MUST have either: lowercase letters OR apostrophe+content (prevents matching single letters like M/F)
  //   - Zero or more: hyphen + capital + lowercase+ (for Jean-Pierre)
  // Latin Extended-A and -B too (U+0100–U+024F): "Krawczyńsk", "Dvořák", "Ștefan"
  // were dropped whole (both cases: the two blocks mix upper and lower letters)
  const upper = 'A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß\u0100-\u024F'
  const lower = 'a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ\u0100-\u024F'
  // Either: lowercase+ (optionally with apostrophe after), OR apostrophe+content (for O'Brien, D'Angelo)
  const nameWord = `[${upper}](?:[${lower}]+(?:'[${upper}]?[${lower}]+)?|'[${upper}]?[${lower}]+)(?:-[${upper}][${lower}]+)*`
  // Full name: one or more name words separated by spaces
  const fullName = `${nameWord}(?:\\s+${nameWord})*`

  // Common patterns for different languages
  const patterns = {
    // Player patterns - look for number, name, DOB
    // Format variations: "1. LastName FirstName DD/MM/YYYY" or "1 LastName FirstName DD/MM/YYYY"
    player: new RegExp(`(\\d+)[.\\s]+(${fullName})\\s+(${fullName})\\s+(\\d{1,2}[./]\\d{1,2}[./]\\d{4})`, 'gi'),

    // Coach patterns - look for "Coach", "Entraîneur", "Allenatore", "Trainer"
    coach: new RegExp(`(?:Coach|Entraîneur|Allenatore|Trainer)[:\\s]+(${fullName})\\s+(${fullName})(?:\\s+(\\d{1,2}[./]\\d{1,2}[./]\\d{4}))?`, 'gi'),

    // Assistant Coach patterns
    ac1: new RegExp(`(?:Assistant\\s+Coach\\s+1|Entraîneur\\s+adjoint\\s+1|Allenatore\\s+assistente\\s+1|Assistenttrainer\\s+1)[:\\s]+(${fullName})\\s+(${fullName})(?:\\s+(\\d{1,2}[./]\\d{1,2}[./]\\d{4}))?`, 'gi'),

    ac2: new RegExp(`(?:Assistant\\s+Coach\\s+2|Entraîneur\\s+adjoint\\s+2|Allenatore\\s+assistente\\s+2|Assistenttrainer\\s+2)[:\\s]+(${fullName})\\s+(${fullName})(?:\\s+(\\d{1,2}[./]\\d{1,2}[./]\\d{4}))?`, 'gi')
  }

    // Extract players
    let match
    while ((match = patterns.player.exec(normalizedText)) !== null) {
      const number = parseInt(match[1])
      const lastName = match[2].trim()
      const firstName = match[3].trim()
      const dob = match[4].trim()
      
      result.players.push({
        number,
        firstName,
        lastName,
        dob: normalizeDate(dob)
      })
    }

    // Extract coach
    const coachMatch = patterns.coach.exec(normalizedText)
    if (coachMatch && !hasLabelledOfficials(normalizedText)) {
      result.coach = {
        firstName: coachMatch[1]?.trim() || '',
        lastName: coachMatch[2]?.trim() || '',
        dob: coachMatch[3] ? normalizeDate(coachMatch[3].trim()) : ''
      }
    }

    // Extract AC1
    const ac1Match = patterns.ac1.exec(normalizedText)
    if (ac1Match && !hasLabelledOfficials(normalizedText)) {
      result.ac1 = {
        firstName: ac1Match[1]?.trim() || '',
        lastName: ac1Match[2]?.trim() || '',
        dob: ac1Match[3] ? normalizeDate(ac1Match[3].trim()) : ''
      }
    }

    // Extract AC2
    const ac2Match = patterns.ac2.exec(normalizedText)
    if (ac2Match && !hasLabelledOfficials(normalizedText)) {
      result.ac2 = {
        firstName: ac2Match[1]?.trim() || '',
        lastName: ac2Match[2]?.trim() || '',
        dob: ac2Match[3] ? normalizeDate(ac2Match[3].trim()) : ''
      }
    }

    // Try Italian/German SV number format (even if some players were found, as the first pattern might miss some)
    // This format is common in Swiss Volleyball rosters
    // Store SV format players separately to avoid duplicates
    const svFormatPlayers = []

      // Try Italian/German/French format: SV number (5-6 digits), First Name, Last Name, M/F/H, Date
      // Pattern: 5-6 digit number, name, name, M/F/H, date (DD.MM.YYYY or DD/MM/YYYY, may have spaces)
      // The SV number is the player's Swiss Volley licence number: kept as `licence`.
      // Example Italian: "123456   Marco   Muster   M   14.03.2004"   (made-up rows)
      // Example German: "98765 | Anna | Beispiel | F | 07.10 .2007"
      // Example French: "234567 | Léa | Exemple | F | 19.08.1999"
      // Use normalized text for consistent spacing, but also try original text for dates with spaces
      // Note: H = Homme (French for Male), M = Male, F = Female
    const svPlayerPattern = new RegExp(`(\\d{5,6})\\s+(${fullName})\\s+(${fullName})\\s+[MFH]\\s+(\\d{1,2}[./]\\s*\\d{1,2}[./]\\s*\\d{4})`, 'gi')

    // Reset regex lastIndex to avoid issues
    svPlayerPattern.lastIndex = 0
    while ((match = svPlayerPattern.exec(normalizedText)) !== null) {
      const firstName = match[2].trim()
      const lastName = match[3].trim()
      const dob = normalizeDate(match[4].replace(/\s+/g, '').trim())
      // Use coordinate-based GFL lookup instead of trailing text heuristic
      const isLfp = gflPlayerNames.has(`${firstName}|${lastName}`)

      svFormatPlayers.push({
        number: null,
        licence: match[1],
        firstName,
        lastName,
        dob,
        isLfp
      })
    }

    // If still no SV format players, try with original text (not normalized) to catch dates with spaces
    if (svFormatPlayers.length === 0) {
      const svPlayerPatternOriginal = new RegExp(`(\\d{5,6})\\s+(${fullName})\\s+(${fullName})\\s+[MFH]\\s+(\\d{1,2}\\s*[./]\\s*\\d{1,2}\\s*[./]\\s*\\d{4})`, 'gi')

      let matchOriginal
      while ((matchOriginal = svPlayerPatternOriginal.exec(text)) !== null) {
        const firstName = matchOriginal[2].trim()
        const lastName = matchOriginal[3].trim()
        const dob = normalizeDate(matchOriginal[4].replace(/\s+/g, '').trim())
        // Use coordinate-based GFL lookup instead of trailing text heuristic
        const isLfp = gflPlayerNames.has(`${firstName}|${lastName}`)

        svFormatPlayers.push({
          number: null,
          licence: matchOriginal[1],
          firstName,
          lastName,
          dob,
          isLfp
        })
      }
    }
    
    // If we found SV format players and they outnumber the original pattern results, use SV format
    // This handles cases where the first pattern only found a few players incorrectly
    if (svFormatPlayers.length > result.players.length) {
      result.players = svFormatPlayers
    } else if (result.players.length === 0 && svFormatPlayers.length > 0) {
      result.players = svFormatPlayers
    }
    
    // If still no players, try simpler patterns in the full text
    if (result.players.length === 0) {
      // Try pattern: number, firstname, lastname, M/F, date (with hyphen/apostrophe support)
      // Must have lowercase+ OR apostrophe+content (prevents matching single letters like M/F)
      const simpleNameWord = "[A-Z](?:[a-z]+(?:'[A-Z]?[a-z]+)?|'[A-Z]?[a-z]+)(?:-[A-Z][a-z]+)*"
      const simpleFullName = `${simpleNameWord}(?:\\s+${simpleNameWord})*`
      const simplePattern = new RegExp(`(\\d+)\\s+(${simpleFullName})\\s+(${simpleFullName})\\s+[MF]\\s+(\\d{1,2}[./]\\d{1,2}[./]\\d{4})`, 'gi')
      simplePattern.lastIndex = 0
      while ((match = simplePattern.exec(text)) !== null) {
          const number = parseInt(match[1])
          const firstName = match[2].trim()
          const lastName = match[3].trim()
          const dob = normalizeDate(match[4].trim())
          
          // Removed console.log('[parseRosterText] Found simple format player:', { number, firstName, lastName, dob })
          
          result.players.push({
            number,
            firstName,
            lastName,
            dob
          })
        }
      }
      
      // Removed console.log('[parseRosterText] Total players found:', result.players.length)
    
    // VolleyManager's officials, in any language: "<role>: #<SV number> | <first> <last> (<year>)",
    // e.g. "Allenatore: #52205 | …", "1. Assistant Coach: #72458 | …".
    // The role is told by its words (officialRoleOf), the SV number is kept as the licence and a
    // year alone is no date of birth (birthYear).
    for (const o of parseLabelledOfficials(normalizedText, fullName)) {
      if (!result[o.slot]) result[o.slot] = o.person
    }
  // The text has no column borders, so "Noel von Wattenwyl" comes out as first name
  // "Noel von": a name particle belongs to the last name
  for (const p of result.players) Object.assign(p, moveNameParticles(p.firstName, p.lastName))
  for (const k of OFFICIAL_SLOTS) {
    if (result[k]) Object.assign(result[k], moveNameParticles(result[k].firstName, result[k].lastName))
  }
  return result
}

// An Einsatzliste names the coach and the two assistants, never a physiotherapist or medic
export const OFFICIAL_SLOTS = ['coach', 'ac1', 'ac2']

const LABELLED_OFFICIAL = /:\s*#\s*\d{3,7}\s*\|/
const hasLabelledOfficials = (text) => LABELLED_OFFICIAL.test(text)

// Lowercase, accents off: "Entraîneur" -> "entraineur"
const foldLabel = (v) => String(v ?? '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '')

/**
 * The slot of an official's role label in VolleyManager's languages (German,
 * French, Italian): 'coach', 'ac1', 'ac2', 'ac' (an assistant without its
 * number) or null (not the coach or an assistant). By its words, not by one
 * language's exact text.
 */
export function officialRoleOf(label) {
  const l = foldLabel(label)
  if (/assist|adjoint|aiuto|vice|\bco-?(coach|trainer|entra|allena)/.test(l)) {
    if (/(^|[^\d])2(?!\d)|\b(second|seconda|secondo|zweit|deuxieme|2nd)/.test(l)) return 'ac2'
    if (/(^|[^\d])1(?!\d)|\b(first|primo|prima|erst|premier|1st)/.test(l)) return 'ac1'
    return 'ac'
  }
  if (/coach|trainer|allenat|entrain|head/.test(l)) return 'coach'
  return null
}

/**
 * The officials written "<role>: #<SV number> | <first> <last> (<year>)":
 * [{ slot, person: { firstName, lastName, dob: '', birthYear, licence } }],
 * each slot once; an assistant without its number takes the first free one.
 */
export function parseLabelledOfficials(text, fullName) {
  const re = new RegExp(`([^:()|#]{1,80}):\\s*#\\s*(\\d{3,7})\\s*\\|\\s*(${fullName})\\s+(${fullName})\\s*\\((\\d{4})\\)`, 'gu')
  const out = []
  const taken = new Set()
  let m
  while ((m = re.exec(text)) !== null) {
    // the label is the last words before the colon ("… 14.03.2004 1. Assistant Coach")
    const label = m[1].split(/\d{1,2}[./]\s*\d{1,2}[./]\s*\d{4}/).pop().trim().split(/\s+/).slice(-4).join(' ')
    let slot = officialRoleOf(label)
    if (slot === 'ac' || (slot === 'coach' && taken.has('coach'))) slot = ['ac1', 'ac2'].find((s) => !taken.has(s)) || null
    if (!slot || taken.has(slot)) continue
    taken.add(slot)
    out.push({ slot, person: { firstName: m[3].trim(), lastName: m[4].trim(), dob: '', birthYear: m[5], licence: m[2] } })
  }
  return out
}

// Lowercase only: as VolleyManager writes them ("von Wattenwyl", "de Weck", "van der Berg")
const NAME_PARTICLES = new Set(['von', 'vom', 'van', 'zu', 'zur', 'zum', 'de', 'des', 'du', 'di', 'da', 'del',
  'della', 'dalla', 'dello', 'degli', 'dei', 'dos', 'das', 'le', 'la', 'lo', 'ten', 'ter', 'den', 'der', 'af', 'av', 'y'])

/** Lowercase name particles at the end of a first name move to the front of the last name. */
export function moveNameParticles(firstName, lastName) {
  const words = String(firstName ?? '').trim().split(/\s+/).filter(Boolean)
  const moved = []
  while (words.length > 1 && NAME_PARTICLES.has(words[words.length - 1])) moved.unshift(words.pop())
  if (!moved.length) return { firstName, lastName }
  return { firstName: words.join(' '), lastName: [...moved, String(lastName ?? '').trim()].filter(Boolean).join(' ') }
}

function normalizeDate(dateStr) {
  if (!dateStr) return ''
  // Normalize date format to DD/MM/YYYY
  return dateStr.replace(/\./g, '/')
}
