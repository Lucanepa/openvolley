/**
 * Parse roster PDF to extract player and official information
 * Supports Italian, French, English, and German formats
 */

export async function parseRosterPdf(file) {
  try {
    // Dynamic import of pdfjs-dist
    const pdfjsLib = await import('pdfjs-dist')
    
    // Set worker source
    pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`

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

    console.log('[parseRosterPdf] Extracted text (first 2000 chars):', fullText.substring(0, 2000))
    console.log('[parseRosterPdf] Full text length:', fullText.length)

    // Parse the text to extract player and official data
    const result = parseRosterText(fullText)
    console.log('[parseRosterPdf] Parse result:', result)
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

  console.log('[parseRosterText] Raw text (first 1000 chars):', text.substring(0, 1000))

  // Normalize text - remove extra whitespace
  const normalizedText = text.replace(/\s+/g, ' ').trim()
  
  console.log('[parseRosterText] Normalized text (first 1000 chars):', normalizedText.substring(0, 1000))
  
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

    // If no players found with regex, try Italian format and other patterns
    if (result.players.length === 0) {
      console.log('[parseRosterText] No players found with regex, trying Italian format and other patterns')
      
      // Try Italian format: SV number (6 digits), First Name, Last Name, M/F, Date
      // Pattern: 6-digit number, name, name, M/F, date (DD.MM.YYYY or DD/MM/YYYY)
      // Example: "312307   Oscar   Bizard   M   29.10.2005"
      // Use normalized text for consistent spacing
      const italianPlayerPattern = /(\d{6})\s+([A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+(?:\s+[A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+)*)\s+([A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+(?:\s+[A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+)*)\s+[MF]\s+(\d{1,2}[./]\d{1,2}[./]\d{4})/gi
      
      let match
      while ((match = italianPlayerPattern.exec(normalizedText)) !== null) {
        const svNumber = match[1] // SV number (Swiss Volleyball registration number)
        const firstName = match[2].trim()
        const lastName = match[3].trim()
        const dob = normalizeDate(match[4].trim())
        
        // Since player numbers aren't in the PDF, assign sequential numbers starting from 1
        // Users can adjust these manually if needed
        const playerNumber = result.players.length + 1
        
        console.log('[parseRosterText] Found Italian format player:', { svNumber, firstName, lastName, dob, playerNumber })
        
        result.players.push({
          number: playerNumber,
          firstName,
          lastName,
          dob
        })
      }
      
      // If still no players, try simpler patterns in the full text
      if (result.players.length === 0) {
        // Try pattern: number, firstname, lastname, M/F, date
        const simplePattern = /(\d+)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+[MF]\s+(\d{1,2}[./]\d{1,2}[./]\d{4})/gi
        while ((match = simplePattern.exec(text)) !== null) {
          const number = parseInt(match[1])
          const firstName = match[2].trim()
          const lastName = match[3].trim()
          const dob = normalizeDate(match[4].trim())
          
          console.log('[parseRosterText] Found simple format player:', { number, firstName, lastName, dob })
          
          result.players.push({
            number,
            firstName,
            lastName,
            dob
          })
        }
      }
      
      console.log('[parseRosterText] Total players found:', result.players.length)
    }
    
    // Parse Italian coach format: "Allenatore: #52205 | Michelle Howald (1997)"
    if (!result.coach) {
      const italianCoachPattern = /Allenatore:\s*#\d+\s*\|\s*([A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+(?:\s+[A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+)*)\s+([A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+(?:\s+[A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+)*)\s*\((\d{4})\)/i
      const coachMatch = normalizedText.match(italianCoachPattern)
      if (coachMatch) {
        result.coach = {
          firstName: coachMatch[1]?.trim() || '',
          lastName: coachMatch[2]?.trim() || '',
          dob: coachMatch[3] ? `01/01/${coachMatch[3]}` : '' // Year only, set to Jan 1
        }
        console.log('[parseRosterText] Found Italian coach:', result.coach)
      }
    }
    
    // Parse Italian assistant coach format: "1. Assistente allenatore: #90382 | Luca Canepa (1993)"
    if (!result.ac1) {
      const italianAc1Pattern = /1\.\s*Assistente\s+allenatore:\s*#\d+\s*\|\s*([A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+(?:\s+[A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+)*)\s+([A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+(?:\s+[A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+)*)\s*\((\d{4})\)/i
      const ac1Match = normalizedText.match(italianAc1Pattern)
      if (ac1Match) {
        result.ac1 = {
          firstName: ac1Match[1]?.trim() || '',
          lastName: ac1Match[2]?.trim() || '',
          dob: ac1Match[3] ? `01/01/${ac1Match[3]}` : ''
        }
        console.log('[parseRosterText] Found Italian AC1:', result.ac1)
      }
    }
    
    // Parse Italian assistant coach 2
    if (!result.ac2) {
      const italianAc2Pattern = /2\.\s*Assistente\s+allenatore:\s*#\d+\s*\|\s*([A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+(?:\s+[A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+)*)\s+([A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+(?:\s+[A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+)*)\s*\((\d{4})\)/i
      const ac2Match = normalizedText.match(italianAc2Pattern)
      if (ac2Match) {
        result.ac2 = {
          firstName: ac2Match[1]?.trim() || '',
          lastName: ac2Match[2]?.trim() || '',
          dob: ac2Match[3] ? `01/01/${ac2Match[3]}` : ''
        }
        console.log('[parseRosterText] Found Italian AC2:', result.ac2)
      }
    }

  return result
}

function normalizeDate(dateStr) {
  if (!dateStr) return ''
  // Normalize date format to DD/MM/YYYY
  return dateStr.replace(/\./g, '/')
}
