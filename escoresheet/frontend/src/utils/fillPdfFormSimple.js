/**
 * Fill PDF form with match data - matches Python implementation
 * Based on the working Python script using pypdf
 */

import { degrees, rgb } from 'pdf-lib'

export async function fillPdfForm(pdfDoc, matchData) {
  const form = pdfDoc.getForm()
  const fields = form.getFields()
  
  // Helper to format date as DD.MM.YYYY
  function formatDate(dateString) {
    if (!dateString) return ''
    try {
      const date = new Date(dateString)
      const day = String(date.getDate()).padStart(2, '0')
      const month = String(date.getMonth() + 1).padStart(2, '0')
      const year = date.getFullYear()
      return `${day}.${month}.${year}`
    } catch {
      return dateString
    }
  }

  // Helper to format time as HH:MM
  function formatTime(dateString) {
    if (!dateString) return ''
    try {
      const date = new Date(dateString)
      const hours = String(date.getHours()).padStart(2, '0')
      const minutes = String(date.getMinutes()).padStart(2, '0')
      return `${hours}:${minutes}`
    } catch {
      return ''
    }
  }

  // Helper to format DOB from DD/MM/YYYY to DD.MM.YYYY
  function formatDob(dobString) {
    if (!dobString) return ''
    if (dobString.includes('/')) {
      return dobString.replace(/\//g, '.')
    }
    return dobString
  }

  // Helper to format name as "Last, F."
  function formatName(firstName, lastName) {
    if (!lastName && !firstName) return ''
    if (!lastName) return firstName
    if (!firstName) return lastName
    const firstInitial = firstName.charAt(0).toUpperCase()
    return `${lastName}, ${firstInitial}.`
  }

  // Get field by name
  function getField(fieldName) {
    try {
      return form.getTextField(fieldName)
    } catch {
      return null
    }
  }

  // Set field value safely
  function setField(fieldName, value, fontSize = null, options = {}) {
    const field = getField(fieldName)
    if (field && value !== undefined && value !== null) {
      field.setText(String(value))
      // Set font size if specified
      if (fontSize !== null) {
        try {
          field.setFontSize(fontSize)
        } catch (e) {
          // Font size setting might fail on some fields
        }
      }
      // Center text if requested
      if (options.center) {
        try {
          // Update alignment to center
          field.setAlignment(1) // 0=left, 1=center, 2=right
        } catch (e) {
          // Alignment setting might fail on some fields
        }
      }
      return true
    }
    return false
  }

  let fieldsSet = 0

  // Match type checkboxes (fields ending with _x need "X" written)
  const matchTypeMapping = {
    'championship': 'championship_x',
    'cup': 'cup_x',
    'friendly': 'friendly_x',
    'tournament': 'tournament_x',
    'other': 'other_championship_x'
  }

  const matchType1 = matchData.match_type_1 || ''
  if (matchType1 && matchTypeMapping[matchType1]) {
    if (setField(matchTypeMapping[matchType1], 'X')) fieldsSet++
  }
  // If "other" is selected, fill the text field
  if (matchType1 === 'other') {
    const otherText = matchData.match_type_1_other || ''
    if (setField('other_championship_text', otherText)) fieldsSet++
  }

  // Championship type checkboxes (regional, national, international)
  const championshipTypeMapping = {
    'regional': 'regional_x',
    'national': 'national_x',
    'international': 'international_x'
  }

  const champType = matchData.championshipType || ''
  if (champType && championshipTypeMapping[champType]) {
    if (setField(championshipTypeMapping[champType], 'X')) fieldsSet++
  }
  // If "other" is selected for championship type
  if (champType === 'other') {
    const otherText = matchData.championshipTypeOther || ''
    if (otherText) {
      // Use other_championship_text field
      if (setField('other_championship_text', otherText)) fieldsSet++
    }
  }

  // Category checkboxes (gender/age)
  const categoryMapping = {
    'men': 'men_x',
    'women': 'female_x',
    'female': 'female_x',
    'U19': 'U19_x',
    'U17': 'U17_x',
    'U23': 'U23_x'
  }

  const matchType2 = matchData.match_type_2 || ''
  if (matchType2 && categoryMapping[matchType2]) {
    if (setField(categoryMapping[matchType2], 'X')) fieldsSet++
  }

  // Level (if "other" is selected for type3)
  const matchType3 = matchData.match_type_3 || ''
  if (matchType3 === 'other') {
    const otherText = matchData.match_type_3_other || ''
    if (setField('other_category_text', otherText)) fieldsSet++
  } else if (matchType3 && categoryMapping[matchType3]) {
    if (setField(categoryMapping[matchType3], 'X')) fieldsSet++
  }

  // Basic match information
  if (setField('liga_text', matchData.league || '')) fieldsSet++
  if (setField('match_n', String(matchData.gameNumber || matchData.externalId || ''))) fieldsSet++
  if (setField('home_team', matchData.homeTeam || '')) fieldsSet++
  if (setField('away_team', matchData.awayTeam || '')) fieldsSet++
  if (setField('city', matchData.city || '')) fieldsSet++
  if (setField('hall', matchData.hall || matchData.venue || '')) fieldsSet++
  if (setField('date', formatDate(matchData.scheduledAt))) fieldsSet++
  if (setField('time', formatTime(matchData.scheduledAt))) fieldsSet++

  // Short team names
  const homeTeamShort = matchData.homeShortName || matchData.match?.homeShortName || (matchData.homeTeam || '').substring(0, 3).toUpperCase()
  const awayTeamShort = matchData.awayShortName || matchData.match?.awayShortName || (matchData.awayTeam || '').substring(0, 3).toUpperCase()
  if (setField('home_team_short', homeTeamShort)) fieldsSet++
  if (setField('away_team_short', awayTeamShort)) fieldsSet++

  // Home team bench
  const benchHome = matchData.bench_home || []
  const filledHomeBenchRoles = new Set()
  
  benchHome.forEach(person => {
    const role = person.role || ''
    const firstName = person.firstName || ''
    const lastName = person.lastName || ''
    const dob = formatDob(person.dob || '')
    const fullName = formatName(firstName, lastName)

    if (role === 'Coach') {
      if (setField('home_roster_coach_name', fullName)) fieldsSet++
      if (setField('home_roster_coach_dob', dob, 6)) fieldsSet++
      filledHomeBenchRoles.add('coach')
    } else if (role === 'Assistant Coach 1') {
      if (setField('home_roster_ac1_name', fullName)) fieldsSet++
      if (setField('home_roster_ac1_dob', dob, 6)) fieldsSet++
      filledHomeBenchRoles.add('ac1')
    } else if (role === 'Assistant Coach 2') {
      if (setField('home_roster_ac2_name', fullName)) fieldsSet++
      if (setField('home_roster_ac2_dob', dob, 6)) fieldsSet++
      filledHomeBenchRoles.add('ac2')
    } else if (role === 'Physiotherapist') {
      if (setField('home_roster_p_name', fullName)) fieldsSet++
      if (setField('home_roster_p_dob', dob, 6)) fieldsSet++
      filledHomeBenchRoles.add('p')
    } else if (role === 'Medical') {
      if (setField('home_roster_m_name', fullName)) fieldsSet++
      if (setField('home_roster_m_dob', dob, 6)) fieldsSet++
      filledHomeBenchRoles.add('m')
    }
  })
  
  // Strike empty bench official rows
  if (!filledHomeBenchRoles.has('coach')) {
    setField('home_roster_coach_name', '- -')
    setField('home_roster_coach_dob', '- -')
  }
  if (!filledHomeBenchRoles.has('ac1')) {
    setField('home_roster_ac1_name', '- -')
    setField('home_roster_ac1_dob', '- -')
  }
  if (!filledHomeBenchRoles.has('ac2')) {
    setField('home_roster_ac2_name', '- -')
    setField('home_roster_ac2_dob', '- -')
  }
  if (!filledHomeBenchRoles.has('p')) {
    setField('home_roster_p_name', '- -')
    setField('home_roster_p_dob', '- -')
  }
  if (!filledHomeBenchRoles.has('m')) {
    setField('home_roster_m_name', '- -')
    setField('home_roster_m_dob', '- -')
  }

  // Away team bench
  const benchAway = matchData.bench_away || []
  const filledAwayBenchRoles = new Set()
  
  benchAway.forEach(person => {
    const role = person.role || ''
    const firstName = person.firstName || ''
    const lastName = person.lastName || ''
    const dob = formatDob(person.dob || '')
    const fullName = formatName(firstName, lastName)

    if (role === 'Coach') {
      if (setField('away_roster_coach_name', fullName)) fieldsSet++
      if (setField('away_roster_coach_dob', dob, 6)) fieldsSet++
      filledAwayBenchRoles.add('coach')
    } else if (role === 'Assistant Coach 1') {
      if (setField('away_roster_ac1_name', fullName)) fieldsSet++
      if (setField('away_roster_ac1_dob', dob, 6)) fieldsSet++
      filledAwayBenchRoles.add('ac1')
    } else if (role === 'Assistant Coach 2') {
      if (setField('away_roster_ac2_name', fullName)) fieldsSet++
      if (setField('away_roster_ac2_dob', dob, 6)) fieldsSet++
      filledAwayBenchRoles.add('ac2')
    } else if (role === 'Physiotherapist') {
      if (setField('away_roster_p_name', fullName)) fieldsSet++
      if (setField('away_roster_p_dob', dob, 6)) fieldsSet++
      filledAwayBenchRoles.add('p')
    } else if (role === 'Medical') {
      if (setField('away_roster_m_name', fullName)) fieldsSet++
      if (setField('away_roster_m_dob', dob, 6)) fieldsSet++
      filledAwayBenchRoles.add('m')
    }
  })
  
  // Strike empty bench official rows
  if (!filledAwayBenchRoles.has('coach')) {
    setField('away_roster_coach_name', '- -')
    setField('away_roster_coach_dob', '- -')
  }
  if (!filledAwayBenchRoles.has('ac1')) {
    setField('away_roster_ac1_name', '- -')
    setField('away_roster_ac1_dob', '- -')
  }
  if (!filledAwayBenchRoles.has('ac2')) {
    setField('away_roster_ac2_name', '- -')
    setField('away_roster_ac2_dob', '- -')
  }
  if (!filledAwayBenchRoles.has('p')) {
    setField('away_roster_p_name', '- -')
    setField('away_roster_p_dob', '- -')
  }
  if (!filledAwayBenchRoles.has('m')) {
    setField('away_roster_m_name', '- -')
    setField('away_roster_m_dob', '- -')
  }

  // Officials
  const officials = matchData.officials || []
  officials.forEach(official => {
    const role = official.role || ''
    const firstName = official.firstName || ''
    const lastName = official.lastName || ''
    const country = official.country || ''
    const dob = formatDob(official.dob || '')
    const fullName = formatName(firstName, lastName)

    if (role === '1st referee') {
      if (setField('1_referee_name', fullName)) fieldsSet++
      if (setField('1_referee_country', country)) fieldsSet++
      if (setField('1_referee_dob', dob, 6)) fieldsSet++
    } else if (role === '2nd referee') {
      if (setField('2_referee_name', fullName)) fieldsSet++
      if (setField('2_referee_country', country)) fieldsSet++
      if (setField('2_referee_dob', dob, 6)) fieldsSet++
    } else if (role === 'scorer') {
      if (setField('scorer_name', fullName)) fieldsSet++
      if (setField('scorer_country', country)) fieldsSet++
      if (setField('scorer_dob', dob, 6)) fieldsSet++
    } else if (role === 'assistant scorer') {
      if (setField('ass_scorer_name', fullName)) fieldsSet++
      if (setField('ass_scorer_country', country)) fieldsSet++
      if (setField('ass_scorer_dob', dob, 6)) fieldsSet++
    }
  })

  // Fill player rosters
  console.log('Filling player rosters...')
  
  // Helper to fill individual player fields
  function fillPlayerRoster(players, prefix, maxPlayers) {
    if (!players || players.length === 0) return 0
    
    let filled = 0
    const playersToFill = Math.min(players.length, maxPlayers)
    const captain = players.find(p => p.isCaptain)
    
    for (let i = 0; i < playersToFill; i++) {
      const player = players[i]
      const num = i + 1 // Fields are 1-indexed
      
      const dob = formatDob(player.dob || '')
      const number = String(player.number || '')
      const name = formatName(player.firstName, player.lastName) || `${player.lastName || ''} ${player.firstName || ''}`.trim()
      
      if (setField(`${prefix}${num}_dob`, dob, 6)) filled++
      if (setField(`${prefix}${num}_name`, name)) filled++
      if (setField(`${prefix}${num}_number`, number)) {
        filled++
        
        // Circle the captain's number
        if (captain && player.number === captain.number) {
          circlePlayerNumber(`${prefix}${num}_number`, number)
        }
      }
    }
    
    return filled
  }
  
  // Helper to circle captain number
  function circlePlayerNumber(fieldName, numberText) {
    try {
      const field = getField(fieldName)
      if (!field) return
      
      const widgets = field.acroField.getWidgets()
      if (widgets.length === 0) return
      
      const widget = widgets[0]
      const rect = widget.getRectangle()
      const page = pdfDoc.getPages()[0]
      
      // Draw a circle around the number
      const centerX = rect.x + rect.width / 2
      const centerY = rect.y + rect.height / 2
      const radius = Math.min(rect.width, rect.height) / 2.2
      
      page.drawCircle({
        x: centerX,
        y: centerY,
        size: radius,
        borderWidth: 1.5,
        borderColor: { type: 'RGB', red: 0, green: 0, blue: 0 },
        opacity: 1.0
      })
      
      console.log(`✓ Circled captain number: ${numberText}`)
    } catch (error) {
      console.error(`Error circling number ${fieldName}:`, error)
    }
  }
  
  // Fill libero rosters
  function fillLiberoRoster(players, prefix) {
    if (!players || players.length === 0) return 0
    
    let filled = 0
    const liberos = players.filter(p => p.libero)
    
    // Fill up to 2 liberos
    for (let i = 0; i < Math.min(liberos.length, 2); i++) {
      const libero = liberos[i]
      const liberoNum = i + 1 // libero1, libero2
      
      const dob = formatDob(libero.dob || '')
      const number = String(libero.number || '')
      const name = formatName(libero.firstName, libero.lastName) || `${libero.lastName || ''} ${libero.firstName || ''}`.trim()
      
      if (setField(`${prefix}${liberoNum}_dob`, dob, 6)) filled++
      if (setField(`${prefix}${liberoNum}_name`, name)) filled++
      if (setField(`${prefix}${liberoNum}_number`, number)) filled++
    }
    
    return filled
  }
  
  // Get players from matchData
  const homePlayers = matchData.homePlayers || matchData.players?.home || []
  const awayPlayers = matchData.awayPlayers || matchData.players?.away || []
  
  // Helper to find captain
  const findCaptain = (players) => players.find(p => p.isCaptain)
  
  const homeCaptain = findCaptain(homePlayers)
  const awayCaptain = findCaptain(awayPlayers)
  
  // Fill home team players (14 max) - INCLUDE liberos in player roster
  const homePlayersFilled = fillPlayerRoster(
    homePlayers, // Include all players, even liberos
    'home_roster_players', 
    14
  )
  
  // Strike empty rows with centered dashes
  for (let i = homePlayers.length + 1; i <= 14; i++) {
    setField(`home_roster_players${i}_dob`, '- -')
    setField(`home_roster_players${i}_number`, '- -')
    setField(`home_roster_players${i}_name`, '- -')
  }
  console.log(`✓ Filled ${homePlayersFilled} home player fields, struck ${14 - homePlayers.length} empty rows`)
  
  // Fill home team liberos (2 max)
  const homeLiberosFilled = fillLiberoRoster(homePlayers, 'home_roster_libero')
  console.log(`✓ Filled ${homeLiberosFilled} home libero fields`)
  
  // Fill away team players (14 max) - INCLUDE liberos in player roster
  const awayPlayersFilled = fillPlayerRoster(
    awayPlayers, // Include all players, even liberos
    'away_roster_players',
    14
  )
  
  // Strike empty rows with centered dashes
  for (let i = awayPlayers.length + 1; i <= 14; i++) {
    setField(`away_roster_players${i}_dob`, '- -')
    setField(`away_roster_players${i}_number`, '- -')
    setField(`away_roster_players${i}_name`, '- -')
  }
  console.log(`✓ Filled ${awayPlayersFilled} away player fields, struck ${14 - awayPlayers.length} empty rows`)
  
  // Fill away team liberos (2 max)
  const awayLiberosFilled = fillLiberoRoster(awayPlayers, 'away_roster_libero')
  console.log(`✓ Filled ${awayLiberosFilled} away libero fields`)
  
  // Fill Team A/B short names and lineups
  console.log('Filling Team A/B data...')
  
  // Determine which team is A and which is B based on coin toss
  const coinTossTeamA = matchData.coinTossTeamA || matchData.match?.coinTossTeamA || 'home'
  const coinTossTeamB = coinTossTeamA === 'home' ? 'away' : 'home'
  
  const teamAName = coinTossTeamA === 'home' ? matchData.homeTeam : matchData.awayTeam
  const teamBName = coinTossTeamB === 'home' ? matchData.homeTeam : matchData.awayTeam
  const teamAShort = coinTossTeamA === 'home' ? matchData.homeShortName : matchData.awayShortName
  const teamBShort = coinTossTeamB === 'home' ? matchData.homeShortName : matchData.awayShortName
  
  console.log(`Team A: ${coinTossTeamA}, Short: ${teamAShort}`)
  console.log(`Team B: ${coinTossTeamB}, Short: ${teamBShort}`)
  
  const teamAShortFinal = teamAShort || teamAName?.substring(0, 3).toUpperCase() || ''
  const teamBShortFinal = teamBShort || teamBName?.substring(0, 3).toUpperCase() || ''
  
  if (setField('teamA_short', teamAShortFinal)) {
    fieldsSet++
    console.log(`✓ Set teamA_short: ${teamAShortFinal}`)
  } else {
    console.warn('Failed to set teamA_short')
  }
  
  if (setField('teamB_short', teamBShortFinal)) {
    fieldsSet++
    console.log(`✓ Set teamB_short: ${teamBShortFinal}`)
  } else {
    console.warn('Failed to set teamB_short')
  }
  
  // Fill home_AB and away_AB fields (indicates if team is A or B)
  const homeIsA = coinTossTeamA === 'home'
  const awayIsA = coinTossTeamA === 'away'
  
  if (setField('home_AB', homeIsA ? 'A' : 'B', null, { center: true })) {
    fieldsSet++
    console.log(`✓ Set home_AB: ${homeIsA ? 'A' : 'B'} (centered)`)
  } else {
    console.warn('Failed to set home_AB field')
  }
  
  // Set away team A/B fields (you have away_AB_1 and away_AB_2 in your PDF)
  // Fill both with the same value
  if (setField('away_AB_1', awayIsA ? 'A' : 'B', null, { center: true })) {
    fieldsSet++
    console.log(`✓ Set away_AB_1: ${awayIsA ? 'A' : 'B'} (centered)`)
  }
  if (setField('away_AB_2', awayIsA ? 'A' : 'B', null, { center: true })) {
    fieldsSet++
    console.log(`✓ Set away_AB_2: ${awayIsA ? 'A' : 'B'} (centered)`)
  }
  
  // Fill service/reception for set 1 (first serve determines this)
  const firstServe = matchData.firstServe || matchData.match?.firstServe
  const coinTossServeA = matchData.coinTossServeA !== undefined ? matchData.coinTossServeA : matchData.match?.coinTossServeA
  
  // Determine who serves in set 1
  let set1TeamAServes = false
  if (firstServe) {
    set1TeamAServes = (firstServe === coinTossTeamA)
  } else if (coinTossServeA !== undefined) {
    set1TeamAServes = coinTossServeA
  }
  
  if (set1TeamAServes) {
    setField('set1_A_S', 'X') // Team A serves
    setField('set1_B_R', 'X') // Team B receives
  } else {
    setField('set1_A_R', 'X') // Team A receives  
    setField('set1_B_S', 'X') // Team B serves
  }
  
  // Fill lineups for each set
  const sets = matchData.sets || []
  const events = matchData.events || []
  
  for (let setNum = 1; setNum <= 5; setNum++) {
    // Get lineup events for this set
    const setLineupEvents = events.filter(e => 
      e.type === 'lineup' && 
      e.setIndex === setNum &&
      e.payload?.isInitial === true
    )
    
    if (setLineupEvents.length === 0) continue
    
    // Get lineups for each team
    const teamALineup = setLineupEvents.find(e => e.payload?.team === coinTossTeamA)?.payload?.lineup
    const teamBLineup = setLineupEvents.find(e => e.payload?.team === coinTossTeamB)?.payload?.lineup
    
    // Fill Team A lineup
    if (teamALineup) {
      ['I', 'II', 'III', 'IV', 'V', 'VI'].forEach(pos => {
        const playerNumber = teamALineup[pos]
        if (playerNumber !== undefined && playerNumber !== null && playerNumber !== '') {
          setField(`A_${pos}_set${setNum}`, String(playerNumber))
        }
      })
    }
    
    // Fill Team B lineup
    if (teamBLineup) {
      ['I', 'II', 'III', 'IV', 'V', 'VI'].forEach(pos => {
        const playerNumber = teamBLineup[pos]
        if (playerNumber !== undefined && playerNumber !== null && playerNumber !== '') {
          setField(`B_${pos}_set${setNum}`, String(playerNumber))
        }
      })
    }
  }
  
  console.log(`✓ Filled Team A/B and lineup data`)
  
  // Add signatures as images
  console.log('Adding signatures...')
  console.log('Full matchData keys:', Object.keys(matchData))
  console.log('Signature data check:', {
    homeCoach: !!matchData.homeCoachSignature,
    homeCaptain: !!matchData.homeCaptainSignature,
    awayCoach: !!matchData.awayCoachSignature,
    awayCaptain: !!matchData.awayCaptainSignature
  })
  console.log('First 50 chars of homeCoachSignature:', matchData.homeCoachSignature?.substring(0, 50))
  
  // Helper to embed signature image
  async function embedSignature(signatureDataUrl, fieldName) {
    console.log(`Attempting to embed signature for ${fieldName}...`)
    if (!signatureDataUrl) {
      console.log(`No signature data for ${fieldName}`)
      return false
    }
    
    try {
      // Extract base64 data from data URL
      const base64Data = signatureDataUrl.split(',')[1]
      if (!base64Data) return false
      
      // Determine image type
      const isPng = signatureDataUrl.startsWith('data:image/png')
      
      // Embed image
      const imageBytes = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0))
      const image = isPng 
        ? await pdfDoc.embedPng(imageBytes)
        : await pdfDoc.embedJpg(imageBytes)
      
      // Try to find the field (could be text field or button field)
      let field = null
      try {
        field = form.getTextField(fieldName)
      } catch {
        try {
          field = form.getButton(fieldName)
        } catch {
          console.warn(`Signature field ${fieldName} not found`)
          return false
        }
      }
      
      if (!field) return false
      
      // Get field position and dimensions
      const widgets = field.acroField.getWidgets()
      if (widgets.length === 0) return false
      
      const widget = widgets[0]
      const rect = widget.getRectangle()
      const page = pdfDoc.getPages()[0] // Assuming single page
      
      // Since PDF is rotated, we need to rotate signatures 90° and stretch to fill HEIGHT
      const aspectRatio = image.width / image.height
      
      // For 90° rotation: we want the signature to fill the field HEIGHT
      // So the signature WIDTH (before rotation) should be based on field height
      let drawWidth = rect.height * 0.4 // This will become the vertical dimension after rotation
      let drawHeight = drawWidth / aspectRatio // This will become the horizontal dimension
      
      // Ensure it doesn't exceed field width after rotation
      if (drawHeight > rect.width * 0.9) {
        drawHeight = rect.width * 0.9
        drawWidth = drawHeight * aspectRatio
      }
      
      console.log(`Image: ${image.width}x${image.height}, Field: ${rect.width.toFixed(1)}x${rect.height.toFixed(1)}`)
      console.log(`Drawing: ${drawWidth.toFixed(1)}x${drawHeight.toFixed(1)} → after 90° rotation: ${drawHeight.toFixed(1)}w x ${drawWidth.toFixed(1)}h`)
      
      // Center in field
      const centerX = rect.x + rect.width / 2
      const centerY = rect.y + rect.height / 2
      
      // Draw signature rotated 90° to match PDF orientation
      page.drawImage(image, {
        x: centerX - drawHeight / 2, // After rotation, height becomes horizontal
        y: centerY - drawWidth / 2,  // After rotation, width becomes vertical
        width: drawWidth,
        height: drawHeight,
        rotate: degrees(90),
        opacity: 1.0
      })
      
      console.log(`✓ Embedded signature: ${fieldName} (${drawWidth.toFixed(1)}x${drawHeight.toFixed(1)}, rotated 90°)`)
      return true
    } catch (error) {
      console.error(`❌ Error embedding signature ${fieldName}:`, error.message)
      return false
    }
  }
  
  // Embed signatures if available
  let signaturesEmbedded = 0
  if (matchData.homeCoachSignature) {
    if (await embedSignature(matchData.homeCoachSignature, 'home_coach_sign')) signaturesEmbedded++
  }
  if (matchData.homeCaptainSignature) {
    if (await embedSignature(matchData.homeCaptainSignature, 'home_captain_sign')) signaturesEmbedded++
  }
  if (matchData.awayCoachSignature) {
    if (await embedSignature(matchData.awayCoachSignature, 'away_coach_sign')) signaturesEmbedded++
  }
  if (matchData.awayCaptainSignature) {
    if (await embedSignature(matchData.awayCaptainSignature, 'away_captain_sign')) signaturesEmbedded++
  }
  
  console.log(`✓ Embedded ${signaturesEmbedded} signatures`)
  
  console.log(`✓ Filled ${fieldsSet} fields in PDF`)
  
  return pdfDoc
}

