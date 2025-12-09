import jsPDF from 'jspdf'

/**
 * Generate a PDF scoresheet following official FIVB volleyball scoresheet format
 * Based on the official scoresheet template structure
 */
export async function generateScoresheetPDF(matchData) {
  const {
    match,
    homeTeam,
    awayTeam,
    homePlayers,
    awayPlayers,
    sets,
    events,
    referees,
    scorers
  } = matchData

  // Create PDF in landscape orientation (A4 landscape: 297mm x 210mm)
  const pdf = new jsPDF({
    orientation: 'landscape',
    unit: 'mm',
    format: 'a4'
  })

  // Constants for layout (matching official scoresheet proportions)
  const pageWidth = 297
  const pageHeight = 210
  const margin = 8
  const contentWidth = pageWidth - (margin * 2)
  
  // Font sizes
  const fontSizeHeader = 10
  const fontSizeNormal = 8
  const fontSizeSmall = 7
  const fontSizeTiny = 6
  const fontSizeBox = 6

  // Starting position
  let yPos = margin
  const lineHeight = 4.5
  const smallLineHeight = 3.5

  // Helper function to draw a box with optional text
  const drawBox = (x, y, width, height, text = '', fontSize = fontSizeBox, align = 'center', fill = false) => {
    pdf.setDrawColor(0, 0, 0)
    pdf.setLineWidth(0.1)
    if (fill) {
      pdf.setFillColor(0, 0, 0)
      pdf.rect(x, y, width, height, 'FD')
    } else {
      pdf.rect(x, y, width, height)
    }
    if (text) {
      pdf.setFontSize(fontSize)
      pdf.setDrawColor(0, 0, 0)
      const textY = y + (height / 2) + (fontSize * 0.35)
      if (align === 'center') {
        pdf.text(text, x + width / 2, textY, { align: 'center' })
      } else if (align === 'left') {
        pdf.text(text, x + 1, textY, { align: 'left' })
      } else {
        pdf.text(text, x + width - 1, textY, { align: 'right' })
      }
    }
  }

  // Determine team labels (A or B) based on coin toss
  const teamAKey = match.coinTossTeamA || 'home'
  const teamBKey = match.coinTossTeamB || 'away'
  const homeLabel = teamAKey === 'home' ? 'A' : 'B'
  const awayLabel = teamAKey === 'away' ? 'A' : 'B'
  const teamA = teamAKey === 'home' ? homeTeam : awayTeam
  const teamB = teamAKey === 'away' ? homeTeam : awayTeam
  const teamAPlayers = teamAKey === 'home' ? homePlayers : awayPlayers
  const teamBPlayers = teamAKey === 'away' ? homePlayers : awayPlayers

  // HEADER SECTION
  pdf.setFontSize(fontSizeHeader)
  pdf.setFont(undefined, 'bold')
  pdf.text('OFFICIAL SCORESHEET', pageWidth / 2, yPos, { align: 'center' })
  yPos += lineHeight + 1

  // Match information row
  pdf.setFontSize(fontSizeSmall)
  pdf.setFont(undefined, 'normal')
  
  const matchDate = match.scheduledAt ? new Date(match.scheduledAt).toLocaleDateString('en-GB') : new Date().toLocaleDateString('en-GB')
  const matchTime = match.scheduledAt ? new Date(match.scheduledAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : ''
  const venue = match.hall || match.venue || ''
  const city = match.city || ''
  const league = match.league || ''
  const gameNumber = match.externalId || match.gameNumber || ''

  pdf.text(`Date: ${matchDate}`, margin, yPos)
  if (matchTime) pdf.text(`Time: ${matchTime}`, margin + 50, yPos)
  if (venue) pdf.text(`Venue: ${venue}`, margin + 100, yPos)
  if (city) pdf.text(`City: ${city}`, margin + 150, yPos)
  yPos += lineHeight

  if (league) pdf.text(`League: ${league}`, margin, yPos)
  if (gameNumber) pdf.text(`Game #: ${gameNumber}`, margin + 50, yPos)
  yPos += lineHeight + 2

  // Teams section
  pdf.setFontSize(fontSizeNormal)
  pdf.setFont(undefined, 'bold')
  const teamBoxHeight = 7
  const teamBoxWidth = (contentWidth - 10) / 2
  
  // Team A
  drawBox(margin, yPos, teamBoxWidth, teamBoxHeight, `TEAM ${homeLabel}: ${teamA?.name || 'Team A'}`, fontSizeNormal, 'left')
  
  // Team B
  drawBox(margin + teamBoxWidth + 10, yPos, teamBoxWidth, teamBoxHeight, `TEAM ${awayLabel}: ${teamB?.name || 'Team B'}`, fontSizeNormal, 'left')
  yPos += teamBoxHeight + 3

  // Officials
  pdf.setFontSize(fontSizeSmall)
  pdf.setFont(undefined, 'normal')
  const ref1 = referees?.find(r => r.role === 'ref1') || referees?.[0]
  const ref2 = referees?.find(r => r.role === 'ref2') || referees?.[1]
  const scorer = scorers?.find(s => s.role === 'scorer') || scorers?.[0]
  const asstScorer = scorers?.find(s => s.role === 'asst-scorer') || scorers?.[1]

  if (ref1) pdf.text(`1st Referee: ${ref1.firstName || ''} ${ref1.lastName || ''}`, margin, yPos)
  if (ref2) pdf.text(`2nd Referee: ${ref2.firstName || ''} ${ref2.lastName || ''}`, margin + 100, yPos)
  yPos += lineHeight
  if (scorer) pdf.text(`Scorer: ${scorer.firstName || ''} ${scorer.lastName || ''}`, margin, yPos)
  if (asstScorer) pdf.text(`Asst. Scorer: ${asstScorer.firstName || ''} ${asstScorer.lastName || ''}`, margin + 100, yPos)
  yPos += lineHeight + 3

  // Sort sets by index
  const sortedSets = [...sets].sort((a, b) => a.index - b.index)
  const finishedSets = sortedSets.filter(s => s.finished)

  // For each set, create scoresheet section
  for (let setIdx = 0; setIdx < Math.max(5, finishedSets.length); setIdx++) {
    const set = sortedSets.find(s => s.index === setIdx)
    const setEvents = events.filter(e => e.setIndex === setIdx).sort((a, b) => {
      const aSeq = a.seq || 0
      const bSeq = b.seq || 0
      if (aSeq !== 0 || bSeq !== 0) return aSeq - bSeq
      return new Date(a.ts) - new Date(b.ts)
    })

    // Check if we need a new page (each set needs significant space)
    if (yPos > pageHeight - 80) {
      pdf.addPage()
      yPos = margin
    }

    // SET HEADER
    pdf.setFontSize(fontSizeHeader)
    pdf.setFont(undefined, 'bold')
    pdf.text(`SET ${setIdx + 1}`, pageWidth / 2, yPos, { align: 'center' })
    yPos += lineHeight + 1

    if (set && set.finished) {
      pdf.setFontSize(fontSizeSmall)
      pdf.setFont(undefined, 'normal')
      const homePoints = teamAKey === 'home' ? set.homePoints : set.awayPoints
      const awayPoints = teamAKey === 'home' ? set.awayPoints : set.homePoints
      pdf.text(`Final: Team ${homeLabel} ${homePoints} - Team ${awayLabel} ${awayPoints}`, pageWidth / 2, yPos, { align: 'center' })
      yPos += lineHeight
    }

    // Starting Lineups section
    pdf.setFontSize(fontSizeSmall)
    pdf.setFont(undefined, 'bold')
    pdf.text('Starting Lineups:', margin, yPos)
    yPos += lineHeight + 1

    // Get starting lineup for this set
    const setStartEvent = setEvents.find(e => e.type === 'set_start')
    const initialLineupA = setStartEvent?.payload?.homeLineup || setStartEvent?.payload?.lineup?.home || {}
    const initialLineupB = setStartEvent?.payload?.awayLineup || setStartEvent?.payload?.lineup?.away || {}

    // Find INITIAL lineup event for each team (not rotation or substitution lineups)
    const firstLineupA = setEvents.find(e =>
      e.type === 'lineup' &&
      e.payload?.team === (teamAKey === 'home' ? 'home' : 'away') &&
      e.payload?.isInitial === true
    )
    const firstLineupB = setEvents.find(e =>
      e.type === 'lineup' &&
      e.payload?.team === (teamBKey === 'home' ? 'home' : 'away') &&
      e.payload?.isInitial === true
    )

    const lineupA = firstLineupA?.payload?.lineup || initialLineupA
    const lineupB = firstLineupB?.payload?.lineup || initialLineupB

    // Positions: I, II, III (front row), IV, V, VI (back row)
    const positions = ['I', 'II', 'III', 'IV', 'V', 'VI']

    // Team A lineup
    pdf.setFontSize(fontSizeTiny)
    pdf.setFont(undefined, 'normal')
    pdf.text(`Team ${homeLabel}:`, margin, yPos)
    const boxSize = 5.5
    const boxSpacing = 7
    let xPos = margin + 20
    for (let i = 0; i < positions.length; i++) {
      const pos = positions[i]
      const playerNum = lineupA[pos] || ''
      drawBox(xPos, yPos - 2.5, boxSize, boxSize, playerNum.toString(), fontSizeTiny)
      pdf.text(pos, xPos + boxSize / 2, yPos - 4.5, { align: 'center' })
      xPos += boxSpacing
    }
    yPos += lineHeight + 1

    // Team B lineup
    pdf.text(`Team ${awayLabel}:`, margin, yPos)
    xPos = margin + 20
    for (let i = 0; i < positions.length; i++) {
      const pos = positions[i]
      const playerNum = lineupB[pos] || ''
      drawBox(xPos, yPos - 2.5, boxSize, boxSize, playerNum.toString(), fontSizeTiny)
      pdf.text(pos, xPos + boxSize / 2, yPos - 4.5, { align: 'center' })
      xPos += boxSpacing
    }
    yPos += lineHeight + 2

    // Score tracking grid section (official format)
    pdf.setFontSize(fontSizeSmall)
    pdf.setFont(undefined, 'bold')
    pdf.text('Score Tracking (Service order marked with filled box):', margin, yPos)
    yPos += lineHeight + 1

    // Calculate scores and service through the set
    let teamAScore = 0
    let teamBScore = 0
    let currentServe = null // 'A' or 'B'
    
    // Determine who serves first
    if (setIdx === 4 && match.set5FirstServe) {
      currentServe = match.set5FirstServe === teamAKey ? 'A' : 'B'
    } else {
      const firstPoint = setEvents.find(e => e.type === 'point')
      if (firstPoint) {
        const firstPointTeam = firstPoint.payload?.team
        currentServe = (firstPointTeam === teamAKey) ? 'A' : 'B'
      }
    }

    // Score grid - up to 35 points per team (official scoresheet format)
    const maxPoints = 35
    const scoreBoxSize = 3.5
    const scoreBoxSpacing = 4
    const scoreStartX = margin + 25
    const scoreLabelWidth = 20

    // Team A score row with label
    pdf.setFontSize(fontSizeTiny)
    pdf.setFont(undefined, 'normal')
    pdf.text(`Team ${homeLabel}:`, margin, yPos)
    xPos = scoreStartX
    const teamARowY = yPos - 2.5
    for (let i = 0; i < maxPoints; i++) {
      drawBox(xPos, teamARowY, scoreBoxSize, scoreBoxSize, '', fontSizeTiny)
      xPos += scoreBoxSpacing
    }
    yPos += lineHeight + 1

    // Team B score row with label
    pdf.text(`Team ${awayLabel}:`, margin, yPos)
    xPos = scoreStartX
    const teamBRowY = yPos - 2.5
    for (let i = 0; i < maxPoints; i++) {
      drawBox(xPos, teamBRowY, scoreBoxSize, scoreBoxSize, '', fontSizeTiny)
      xPos += scoreBoxSpacing
    }
    yPos += lineHeight + 2

    // Process events to fill in scores, track service, and collect other events
    const substitutions = []
    const timeouts = []
    const sanctions = []
    const liberoActions = []

    for (const event of setEvents) {
      if (event.type === 'point') {
        const pointTeam = event.payload?.team
        if (pointTeam === teamAKey) {
          teamAScore++
          const boxX = scoreStartX + ((teamAScore - 1) * scoreBoxSpacing)
          // Fill score box with number
          drawBox(boxX, teamARowY, scoreBoxSize, scoreBoxSize, teamAScore.toString(), fontSizeTiny)
          // Mark service with filled box in corner
          if (currentServe === 'A') {
            drawBox(boxX + scoreBoxSize - 1.2, teamARowY, 1.2, 1.2, '', fontSizeTiny, 'center', true)
          }
          currentServe = 'A'
        } else {
          teamBScore++
          const boxX = scoreStartX + ((teamBScore - 1) * scoreBoxSpacing)
          drawBox(boxX, teamBRowY, scoreBoxSize, scoreBoxSize, teamBScore.toString(), fontSizeTiny)
          if (currentServe === 'B') {
            drawBox(boxX + scoreBoxSize - 1.2, teamBRowY, 1.2, 1.2, '', fontSizeTiny, 'center', true)
          }
          currentServe = 'B'
        }
      } else if (event.type === 'substitution') {
        substitutions.push({
          team: event.payload?.team === teamAKey ? 'A' : 'B',
          playerOut: event.payload?.playerOut,
          playerIn: event.payload?.playerIn,
          scoreA: teamAScore,
          scoreB: teamBScore,
          isExceptional: event.payload?.isExceptional || false
        })
      } else if (event.type === 'timeout') {
        timeouts.push({
          team: event.payload?.team === teamAKey ? 'A' : 'B',
          scoreA: teamAScore,
          scoreB: teamBScore
        })
      } else if (event.type === 'sanction') {
        sanctions.push({
          team: event.payload?.team === teamAKey ? 'A' : 'B',
          type: event.payload?.type,
          playerNumber: event.payload?.playerNumber,
          role: event.payload?.role,
          scoreA: teamAScore,
          scoreB: teamBScore
        })
      } else if (event.type === 'libero_entry' || event.type === 'libero_exit') {
        liberoActions.push({
          type: event.type,
          team: event.payload?.team === teamAKey ? 'A' : 'B',
          liberoNumber: event.payload?.liberoIn || event.payload?.liberoOut,
          liberoType: event.payload?.liberoType,
          playerNumber: event.payload?.playerOut,
          scoreA: teamAScore,
          scoreB: teamBScore
        })
      }
    }

    // Substitutions notation (official format: player numbers with score)
    if (substitutions.length > 0) {
      yPos += 2
      pdf.setFontSize(fontSizeSmall)
      pdf.setFont(undefined, 'bold')
      pdf.text('Substitutions:', margin, yPos)
      yPos += lineHeight
      pdf.setFontSize(fontSizeTiny)
      pdf.setFont(undefined, 'normal')
      for (const sub of substitutions) {
        const excMark = sub.isExceptional ? ' (EXC)' : ''
        pdf.text(`Team ${sub.team}: ${sub.playerOut}→${sub.playerIn}${excMark} @ ${sub.scoreA}-${sub.scoreB}`, margin, yPos)
        yPos += smallLineHeight
        if (yPos > pageHeight - 25) {
          pdf.addPage()
          yPos = margin
        }
      }
    }

    // Timeouts notation
    if (timeouts.length > 0) {
      yPos += 1
      pdf.setFontSize(fontSizeSmall)
      pdf.setFont(undefined, 'bold')
      pdf.text('Timeouts:', margin, yPos)
      yPos += lineHeight
      pdf.setFontSize(fontSizeTiny)
      pdf.setFont(undefined, 'normal')
      for (const timeout of timeouts) {
        pdf.text(`Team ${timeout.team} @ ${timeout.scoreA}-${timeout.scoreB}`, margin, yPos)
        yPos += smallLineHeight
        if (yPos > pageHeight - 25) {
          pdf.addPage()
          yPos = margin
        }
      }
    }

    // Sanctions notation
    if (sanctions.length > 0) {
      yPos += 1
      pdf.setFontSize(fontSizeSmall)
      pdf.setFont(undefined, 'bold')
      pdf.text('Sanctions:', margin, yPos)
      yPos += lineHeight
      pdf.setFontSize(fontSizeTiny)
      pdf.setFont(undefined, 'normal')
      for (const sanction of sanctions) {
        const typeLabel = sanction.type === 'warning' ? 'W' : 
                         sanction.type === 'penalty' ? 'P' :
                         sanction.type === 'expulsion' ? 'E' :
                         sanction.type === 'disqualification' ? 'D' : 
                         sanction.type === 'improper_request' ? 'IR' :
                         sanction.type === 'delay_warning' ? 'DW' :
                         sanction.type === 'delay_penalty' ? 'DP' : sanction.type
        const playerText = sanction.playerNumber ? `${sanction.playerNumber}` : (sanction.role || 'Team')
        pdf.text(`Team ${sanction.team}: ${playerText} ${typeLabel} @ ${sanction.scoreA}-${sanction.scoreB}`, margin, yPos)
        yPos += smallLineHeight
        if (yPos > pageHeight - 25) {
          pdf.addPage()
          yPos = margin
        }
      }
    }

    // Libero actions notation
    if (liberoActions.length > 0) {
      yPos += 1
      pdf.setFontSize(fontSizeSmall)
      pdf.setFont(undefined, 'bold')
      pdf.text('Libero Actions:', margin, yPos)
      yPos += lineHeight
      pdf.setFontSize(fontSizeTiny)
      pdf.setFont(undefined, 'normal')
      for (const action of liberoActions) {
        const actionText = action.type === 'libero_entry' ? 'IN' : 'OUT'
        const liberoLabel = action.liberoType === 'libero1' ? 'L1' : action.liberoType === 'libero2' ? 'L2' : 'L'
        pdf.text(`Team ${action.team}: ${liberoLabel}#${action.liberoNumber} ${actionText} (for ${action.playerNumber}) @ ${action.scoreA}-${action.scoreB}`, margin, yPos)
        yPos += smallLineHeight
        if (yPos > pageHeight - 25) {
          pdf.addPage()
          yPos = margin
        }
      }
    }

    yPos += 3 // Space between sets
  }

  // Final match result
  if (finishedSets.length > 0) {
    if (yPos > pageHeight - 50) {
      pdf.addPage()
      yPos = margin
    }

    pdf.setFontSize(fontSizeHeader)
    pdf.setFont(undefined, 'bold')
    pdf.text('MATCH RESULT', pageWidth / 2, yPos, { align: 'center' })
    yPos += lineHeight + 2

    const homeSetsWon = finishedSets.filter(s => {
      const homePoints = teamAKey === 'home' ? s.homePoints : s.awayPoints
      const awayPoints = teamAKey === 'home' ? s.awayPoints : s.homePoints
      return homePoints > awayPoints
    }).length

    const awaySetsWon = finishedSets.filter(s => {
      const homePoints = teamAKey === 'home' ? s.homePoints : s.awayPoints
      const awayPoints = teamAKey === 'home' ? s.awayPoints : s.homePoints
      return awayPoints > homePoints
    }).length

    pdf.setFontSize(fontSizeHeader)
    pdf.text(`Team ${homeLabel} ${homeSetsWon} - Team ${awayLabel} ${awaySetsWon}`, pageWidth / 2, yPos, { align: 'center' })
    yPos += lineHeight + 2

    // Set breakdown
    pdf.setFontSize(fontSizeSmall)
    pdf.setFont(undefined, 'normal')
    for (const set of finishedSets) {
      const homePoints = teamAKey === 'home' ? set.homePoints : set.awayPoints
      const awayPoints = teamAKey === 'home' ? set.awayPoints : set.homePoints
      pdf.text(`Set ${set.index + 1}: ${homePoints}-${awayPoints}`, pageWidth / 2, yPos, { align: 'center' })
      yPos += lineHeight
    }
    yPos += 3
  }

  // Signatures section
  if (yPos > pageHeight - 60) {
    pdf.addPage()
    yPos = margin
  }

  pdf.setFontSize(fontSizeHeader)
  pdf.setFont(undefined, 'bold')
  pdf.text('SIGNATURES', pageWidth / 2, yPos, { align: 'center' })
  yPos += lineHeight + 2

  const signatureBoxHeight = 12
  const signatureBoxWidth = 55
  const signatureSpacing = 12

  // Captains
  pdf.setFontSize(fontSizeSmall)
  pdf.setFont(undefined, 'normal')
  pdf.text(`Team ${homeLabel} Captain:`, margin, yPos)
  if (match.homeCaptainSignature || match.postMatchSignatureHomeCaptain) {
    const sig = match.postMatchSignatureHomeCaptain || match.homeCaptainSignature
    pdf.addImage(sig, 'PNG', margin, yPos + 2, signatureBoxWidth, signatureBoxHeight)
  } else {
    drawBox(margin, yPos + 2, signatureBoxWidth, signatureBoxHeight)
  }
  yPos += signatureBoxHeight + 4

  pdf.text(`Team ${awayLabel} Captain:`, margin, yPos)
  if (match.awayCaptainSignature || match.postMatchSignatureAwayCaptain) {
    const sig = match.postMatchSignatureAwayCaptain || match.awayCaptainSignature
    pdf.addImage(sig, 'PNG', margin, yPos + 2, signatureBoxWidth, signatureBoxHeight)
  } else {
    drawBox(margin, yPos + 2, signatureBoxWidth, signatureBoxHeight)
  }
  yPos += signatureBoxHeight + 5

  // Officials
  pdf.text('1st Referee:', margin, yPos)
  if (match.ref1Signature) {
    pdf.addImage(match.ref1Signature, 'PNG', margin, yPos + 2, signatureBoxWidth, signatureBoxHeight)
  } else {
    drawBox(margin, yPos + 2, signatureBoxWidth, signatureBoxHeight)
  }

  pdf.text('2nd Referee:', margin + signatureBoxWidth + signatureSpacing, yPos)
  if (match.ref2Signature) {
    pdf.addImage(match.ref2Signature, 'PNG', margin + signatureBoxWidth + signatureSpacing, yPos + 2, signatureBoxWidth, signatureBoxHeight)
  } else {
    drawBox(margin + signatureBoxWidth + signatureSpacing, yPos + 2, signatureBoxWidth, signatureBoxHeight)
  }
  yPos += signatureBoxHeight + 4

  pdf.text('Scorer:', margin, yPos)
  if (match.scorerSignature) {
    pdf.addImage(match.scorerSignature, 'PNG', margin, yPos + 2, signatureBoxWidth, signatureBoxHeight)
  } else {
    drawBox(margin, yPos + 2, signatureBoxWidth, signatureBoxHeight)
  }

  pdf.text('Asst. Scorer:', margin + signatureBoxWidth + signatureSpacing, yPos)
  if (match.asstScorerSignature) {
    pdf.addImage(match.asstScorerSignature, 'PNG', margin + signatureBoxWidth + signatureSpacing, yPos + 2, signatureBoxWidth, signatureBoxHeight)
  } else {
    drawBox(margin + signatureBoxWidth + signatureSpacing, yPos + 2, signatureBoxWidth, signatureBoxHeight)
  }

  // Generate filename
  const filename = `Scoresheet_${(teamA?.name || 'TeamA').replace(/[^a-zA-Z0-9]/g, '_')}_vs_${(teamB?.name || 'TeamB').replace(/[^a-zA-Z0-9]/g, '_')}_${matchDate.replace(/\//g, '-')}.pdf`

  // Save PDF
  pdf.save(filename)
}
