/**
 * Parse roster PDF to extract player and official information
 * Supports Italian, French, English, and German formats
 */

export async function parseRosterPdf(file) {
  try {
    // Dynamic import of pdfjs-dist
    const pdfjsLib = await import('pdfjs-dist')

    // Set worker source - use unpkg which has reliable file structure for all versions
    // Try multiple CDN sources for better reliability
    const version = pdfjsLib.version
    const cdnUrls = [
      `https://unpkg.com/pdfjs-dist@${version}/build/pdf.worker.min.mjs`,
      `https://unpkg.com/pdfjs-dist@${version}/build/pdf.worker.min.js`,
      `https://cdn.jsdelivr.net/npm/pdfjs-dist@${version}/build/pdf.worker.min.mjs`,
      `https://cdn.jsdelivr.net/npm/pdfjs-dist@${version}/build/pdf.worker.min.js`,
    ]

    // Use the first URL (unpkg with .mjs extension for v5.x)
    pdfjsLib.GlobalWorkerOptions.workerSrc = cdnUrls[0]

    const arrayBuffer = await file.arrayBuffer()
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
    
    let fullText = ''
    
    // Extract text from all pages
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i)
      const textContent = await page.getTextContent()
      const pageText = textContent.items.map(item => item.str).join(' ')
      fullText += pageText + '\n'
    }

    // Removed console.log('[parseRosterPdf] Extracted text (first 2000 chars):', fullText.substring(0, 2000))
    // Removed console.log('[parseRosterPdf] Full text length:', fullText.length)

    // Parse the text to extract player and official data
    const result = parseRosterText(fullText)
    // Removed console.log('[parseRosterPdf] Parse result:', result)
    return result
  } catch (error) {
    console.error('Error parsing PDF:', error)
    throw new Error(`Failed to parse PDF: ${error.message}. Please ensure pdfjs-dist is installed.`)
  }
}

function parseRosterText(text) {
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
  
  // Common patterns for different languages
  const patterns = {
    // Player patterns - look for number, name, DOB
    // Format variations: "1. LastName FirstName DD/MM/YYYY" or "1 LastName FirstName DD/MM/YYYY"
    player: /(\d+)[.\s]+([A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+(?:\s+[A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+)*)\s+([A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+(?:\s+[A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+)*)\s+(\d{1,2}[./]\d{1,2}[./]\d{4})/gi,
    
    // Coach patterns - look for "Coach", "Entraîneur", "Allenatore", "Trainer"
    coach: /(?:Coach|Entraîneur|Allenatore|Trainer)[:\s]+([A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+(?:\s+[A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+)*)\s+([A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+(?:\s+[A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+)*)(?:\s+(\d{1,2}[./]\d{1,2}[./]\d{4}))?/gi,
    
    // Assistant Coach patterns
    ac1: /(?:Assistant\s+Coach\s+1|Entraîneur\s+adjoint\s+1|Allenatore\s+assistente\s+1|Assistenttrainer\s+1)[:\s]+([A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+(?:\s+[A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+)*)\s+([A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+(?:\s+[A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+)*)(?:\s+(\d{1,2}[./]\d{1,2}[./]\d{4}))?/gi,
    
    ac2: /(?:Assistant\s+Coach\s+2|Entraîneur\s+adjoint\s+2|Allenatore\s+assistente\s+2|Assistenttrainer\s+2)[:\s]+([A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+(?:\s+[A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+)*)\s+([A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+(?:\s+[A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+)*)(?:\s+(\d{1,2}[./]\d{1,2}[./]\d{4}))?/gi
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
    if (coachMatch) {
      result.coach = {
        firstName: coachMatch[1]?.trim() || '',
        lastName: coachMatch[2]?.trim() || '',
        dob: coachMatch[3] ? normalizeDate(coachMatch[3].trim()) : ''
      }
    }

    // Extract AC1
    const ac1Match = patterns.ac1.exec(normalizedText)
    if (ac1Match) {
      result.ac1 = {
        firstName: ac1Match[1]?.trim() || '',
        lastName: ac1Match[2]?.trim() || '',
        dob: ac1Match[3] ? normalizeDate(ac1Match[3].trim()) : ''
      }
    }

    // Extract AC2
    const ac2Match = patterns.ac2.exec(normalizedText)
    if (ac2Match) {
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
      // Example Italian: "312307   Oscar   Bizard   M   29.10.2005"
      // Example German: "99724 | Jessica | Dudula | F | 07.10 .2007"
      // Example French: "323547 | Theresa | Hauck | F | 19.08.1999"
      // Use normalized text for consistent spacing, but also try original text for dates with spaces
      // Note: H = Homme (French for Male), M = Male, F = Female
    const svPlayerPattern = /(\d{5,6})\s+([A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+(?:\s+[A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+)*)\s+([A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+(?:\s+[A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+)*)\s+[MFH]\s+(\d{1,2}[./]\s*\d{1,2}[./]\s*\d{4})/gi
    
    // Reset regex lastIndex to avoid issues
    svPlayerPattern.lastIndex = 0
    while ((match = svPlayerPattern.exec(normalizedText)) !== null) {
      const svNumber = match[1] // SV number (Swiss Volleyball registration number)
      const firstName = match[2].trim()
      const lastName = match[3].trim()
      // Normalize date - remove spaces and normalize separators
      const dob = normalizeDate(match[4].replace(/\s+/g, '').trim())

      // Don't assign automatic numbers - user should see which players need numbers
      svFormatPlayers.push({
        number: null,
        firstName,
        lastName,
        dob
      })
    }
    
    // If still no SV format players, try with original text (not normalized) to catch dates with spaces
    if (svFormatPlayers.length === 0) {
      const svPlayerPatternOriginal = /(\d{5,6})\s+([A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+(?:\s+[A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+)*)\s+([A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+(?:\s+[A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+)*)\s+[MFH]\s+(\d{1,2}\s*[./]\s*\d{1,2}\s*[./]\s*\d{4})/gi
      
      let matchOriginal
      while ((matchOriginal = svPlayerPatternOriginal.exec(text)) !== null) {
        const svNumber = matchOriginal[1]
        const firstName = matchOriginal[2].trim()
        const lastName = matchOriginal[3].trim()
        // Normalize date - remove spaces and normalize separators
        const dob = normalizeDate(matchOriginal[4].replace(/\s+/g, '').trim())

        // Don't assign automatic numbers - user should see which players need numbers
        svFormatPlayers.push({
          number: null,
          firstName,
          lastName,
          dob
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
      // Try pattern: number, firstname, lastname, M/F, date
      const simplePattern = /(\d+)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+[MF]\s+(\d{1,2}[./]\d{1,2}[./]\d{4})/gi
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
    
    // Parse Italian/German/French coach format: 
    // Italian: "Allenatore: #52205 | Michelle Howald (1997)"
    // German: "Coach: #80641 | Malcolm Mobétie (2004)"
    // French: "Coach: #313261 | Simon Richle (1994)"
    if (!result.coach) {
      const coachPattern = /(?:Coach|Allenatore|Trainer|Entraîneur):\s*#\d+\s*\|\s*([A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+(?:\s+[A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+)*)\s+([A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+(?:\s+[A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+)*)\s*\((\d{4})\)/i
      const coachMatch = normalizedText.match(coachPattern)
      if (coachMatch) {
        result.coach = {
          firstName: coachMatch[1]?.trim() || '',
          lastName: coachMatch[2]?.trim() || '',
          dob: coachMatch[3] ? `01/01/${coachMatch[3]}` : '' // Year only, set to Jan 1
        }
        // Removed console.log('[parseRosterText] Found coach:', result.coach)
      }
    }
    
    // Parse Italian/German/French assistant coach format: 
    // Italian: "1. Assistente allenatore: #90382 | Luca Canepa (1993)"
    // German: "1. Assistant Coach: #72458 | Sabina Camenzind (2004)"
    // French: "1er coach assistant: #..."
    if (!result.ac1) {
      const ac1Pattern = /(?:1\.|1er)\s*(?:Assistente\s+allenatore|Assistant\s+Coach|Assistenttrainer|coach\s+assistant):\s*#\d+\s*\|\s*([A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+(?:\s+[A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+)*)\s+([A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+(?:\s+[A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+)*)\s*\((\d{4})\)/i
      const ac1Match = normalizedText.match(ac1Pattern)
      if (ac1Match) {
        result.ac1 = {
          firstName: ac1Match[1]?.trim() || '',
          lastName: ac1Match[2]?.trim() || '',
          dob: ac1Match[3] ? `01/01/${ac1Match[3]}` : ''
        }
        // Removed console.log('[parseRosterText] Found AC1:', result.ac1)
      }
    }
    
    // Parse Italian/German/French assistant coach 2
    // Italian: "2. Assistente allenatore: #..."
    // German: "2. Assistant Coach: #..."
    // French: "2e coach assistant: #..."
    if (!result.ac2) {
      const ac2Pattern = /(?:2\.|2e)\s*(?:Assistente\s+allenatore|Assistant\s+Coach|Assistenttrainer|coach\s+assistant):\s*#\d+\s*\|\s*([A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+(?:\s+[A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+)*)\s+([A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+(?:\s+[A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+)*)\s*\((\d{4})\)/i
      const ac2Match = normalizedText.match(ac2Pattern)
      if (ac2Match) {
        result.ac2 = {
          firstName: ac2Match[1]?.trim() || '',
          lastName: ac2Match[2]?.trim() || '',
          dob: ac2Match[3] ? `01/01/${ac2Match[3]}` : ''
        }
        // Removed console.log('[parseRosterText] Found AC2:', result.ac2)
      }
    }

  return result
}

function normalizeDate(dateStr) {
  if (!dateStr) return ''
  // Normalize date format to DD/MM/YYYY
  return dateStr.replace(/\./g, '/')
}
