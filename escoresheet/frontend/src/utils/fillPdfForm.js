/**
 * Fill a PDF form with match data based on field mappings
 * 
 * @param {PDFDocument} pdfDoc - The PDF document from pdf-lib
 * @param {Object} fieldMapping - Field mapping from pdf-field-mapping.json
 * @param {Object} matchData - Match data object
 * @returns {Promise<PDFDocument>} - The filled PDF document
 */

export async function fillPdfForm(pdfDoc, fieldMapping, matchData) {
  const form = pdfDoc.getForm();
  const fields = form.getFields();
  
  // Helper to format date as dd.mm.yyyy
  function formatDate(dateString) {
    if (!dateString) return '';
    const date = new Date(dateString);
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    return `${day}.${month}.${year}`;
  }

  // Helper to format time as HH:mm
  function formatTime(dateString) {
    if (!dateString) return '';
    const date = new Date(dateString);
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
  }

  // Helper to extract row number from field name (e.g., "home_roster_players_dob_1" -> 1)
  function extractRowNumber(fieldName) {
    const match = fieldName.match(/_(\d+)$/);
    return match ? parseInt(match[1]) : null;
  }

  // Helper to fill individual roster fields (players or liberos)
  function fillRosterFields(fields, players, fieldMapping, maxRows) {
    if (!players || players.length === 0) return;
    
    // Get all fields for this roster type, handling both numbered and unnumbered fields
    const dobFields = fields.filter(f => {
      const name = f.getName().toLowerCase();
      return name.includes('dob') && !name.includes('coach') && !name.includes('assistant') && 
             !name.includes('physio') && !name.includes('doctor') && !name.includes('trainer');
    }).sort((a, b) => {
      const numA = extractRowNumber(a.getName());
      const numB = extractRowNumber(b.getName());
      // If both have numbers, sort by number; otherwise maintain original order
      if (numA !== null && numB !== null) {
        return numA - numB;
      }
      // If one has a number, it comes first
      if (numA !== null) return -1;
      if (numB !== null) return 1;
      // Both unnumbered - maintain order
      return 0;
    });
    
    const numberFields = fields.filter(f => {
      const name = f.getName().toLowerCase();
      return name.includes('number') && !name.includes('game') && !name.includes('spiel');
    }).sort((a, b) => {
      const numA = extractRowNumber(a.getName());
      const numB = extractRowNumber(b.getName());
      if (numA !== null && numB !== null) {
        return numA - numB;
      }
      if (numA !== null) return -1;
      if (numB !== null) return 1;
      return 0;
    });
    
    const nameFields = fields.filter(f => {
      const name = f.getName().toLowerCase();
      return name.includes('name') && !name.includes('coach') && !name.includes('assistant') && 
             !name.includes('physio') && !name.includes('doctor') && !name.includes('trainer') &&
             !name.includes('team'); // Exclude team name fields
    }).sort((a, b) => {
      const numA = extractRowNumber(a.getName());
      const numB = extractRowNumber(b.getName());
      if (numA !== null && numB !== null) {
        return numA - numB;
      }
      if (numA !== null) return -1;
      if (numB !== null) return 1;
      return 0;
    });

    // Fill up to maxRows or available fields
    const rowsToFill = Math.min(players.length, maxRows, dobFields.length, numberFields.length, nameFields.length);
    
    for (let i = 0; i < rowsToFill; i++) {
      const player = players[i];
      
      // Format DOB as dd.mm.yyyy (convert from any format)
      let dob = player.dob || '';
      if (dob && dob.includes('/')) {
        // Convert from dd/mm/yyyy to dd.mm.yyyy
        dob = dob.replace(/\//g, '.');
      }
      
      const number = String(player.number || '');
      const name = player.name || `${player.lastName || ''} ${player.firstName || ''}`.trim();
      
      // Fill DOB field
      if (dobFields[i] && dobFields[i].constructor.name === 'PDFTextField') {
        dobFields[i].setText(dob);
      }
      
      // Fill number field
      if (numberFields[i] && numberFields[i].constructor.name === 'PDFTextField') {
        numberFields[i].setText(number);
      }
      
      // Fill name field
      if (nameFields[i] && nameFields[i].constructor.name === 'PDFTextField') {
        nameFields[i].setText(name);
      }
    }
  }

  // First, handle roster fields (players and liberos) separately
  const fieldNameLower = {};
  fields.forEach(f => {
    fieldNameLower[f.getName()] = f.getName().toLowerCase();
  });

  // Fill player rosters (14 rows per team)
  ['home', 'away'].forEach(team => {
    const teamFields = fields.filter(f => {
      const name = f.getName().toLowerCase();
      return name.includes('roster') && name.includes('player') && name.includes(team);
    });
    
    if (teamFields.length > 0) {
      const players = team === 'home' 
        ? (matchData.players?.home || matchData.homePlayers || [])
        : (matchData.players?.away || matchData.awayPlayers || []);
      
      fillRosterFields(teamFields, players, fieldMapping, 14);
    }
  });

  // Fill libero rosters (2 rows per team)
  ['home', 'away'].forEach(team => {
    const liberoFields = fields.filter(f => {
      const name = f.getName().toLowerCase();
      return name.includes('roster') && name.includes('libero') && name.includes(team);
    });
    
    if (liberoFields.length > 0) {
      const liberos = team === 'home'
        ? (matchData.liberos?.home || matchData.homePlayers?.filter(p => p.libero) || [])
        : (matchData.liberos?.away || matchData.awayPlayers?.filter(p => p.libero) || []);
      
      fillRosterFields(liberoFields, liberos, fieldMapping, 2);
    }
  });

  // Fill bench official fields
  ['home', 'away'].forEach(team => {
    const bench = team === 'home'
      ? (matchData.bench?.home || matchData.match?.bench_home || [])
      : (matchData.bench?.away || matchData.match?.bench_away || []);
    
    bench.forEach(official => {
      const role = official.role || 'coach';
      const roleMap = {
        'coach': 'coach',
        'assistant coach 1': 'assistant_coach',
        'assistant coach': 'assistant_coach',
        'physiotherapist': 'physiotherapist',
        'doctor': 'doctor',
        'trainer': 'trainer'
      };
      const roleKey = roleMap[role.toLowerCase()] || role.toLowerCase().replace(/\s+/g, '_');
      
      // Find DOB and name fields for this role
      const dobField = fields.find(f => {
        const name = f.getName().toLowerCase();
        return name.includes('roster') && name.includes(roleKey) && 
               name.includes(team) && name.includes('dob') && 
               !name.match(/_(\d+)$/); // Not a numbered field
      });
      
      const nameField = fields.find(f => {
        const name = f.getName().toLowerCase();
        return name.includes('roster') && name.includes(roleKey) && 
               name.includes(team) && name.includes('name') && 
               !name.match(/_(\d+)$/); // Not a numbered field
      });
      
      // Format DOB
      let dob = official.dob || '';
      if (dob && dob.includes('/')) {
        dob = dob.replace(/\//g, '.');
      }
      
      const name = official.name || `${official.lastName || ''} ${official.firstName || ''}`.trim();
      
      if (dobField && dobField.constructor.name === 'PDFTextField') {
        dobField.setText(dob);
      }
      
      if (nameField && nameField.constructor.name === 'PDFTextField') {
        nameField.setText(name);
      }
    });
  });

  // Process all other fields
  fields.forEach(field => {
    const fieldName = field.getName();
    const fieldNameLower = fieldName.toLowerCase();
    
    // Skip roster fields we already handled
    if (fieldNameLower.includes('roster') && 
        (fieldNameLower.includes('player') || fieldNameLower.includes('libero') || 
         fieldNameLower.includes('coach') || fieldNameLower.includes('assistant') ||
         fieldNameLower.includes('physio'))) {
      return; // Already handled above
    }

    const mapping = fieldMapping.fieldMappings?.[fieldName];
    const fieldType = field.constructor.name;

    try {
      // Handle checkboxes (fields ending with _x or checkbox type)
      if (mapping?.dataType === 'checkbox' || fieldNameLower.endsWith('_x') || fieldType === 'PDFCheckBox') {
        // Determine if checkbox should be checked based on field name
        let shouldCheck = false;
        
        if (fieldNameLower.includes('championship') && matchData.match?.matchType === 'championship') {
          shouldCheck = true;
        } else if (fieldNameLower.includes('cup') && matchData.match?.matchType === 'cup') {
          shouldCheck = true;
        } else if (fieldNameLower.includes('home') && fieldNameLower.includes('captain')) {
          shouldCheck = !!matchData.homeTeam?.captain;
        } else if (fieldNameLower.includes('away') && fieldNameLower.includes('captain')) {
          shouldCheck = !!matchData.awayTeam?.captain;
        }
        
        if (shouldCheck) {
          field.check();
        } else {
          field.uncheck();
        }
        return;
      }

      // Handle text fields
      if (fieldType === 'PDFTextField') {
        let value = '';

        // Match date
        if (fieldNameLower.includes('date') || fieldNameLower.includes('datum')) {
          value = formatDate(matchData.match?.scheduledAt || matchData.match?.date);
        }
        // Match time
        else if (fieldNameLower.includes('time') || fieldNameLower.includes('zeit')) {
          value = formatTime(matchData.match?.scheduledAt || matchData.match?.time);
        }
        // Venue/Hall
        else if (fieldNameLower.includes('venue') || fieldNameLower.includes('hall') || fieldNameLower.includes('halle')) {
          value = matchData.match?.venue || matchData.match?.hall || '';
        }
        // City
        else if (fieldNameLower.includes('city') || fieldNameLower.includes('stadt')) {
          value = matchData.match?.city || '';
        }
        // League
        else if (fieldNameLower.includes('league') || fieldNameLower.includes('liga')) {
          value = matchData.match?.league || '';
        }
        // Game number (but not player numbers)
        else if ((fieldNameLower.includes('game') || fieldNameLower.includes('spiel')) && 
                 !fieldNameLower.includes('player') && !fieldNameLower.includes('roster')) {
          value = matchData.match?.gameNumber || matchData.match?.externalId || '';
        }
        // Home team name
        else if (fieldNameLower.includes('home') && fieldNameLower.includes('team') && 
                 !fieldNameLower.includes('roster') && !fieldNameLower.includes('player')) {
          value = matchData.homeTeam?.name || '';
        }
        // Away team name
        else if (fieldNameLower.includes('away') && fieldNameLower.includes('team') && 
                 !fieldNameLower.includes('roster') && !fieldNameLower.includes('player')) {
          value = matchData.awayTeam?.name || '';
        }
        // Referee 1
        else if (fieldNameLower.includes('referee1') || fieldNameLower.includes('referee_1') || 
                 (fieldNameLower.includes('referee') && fieldNameLower.includes('1') && 
                  !fieldNameLower.includes('2'))) {
          const ref = matchData.officials?.referee1 || matchData.referees?.[0];
          value = ref ? `${ref.firstName || ''} ${ref.lastName || ''}`.trim() : '';
        }
        // Referee 2
        else if (fieldNameLower.includes('referee2') || fieldNameLower.includes('referee_2') || 
                 (fieldNameLower.includes('referee') && fieldNameLower.includes('2'))) {
          const ref = matchData.officials?.referee2 || matchData.referees?.[1];
          value = ref ? `${ref.firstName || ''} ${ref.lastName || ''}`.trim() : '';
        }
        // Scorer
        else if (fieldNameLower.includes('scorer') && !fieldNameLower.includes('assistant')) {
          const scorer = matchData.officials?.scorer || matchData.scorers?.[0];
          value = scorer ? `${scorer.firstName || ''} ${scorer.lastName || ''}`.trim() : '';
        }
        // Assistant Scorer
        else if (fieldNameLower.includes('assistant') || fieldNameLower.includes('asst')) {
          const asstScorer = matchData.officials?.assistantScorer || matchData.scorers?.[1];
          value = asstScorer ? `${asstScorer.firstName || ''} ${asstScorer.lastName || ''}`.trim() : '';
        }
        // Default: try to get value from matchData using field name
        else {
          // Try nested access (e.g., "match.venue" -> matchData.match.venue)
          const parts = fieldName.split('_');
          let current = matchData;
          for (const part of parts) {
            if (current && typeof current === 'object') {
              current = current[part] || current[part.charAt(0).toUpperCase() + part.slice(1)];
            } else {
              current = undefined;
              break;
            }
          }
          value = current ? String(current) : '';
        }

        if (value !== '') {
          field.setText(value);
        }
      }
    } catch (error) {
      console.error(`Error filling field ${fieldName}:`, error);
    }
  });

  return pdfDoc;
}

/**
 * Generate a filled PDF from template and match data
 * 
 * @param {string|ArrayBuffer} templateUrlOrBytes - URL or ArrayBuffer of PDF template
 * @param {Object} fieldMapping - Field mapping from pdf-field-mapping.json
 * @param {Object} matchData - Match data object
 * @returns {Promise<Uint8Array>} - PDF bytes
 */
export async function generateFilledPdf(templateUrlOrBytes, fieldMapping, matchData) {
  const { PDFDocument } = await import('pdf-lib');
  
  let templateBytes;
  if (typeof templateUrlOrBytes === 'string') {
    const response = await fetch(templateUrlOrBytes);
    templateBytes = await response.arrayBuffer();
  } else {
    templateBytes = templateUrlOrBytes;
  }

  const pdfDoc = await PDFDocument.load(templateBytes);
  await fillPdfForm(pdfDoc, fieldMapping, matchData);
  
  return await pdfDoc.save();
}

