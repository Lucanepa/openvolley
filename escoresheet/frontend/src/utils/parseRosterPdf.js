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

    // Parse the text to extract player and official data
    return parseRosterText(fullText)
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

  // Normalize text - remove extra whitespace
  const normalizedText = text.replace(/\s+/g, ' ').trim()
  
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

    // If no players found with regex, try a simpler line-by-line approach
    if (result.players.length === 0) {
      const lines = text.split('\n').filter(line => line.trim().length > 0)
      
      for (const line of lines) {
        // Look for lines that start with a number followed by a name
        const simpleMatch = line.match(/^(\d+)[.\s]+(.+?)\s+(\d{1,2}[./]\d{1,2}[./]\d{4})/)
        if (simpleMatch) {
          const number = parseInt(simpleMatch[1])
          const nameParts = simpleMatch[2].trim().split(/\s+/)
          const lastName = nameParts[nameParts.length - 1] || ''
          const firstName = nameParts.slice(0, -1).join(' ') || ''
          const dob = normalizeDate(simpleMatch[3].trim())
          
          result.players.push({
            number,
            firstName,
            lastName,
            dob
          })
        }
      }
    }

  return result
}

function normalizeDate(dateStr) {
  if (!dateStr) return ''
  // Normalize date format to DD/MM/YYYY
  return dateStr.replace(/\./g, '/')
}

