/**
 * Generate a filled PDF using the fillable PDF template and field mapping
 * This uses the official fillable PDF form instead of generating from scratch
 */

import { generateFilledPdf } from './fillPdfForm.js'

/**
 * Generate a filled PDF scoresheet from the fillable template
 * 
 * @param {Object} matchData - Match data object with the following structure:
 *   {
 *     match: {
 *       scheduledAt: '2025-11-16T20:00:00.000Z', // ISO date string
 *       date: '16.11.2025', // Optional: formatted date (dd.mm.yyyy)
 *       time: '20:00', // Optional: formatted time (HH:mm)
 *       venue: 'Kantonsschule Wiedikon (Halle A)',
 *       city: 'Zürich',
 *       league: '3L B',
 *       gameNumber: '123456',
 *       matchType: 'championship' // or 'cup'
 *     },
 *     homeTeam: { name: 'Volley Zürich Test' },
 *     awayTeam: { name: 'Volley Basel Test' },
 *     players: {
 *       home: [
 *         { number: 1, name: 'Müller Max', firstName: 'Max', lastName: 'Müller', dob: '15.05.1995' },
 *         // ... up to 14 players
 *       ],
 *       away: [ /* same structure */ ]
 *     },
 *     liberos: {
 *       home: [
 *         { number: 13, name: 'Libero1', firstName: 'Lib', lastName: 'Ero1', dob: '10.01.1995' },
 *         // ... up to 2 liberos
 *       ],
 *       away: [ /* same structure */ ]
 *     },
 *     bench: {
 *       home: [
 *         { role: 'coach', firstName: 'Marco', lastName: 'Frei', dob: '15.05.1975' },
 *         { role: 'assistant_coach', firstName: 'Jan', lastName: 'Widmer', dob: '21.09.1980' },
 *         { role: 'physiotherapist', firstName: 'Eva', lastName: 'Gerber', dob: '03.12.1985' }
 *       ],
 *       away: [ /* same structure */ ]
 *     },
 *     officials: {
 *       referee1: { firstName: 'Hans', lastName: 'Müller' },
 *       referee2: { firstName: 'Peter', lastName: 'Schmidt' },
 *       scorer: { firstName: 'Anna', lastName: 'Weber' },
 *       assistantScorer: { firstName: 'Lisa', lastName: 'Fischer' }
 *     }
 *   }
 * 
 * @param {string} templatePath - Path to the fillable PDF template (default: 'matchblatt_fillable.pdf')
 * @param {string} mappingPath - Path to the field mapping JSON file (default: 'pdf-field-mapping.json')
 * @returns {Promise<Uint8Array>} - PDF bytes that can be saved or displayed
 */
export async function generateFillablePdf(matchData, templatePath = 'matchblatt_fillable.pdf', mappingPath = 'pdf-field-mapping.json') {
  try {
    // Load the field mapping JSON file
    const mappingResponse = await fetch(mappingPath)
    if (!mappingResponse.ok) {
      throw new Error(`Failed to load field mapping: ${mappingResponse.statusText}`)
    }
    const fieldMapping = await mappingResponse.json()

    // Generate the filled PDF
    const pdfBytes = await generateFilledPdf(templatePath, fieldMapping, matchData)

    return pdfBytes
  } catch (error) {
    console.error('Error generating fillable PDF:', error)
    throw error
  }
}

/**
 * Generate and download a filled PDF scoresheet
 * 
 * @param {Object} matchData - Match data (see generateFillablePdf for structure)
 * @param {string} filename - Optional filename for download
 */
export async function generateAndDownloadFillablePdf(matchData, filename = null) {
  try {
    const pdfBytes = await generateFillablePdf(matchData)
    
    // Generate filename if not provided
    if (!filename) {
      const homeTeamName = (matchData.homeTeam?.name || 'Home').replace(/[^a-zA-Z0-9]/g, '_')
      const awayTeamName = (matchData.awayTeam?.name || 'Away').replace(/[^a-zA-Z0-9]/g, '_')
      const date = matchData.match?.date || 
                   (matchData.match?.scheduledAt ? 
                     new Date(matchData.match.scheduledAt).toLocaleDateString('de-DE').replace(/\//g, '-') : 
                     new Date().toLocaleDateString('de-DE').replace(/\//g, '-'))
      filename = `Matchblatt_${homeTeamName}_vs_${awayTeamName}_${date}.pdf`
    }

    // Create blob and download
    const blob = new Blob([pdfBytes], { type: 'application/pdf' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)

    return pdfBytes
  } catch (error) {
    console.error('Error generating and downloading PDF:', error)
    throw error
  }
}

/**
 * Convert match data from your database format to the format expected by fillPdfForm
 * This is a helper to transform your existing match data structure
 * 
 * @param {Object} dbMatchData - Match data from your database (similar to generateScoresheetPDF format)
 * @returns {Object} - Transformed match data for fillPdfForm
 */
export function transformMatchDataForFillablePdf(dbMatchData) {
  const {
    match,
    homeTeam,
    awayTeam,
    homePlayers = [],
    awayPlayers = [],
    referees = [],
    scorers = []
  } = dbMatchData

  // Format date as dd.mm.yyyy
  function formatDate(dateString) {
    if (!dateString) return ''
    const date = new Date(dateString)
    const day = String(date.getDate()).padStart(2, '0')
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const year = date.getFullYear()
    return `${day}.${month}.${year}`
  }

  // Format time as HH:mm
  function formatTime(dateString) {
    if (!dateString) return ''
    const date = new Date(dateString)
    const hours = String(date.getHours()).padStart(2, '0')
    const minutes = String(date.getMinutes()).padStart(2, '0')
    return `${hours}:${minutes}`
  }

  // Transform players - ensure DOB is in dd.mm.yyyy format
  const transformPlayers = (players) => {
    return players.map(p => ({
      number: p.number,
      name: p.name || `${p.lastName || ''} ${p.firstName || ''}`.trim(),
      firstName: p.firstName,
      lastName: p.lastName,
      dob: p.dob ? (p.dob.includes('/') ? p.dob.replace(/\//g, '.') : p.dob) : ''
    }))
  }

  // Separate liberos from regular players
  const getLiberos = (players) => {
    return players
      .filter(p => p.libero && p.libero !== '')
      .map(p => ({
        number: p.number,
        name: p.name || `${p.lastName || ''} ${p.firstName || ''}`.trim(),
        firstName: p.firstName,
        lastName: p.lastName,
        dob: p.dob ? (p.dob.includes('/') ? p.dob.replace(/\//g, '.') : p.dob) : ''
      }))
  }

  // Transform bench officials
  const transformBench = (bench) => {
    if (!bench || !Array.isArray(bench)) return []
    return bench.map(b => ({
      role: b.role || 'coach',
      firstName: b.firstName,
      lastName: b.lastName,
      name: b.name || `${b.lastName || ''} ${b.firstName || ''}`.trim(),
      dob: b.dob ? (b.dob.includes('/') ? b.dob.replace(/\//g, '.') : b.dob) : ''
    }))
  }

  return {
    match: {
      scheduledAt: match?.scheduledAt,
      date: formatDate(match?.scheduledAt),
      time: formatTime(match?.scheduledAt),
      venue: match?.venue || match?.hall || '',
      city: match?.city || '',
      league: match?.league || '',
      gameNumber: match?.gameNumber || match?.externalId || '',
      matchType: match?.matchType || 'championship'
    },
    homeTeam: {
      name: homeTeam?.name || ''
    },
    awayTeam: {
      name: awayTeam?.name || ''
    },
    players: {
      home: transformPlayers(homePlayers),
      away: transformPlayers(awayPlayers)
    },
    liberos: {
      home: getLiberos(homePlayers),
      away: getLiberos(awayPlayers)
    },
    bench: {
      home: transformBench(match?.bench_home),
      away: transformBench(match?.bench_away)
    },
    officials: {
      referee1: referees.find(r => r.role === 'ref1') || referees[0] || {},
      referee2: referees.find(r => r.role === 'ref2') || referees[1] || {},
      scorer: scorers.find(s => s.role === 'scorer') || scorers[0] || {},
      assistantScorer: scorers.find(s => s.role === 'asst-scorer') || scorers[1] || {}
    }
  }
}

