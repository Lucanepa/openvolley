import React, { useRef, useEffect, useState } from 'react';
import { Header } from './components/Header';
import { StandardSet } from './components/StandardSet';
import { SetFive } from './components/SetFive';
import { Sanctions, Results, Approvals, Roster, Remarks } from './components/FooterSection';
import { Player, SanctionRecord } from './types_scoresheet';

interface AppScoresheetProps {
  matchData: {
    match: any;
    homeTeam: any;
    awayTeam: any;
    homePlayers: Player[];
    awayPlayers: Player[];
    sets: any[];
    events: any[];
    sanctions?: SanctionRecord[];
  };
}

const App: React.FC<AppScoresheetProps> = ({ matchData }) => {
  const { match, homeTeam, awayTeam, homePlayers, awayPlayers, sets, events, sanctions = [] } = matchData;
  
  // Helper function to format players for scoresheet
  const formatPlayers = (players: any[]): Player[] => {
    return players.map(p => ({
      number: String(p.number || ''),
      name: p.name || `${p.lastName || ''} ${p.firstName || ''}`.trim(),
      firstName: p.firstName,
      lastName: p.lastName,
      dob: p.dob,
      libero: p.libero,
      isCaptain: p.isCaptain,
      license: p.license || '',
      role: p.role
    }));
  };
  
  // Determine team labels (A or B) based on coin toss
  const teamAKey = match?.coinTossTeamA || 'home';
  const teamBKey = teamAKey === 'home' ? 'away' : 'home';
  
  const teamAPlayers = formatPlayers(teamAKey === 'home' ? homePlayers : awayPlayers);
  const teamBPlayers = formatPlayers(teamBKey === 'home' ? homePlayers : awayPlayers);
  
  // Use full team names
  const teamAName = (teamAKey === 'home' ? homeTeam?.name : awayTeam?.name) || (teamAKey === 'home' ? 'Home' : 'Away');
  const teamBName = (teamBKey === 'home' ? homeTeam?.name : awayTeam?.name) || (teamBKey === 'home' ? 'Home' : 'Away');
  
  // Use short names for set labels and rosters
  const teamAShortName = (teamAKey === 'home' ? match?.homeShortName : match?.awayShortName) || teamAName;
  const teamBShortName = (teamBKey === 'home' ? match?.homeShortName : match?.awayShortName) || teamBName;
  
  // Helper function to get set data from events and sets
  const getSetData = (setNumber: number, isSwapped: boolean = false) => {
    const setInfo = sets?.find(s => s.index === setNumber);
    
    // Check if set has been played (has points or startTime)
    const hasBeenPlayed = setInfo && (setInfo.homePoints > 0 || setInfo.awayPoints > 0 || setInfo.startTime);
    
    // Only calculate points if set has been played
    let leftPoints = 0;
    let rightPoints = 0;
    
    if (hasBeenPlayed) {
      leftPoints = !isSwapped 
        ? (teamAKey === 'home' ? (setInfo.homePoints || 0) : (setInfo.awayPoints || 0))
        : (teamBKey === 'home' ? (setInfo.homePoints || 0) : (setInfo.awayPoints || 0));
      
      rightPoints = !isSwapped
        ? (teamBKey === 'home' ? (setInfo.homePoints || 0) : (setInfo.awayPoints || 0))
        : (teamAKey === 'home' ? (setInfo.homePoints || 0) : (setInfo.awayPoints || 0));
    }
    
    // Get starting lineup from events
    const setEvents = events?.filter(e => e.setIndex === setNumber) || [];
    const homeLineupEvent = setEvents.find(e => e.type === 'lineup' && e.payload?.team === 'home');
    const awayLineupEvent = setEvents.find(e => e.type === 'lineup' && e.payload?.team === 'away');
    
    // Extract lineup arrays (positions I-VI)
    const homeLineupObj = homeLineupEvent?.payload?.lineup || {};
    const awayLineupObj = awayLineupEvent?.payload?.lineup || {};
    const positions = ['I', 'II', 'III', 'IV', 'V', 'VI'];
    const homeLineupArray = positions.map(pos => homeLineupObj[pos] ? String(homeLineupObj[pos]) : '');
    const awayLineupArray = positions.map(pos => awayLineupObj[pos] ? String(awayLineupObj[pos]) : '');
    
    // Determine left and right lineups based on team assignments and swapping
    const leftLineup = !isSwapped 
      ? (teamAKey === 'home' ? homeLineupArray : awayLineupArray)
      : (teamBKey === 'home' ? homeLineupArray : awayLineupArray);
    
    const rightLineup = !isSwapped
      ? (teamBKey === 'home' ? homeLineupArray : awayLineupArray)
      : (teamAKey === 'home' ? homeLineupArray : awayLineupArray);
    
    // Get point-by-point scoring sequence
    const pointEvents = setEvents
      .filter(e => e.type === 'point')
      .sort((a, b) => {
        const aSeq = a.seq || 0;
        const bSeq = b.seq || 0;
        if (aSeq !== 0 || bSeq !== 0) return aSeq - bSeq; // Sort by sequence
        return new Date(a.ts).getTime() - new Date(b.ts).getTime(); // Fallback to timestamp
      });
    
    // Track points for each team as they accumulate
    const homeMarkedPoints: number[] = [];
    const awayMarkedPoints: number[] = [];
    let homeScore = 0;
    let awayScore = 0;
    
    // Determine first serve team
    const firstServeTeam = setNumber === 1 
      ? (match?.coinTossServeA ? teamAKey : teamBKey)
      : (setNumber % 2 === 0 ? (teamAKey === 'home' ? 'away' : 'home') : teamAKey);
    
    // Service tracking: track service rounds for each team
    interface ServiceRound {
      position: number; // 0-5 for I-VI
      box: number; // 1-8
      ticked: boolean; // Has tick (4) when player starts serving
      points: number | null; // Points scored when service lost (null if still serving)
      rotation8: boolean; // Has "8" when opponent must rotate
      circled: boolean; // Circled at end of set for last point
    }
    
    const leftServiceRounds: ServiceRound[] = [];
    const rightServiceRounds: ServiceRound[] = [];
    
    // Determine which team is left and right
    const leftTeamKey = !isSwapped 
      ? (teamAKey === 'home' ? 'home' : 'away')
      : (teamBKey === 'home' ? 'home' : 'away');
    const rightTeamKey = !isSwapped
      ? (teamBKey === 'home' ? 'home' : 'away')
      : (teamAKey === 'home' ? 'home' : 'away');
    
    // Wrap service tracking in try-catch to prevent crashes
    try {
    // Track current serve and service state
    let currentServeTeam: 'home' | 'away' = firstServeTeam as 'home' | 'away';
    let leftServiceRound = 0; // Current service round index (0-47, increments by 1 each rotation)
    let rightServiceRound = 0; // Current service round index (0-47, increments by 1 each rotation)
    let leftCurrentPosition = 0; // Current serving position (0-5 for I-VI)
    let rightCurrentPosition = 0; // Current serving position (0-5 for I-VI)
    let leftPointsInService = 0; // Points scored in current service
    let rightPointsInService = 0; // Points scored in current service
    let leftServiceStarted = false; // Has left team started serving?
    let rightServiceStarted = false; // Has right team started serving?
    
    // Initialize first serve (no tick, just track state)
    if (firstServeTeam === leftTeamKey) {
      leftServiceStarted = true;
      leftCurrentPosition = 0;
    } else {
      rightServiceStarted = true;
      rightCurrentPosition = 0;
    }
    
    pointEvents.forEach((event, idx) => {
      const scoringTeam = event.payload?.team as 'home' | 'away';
      const isLeftTeam = scoringTeam === leftTeamKey;
      const isRightTeam = scoringTeam === rightTeamKey;
      
      // Update scores
      if (scoringTeam === 'home') {
        homeScore++;
        homeMarkedPoints.push(homeScore);
      } else if (scoringTeam === 'away') {
        awayScore++;
        awayMarkedPoints.push(awayScore);
      }
      
      // Check if service was lost (opponent scored while we had serve)
      if (scoringTeam !== currentServeTeam) {
        // Service was lost - record TEAM SCORE at time of service loss
        if (currentServeTeam === leftTeamKey && leftServiceStarted) {
          // Left team lost service - record their TEAM SCORE in service box
          const boxNum = Math.floor(leftServiceRound / 6) + 1; // Box number (1-8)
          // Get the team score at the time of service loss (before the opponent scored)
          const teamScoreAtLoss = leftTeamKey === 'home' ? homeScore : awayScore;
          
          // Update or add service round
          const existingRound = leftServiceRounds.find(sr => sr.position === leftCurrentPosition && sr.box === boxNum);
          if (existingRound) {
            existingRound.points = teamScoreAtLoss;
          } else {
            leftServiceRounds.push({
              position: leftCurrentPosition,
              box: boxNum,
              ticked: false,
              points: teamScoreAtLoss,
              rotation8: false,
              circled: false
            });
          }
          
          // Right team now serves - mark "8" in their column I, box 1 (if first time)
          if (!rightServiceStarted) {
            rightServiceRounds.push({
              position: 0, // Column I
              box: 1,
              ticked: false,
              points: null,
              rotation8: true, // Mark "8" for rotation
              circled: false
            });
          }
          
          // Right team rotates - next position serves
          rightCurrentPosition = (rightCurrentPosition + 1) % 6;
          rightServiceRound++;
          
          rightServiceStarted = true;
          rightPointsInService = 0;
        } else if (currentServeTeam === rightTeamKey && rightServiceStarted) {
          // Right team lost service - record their TEAM SCORE in service box
          const boxNum = Math.floor(rightServiceRound / 6) + 1;
          // Get the team score at the time of service loss (before the opponent scored)
          const teamScoreAtLoss = rightTeamKey === 'home' ? homeScore : awayScore;
          
          const existingRound = rightServiceRounds.find(sr => sr.position === rightCurrentPosition && sr.box === boxNum);
          if (existingRound) {
            existingRound.points = teamScoreAtLoss;
          } else {
            rightServiceRounds.push({
              position: rightCurrentPosition,
              box: boxNum,
              ticked: false,
              points: teamScoreAtLoss,
              rotation8: false,
              circled: false
            });
          }
          
          // Left team now serves - mark "8" in their column I, box 1 (if first time)
          if (!leftServiceStarted) {
            leftServiceRounds.push({
              position: 0, // Column I
              box: 1,
              ticked: false,
              points: null,
              rotation8: true, // Mark "8" for rotation
              circled: false
            });
          }
          
          // Left team rotates - next position serves
          leftCurrentPosition = (leftCurrentPosition + 1) % 6;
          leftServiceRound++;
          
          leftServiceStarted = true;
          leftPointsInService = 0;
        }
        
        // Update current serve
        currentServeTeam = scoringTeam;
      } else {
        // Scoring team had serve - increment their service points (for tracking, but we use team score instead)
        if (isLeftTeam && currentServeTeam === leftTeamKey) {
          leftPointsInService++;
        } else if (isRightTeam && currentServeTeam === rightTeamKey) {
          rightPointsInService++;
        }
      }
    });
    
    // End of set logic: circle last point for both teams
    const isSetFinished = setInfo?.finished || false;
    if (isSetFinished && pointEvents.length > 0) {
      const lastPoint = pointEvents[pointEvents.length - 1];
      const lastScoringTeam = lastPoint.payload?.team as 'home' | 'away';
      const isLastPointLeft = lastScoringTeam === leftTeamKey;
      const isLastPointRight = lastScoringTeam === rightTeamKey;
      
      // Get final scores from setInfo (after all points have been scored)
      const leftFinalScore = !isSwapped 
        ? (teamAKey === 'home' ? (setInfo.homePoints || 0) : (setInfo.awayPoints || 0))
        : (teamBKey === 'home' ? (setInfo.homePoints || 0) : (setInfo.awayPoints || 0));
      const rightFinalScore = !isSwapped
        ? (teamBKey === 'home' ? (setInfo.homePoints || 0) : (setInfo.awayPoints || 0))
        : (teamAKey === 'home' ? (setInfo.homePoints || 0) : (setInfo.awayPoints || 0));
      
      // Circle the last point for the winning team (team that scored the last point)
      if (isLastPointLeft) {
        // Left team won - circle their last point
        if (currentServeTeam === leftTeamKey && leftServiceStarted) {
          // Left team was serving - find their CURRENT active service round (the one with null points)
          const currentBoxNum = Math.floor(leftServiceRound / 6) + 1;
          let activeServiceRound = leftServiceRounds.find(sr => 
            sr.position === leftCurrentPosition && 
            sr.box === currentBoxNum && 
            sr.points === null
          );
          
          if (activeServiceRound) {
            // Found the active service round - update with final score and circle
            activeServiceRound.points = leftFinalScore;
            activeServiceRound.circled = true;
          } else {
            // No active round found, check the last one
            const lastServiceRound = leftServiceRounds[leftServiceRounds.length - 1];
            if (lastServiceRound && lastServiceRound.points === null) {
              lastServiceRound.points = leftFinalScore;
              lastServiceRound.circled = true;
            } else {
              // Create a new service round for the final score
              leftServiceRounds.push({
                position: leftCurrentPosition,
                box: currentBoxNum,
                ticked: false,
                points: leftFinalScore,
                rotation8: false,
                circled: true
              });
            }
          }
        } else {
          // Left team won on receive - add final score and circle
          const nextLeftPosition = (leftCurrentPosition + 1) % 6;
          const nextLeftBox = Math.floor((leftServiceRound + 1) / 6) + 1;
          leftServiceRounds.push({
            position: nextLeftPosition,
            box: nextLeftBox,
            ticked: false,
            points: leftFinalScore, // Add final score even though they didn't serve
            rotation8: false,
            circled: true
          });
        }
      } else if (isLastPointRight) {
        // Right team won - circle their last point
        if (currentServeTeam === rightTeamKey && rightServiceStarted) {
          // Right team was serving - find their CURRENT active service round (the one with null points)
          const currentBoxNum = Math.floor(rightServiceRound / 6) + 1;
          let activeServiceRound = rightServiceRounds.find(sr => 
            sr.position === rightCurrentPosition && 
            sr.box === currentBoxNum && 
            sr.points === null
          );
          
          if (activeServiceRound) {
            // Found the active service round - update with final score and circle
            activeServiceRound.points = rightFinalScore;
            activeServiceRound.circled = true;
          } else {
            // No active round found, check the last one
            const lastServiceRound = rightServiceRounds[rightServiceRounds.length - 1];
            if (lastServiceRound && lastServiceRound.points === null) {
              lastServiceRound.points = rightFinalScore;
              lastServiceRound.circled = true;
            } else {
              // Create a new service round for the final score
              rightServiceRounds.push({
                position: rightCurrentPosition,
                box: currentBoxNum,
                ticked: false,
                points: rightFinalScore,
                rotation8: false,
                circled: true
              });
            }
          }
        } else {
          // Right team won on receive - add final score and circle
          const nextRightPosition = (rightCurrentPosition + 1) % 6;
          const nextRightBox = Math.floor((rightServiceRound + 1) / 6) + 1;
          rightServiceRounds.push({
            position: nextRightPosition,
            box: nextRightBox,
            ticked: false,
            points: rightFinalScore, // Add final score even though they didn't serve
            rotation8: false,
            circled: true
          });
        }
      }
      
      // Circle the last point for the losing team as well
      if (isLastPointLeft) {
        // Right team lost - circle their last service round
        if (rightServiceRounds.length > 0) {
          const lastRightServiceRound = rightServiceRounds[rightServiceRounds.length - 1];
          if (lastRightServiceRound.points !== null) {
            lastRightServiceRound.circled = true;
          } else {
            // Right team was still serving - add their final score and circle
            lastRightServiceRound.points = rightFinalScore;
            lastRightServiceRound.circled = true;
          }
        }
      } else if (isLastPointRight) {
        // Left team lost - circle their last service round
        if (leftServiceRounds.length > 0) {
          const lastLeftServiceRound = leftServiceRounds[leftServiceRounds.length - 1];
          if (lastLeftServiceRound.points !== null) {
            lastLeftServiceRound.circled = true;
          } else {
            // Left team was still serving - add their final score and circle
            lastLeftServiceRound.points = leftFinalScore;
            lastLeftServiceRound.circled = true;
          }
        }
      }
    }
    } catch (error) {
      // If service tracking fails, just use empty arrays
      console.error('Error tracking service rounds:', error);
    }
    
    // Determine which team's points go left and right based on team assignments and swapping
    const leftMarkedPoints = !isSwapped 
      ? (teamAKey === 'home' ? homeMarkedPoints : awayMarkedPoints)
      : (teamBKey === 'home' ? homeMarkedPoints : awayMarkedPoints);
    
    const rightMarkedPoints = !isSwapped
      ? (teamBKey === 'home' ? homeMarkedPoints : awayMarkedPoints)
      : (teamAKey === 'home' ? homeMarkedPoints : awayMarkedPoints);
    
    // Process timeouts and substitutions with scores
    // Get all events sorted chronologically
    const allEvents = setEvents
      .filter(e => e.type === 'point' || e.type === 'timeout' || e.type === 'substitution' || e.type === 'lineup')
      .sort((a, b) => {
        const aSeq = a.seq || 0;
        const bSeq = b.seq || 0;
        if (aSeq !== 0 || bSeq !== 0) return aSeq - bSeq;
        return new Date(a.ts).getTime() - new Date(b.ts).getTime();
      });
    
    // Track scores as we process events
    let currentHomeScore = 0;
    let currentAwayScore = 0;
    
    // Track timeouts
    const leftTimeoutsList: string[] = [];
    const rightTimeoutsList: string[] = [];
    
    // Track substitutions by position (I-VI = 0-5)
    // Each position has an array of substitution records
    // Using inline type to match SubRecord from types_scoresheet.ts
    type SubRecordLocal = {
      playerOut: number;
      playerIn: number;
      score: string; // Format "substitutingTeam:otherTeam"
      isCircled: boolean; // True if playerOut should be circled (can't reenter)
    };
    
    // Organize substitutions by player number (playerOut), not by rotation position
    // Map: playerOut number -> array of substitutions for that player
    const leftSubsByPlayer: Map<number, SubRecordLocal[]> = new Map();
    const rightSubsByPlayer: Map<number, SubRecordLocal[]> = new Map();
    
    // Track current lineup to know which position a player is in
    let currentLeftLineup = [...leftLineup];
    let currentRightLineup = [...rightLineup];
    
    // Process all events chronologically
    allEvents.forEach((event) => {
      if (event.type === 'point') {
        const scoringTeam = event.payload?.team as 'home' | 'away';
        if (scoringTeam === 'home') {
          currentHomeScore++;
        } else {
          currentAwayScore++;
        }
      } else if (event.type === 'timeout') {
        const timeoutTeam = event.payload?.team as 'home' | 'away';
        const isLeftTeam = timeoutTeam === leftTeamKey;
        const isRightTeam = timeoutTeam === rightTeamKey;
        
        if (isLeftTeam) {
          // Format: "leftScore:rightScore" (team requesting timeout first)
          const leftScore = leftTeamKey === 'home' ? currentHomeScore : currentAwayScore;
          const rightScore = rightTeamKey === 'home' ? currentHomeScore : currentAwayScore;
          leftTimeoutsList.push(`${leftScore}:${rightScore}`);
        } else if (isRightTeam) {
          // Format: "rightScore:leftScore" (team requesting timeout first)
          const rightScore = rightTeamKey === 'home' ? currentHomeScore : currentAwayScore;
          const leftScore = leftTeamKey === 'home' ? currentHomeScore : currentAwayScore;
          rightTimeoutsList.push(`${rightScore}:${leftScore}`);
        }
      } else if (event.type === 'substitution') {
        const subTeam = event.payload?.team as 'home' | 'away';
        const playerOut = event.payload?.playerOut as number;
        const playerIn = event.payload?.playerIn as number;
        const position = event.payload?.position as string; // 'I', 'II', 'III', 'IV', 'V', 'VI'
        const isExceptional = event.payload?.isExceptional || false;
        
        // Skip exceptional substitutions (handled in remarks)
        if (isExceptional) return;
        
        const positionIndex = ['I', 'II', 'III', 'IV', 'V', 'VI'].indexOf(position);
        if (positionIndex === -1) return;
        
        const isLeftTeam = subTeam === leftTeamKey;
        const isRightTeam = subTeam === rightTeamKey;
        
        // Get scores (substituting team first, then other team)
        const subTeamScore = subTeam === 'home' ? currentHomeScore : currentAwayScore;
        const otherTeamScore = subTeam === 'home' ? currentAwayScore : currentHomeScore;
        const scoreStr = `${subTeamScore}:${otherTeamScore}`;
        
        if (isLeftTeam) {
          // Get or create substitution array for this playerOut (regardless of rotation position)
          if (!leftSubsByPlayer.has(playerOut)) {
            leftSubsByPlayer.set(playerOut, []);
          }
          const subsArray = leftSubsByPlayer.get(playerOut)!;
          
          // Check if this is a return (playerIn matches a previous playerOut)
          const isReturn = subsArray.some(sub => sub.playerOut === playerIn);
          
          if (isReturn) {
            // Find the substitution where this player went out
            const originalSub = subsArray.find(sub => sub.playerOut === playerIn);
            if (originalSub) {
              originalSub.isCircled = true; // Circle the original playerOut
            }
            // Add return substitution (playerIn goes out, playerOut comes back in)
            subsArray.push({
              playerOut: playerIn,
              playerIn: playerOut,
              score: scoreStr,
              isCircled: false
            });
          } else {
            // New substitution
            subsArray.push({
              playerOut,
              playerIn,
              score: scoreStr,
              isCircled: false
            });
          }
          
          // Update current lineup
          currentLeftLineup[positionIndex] = String(playerIn);
        } else if (isRightTeam) {
          // Get or create substitution array for this playerOut (regardless of rotation position)
          if (!rightSubsByPlayer.has(playerOut)) {
            rightSubsByPlayer.set(playerOut, []);
          }
          const subsArray = rightSubsByPlayer.get(playerOut)!;
          
          // Check if this is a return (playerIn matches a previous playerOut)
          const isReturn = subsArray.some(sub => sub.playerOut === playerIn);
          
          if (isReturn) {
            // Find the substitution where this player went out
            const originalSub = subsArray.find(sub => sub.playerOut === playerIn);
            if (originalSub) {
              originalSub.isCircled = true; // Circle the original playerOut
            }
            // Add return substitution (playerIn goes out, playerOut comes back in)
            subsArray.push({
              playerOut: playerIn,
              playerIn: playerOut,
              score: scoreStr,
              isCircled: false
            });
          } else {
            // New substitution
            subsArray.push({
              playerOut,
              playerIn,
              score: scoreStr,
              isCircled: false
            });
          }
          
          // Update current lineup
          currentRightLineup[positionIndex] = String(playerIn);
        }
      } else if (event.type === 'lineup') {
        // Update current lineup when lineup changes
        const lineupTeam = event.payload?.team as 'home' | 'away';
        const lineupObj = event.payload?.lineup || {};
        const positions = ['I', 'II', 'III', 'IV', 'V', 'VI'];
        const lineupArray = positions.map(pos => lineupObj[pos] ? String(lineupObj[pos]) : '');
        
        if (lineupTeam === leftTeamKey) {
          currentLeftLineup = lineupArray;
        } else if (lineupTeam === rightTeamKey) {
          currentRightLineup = lineupArray;
        }
      }
    });
    
    // Format timeouts (max 2 per team)
    const leftTimeouts: [string, string] = [
      leftTimeoutsList[0] || '',
      leftTimeoutsList[1] || ''
    ];
    const rightTimeouts: [string, string] = [
      rightTimeoutsList[0] || '',
      rightTimeoutsList[1] || ''
    ];
    
    // Determine start time
    let startTimeStr = '';
    if (setNumber === 1 && match?.scheduledAt) {
      // Set 1 uses match start time
      startTimeStr = new Date(match.scheduledAt).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });
    } else if (hasBeenPlayed && setInfo?.startTime) {
      // Other sets use their recorded start time
      startTimeStr = new Date(setInfo.startTime).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });
    }
    
    return {
      startTime: startTimeStr,
      endTime: hasBeenPlayed && setInfo?.endTime ? new Date(setInfo.endTime).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' }) : '',
      leftLineup,
      rightLineup,
      leftPoints,
      rightPoints,
      leftMarkedPoints,
      rightMarkedPoints,
      leftServiceRounds,
      rightServiceRounds,
      leftTimeouts,
      rightTimeouts,
      // Convert Map back to position-based array based on initial lineup
      // Find which position in the initial lineup has each player number
      leftSubs: (() => {
        const result: SubRecordLocal[][] = [[], [], [], [], [], []];
        // For each position in the initial lineup, find substitutions for that player
        leftLineup.forEach((playerNum, positionIndex) => {
          const playerNumInt = parseInt(playerNum, 10);
          if (!isNaN(playerNumInt) && leftSubsByPlayer.has(playerNumInt)) {
            result[positionIndex] = leftSubsByPlayer.get(playerNumInt)!;
          }
        });
        return result;
      })(),
      rightSubs: (() => {
        const result: SubRecordLocal[][] = [[], [], [], [], [], []];
        // For each position in the initial lineup, find substitutions for that player
        rightLineup.forEach((playerNum, positionIndex) => {
          const playerNumInt = parseInt(playerNum, 10);
          if (!isNaN(playerNumInt) && rightSubsByPlayer.has(playerNumInt)) {
            result[positionIndex] = rightSubsByPlayer.get(playerNumInt)!;
          }
        });
        return result;
      })()
    };
  };

  // Always get data for all sets (will be empty if not played)
  const set1Data = getSetData(1, false);
  const set2Data = getSetData(2, true);
  const set3Data = getSetData(3, false);
  const set4Data = getSetData(4, true);
  const set5Data = getSetData(5, false);
  const set5Info = sets?.find(s => s.index === 5);
  
  // Get Set 5 marked points (special handling for 3 panels)
  const set5Events = events?.filter(e => e.setIndex === 5) || [];
  const set5PointEvents = set5Events
    .filter(e => e.type === 'point')
    .sort((a, b) => {
      const aSeq = a.seq || 0;
      const bSeq = b.seq || 0;
      if (aSeq !== 0 || bSeq !== 0) return aSeq - bSeq;
      return new Date(a.ts).getTime() - new Date(b.ts).getTime();
    });
  
  const set5MarkedPointsHome: number[] = [];
  const set5MarkedPointsAway: number[] = [];
  let set5HomeScore = 0;
  let set5AwayScore = 0;
  
  set5PointEvents.forEach(event => {
    if (event.payload?.team === 'home') {
      set5HomeScore++;
      set5MarkedPointsHome.push(set5HomeScore);
    } else if (event.payload?.team === 'away') {
      set5AwayScore++;
      set5MarkedPointsAway.push(set5AwayScore);
    }
  });
  
  // Team A marked points split at court change (8 points)
  const set5MarkedPointsTeamA = teamAKey === 'home' ? set5MarkedPointsHome : set5MarkedPointsAway;
  const set5MarkedPointsTeamB = teamBKey === 'home' ? set5MarkedPointsHome : set5MarkedPointsAway;
  
  const markedPointsA_Left = set5MarkedPointsTeamA.filter(p => p <= 8); // Points 1-8 on left
  const markedPointsA_Right = set5MarkedPointsTeamA.filter(p => p > 8).map(p => p - 8); // Points 9+ become 1, 2, 3... on right
  const markedPointsB = set5MarkedPointsTeamB; // Team B doesn't change sides
  
  // Service tracking for Set 5 (similar to standard sets but with court change for Team A)
  interface ServiceRound {
    position: number; // 0-5 for I-VI
    box: number; // 1-6 for Set 5
    ticked: boolean;
    points: number | null;
    rotation8: boolean;
    circled: boolean;
  }
  
  const set5ServiceRoundsA_Left: ServiceRound[] = [];
  const set5ServiceRoundsA_Right: ServiceRound[] = [];
  const set5ServiceRoundsB: ServiceRound[] = [];
  
  // Wrap Set 5 service tracking in try-catch to prevent crashes
  try {
  
  // Determine first serve team for Set 5
  const set5FirstServeTeam = match?.set5FirstServe === 'A' ? teamAKey : teamBKey;
  const set5TeamAKey = teamAKey;
  const set5TeamBKey = teamBKey;
  
  // Track service state
  let set5CurrentServeTeam: 'home' | 'away' = set5FirstServeTeam as 'home' | 'away';
  let set5AServiceRound_Left = 0;
  let set5AServiceRound_Right = 0;
  let set5BServiceRound = 0;
  let set5ACurrentPosition_Left = 0;
  let set5ACurrentPosition_Right = 0;
  let set5BCurrentPosition = 0;
  let set5APointsInService_Left = 0;
  let set5APointsInService_Right = 0;
  let set5BPointsInService = 0;
  let set5AServiceStarted_Left = false;
  let set5AServiceStarted_Right = false;
  let set5BServiceStarted = false;
  let set5ATotalScore = 0; // Track total Team A score to determine left vs right
  
  // Initialize first serve for Set 5 (no tick, just track state)
  if (set5FirstServeTeam === set5TeamAKey) {
    set5AServiceStarted_Left = true;
  } else {
    set5BServiceStarted = true;
  }
  
  // Track team scores for Set 5
  let set5HomeScore = 0;
  let set5AwayScore = 0;
  
  set5PointEvents.forEach((event) => {
    const scoringTeam = event.payload?.team as 'home' | 'away';
    const isTeamA = scoringTeam === set5TeamAKey;
    const isTeamB = scoringTeam === set5TeamBKey;
    
    // Update team scores
    if (scoringTeam === 'home') {
      set5HomeScore++;
    } else if (scoringTeam === 'away') {
      set5AwayScore++;
    }
    
    // Update Team A total score
    if (isTeamA) {
      set5ATotalScore++;
    }
    
    // Determine if Team A is on left (≤8) or right (>8)
    const isTeamALeft = isTeamA && set5ATotalScore <= 8;
    const isTeamARight = isTeamA && set5ATotalScore > 8;
    
    // Check if service was lost
    if (scoringTeam !== set5CurrentServeTeam) {
      // Service was lost - record TEAM SCORE at time of service loss
      if (set5CurrentServeTeam === set5TeamAKey) {
        // Team A lost service - record their TEAM SCORE
        const teamAScoreAtLoss = set5TeamAKey === 'home' ? set5HomeScore : set5AwayScore;
        
        if (set5ATotalScore <= 8 && set5AServiceStarted_Left) {
          // Team A was on left side
          const boxNum = Math.floor(set5AServiceRound_Left / 6) + 1;
          const existingRound = set5ServiceRoundsA_Left.find(sr => sr.position === set5ACurrentPosition_Left && sr.box === boxNum);
          if (existingRound) {
            existingRound.points = teamAScoreAtLoss;
          } else {
            set5ServiceRoundsA_Left.push({
              position: set5ACurrentPosition_Left,
              box: boxNum,
              ticked: false,
              points: teamAScoreAtLoss,
              rotation8: false,
              circled: false
            });
          }
        } else if (set5ATotalScore > 8 && set5AServiceStarted_Right) {
          // Team A was on right side
          const boxNum = Math.floor(set5AServiceRound_Right / 6) + 1;
          const existingRound = set5ServiceRoundsA_Right.find(sr => sr.position === set5ACurrentPosition_Right && sr.box === boxNum);
          if (existingRound) {
            existingRound.points = teamAScoreAtLoss;
          } else {
            set5ServiceRoundsA_Right.push({
              position: set5ACurrentPosition_Right,
              box: boxNum,
              ticked: false,
              points: teamAScoreAtLoss,
              rotation8: false,
              circled: false
            });
          }
        }
        
        // Team B now serves - mark "8" in their column I, box 1 (if first time)
        if (!set5BServiceStarted) {
          set5ServiceRoundsB.push({
            position: 0,
            box: 1,
            ticked: false,
            points: null,
            rotation8: true,
            circled: false
          });
        }
        
        set5BCurrentPosition = (set5BCurrentPosition + 1) % 6;
        set5BServiceRound++;
        
        set5BServiceStarted = true;
        set5BPointsInService = 0;
      } else if (set5CurrentServeTeam === set5TeamBKey && set5BServiceStarted) {
        // Team B lost service - record their TEAM SCORE
        const teamBScoreAtLoss = set5TeamBKey === 'home' ? set5HomeScore : set5AwayScore;
        const boxNum = Math.floor(set5BServiceRound / 6) + 1;
        const existingRound = set5ServiceRoundsB.find(sr => sr.position === set5BCurrentPosition && sr.box === boxNum);
        if (existingRound) {
          existingRound.points = teamBScoreAtLoss;
        } else {
          set5ServiceRoundsB.push({
            position: set5BCurrentPosition,
            box: boxNum,
            ticked: false,
            points: teamBScoreAtLoss,
            rotation8: false,
            circled: false
          });
        }
        
        // Team A now serves - mark "8" in their column I, box 1 (if first time)
        if (set5ATotalScore <= 8) {
          // Team A on left
          if (!set5AServiceStarted_Left) {
            set5ServiceRoundsA_Left.push({
              position: 0,
              box: 1,
              ticked: false,
              points: null,
              rotation8: true,
              circled: false
            });
          }
          set5ACurrentPosition_Left = (set5ACurrentPosition_Left + 1) % 6;
          set5AServiceRound_Left++;
          set5AServiceStarted_Left = true;
          set5APointsInService_Left = 0;
        } else {
          // Team A on right
          if (!set5AServiceStarted_Right) {
            set5ServiceRoundsA_Right.push({
              position: 0,
              box: 1,
              ticked: false,
              points: null,
              rotation8: true,
              circled: false
            });
          }
          set5ACurrentPosition_Right = (set5ACurrentPosition_Right + 1) % 6;
          set5AServiceRound_Right++;
          set5AServiceStarted_Right = true;
          set5APointsInService_Right = 0;
        }
      }
      
      set5CurrentServeTeam = scoringTeam;
    } else {
      // Scoring team had serve - increment service points (for tracking, but we use team score instead)
      if (isTeamALeft && set5CurrentServeTeam === set5TeamAKey) {
        set5APointsInService_Left++;
      } else if (isTeamARight && set5CurrentServeTeam === set5TeamAKey) {
        set5APointsInService_Right++;
      } else if (isTeamB && set5CurrentServeTeam === set5TeamBKey) {
        set5BPointsInService++;
      }
    }
  });
  
  // End of set logic for Set 5: circle last point for both teams
  const isSet5Finished = set5Info?.finished || false;
  if (isSet5Finished && set5PointEvents.length > 0) {
    const lastPoint = set5PointEvents[set5PointEvents.length - 1];
    const lastScoringTeam = lastPoint.payload?.team as 'home' | 'away';
    const isTeamA = lastScoringTeam === set5TeamAKey;
    const isTeamB = lastScoringTeam === set5TeamBKey;
    
    // Get final scores from setInfo (after all points have been scored)
    const teamAFinalScore = set5TeamAKey === 'home' ? (set5Info.homePoints || 0) : (set5Info.awayPoints || 0);
    const teamBFinalScore = set5TeamBKey === 'home' ? (set5Info.homePoints || 0) : (set5Info.awayPoints || 0);
    
    // Circle the last point for the winning team (team that scored the last point)
    if (isTeamA) {
      // Team A won
      const isTeamAOnLeft = set5ATotalScore <= 8;
      
      if (set5CurrentServeTeam === set5TeamAKey) {
        // Team A was serving - find their CURRENT active service round (the one with null points)
        if (isTeamAOnLeft) {
          const currentBoxNum = Math.floor(set5AServiceRound_Left / 6) + 1;
          let activeServiceRound = set5ServiceRoundsA_Left.find(sr => 
            sr.position === set5ACurrentPosition_Left && 
            sr.box === currentBoxNum && 
            sr.points === null
          );
          
          if (activeServiceRound) {
            activeServiceRound.points = teamAFinalScore;
            activeServiceRound.circled = true;
          } else {
            const lastServiceRound = set5ServiceRoundsA_Left[set5ServiceRoundsA_Left.length - 1];
            if (lastServiceRound && lastServiceRound.points === null) {
              lastServiceRound.points = teamAFinalScore;
              lastServiceRound.circled = true;
            } else {
              set5ServiceRoundsA_Left.push({
                position: set5ACurrentPosition_Left,
                box: currentBoxNum,
                ticked: false,
                points: teamAFinalScore,
                rotation8: false,
                circled: true
              });
            }
          }
        } else {
          const currentBoxNum = Math.floor(set5AServiceRound_Right / 6) + 1;
          let activeServiceRound = set5ServiceRoundsA_Right.find(sr => 
            sr.position === set5ACurrentPosition_Right && 
            sr.box === currentBoxNum && 
            sr.points === null
          );
          
          if (activeServiceRound) {
            activeServiceRound.points = teamAFinalScore;
            activeServiceRound.circled = true;
          } else {
            const lastServiceRound = set5ServiceRoundsA_Right[set5ServiceRoundsA_Right.length - 1];
            if (lastServiceRound && lastServiceRound.points === null) {
              lastServiceRound.points = teamAFinalScore;
              lastServiceRound.circled = true;
            } else {
              set5ServiceRoundsA_Right.push({
                position: set5ACurrentPosition_Right,
                box: currentBoxNum,
                ticked: false,
                points: teamAFinalScore,
                rotation8: false,
                circled: true
              });
            }
          }
        }
      } else {
        // Team A won on receive - add final score and circle
        if (isTeamAOnLeft) {
          const nextLeftPosition = (set5ACurrentPosition_Left + 1) % 6;
          const nextLeftBox = Math.floor((set5AServiceRound_Left + 1) / 6) + 1;
          set5ServiceRoundsA_Left.push({
            position: nextLeftPosition,
            box: nextLeftBox,
            ticked: false,
            points: teamAFinalScore,
            rotation8: false,
            circled: true
          });
        } else {
          const nextRightPosition = (set5ACurrentPosition_Right + 1) % 6;
          const nextRightBox = Math.floor((set5AServiceRound_Right + 1) / 6) + 1;
          set5ServiceRoundsA_Right.push({
            position: nextRightPosition,
            box: nextRightBox,
            ticked: false,
            points: teamAFinalScore,
            rotation8: false,
            circled: true
          });
        }
      }
      
      // Circle Team B's last point (losing team)
      if (set5ServiceRoundsB.length > 0) {
        const lastBServiceRound = set5ServiceRoundsB[set5ServiceRoundsB.length - 1];
        if (lastBServiceRound.points !== null) {
          lastBServiceRound.circled = true;
        } else {
          lastBServiceRound.points = teamBFinalScore;
          lastBServiceRound.circled = true;
        }
      }
    } else if (isTeamB) {
      // Team B won
      if (set5CurrentServeTeam === set5TeamBKey) {
        // Team B was serving - find their CURRENT active service round (the one with null points)
        const currentBoxNum = Math.floor(set5BServiceRound / 6) + 1;
        let activeServiceRound = set5ServiceRoundsB.find(sr => 
          sr.position === set5BCurrentPosition && 
          sr.box === currentBoxNum && 
          sr.points === null
        );
        
        if (activeServiceRound) {
          activeServiceRound.points = teamBFinalScore;
          activeServiceRound.circled = true;
        } else {
          const lastServiceRound = set5ServiceRoundsB[set5ServiceRoundsB.length - 1];
          if (lastServiceRound && lastServiceRound.points === null) {
            lastServiceRound.points = teamBFinalScore;
            lastServiceRound.circled = true;
          } else {
            set5ServiceRoundsB.push({
              position: set5BCurrentPosition,
              box: currentBoxNum,
              ticked: false,
              points: teamBFinalScore,
              rotation8: false,
              circled: true
            });
          }
        }
      } else {
        // Team B won on receive - add final score and circle
        const nextBPosition = (set5BCurrentPosition + 1) % 6;
        const nextBBox = Math.floor((set5BServiceRound + 1) / 6) + 1;
        set5ServiceRoundsB.push({
          position: nextBPosition,
          box: nextBBox,
          ticked: false,
          points: teamBFinalScore,
          rotation8: false,
          circled: true
        });
      }
      
      // Circle Team A's last point (losing team)
      const isTeamAOnLeft = set5ATotalScore <= 8;
      if (isTeamAOnLeft && set5ServiceRoundsA_Left.length > 0) {
        const lastAServiceRound = set5ServiceRoundsA_Left[set5ServiceRoundsA_Left.length - 1];
        if (lastAServiceRound.points !== null) {
          lastAServiceRound.circled = true;
        } else {
          lastAServiceRound.points = teamAFinalScore;
          lastAServiceRound.circled = true;
        }
      } else if (!isTeamAOnLeft && set5ServiceRoundsA_Right.length > 0) {
        const lastAServiceRound = set5ServiceRoundsA_Right[set5ServiceRoundsA_Right.length - 1];
        if (lastAServiceRound.points !== null) {
          lastAServiceRound.circled = true;
        } else {
          lastAServiceRound.points = teamAFinalScore;
          lastAServiceRound.circled = true;
        }
      }
    }
  }
  } catch (error) {
    // If Set 5 service tracking fails, just use empty arrays
    console.error('Error tracking Set 5 service rounds:', error);
  }

  // Ruler measurements
  const containerRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const set1Ref = useRef<HTMLDivElement>(null);
  const set2Ref = useRef<HTMLDivElement>(null);
  const set3Ref = useRef<HTMLDivElement>(null);
  const set4Ref = useRef<HTMLDivElement>(null);
  const set5Ref = useRef<HTMLDivElement>(null);
  const sanctionsRef = useRef<HTMLDivElement>(null);
  const remarksRef = useRef<HTMLDivElement>(null);
  const approvalsRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const rosterARef = useRef<HTMLDivElement>(null);
  const rosterBRef = useRef<HTMLDivElement>(null);
  const positionBoxSet1Ref = useRef<HTMLDivElement>(null);
  const positionBoxSet5Ref = useRef<HTMLDivElement>(null);
  



  return (
    <>
      {/* Web Only Controls - Outside print area */}
      <div className="mb-2 flex justify-center items-center print:hidden w-full">
          <div className="space-x-2">
              <button 
                  onClick={() => window.print()} 
                  className="bg-blue-500 hover:bg-blue-700 text-white px-3 py-1 rounded text-sm shadow"
              >
                  Print PDF
              </button>
              <button 
                  onClick={() => window.close()} 
                  className="bg-gray-200 hover:bg-gray-300 text-gray-800 px-3 py-1 rounded text-sm shadow"
              >
                  Close
              </button>
          </div>
      </div>

      <div className="min-h-screen bg-gray-100 p-2 flex justify-center print:p-0 print:bg-white print:h-[297mm] print:w-[420mm] print:flex print:items-center print:justify-center print:overflow-hidden">
        <div 
          ref={containerRef}
          className="w-[410mm] h-[287mm] bg-white shadow-xl print:shadow-none p-3 print:p-0 print:overflow-hidden print:m-auto print:w-[410mm] print:h-[287mm] print:box-border relative print:page-break-inside-avoid" 
          style={{ boxSizing: 'border-box' }}
        >
        <div className="h-full print:overflow-hidden" style={{ padding: '5mm 5mm 5mm 5mm' }}>
            <div ref={headerRef}>
              <Header 
                match={match}
                homeTeam={homeTeam}
                awayTeam={awayTeam}
                teamAName={teamAName}
                teamBName={teamBName}
              />
            </div>
            
            {/* Row 1: Sets 1 and 2 - Full Width 50/50 */}
            <div className="flex">
                  <div
                    className="bg-white shrink-0"
                    style={{ width: '50mm', height: '5.3cm', borderRightWidth: 0 }}
                  ></div>
                <div className="flex flex-1 gap-1">
                    <div ref={set1Ref} className="flex flex-1">
                        <div className="flex flex-col items-center justify-center min-w-[30px] border-l border-t border-b border-black p-1 bg-gray-300">
                            <div className="flex flex-col items-center font-black text-sm uppercase tracking-widest leading-tight">
                                <span>S</span>
                                <span>E</span>
                                <span>T</span>
                            </div>
                            <div className="font-black text-sm mt-1">1</div>
                        </div>
                        <div className="flex-1">
                            <StandardSet 
                                setNumber={1} 
                                teamNameLeft={teamAShortName}
                                teamNameRight={teamBShortName}
                                firstServeTeamA={match?.coinTossServeA}
                                positionBoxRef={positionBoxSet1Ref}
                                {...set1Data}
                            />
                        </div>
                    </div>
                    <div ref={set2Ref} className="flex flex-1">
                        <div className="flex flex-col items-center justify-center min-w-[30px] border-l border-t border-b border-black p-1 bg-gray-300">
                            <div className="flex flex-col items-center font-black text-sm uppercase tracking-widest leading-tight">
                                <span>S</span>
                                <span>E</span>
                                <span>T</span>
                            </div>
                            <div className="font-black text-sm mt-1">2</div>
                        </div>
                        <div className="flex-1">
                            <StandardSet 
                                setNumber={2} 
                                isSwapped={true} 
                                teamNameLeft={teamBShortName}
                                teamNameRight={teamAShortName}
                                firstServeTeamA={!match?.coinTossServeA}
                                {...set2Data}
                            />
                        </div>
                    </div>
                </div>
            </div>

            {/* Row 2: Sets 3 and 4 - Full Width 50/50 */}
            <div className="flex mt-1">
                      <div
                        className=" bg-white shrink-0"
                        style={{ width: '50mm', height: '5.3cm', borderRightWidth: 0 }}
                      ></div>
                <div className="flex gap-1 flex-1">
                    <div ref={set3Ref} className="flex flex-1">
                        <div className="flex flex-col items-center justify-center min-w-[30px] border-l border-t border-b border-black p-1 bg-gray-300">
                            <div className="flex flex-col items-center font-black text-sm uppercase tracking-widest leading-tight">
                                <span>S</span>
                                <span>E</span>
                                <span>T</span>
                            </div>
                            <div className="font-black text-sm mt-1">3</div>
                        </div>
                        <div className="flex-1">
                            <StandardSet 
                                setNumber={3} 
                                teamNameLeft={teamAShortName}
                                teamNameRight={teamBShortName}
                                firstServeTeamA={match?.coinTossServeA}
                                {...set3Data}
                            />
                        </div>
                    </div>
                    <div ref={set4Ref} className="flex flex-1">
                        <div className="flex flex-col items-center justify-center min-w-[30px] border-l border-t border-b border-black p-1 bg-gray-300">
                            <div className="flex flex-col items-center font-black text-sm uppercase tracking-widest leading-tight">
                                <span>S</span>
                                <span>E</span>
                                <span>T</span>
                            </div>
                            <div className="font-black text-sm mt-1">4</div>
                        </div>
                        <div className="flex-1">
                            <StandardSet 
                                setNumber={4} 
                                isSwapped={true} 
                                teamNameLeft={teamBShortName}
                                teamNameRight={teamAShortName}
                                firstServeTeamA={!match?.coinTossServeA}
                                {...set4Data}
                            />
                        </div>
                    </div>
                </div>
            </div>

            {/* Rows 3-4: Set 5 + Footer sections on left, Rosters spanning on right */}
            <div className="flex gap-1 mt-1 items-stretch print:flex-1 print:min-h-0">
                {/* Left side: Set 5 + Footer sections stacked */}
                <div className="flex flex-col gap-2 min-h-0" style={{ width: '295mm' }}>
                    {/* Set 5 */}
                    <div ref={set5Ref} className="flex">
                        <div
                          className=" bg-white shrink-0 mr-1"
                          style={{ width: '49mm', height: '4.8cm', borderRightWidth: 0 }}
                        ></div>
                        <div className="flex flex-col items-center justify-center min-w-[30px] border-l border-t border-b border-black p-1 bg-gray-300">
                            <div className="flex flex-col items-center font-black text-sm uppercase tracking-widest leading-tight">
                                <span>S</span>
                                <span>E</span>
                                <span>T</span>
                            </div>
                            <div className="font-black text-sm mt-1">5</div>
                        </div>
                        <div className="flex-1">
                            <SetFive 
                                teamNameA=""
                                teamNameB=""
                                startTime={set5Data.startTime}
                                endTime={set5Data.endTime}
                                lineupA={set5Data.leftLineup}
                                subsA={set5Data.leftSubs}
                                lineupB={set5Data.rightLineup}
                                subsB={set5Data.rightSubs}
                                pointsA_Left={Math.min((set5Info && (set5Info.homePoints > 0 || set5Info.awayPoints > 0 || set5Info.startTime)) ? (teamAKey === 'home' ? (set5Info.homePoints || 0) : (set5Info.awayPoints || 0)) : 0, 8)}
                                markedPointsA_Left={markedPointsA_Left}
                                serviceRoundsA_Left={set5ServiceRoundsA_Left}
                                pointsB={(set5Info && (set5Info.homePoints > 0 || set5Info.awayPoints > 0 || set5Info.startTime)) ? (teamBKey === 'home' ? (set5Info.homePoints || 0) : (set5Info.awayPoints || 0)) : 0}
                                markedPointsB={markedPointsB}
                                serviceRoundsB={set5ServiceRoundsB}
                                pointsA_Right={Math.max((set5Info && (set5Info.homePoints > 0 || set5Info.awayPoints > 0 || set5Info.startTime)) ? (teamAKey === 'home' ? (set5Info.homePoints || 0) : (set5Info.awayPoints || 0)) : 0 - 8, 0)}
                                markedPointsA_Right={markedPointsA_Right}
                                serviceRoundsA_Right={set5ServiceRoundsA_Right}
                                pointsAtChange=""
                                positionBoxRef={positionBoxSet5Ref}
                            />
                        </div>
                    </div>
                    
                    {/* Footer sections row - flex for horizontal control */}
                    <div ref={footerRef} className="flex gap-0.5 shrink-0" style={{ height: '8.4cm' }}>
                        {/* Sanctions - narrower width */}
                        <div ref={sanctionsRef} className="flex-col shrink-0" style={{ height: '8.4cm', width: '50mm' }}>
                            <Sanctions items={sanctions} />
                        </div>
                        
                        {/* Remarks and Approvals stacked - takes remaining space */}
                        <div className="flex-1 flex flex-col gap-2 min-h-0">
                            {/* Remarks - 30% height */}
                            <div ref={remarksRef} className="flex-[3] min-h-0">
                                <Remarks />
                            </div>
                            {/* Approvals - 70% height */}
                            <div ref={approvalsRef} className="flex-[5] min-h-0">
                                <Approvals officials={match?.officials} />
                            </div>
                        </div>
                        
                        {/* Results - adjust flex-[x] to change width proportion */}
                        <div ref={resultsRef} className="flex-[0.67] flex flex-col shrink-0" style={{ height: '8.4cm' }}>
                            <Results teamAShortName={teamAShortName} teamBShortName={teamBShortName} />
                        </div>
                    </div>
                </div>
                
                {/* Right side: Rosters spanning full height */}
                <div className="flex gap-0.5 shrink-0" style={{ width: '110mm', height: '13.5cm', maxWidth: '110mm' }}>
                    <div ref={rosterARef} className="flex-1 min-w-0">
                        <Roster 
                          team={teamAShortName} 
                          side="A" 
                          players={teamAPlayers}
                          benchStaff={teamAKey === 'home' ? match?.bench_home : match?.bench_away}
                        />
                    </div>
                    <div ref={rosterBRef} className="flex-1 min-w-0">
                        <Roster 
                          team={teamBShortName} 
                          side="B" 
                          players={teamBPlayers}
                          benchStaff={teamBKey === 'home' ? match?.bench_home : match?.bench_away}
                        />
                    </div>
                </div>
            </div>

        </div>
      </div>
    </div>
    </>
  );
};

export default App;
