import React, { useRef, useEffect, useState } from 'react';
import jsPDF from 'jspdf';
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
    const homeCircledPoints: number[] = []; // Points scored due to sanctions
    const awayCircledPoints: number[] = []; // Points scored due to sanctions
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
    
    // Identify points scored due to sanctions
    // Get all events (including sanctions) sorted chronologically
    const allEventsWithSanctions = setEvents
      .filter(e => e.type === 'point' || e.type === 'sanction')
      .sort((a, b) => {
        const aSeq = a.seq || 0;
        const bSeq = b.seq || 0;
        if (aSeq !== 0 || bSeq !== 0) return aSeq - bSeq;
        return new Date(a.ts).getTime() - new Date(b.ts).getTime();
      });
    
    // Track which points should be circled due to sanctions
    // For each sanction that awards a point (penalty, expulsion, disqualification, delay_penalty),
    // find the next point scored by the opponent and mark it for circling
    let homePointCount = 0;
    let awayPointCount = 0;
    
    for (let i = 0; i < allEventsWithSanctions.length; i++) {
      const event = allEventsWithSanctions[i];
      
      if (event.type === 'point') {
        // Track point counts
        if (event.payload?.team === 'home') {
          homePointCount++;
        } else if (event.payload?.team === 'away') {
          awayPointCount++;
        }
      } else if (event.type === 'sanction') {
        const payload = event.payload || {};
        const sanctionType = payload.type;
        const sanctionedTeam = payload.team; // 'home' or 'away'
        const opponentTeam = sanctionedTeam === 'home' ? 'away' : 'home';
        
        // Check if this sanction awards a point to the opponent
        const awardsPoint = ['penalty', 'expulsion', 'disqualification', 'delay_penalty'].includes(sanctionType);
        
        if (awardsPoint) {
          // Find the next point event scored by the opponent after this sanction
          for (let j = i + 1; j < allEventsWithSanctions.length; j++) {
            const nextEvent = allEventsWithSanctions[j];
            if (nextEvent.type === 'point' && nextEvent.payload?.team === opponentTeam) {
              // This point was scored due to the sanction - mark it for circling
              if (opponentTeam === 'home') {
                homePointCount++;
                if (!homeCircledPoints.includes(homePointCount)) {
                  homeCircledPoints.push(homePointCount);
                }
              } else {
                awayPointCount++;
                if (!awayCircledPoints.includes(awayPointCount)) {
                  awayCircledPoints.push(awayPointCount);
                }
              }
              break; // Only circle the first point after the sanction
            }
          }
        }
      }
    }
    
    // Determine which team's points go left and right based on team assignments and swapping
    const leftMarkedPoints = !isSwapped 
      ? (teamAKey === 'home' ? homeMarkedPoints : awayMarkedPoints)
      : (teamBKey === 'home' ? homeMarkedPoints : awayMarkedPoints);
    
    const rightMarkedPoints = !isSwapped
      ? (teamBKey === 'home' ? homeMarkedPoints : awayMarkedPoints)
      : (teamAKey === 'home' ? homeMarkedPoints : awayMarkedPoints);
    
    // Determine which team's circled points go left and right
    const leftCircledPoints = !isSwapped 
      ? (teamAKey === 'home' ? homeCircledPoints : awayCircledPoints)
      : (teamBKey === 'home' ? homeCircledPoints : awayCircledPoints);
    
    const rightCircledPoints = !isSwapped
      ? (teamBKey === 'home' ? homeCircledPoints : awayCircledPoints)
      : (teamAKey === 'home' ? homeCircledPoints : awayCircledPoints);
    
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
    
    // For Set 5, track when court change happens (when any team reaches 8 points)
    const isSet5 = setNumber === 5;
    let courtChangeHappened = false;
    
    // Track timeouts
    // For Set 5, split left team timeouts into before/after court change
    const leftTimeoutsList: string[] = [];
    const leftTimeoutsList_Before: string[] = [];
    const leftTimeoutsList_After: string[] = [];
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
    // For Set 5, split left team substitutions into before/after court change
    const leftSubsByPlayer: Map<number, SubRecordLocal[]> = new Map();
    const leftSubsByPlayer_Before: Map<number, SubRecordLocal[]> = new Map();
    const leftSubsByPlayer_After: Map<number, SubRecordLocal[]> = new Map();
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
        
        // Check if court change has happened (Set 5: when any team reaches 8 points)
        if (isSet5 && !courtChangeHappened && (currentHomeScore >= 8 || currentAwayScore >= 8)) {
          courtChangeHappened = true;
        }
      } else if (event.type === 'timeout') {
        const timeoutTeam = event.payload?.team as 'home' | 'away';
        const isLeftTeam = timeoutTeam === leftTeamKey;
        const isRightTeam = timeoutTeam === rightTeamKey;
        
        if (isLeftTeam) {
          // Format: "leftScore:rightScore" (team requesting timeout first)
          const leftScore = leftTeamKey === 'home' ? currentHomeScore : currentAwayScore;
          const rightScore = rightTeamKey === 'home' ? currentHomeScore : currentAwayScore;
          const timeoutStr = `${leftScore}:${rightScore}`;
          
          if (isSet5) {
            // For Set 5, split by court change
            // Panel 1: timeouts when left team has < 8 points
            // Panel 3: timeouts when left team has >= 8 points OR when court change has happened
            // If timeout happens when left < 8 but court change already happened, it goes to both panels
            if (leftScore < 8) {
              leftTimeoutsList_Before.push(timeoutStr);
            }
            if (leftScore >= 8 || courtChangeHappened) {
              leftTimeoutsList_After.push(timeoutStr);
            }
          } else {
            leftTimeoutsList.push(timeoutStr);
          }
        } else if (isRightTeam) {
          // Format: "rightScore:leftScore" (team requesting timeout first)
          const rightScore = rightTeamKey === 'home' ? currentHomeScore : currentAwayScore;
          const leftScore = leftTeamKey === 'home' ? currentHomeScore : currentAwayScore;
          rightTimeoutsList.push(`${rightScore}:${leftScore}`);
        }
      } else if (event.type === 'substitution') {
        const subTeam = event.payload?.team as 'home' | 'away';
        // Ensure playerOut and playerIn are numbers
        const playerOut = Number(event.payload?.playerOut);
        const playerIn = Number(event.payload?.playerIn);
        const position = event.payload?.position as string; // 'I', 'II', 'III', 'IV', 'V', 'VI'
        const isExceptional = event.payload?.isExceptional || false;
        
        // Skip exceptional substitutions (handled in remarks)
        if (isExceptional) return;
        
        // Skip if playerOut or playerIn is invalid
        if (isNaN(playerOut) || isNaN(playerIn)) return;
        
        const positionIndex = ['I', 'II', 'III', 'IV', 'V', 'VI'].indexOf(position);
        if (positionIndex === -1) return;
        
        const isLeftTeam = subTeam === leftTeamKey;
        const isRightTeam = subTeam === rightTeamKey;
        
        // Get scores (substituting team first, then other team)
        const subTeamScore = subTeam === 'home' ? currentHomeScore : currentAwayScore;
        const otherTeamScore = subTeam === 'home' ? currentAwayScore : currentHomeScore;
        const scoreStr = `${subTeamScore}:${otherTeamScore}`;
        
        if (isLeftTeam) {
          // Ensure playerOut and playerIn are numbers
          const playerOutNum = Number(playerOut);
          const playerInNum = Number(playerIn);
          
          // Get scores at time of substitution
          const leftScore = leftTeamKey === 'home' ? currentHomeScore : currentAwayScore;
          const rightScore = rightTeamKey === 'home' ? currentHomeScore : currentAwayScore;
          
          // For Set 5, determine which Map to use based on court change
          // Substitution goes to Panel 3 (After) if leftScore >= 8 OR court change has happened (any team >= 8)
          // Otherwise goes to Panel 1 (Before)
          // Note: If leftScore < 8 but court change happened (rightScore >= 8), it should still go to After
          const targetMap = isSet5 
            ? ((leftScore >= 8 || courtChangeHappened) ? leftSubsByPlayer_After : leftSubsByPlayer_Before)
            : leftSubsByPlayer;
          
          // Check if this is a return substitution (playerIn was previously substituted out)
          // We need to find which original playerOut this return belongs to
          // For Set 5, search both before and after Maps
          let isReturn = false;
          let originalPlayerOut: number | null = null;
          let returnSubsArray: SubRecordLocal[] | null = null;
          
          // Search through substitution arrays to find where playerIn was the original playerOut
          const mapsToSearch = isSet5 
            ? [leftSubsByPlayer_Before, leftSubsByPlayer_After]
            : [leftSubsByPlayer];
          
          for (const mapToSearch of mapsToSearch) {
            for (const [originalPlayerOutKey, subsArray] of mapToSearch.entries()) {
              // Check if playerIn matches the original playerOut (the key of this array)
              if (originalPlayerOutKey === playerInNum) {
                // This is a return - the player coming back in was the original playerOut
                isReturn = true;
                originalPlayerOut = originalPlayerOutKey;
                returnSubsArray = subsArray;
                break;
              }
            }
            if (isReturn) break;
          }
          
          if (isReturn && returnSubsArray && originalPlayerOut !== null) {
            // This is a return substitution - add it to the original player's substitution array
            // Find the original substitution where this player went out
            const originalSub = returnSubsArray.find(sub => sub.playerOut === originalPlayerOut && sub.playerIn === playerOutNum);
            if (originalSub) {
              // Circle the playerIn (the substitute who came in), not the playerOut
              originalSub.isCircled = true; // Circle the playerIn who can't re-enter
            }
            // Add return substitution (playerIn goes out, originalPlayerOut comes back in)
            returnSubsArray.push({
              playerOut: playerOutNum, // The player currently going out
              playerIn: originalPlayerOut, // The original player coming back in
              score: scoreStr,
              isCircled: false
            });
          } else {
            // New substitution - playerOut is going out, playerIn is coming in
            if (!targetMap.has(playerOutNum)) {
              targetMap.set(playerOutNum, []);
            }
            const subsArray = targetMap.get(playerOutNum)!;
            subsArray.push({
              playerOut: playerOutNum,
              playerIn: playerInNum,
              score: scoreStr,
              isCircled: false
            });
          }
          
          // Update current lineup
          currentLeftLineup[positionIndex] = String(playerIn);
        } else if (isRightTeam) {
          // Ensure playerOut and playerIn are numbers
          const playerOutNum = Number(playerOut);
          const playerInNum = Number(playerIn);
          
          // Check if this is a return substitution (playerIn was previously substituted out)
          // We need to find which original playerOut this return belongs to
          let isReturn = false;
          let originalPlayerOut: number | null = null;
          let returnSubsArray: SubRecordLocal[] | null = null;
          
          // Search through all substitution arrays to find where playerIn was the original playerOut
          for (const [originalPlayerOutKey, subsArray] of rightSubsByPlayer.entries()) {
            // Check if playerIn matches the original playerOut (the key of this array)
            if (originalPlayerOutKey === playerInNum) {
              // This is a return - the player coming back in was the original playerOut
              isReturn = true;
              originalPlayerOut = originalPlayerOutKey;
              returnSubsArray = subsArray;
              break;
            }
          }
          
          if (isReturn && returnSubsArray && originalPlayerOut !== null) {
            // This is a return substitution - add it to the original player's substitution array
            // Find the original substitution where this player went out
            const originalSub = returnSubsArray.find(sub => sub.playerOut === originalPlayerOut && sub.playerIn === playerOutNum);
            if (originalSub) {
              // Circle the playerIn (the substitute who came in), not the playerOut
              originalSub.isCircled = true; // Circle the playerIn who can't re-enter
            }
            // Add return substitution (playerIn goes out, originalPlayerOut comes back in)
            returnSubsArray.push({
              playerOut: playerOutNum, // The player currently going out
              playerIn: originalPlayerOut, // The original player coming back in
              score: scoreStr,
              isCircled: false
            });
          } else {
            // New substitution - playerOut is going out, playerIn is coming in
            if (!rightSubsByPlayer.has(playerOutNum)) {
              rightSubsByPlayer.set(playerOutNum, []);
            }
            const subsArray = rightSubsByPlayer.get(playerOutNum)!;
            subsArray.push({
              playerOut: playerOutNum,
              playerIn: playerInNum,
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
    // For Set 5, split into before/after court change
    const leftTimeouts: [string, string] = isSet5
      ? [
          leftTimeoutsList_Before[0] || '',
          leftTimeoutsList_Before[1] || ''
        ]
      : [
          leftTimeoutsList[0] || '',
          leftTimeoutsList[1] || ''
        ];
    const leftTimeouts_After: [string, string] = isSet5
      ? [
          leftTimeoutsList_After[0] || '',
          leftTimeoutsList_After[1] || ''
        ]
      : ['', ''];
    const rightTimeouts: [string, string] = [
      rightTimeoutsList[0] || '',
      rightTimeoutsList[1] || ''
    ];
    
    // Helper function to convert Map to position-based array
    const convertSubsMapToArray = (subsMap: Map<number, SubRecordLocal[]>, lineup: string[]): SubRecordLocal[][] => {
      const result: SubRecordLocal[][] = [[], [], [], [], [], []];
      // For each position in the initial lineup, find substitutions for that player
      lineup.forEach((playerNum, positionIndex) => {
        if (playerNum && playerNum.trim() !== '') {
          const playerNumInt = parseInt(playerNum, 10);
          if (!isNaN(playerNumInt) && subsMap.has(playerNumInt)) {
            result[positionIndex] = subsMap.get(playerNumInt)!;
          }
        }
      });
      return result;
    };
    
    // Convert Map back to position-based array based on initial lineup
    // For Set 5, split into before/after court change
    const leftSubs: SubRecordLocal[][] = isSet5
      ? convertSubsMapToArray(leftSubsByPlayer_Before, leftLineup)
      : convertSubsMapToArray(leftSubsByPlayer, leftLineup);
    // For Set 5 Panel 3, merge substitutions from Panel 1 (before) with substitutions after change
    const leftSubs_After: SubRecordLocal[][] = isSet5
      ? (() => {
          const beforeSubs = convertSubsMapToArray(leftSubsByPlayer_Before, leftLineup);
          const afterSubs = convertSubsMapToArray(leftSubsByPlayer_After, leftLineup);
          // Merge: for each position, combine before and after substitutions
          return beforeSubs.map((beforeSubsForPosition, positionIndex) => {
            return [...beforeSubsForPosition, ...afterSubs[positionIndex]];
          });
        })()
      : [[], [], [], [], [], []];
    const rightSubs: SubRecordLocal[][] = convertSubsMapToArray(rightSubsByPlayer, rightLineup);
    
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
      leftCircledPoints,
      rightCircledPoints,
      leftServiceRounds,
      rightServiceRounds,
      leftTimeouts,
      leftTimeouts_After: isSet5 ? leftTimeouts_After : undefined,
      rightTimeouts,
      leftSubs,
      leftSubs_After: isSet5 ? leftSubs_After : undefined,
      rightSubs
    };
  };

  // Always get data for all sets (will be empty if not played)
  const set1Data = getSetData(1, false);
  const set2Data = getSetData(2, true);
  const set3Data = getSetData(3, false);
  const set4Data = getSetData(4, true);
  
  // Calculate set wins to determine if Set 4 should be displayed
  // Set 4 should only be filled if both teams have won at least one set
  // (This calculation is also used later for match results, so we calculate it once here)
  const finishedSetsForSet4Check = sets?.filter(s => s.finished) || [];
  const teamASetsWonForSet4Check = finishedSetsForSet4Check.filter(s => {
    const teamAPoints = teamAKey === 'home' ? (s.homePoints || 0) : (s.awayPoints || 0);
    const teamBPoints = teamBKey === 'home' ? (s.homePoints || 0) : (s.awayPoints || 0);
    return teamAPoints > teamBPoints;
  }).length;
  const teamBSetsWonForSet4Check = finishedSetsForSet4Check.filter(s => {
    const teamAPoints = teamAKey === 'home' ? (s.homePoints || 0) : (s.awayPoints || 0);
    const teamBPoints = teamBKey === 'home' ? (s.homePoints || 0) : (s.awayPoints || 0);
    return teamBPoints > teamAPoints;
  }).length;
  
  // Set 4 should only be displayed if both teams have won at least one set
  const shouldShowSet4 = teamASetsWonForSet4Check >= 1 && teamBSetsWonForSet4Check >= 1;
  
  // For set 5, determine which team is on left based on set5LeftTeam
  // If set5LeftTeam is 'B', then Team B is on left, otherwise Team A is on left
  // Set 5 should only be displayed if the set 5 coin toss has been done
  const hasSet5CoinToss = !!(match?.set5LeftTeam || match?.set5FirstServe);
  const set5LeftTeamIsB = match?.set5LeftTeam === 'B';
  // getSetData uses isSwapped: true means Team B on left, false means Team A on left
  const set5Data = hasSet5CoinToss ? getSetData(5, set5LeftTeamIsB) : null;
  const set5Info = sets?.find(s => s.index === 5);
  
  // Determine which team actually changes sides (the one on the left)
  const set5TeamOnLeft = set5LeftTeamIsB ? teamBKey : teamAKey;
  const set5TeamOnRight = set5LeftTeamIsB ? teamAKey : teamBKey;
  
  // Calculate set results for Results section
  const calculateSetResults = () => {
    const results = [];
    for (let setNum = 1; setNum <= 5; setNum++) {
      const setInfo = sets?.find(s => s.index === setNum);
      const setEvents = events?.filter(e => e.setIndex === setNum) || [];
      
      // Check if set is finished
      const isSetFinished = setInfo?.finished === true;
      
      // Determine which team is A and which is B for this set
      const isSwapped = setNum === 2 || setNum === 4;
      const teamAKey = match?.coinTossTeamA || 'home';
      const teamBKey = teamAKey === 'home' ? 'away' : 'home';
      
      // Get points for each team (only if set is finished)
      // Points are always stored by home/away, not by left/right
      // Team A and Team B are identified by coinTossTeamA, which doesn't change
      // So we can always get points correctly regardless of side swaps
      const teamAPoints = isSetFinished
        ? (teamAKey === 'home' ? (setInfo?.homePoints || 0) : (setInfo?.awayPoints || 0))
        : null;
      const teamBPoints = isSetFinished
        ? (teamBKey === 'home' ? (setInfo?.homePoints || 0) : (setInfo?.awayPoints || 0))
        : null;
      
      // Count timeouts (only if set is finished)
      const teamATimeouts = isSetFinished
        ? setEvents.filter(e => 
            e.type === 'timeout' && e.payload?.team === teamAKey
          ).length
        : null;
      const teamBTimeouts = isSetFinished
        ? setEvents.filter(e => 
            e.type === 'timeout' && e.payload?.team === teamBKey
          ).length
        : null;
      
      // Count substitutions (only if set is finished)
      const teamASubstitutions = isSetFinished
        ? setEvents.filter(e => 
            e.type === 'substitution' && e.payload?.team === teamAKey
          ).length
        : null;
      const teamBSubstitutions = isSetFinished
        ? setEvents.filter(e => 
            e.type === 'substitution' && e.payload?.team === teamBKey
          ).length
        : null;
      
      // Determine winner (1 if won, 0 otherwise, only if set is finished)
      const teamAWon = isSetFinished && teamAPoints !== null && teamBPoints !== null
        ? (teamAPoints > teamBPoints ? 1 : 0)
        : null;
      const teamBWon = isSetFinished && teamAPoints !== null && teamBPoints !== null
        ? (teamBPoints > teamAPoints ? 1 : 0)
        : null;
      
      // Calculate duration (in minutes with single quote, only if set is finished)
      // Use official starting time (match.scheduledAt) for set 1, set's own startTime for others
      let duration = '';
      if (isSetFinished && setInfo?.endTime) {
        let start: Date;
        if (setNum === 1 && match?.scheduledAt) {
          // Set 1 uses official match start time
          start = new Date(match.scheduledAt);
        } else if (setInfo?.startTime) {
          // Other sets use their recorded start time
          start = new Date(setInfo.startTime);
        } else {
          start = new Date(); // Fallback (shouldn't happen)
        }
        const end = new Date(setInfo.endTime);
        const durationMs = end.getTime() - start.getTime();
        const minutes = Math.floor(durationMs / 60000);
        duration = minutes > 0 ? `${minutes}'` : '';
      }
      
      results.push({
        setNumber: setNum,
        teamATimeouts: teamATimeouts,
        teamASubstitutions: teamASubstitutions,
        teamAWon: teamAWon,
        teamAPoints: teamAPoints,
        teamBTimeouts: teamBTimeouts,
        teamBSubstitutions: teamBSubstitutions,
        teamBWon: teamBWon,
        teamBPoints: teamBPoints,
        duration: duration,
        endTime: isSetFinished && setInfo?.endTime ? setInfo.endTime : undefined
      });
    }
    return results;
  };
  
  const setResults = calculateSetResults();
  
  // Process sanctions from events
  const processSanctions = (): { sanctions: SanctionRecord[], improperRequests: { teamA: boolean, teamB: boolean } } => {
    const sanctionRecords: SanctionRecord[] = [];
    const improperRequests = { teamA: false, teamB: false };
    
    // Check match.sanctions for improper requests (stored separately as left/right)
    // In set 1, Team A is always left, Team B is always right
    // Note: We'll process improper requests from events below, so we don't need to check match.sanctions here
    // to avoid duplicates
    
    if (!events) return { sanctions: sanctionRecords, improperRequests };
    
    // Get all sanction events sorted chronologically
    const sanctionEvents = events
      .filter(e => e.type === 'sanction')
      .sort((a, b) => {
        const aSeq = a.seq || 0;
        const bSeq = b.seq || 0;
        if (aSeq !== 0 || bSeq !== 0) return aSeq - bSeq;
        return new Date(a.ts).getTime() - new Date(b.ts).getTime();
      });
    
    // Helper to get score at a specific event timestamp
    const getScoreAtEvent = (eventTimestamp: Date, setIndex: number): string => {
      // Get all point events before or at this timestamp in this set
      const pointEvents = events
        .filter(e => 
          e.setIndex === setIndex && 
          e.type === 'point' &&
          new Date(e.ts).getTime() <= eventTimestamp.getTime()
        )
        .sort((a, b) => {
          const aSeq = a.seq || 0;
          const bSeq = b.seq || 0;
          if (aSeq !== 0 || bSeq !== 0) return aSeq - bSeq;
          return new Date(a.ts).getTime() - new Date(b.ts).getTime();
        });
      
      // Count points
      let homeScore = 0;
      let awayScore = 0;
      
      for (const e of pointEvents) {
        if (e.payload?.team === 'home') homeScore++;
        else if (e.payload?.team === 'away') awayScore++;
      }
      
      // Map to Team A/B based on team keys
      const teamAScore = teamAKey === 'home' ? homeScore : awayScore;
      const teamBScore = teamBKey === 'home' ? homeScore : awayScore;
      
      // Return score in format "sanctionedTeam:otherTeam" (sanctioned team score first)
      // This will be set correctly when processing each sanction
      return `${teamAScore}:${teamBScore}`;
    };
    
    // Process each sanction event
    for (const event of sanctionEvents) {
      const payload = event.payload || {};
      const sanctionType = payload.type;
      const eventTeam = payload.team; // 'home' or 'away'
      const setIndex = event.setIndex;
      
      // Map team to A or B
      const teamLabel = (eventTeam === teamAKey) ? 'A' : 'B';
      
      // Get score at the moment of this sanction
      const eventTimestamp = new Date(event.ts);
      const rawScore = getScoreAtEvent(eventTimestamp, setIndex);
      
      // Format score as "sanctionedTeam:otherTeam" (sanctioned team score first)
      const [teamAScoreStr, teamBScoreStr] = rawScore.split(':');
      const sanctionedTeamScore = teamLabel === 'A' ? teamAScoreStr : teamBScoreStr;
      const otherTeamScore = teamLabel === 'A' ? teamBScoreStr : teamAScoreStr;
      const score = `${sanctionedTeamScore}:${otherTeamScore}`;
      
      // Handle improper request
      if (sanctionType === 'improper_request') {
        if (teamLabel === 'A') improperRequests.teamA = true;
        else improperRequests.teamB = true;
        continue; // Don't add to sanction records
      }
      
      // Handle delay sanctions
      if (sanctionType === 'delay_warning' || sanctionType === 'delay_penalty') {
        const record: SanctionRecord = {
          team: teamLabel,
          playerNr: 'D', // "D" marker for delay sanctions
          type: sanctionType === 'delay_warning' ? 'warning' : 'penalty',
          set: setIndex,
          score: score
        };
        sanctionRecords.push(record);
        continue;
      }
      
      // Handle misconduct sanctions (warning, penalty, expulsion, disqualification)
      if (['warning', 'penalty', 'expulsion', 'disqualification'].includes(sanctionType)) {
        // Get player number or official initial
        let playerNr = '';
        
        if (payload.playerNumber) {
          // Player number
          playerNr = String(payload.playerNumber);
        } else if (payload.role) {
          // Official role - map to initial
          const roleMap: { [key: string]: string } = {
            'Coach': 'C',
            'Assistant Coach 1': 'AC1',
            'Assistant Coach 2': 'AC2',
            'Physiotherapist': 'P',
            'Medic': 'M'
          };
          playerNr = roleMap[payload.role] || payload.role.charAt(0).toUpperCase();
        } else if (payload.playerType === 'official') {
          // Generic official - try to get from role or use 'C' for coach
          playerNr = 'C'; // Default to Coach
        }
        
        if (playerNr) {
          const record: SanctionRecord = {
            team: teamLabel,
            playerNr: playerNr,
            type: sanctionType as 'warning' | 'penalty' | 'expulsion' | 'disqualification',
            set: setIndex,
            score: score
          };
          sanctionRecords.push(record);
        }
      }
    }
    
    return { sanctions: sanctionRecords, improperRequests };
  };
  
  const { sanctions: processedSanctions, improperRequests } = processSanctions();
  
  // Split sanctions into those that fit in the box (first 10) and overflow
  const rowCount = 10;
  const sanctionsInBox = processedSanctions.slice(0, rowCount);
  const overflowSanctions = processedSanctions.slice(rowCount);
  
  // Calculate match start
  const matchStart = match?.scheduledAt 
    ? new Date(match.scheduledAt).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })
    : '';
  
  // Calculate winner and result - only if match is finished (a team won 3 sets)
  // Points are stored by home/away, not by left/right, so we don't need to account for side swaps
  
  const finishedSets = sets?.filter(s => s.finished) || [];
  
  const teamASetsWon = finishedSets.filter(s => {
    // Points are always stored by home/away, regardless of side swaps
    const teamAPoints = teamAKey === 'home' ? s.homePoints : s.awayPoints;
    const teamBPoints = teamBKey === 'home' ? s.homePoints : s.awayPoints;
    return teamAPoints > teamBPoints;
  }).length;
  
  const teamBSetsWon = finishedSets.filter(s => {
    // Points are always stored by home/away, regardless of side swaps
    const teamAPoints = teamAKey === 'home' ? s.homePoints : s.awayPoints;
    const teamBPoints = teamBKey === 'home' ? s.homePoints : s.awayPoints;
    return teamBPoints > teamAPoints;
  }).length;
  
  // Match is finished if a team has won 3 sets
  const isMatchFinished = teamASetsWon >= 3 || teamBSetsWon >= 3;
  
  // Winner: full team name (only if match is finished)
  const winner = isMatchFinished
    ? (teamASetsWon >= 3 
        ? teamAName 
        : teamBSetsWon >= 3 
        ? teamBName 
        : '')
    : '';
  
  // Result: always format as 3:X where X is sets won by loser (only if match is finished)
  const result = isMatchFinished
    ? (teamASetsWon >= 3 
        ? `3-${teamBSetsWon}` 
        : teamBSetsWon >= 3 
        ? `3-${teamASetsWon}` 
        : '')
    : '';
  
  // Calculate match end and duration - only if match is finished
  const lastSet = sets?.filter(s => s.endTime).sort((a, b) => new Date(b.endTime).getTime() - new Date(a.endTime).getTime())[0];
  const matchEndFinal = isMatchFinished && lastSet?.endTime
    ? new Date(lastSet.endTime).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })
    : '';
  const matchDuration = isMatchFinished && match?.scheduledAt && lastSet?.endTime
    ? (() => {
        const start = new Date(match.scheduledAt);
        const end = new Date(lastSet.endTime);
        const durationMs = end.getTime() - start.getTime();
        const totalMinutes = Math.floor(durationMs / 60000);
        return totalMinutes > 0 ? `${totalMinutes}'` : '';
      })()
    : '';
  
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
  const set5CircledPointsHome: number[] = []; // Points scored due to sanctions
  const set5CircledPointsAway: number[] = []; // Points scored due to sanctions
  let set5HomeScore = 0;
  let set5AwayScore = 0;
  
  // Get all Set 5 events (points and sanctions) sorted chronologically
  const set5AllEvents = set5Events
    .filter(e => e.type === 'point' || e.type === 'sanction')
    .sort((a, b) => {
      const aSeq = a.seq || 0;
      const bSeq = b.seq || 0;
      if (aSeq !== 0 || bSeq !== 0) return aSeq - bSeq;
      return new Date(a.ts).getTime() - new Date(b.ts).getTime();
    });
  
  // First pass: process all point events to build marked points and track point numbers
  const pointEventToNumber = new Map(); // Map event to its point number
  let set5HomePointCount = 0;
  let set5AwayPointCount = 0;
  
  for (let i = 0; i < set5AllEvents.length; i++) {
    const event = set5AllEvents[i];
    
    if (event.type === 'point') {
      // Track point counts
      if (event.payload?.team === 'home') {
        set5HomeScore++;
        set5HomePointCount++;
        set5MarkedPointsHome.push(set5HomeScore);
        pointEventToNumber.set(event, set5HomePointCount);
      } else if (event.payload?.team === 'away') {
        set5AwayScore++;
        set5AwayPointCount++;
        set5MarkedPointsAway.push(set5AwayScore);
        pointEventToNumber.set(event, set5AwayPointCount);
      }
    }
  }
  
  // Second pass: process sanctions and circle the next point scored by opponent
  for (let i = 0; i < set5AllEvents.length; i++) {
    const event = set5AllEvents[i];
    
    if (event.type === 'sanction') {
      const payload = event.payload || {};
      const sanctionType = payload.type;
      const sanctionedTeam = payload.team; // 'home' or 'away'
      const opponentTeam = sanctionedTeam === 'home' ? 'away' : 'home';
      
      // Check if this sanction awards a point to the opponent
      const awardsPoint = ['penalty', 'expulsion', 'disqualification', 'delay_penalty'].includes(sanctionType);
      
      if (awardsPoint) {
        // Find the next point event scored by the opponent after this sanction
        for (let j = i + 1; j < set5AllEvents.length; j++) {
          const nextEvent = set5AllEvents[j];
          if (nextEvent.type === 'point' && nextEvent.payload?.team === opponentTeam) {
            // This point was scored due to the sanction - mark it for circling
            const pointNumber = pointEventToNumber.get(nextEvent);
            if (pointNumber !== undefined) {
              if (opponentTeam === 'home') {
                if (!set5CircledPointsHome.includes(pointNumber)) {
                  set5CircledPointsHome.push(pointNumber);
                }
              } else {
                if (!set5CircledPointsAway.includes(pointNumber)) {
                  set5CircledPointsAway.push(pointNumber);
                }
              }
            }
            break; // Only circle the first point after the sanction
          }
        }
      }
    }
  }
  
  // Team A and B marked points
  const set5MarkedPointsTeamA = teamAKey === 'home' ? set5MarkedPointsHome : set5MarkedPointsAway;
  const set5MarkedPointsTeamB = teamBKey === 'home' ? set5MarkedPointsHome : set5MarkedPointsAway;
  
  // The team on the left changes sides (splits at 8 points)
  // The team on the right doesn't change sides
  const set5MarkedPointsTeamOnLeft = set5LeftTeamIsB ? set5MarkedPointsTeamB : set5MarkedPointsTeamA;
  const set5MarkedPointsTeamOnRight = set5LeftTeamIsB ? set5MarkedPointsTeamA : set5MarkedPointsTeamB;
  
  // Split points for the team that changes sides (left team)
  const markedPointsLeftTeam_Left = set5MarkedPointsTeamOnLeft.filter(p => p <= 8); // Points 1-8 on left panel
  const markedPointsLeftTeam_Right = set5MarkedPointsTeamOnLeft.filter(p => p > 8).map(p => p - 8); // Points 9+ become 1, 2, 3... on right panel
  const markedPointsRightTeam = set5MarkedPointsTeamOnRight; // Team on right doesn't change sides
  
  // Get circled points for each team
  const set5CircledPointsTeamA = teamAKey === 'home' ? set5CircledPointsHome : set5CircledPointsAway;
  const set5CircledPointsTeamB = teamBKey === 'home' ? set5CircledPointsHome : set5CircledPointsAway;
  
  // The team on the left changes sides (splits at 8 points)
  const set5CircledPointsTeamOnLeft = set5LeftTeamIsB ? set5CircledPointsTeamB : set5CircledPointsTeamA;
  const set5CircledPointsTeamOnRight = set5LeftTeamIsB ? set5CircledPointsTeamA : set5CircledPointsTeamB;
  
  // Split circled points for the team that changes sides (left team)
  const circledPointsLeftTeam_Left = set5CircledPointsTeamOnLeft.filter(p => p <= 8); // Points 1-8 on left panel
  const circledPointsLeftTeam_Right = set5CircledPointsTeamOnLeft.filter(p => p > 8).map(p => p - 8); // Points 9+ become 1, 2, 3... on right panel
  const circledPointsRightTeam = set5CircledPointsTeamOnRight; // Team on right doesn't change sides
  
  // Map to SetFive component expectations
  // SetFive always uses A for the team that changes sides (panels 1&3), B for the team that doesn't (panel 2)
  // Panel 1 = left team before change (points 1-8)
  // Panel 2 = right team (all points, no change)
  // Panel 3 = left team after change (points 9+, continuation from Panel 1)
  // So we map:
  // - markedPointsA_Left = left team before change (Panel 1)
  // - markedPointsA_Right = left team after change (Panel 3) - continuation
  // - markedPointsB = right team (Panel 2)
  const markedPointsA_Left = markedPointsLeftTeam_Left; // Panel 1: left team before change
  const markedPointsA_Right = markedPointsLeftTeam_Right; // Panel 3: left team after change (continuation)
  const markedPointsB = markedPointsRightTeam; // Panel 2: right team
  
  const circledPointsA_Left = circledPointsLeftTeam_Left; // Panel 1: left team before change
  const circledPointsA_Right = circledPointsLeftTeam_Right; // Panel 3: left team after change (continuation)
  const circledPointsB = circledPointsRightTeam; // Panel 2: right team
  
  // Service tracking for Set 5 - track by LEFT/RIGHT team (not A/B)
  // The left team changes sides at 8 points, so we track:
  // - Left team BEFORE change (≤8 points) -> Panel 1
  // - Left team AFTER change (>8 points) -> Panel 3 (continuation of Panel 1)
  // - Right team (doesn't change sides) -> Panel 2
  interface ServiceRound {
    position: number; // 0-5 for I-VI
    box: number; // 1-6 for Set 5
    ticked: boolean;
    points: number | null;
    rotation8: boolean;
    circled: boolean;
  }
  
  const set5ServiceRoundsLeftTeam_Before: ServiceRound[] = []; // Panel 1: points 1-8
  const set5ServiceRoundsLeftTeam_After: ServiceRound[] = []; // Panel 3: points 9+ (continuation)
  const set5ServiceRoundsRightTeam: ServiceRound[] = []; // Panel 2: all points (no change)
  
  // Wrap Set 5 service tracking in try-catch to prevent crashes
  try {
  
  // Determine first serve team for Set 5
  const set5FirstServeTeam = match?.set5FirstServe === 'A' ? teamAKey : teamBKey;
  const set5TeamAKey = teamAKey;
  const set5TeamBKey = teamBKey;
  
  // Track which team is on left and right
  const set5LeftTeamKey = set5TeamOnLeft === 'home' ? 'home' : 'away';
  const set5RightTeamKey = set5TeamOnRight === 'home' ? 'home' : 'away';
  
  // Track service state for left team (before and after change) and right team
  let set5CurrentServeTeam: 'home' | 'away' = set5FirstServeTeam as 'home' | 'away';
  let set5LeftServiceRound_Before = 0; // Service round counter for left team before change
  let set5LeftServiceRound_After = 0; // Service round counter for left team after change
  let set5RightServiceRound = 0; // Service round counter for right team
  let set5LeftCurrentPosition_Before = 0; // Current serving position for left team before change
  let set5LeftCurrentPosition_After = 0; // Current serving position for left team after change
  let set5RightCurrentPosition = 0; // Current serving position for right team
  let set5LeftPointsInService_Before = 0;
  let set5LeftPointsInService_After = 0;
  let set5RightPointsInService = 0;
  let set5LeftServiceStarted_Before = false;
  let set5LeftServiceStarted_After = false;
  let set5RightServiceStarted = false;
  let set5LeftTeamTotalScore = 0; // Track total left team score to determine before/after change
  
  // Initialize first serve for Set 5
  if (set5FirstServeTeam === set5LeftTeamKey) {
    set5LeftServiceStarted_Before = true;
  } else {
    set5RightServiceStarted = true;
  }
  
  // Track team scores for Set 5
  let set5HomeScore = 0;
  let set5AwayScore = 0;
  
  set5PointEvents.forEach((event) => {
    const scoringTeam = event.payload?.team as 'home' | 'away';
    const isLeftTeam = scoringTeam === set5LeftTeamKey;
    const isRightTeam = scoringTeam === set5RightTeamKey;
    
    // Update team scores
    if (scoringTeam === 'home') {
      set5HomeScore++;
    } else if (scoringTeam === 'away') {
      set5AwayScore++;
    }
    
    // Update left team total score
    if (isLeftTeam) {
      set5LeftTeamTotalScore++;
    }
    
    // Determine if left team is before change (≤8) or after change (>8)
    const isLeftTeamBeforeChange = isLeftTeam && set5LeftTeamTotalScore <= 8;
    const isLeftTeamAfterChange = isLeftTeam && set5LeftTeamTotalScore > 8;
    
    // Check if service was lost
    if (scoringTeam !== set5CurrentServeTeam) {
      // Service was lost - record TEAM SCORE at time of service loss
      if (set5CurrentServeTeam === set5LeftTeamKey) {
        // Left team lost service - record their TEAM SCORE at the time of service loss
        // The score is the current score (before opponent scored), but must be at least 1
        // since they must have scored to get the serve
        const leftTeamCurrentScore = set5LeftTeamKey === 'home' ? set5HomeScore : set5AwayScore;
        const leftTeamScoreAtLoss = Math.max(1, leftTeamCurrentScore - 1);
        // Determine which phase the left team was in when they lost service
        const leftTeamScoreBeforeLoss = set5LeftTeamTotalScore - 1;
        
        if (leftTeamScoreBeforeLoss <= 8 && set5LeftServiceStarted_Before) {
          // Left team was before change (Panel 1) when they lost service
          const boxNum = Math.floor(set5LeftServiceRound_Before / 6) + 1;
          const existingRound = set5ServiceRoundsLeftTeam_Before.find(sr => sr.position === set5LeftCurrentPosition_Before && sr.box === boxNum);
          if (existingRound) {
            existingRound.points = leftTeamScoreAtLoss;
          } else {
            set5ServiceRoundsLeftTeam_Before.push({
              position: set5LeftCurrentPosition_Before,
              box: boxNum,
              ticked: false,
              points: leftTeamScoreAtLoss,
              rotation8: false,
              circled: false
            });
          }
        } else if (leftTeamScoreBeforeLoss > 8 && set5LeftServiceStarted_After) {
          // Left team was after change (Panel 3) when they lost service - continuation from Panel 1
          const boxNum = Math.floor(set5LeftServiceRound_After / 6) + 1;
          const existingRound = set5ServiceRoundsLeftTeam_After.find(sr => sr.position === set5LeftCurrentPosition_After && sr.box === boxNum);
          if (existingRound) {
            existingRound.points = leftTeamScoreAtLoss;
          } else {
            set5ServiceRoundsLeftTeam_After.push({
              position: set5LeftCurrentPosition_After,
              box: boxNum,
              ticked: false,
              points: leftTeamScoreAtLoss,
              rotation8: false,
              circled: false
            });
          }
        }
        
        // Right team now serves - mark "8" in their column I, box 1 (if first time)
        if (!set5RightServiceStarted) {
          set5ServiceRoundsRightTeam.push({
            position: 0,
            box: 1,
            ticked: false,
            points: null,
            rotation8: true,
            circled: false
          });
        }
        
        set5RightCurrentPosition = (set5RightCurrentPosition + 1) % 6;
        set5RightServiceRound++;
        
        set5RightServiceStarted = true;
        set5RightPointsInService = 0;
      } else if (set5CurrentServeTeam === set5RightTeamKey && set5RightServiceStarted) {
        // Right team lost service - record their TEAM SCORE at the time of service loss
        // The score is the current score (before opponent scored), but must be at least 1
        // since they must have scored to get the serve
        const rightTeamCurrentScore = set5RightTeamKey === 'home' ? set5HomeScore : set5AwayScore;
        const rightTeamScoreAtLoss = Math.max(1, rightTeamCurrentScore - 1);
        const boxNum = Math.floor(set5RightServiceRound / 6) + 1;
        const existingRound = set5ServiceRoundsRightTeam.find(sr => sr.position === set5RightCurrentPosition && sr.box === boxNum);
        if (existingRound) {
          existingRound.points = rightTeamScoreAtLoss;
        } else {
          set5ServiceRoundsRightTeam.push({
            position: set5RightCurrentPosition,
            box: boxNum,
            ticked: false,
            points: rightTeamScoreAtLoss,
            rotation8: false,
            circled: false
          });
        }
        
        // Left team now serves - mark "8" in their column I, box 1 (if first time)
        // Determine if left team is before or after change
        if (set5LeftTeamTotalScore <= 8) {
          // Left team before change (Panel 1)
          if (!set5LeftServiceStarted_Before) {
            set5ServiceRoundsLeftTeam_Before.push({
              position: 0,
              box: 1,
              ticked: false,
              points: null,
              rotation8: true,
              circled: false
            });
          }
          set5LeftCurrentPosition_Before = (set5LeftCurrentPosition_Before + 1) % 6;
          set5LeftServiceRound_Before++;
          set5LeftServiceStarted_Before = true;
          set5LeftPointsInService_Before = 0;
        } else {
          // Left team after change (Panel 3) - continuation from Panel 1
          // When transitioning from before to after, copy the state from before
          if (!set5LeftServiceStarted_After) {
            // Copy the last position and service round from before change
            set5LeftCurrentPosition_After = set5LeftCurrentPosition_Before;
            set5LeftServiceRound_After = set5LeftServiceRound_Before;
            // The "8" should be in the NEXT position (the one that will serve after the change)
            // and in box 2 (since we're starting a new box after the change)
            const nextPositionAfterChange = (set5LeftCurrentPosition_Before + 1) % 6;
            set5ServiceRoundsLeftTeam_After.push({
              position: nextPositionAfterChange,
              box: 2,
              ticked: false,
              points: null,
              rotation8: true,
              circled: false
            });
          }
          set5LeftCurrentPosition_After = (set5LeftCurrentPosition_After + 1) % 6;
          set5LeftServiceRound_After++;
          set5LeftServiceStarted_After = true;
          set5LeftPointsInService_After = 0;
        }
      }
      
      set5CurrentServeTeam = scoringTeam;
    } else {
      // Scoring team had serve - increment service points (for tracking, but we use team score instead)
      if (isLeftTeamBeforeChange && set5CurrentServeTeam === set5LeftTeamKey) {
        set5LeftPointsInService_Before++;
      } else if (isLeftTeamAfterChange && set5CurrentServeTeam === set5LeftTeamKey) {
        set5LeftPointsInService_After++;
      } else if (isRightTeam && set5CurrentServeTeam === set5RightTeamKey) {
        set5RightPointsInService++;
      }
    }
  });
  
  // End of set logic for Set 5: circle last point for both teams
  const isSet5Finished = set5Info?.finished || false;
  if (isSet5Finished && set5PointEvents.length > 0) {
    const lastPoint = set5PointEvents[set5PointEvents.length - 1];
    const lastScoringTeam = lastPoint.payload?.team as 'home' | 'away';
    const isLeftTeam = lastScoringTeam === set5LeftTeamKey;
    const isRightTeam = lastScoringTeam === set5RightTeamKey;
    
    // Get final scores from setInfo (after all points have been scored)
    const leftTeamFinalScore = set5LeftTeamKey === 'home' ? (set5Info.homePoints || 0) : (set5Info.awayPoints || 0);
    const rightTeamFinalScore = set5RightTeamKey === 'home' ? (set5Info.homePoints || 0) : (set5Info.awayPoints || 0);
    
    // Circle the last point for the winning team (team that scored the last point)
    if (isLeftTeam) {
      // Left team won
      const isLeftTeamBeforeChange = set5LeftTeamTotalScore <= 8;
      
      if (set5CurrentServeTeam === set5LeftTeamKey) {
        // Left team was serving - find their CURRENT active service round (the one with null points)
        if (isLeftTeamBeforeChange) {
          const currentBoxNum = Math.floor(set5LeftServiceRound_Before / 6) + 1;
          let activeServiceRound = set5ServiceRoundsLeftTeam_Before.find(sr => 
            sr.position === set5LeftCurrentPosition_Before && 
            sr.box === currentBoxNum && 
            sr.points === null
          );
          
          if (activeServiceRound) {
            activeServiceRound.points = leftTeamFinalScore;
            activeServiceRound.circled = true;
          } else {
            const lastServiceRound = set5ServiceRoundsLeftTeam_Before[set5ServiceRoundsLeftTeam_Before.length - 1];
            if (lastServiceRound && lastServiceRound.points === null) {
              lastServiceRound.points = leftTeamFinalScore;
              lastServiceRound.circled = true;
            } else {
              set5ServiceRoundsLeftTeam_Before.push({
                position: set5LeftCurrentPosition_Before,
                box: currentBoxNum,
                ticked: false,
                points: leftTeamFinalScore,
                rotation8: false,
                circled: true
              });
            }
          }
        } else {
          // Left team after change (Panel 3)
          const currentBoxNum = Math.floor(set5LeftServiceRound_After / 6) + 1;
          let activeServiceRound = set5ServiceRoundsLeftTeam_After.find(sr => 
            sr.position === set5LeftCurrentPosition_After && 
            sr.box === currentBoxNum && 
            sr.points === null
          );
          
          if (activeServiceRound) {
            activeServiceRound.points = leftTeamFinalScore;
            activeServiceRound.circled = true;
          } else {
            const lastServiceRound = set5ServiceRoundsLeftTeam_After[set5ServiceRoundsLeftTeam_After.length - 1];
            if (lastServiceRound && lastServiceRound.points === null) {
              lastServiceRound.points = leftTeamFinalScore;
              lastServiceRound.circled = true;
            } else {
              set5ServiceRoundsLeftTeam_After.push({
                position: set5LeftCurrentPosition_After,
                box: currentBoxNum,
                ticked: false,
                points: leftTeamFinalScore,
                rotation8: false,
                circled: true
              });
            }
          }
        }
      } else {
        // Left team won on receive - add final score and circle
        if (isLeftTeamBeforeChange) {
          const nextLeftPosition = (set5LeftCurrentPosition_Before + 1) % 6;
          const nextLeftBox = Math.floor((set5LeftServiceRound_Before + 1) / 6) + 1;
          set5ServiceRoundsLeftTeam_Before.push({
            position: nextLeftPosition,
            box: nextLeftBox,
            ticked: false,
            points: leftTeamFinalScore,
            rotation8: false,
            circled: true
          });
        } else {
          const nextLeftPosition = (set5LeftCurrentPosition_After + 1) % 6;
          const nextLeftBox = Math.floor((set5LeftServiceRound_After + 1) / 6) + 1;
          set5ServiceRoundsLeftTeam_After.push({
            position: nextLeftPosition,
            box: nextLeftBox,
            ticked: false,
            points: leftTeamFinalScore,
            rotation8: false,
            circled: true
          });
        }
      }
      
      // Circle right team's last point (losing team)
      // Find the service round that matches the final score, or add a new one
      if (set5ServiceRoundsRightTeam.length > 0) {
        const lastRightServiceRound = set5ServiceRoundsRightTeam[set5ServiceRoundsRightTeam.length - 1];
        if (lastRightServiceRound.points === null) {
          // Still serving - set to final score and circle
          lastRightServiceRound.points = rightTeamFinalScore;
          lastRightServiceRound.circled = true;
        } else if (lastRightServiceRound.points === rightTeamFinalScore) {
          // Last service round matches final score - circle it
          lastRightServiceRound.circled = true;
        } else if (lastRightServiceRound.points < rightTeamFinalScore) {
          // Final score is higher - add new service round with final score
          const nextRightPosition = (set5RightCurrentPosition + 1) % 6;
          const nextRightBox = Math.floor((set5RightServiceRound + 1) / 6) + 1;
          set5ServiceRoundsRightTeam.push({
            position: nextRightPosition,
            box: nextRightBox,
            ticked: false,
            points: rightTeamFinalScore,
            rotation8: false,
            circled: true
          });
        }
        // If lastRightServiceRound.points > rightTeamFinalScore, something is wrong, don't circle
      }
    } else if (isRightTeam) {
      // Right team won
      if (set5CurrentServeTeam === set5RightTeamKey) {
        // Right team was serving - find their CURRENT active service round (the one with null points)
        const currentBoxNum = Math.floor(set5RightServiceRound / 6) + 1;
        let activeServiceRound = set5ServiceRoundsRightTeam.find(sr => 
          sr.position === set5RightCurrentPosition && 
          sr.box === currentBoxNum && 
          sr.points === null
        );
        
        if (activeServiceRound) {
          activeServiceRound.points = rightTeamFinalScore;
          activeServiceRound.circled = true;
        } else {
          const lastServiceRound = set5ServiceRoundsRightTeam[set5ServiceRoundsRightTeam.length - 1];
          if (lastServiceRound && lastServiceRound.points === null) {
            lastServiceRound.points = rightTeamFinalScore;
            lastServiceRound.circled = true;
          } else {
            set5ServiceRoundsRightTeam.push({
              position: set5RightCurrentPosition,
              box: currentBoxNum,
              ticked: false,
              points: rightTeamFinalScore,
              rotation8: false,
              circled: true
            });
          }
        }
      } else {
        // Right team won on receive - add final score and circle
        const nextRightPosition = (set5RightCurrentPosition + 1) % 6;
        const nextRightBox = Math.floor((set5RightServiceRound + 1) / 6) + 1;
        set5ServiceRoundsRightTeam.push({
          position: nextRightPosition,
          box: nextRightBox,
          ticked: false,
          points: rightTeamFinalScore,
          rotation8: false,
          circled: true
        });
      }
      
      // Circle left team's last point (losing team)
      // Find the service round that matches the final score, or add a new one
      const isLeftTeamBeforeChange = set5LeftTeamTotalScore <= 8;
      
      if (isLeftTeamBeforeChange) {
        if (set5ServiceRoundsLeftTeam_Before.length > 0) {
          const lastLeftServiceRound = set5ServiceRoundsLeftTeam_Before[set5ServiceRoundsLeftTeam_Before.length - 1];
          if (lastLeftServiceRound.points === null) {
            lastLeftServiceRound.points = leftTeamFinalScore;
            lastLeftServiceRound.circled = true;
          } else if (lastLeftServiceRound.points === leftTeamFinalScore) {
            lastLeftServiceRound.circled = true;
          } else if (lastLeftServiceRound.points < leftTeamFinalScore) {
            const nextLeftPosition = (set5LeftCurrentPosition_Before + 1) % 6;
            const nextLeftBox = Math.floor((set5LeftServiceRound_Before + 1) / 6) + 1;
            set5ServiceRoundsLeftTeam_Before.push({
              position: nextLeftPosition,
              box: nextLeftBox,
              ticked: false,
              points: leftTeamFinalScore,
              rotation8: false,
              circled: true
            });
          }
        }
      } else {
        if (set5ServiceRoundsLeftTeam_After.length > 0) {
          const lastLeftServiceRound = set5ServiceRoundsLeftTeam_After[set5ServiceRoundsLeftTeam_After.length - 1];
          if (lastLeftServiceRound.points === null) {
            lastLeftServiceRound.points = leftTeamFinalScore;
            lastLeftServiceRound.circled = true;
          } else if (lastLeftServiceRound.points === leftTeamFinalScore) {
            lastLeftServiceRound.circled = true;
          } else if (lastLeftServiceRound.points < leftTeamFinalScore) {
            const nextLeftPosition = (set5LeftCurrentPosition_After + 1) % 6;
            const nextLeftBox = Math.floor((set5LeftServiceRound_After + 1) / 6) + 1;
            set5ServiceRoundsLeftTeam_After.push({
              position: nextLeftPosition,
              box: nextLeftBox,
              ticked: false,
              points: leftTeamFinalScore,
              rotation8: false,
              circled: true
            });
          }
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
  const buttonsContainerRef = useRef<HTMLDivElement>(null);
  
const captureScreenshot = async () => {
  if (!containerRef.current) return;
  
  // Hide buttons temporarily
  const buttonsContainer = buttonsContainerRef.current;
  const originalDisplay = buttonsContainer?.style.display;
  if (buttonsContainer) {
    buttonsContainer.style.display = 'none';
  }
  
  // Hide cursor
  const originalCursor = document.body.style.cursor;
  document.body.style.cursor = 'none';
  const originalPointerEvents = document.body.style.pointerEvents;
  document.body.style.pointerEvents = 'none';
  
  // Get parent container and remove margins/padding
  const container = containerRef.current;
  const parentContainer = container.parentElement;
  const originalParentStyle = {
    padding: parentContainer?.style.padding || '',
    margin: parentContainer?.style.margin || '',
    backgroundColor: parentContainer?.style.backgroundColor || '',
    display: parentContainer?.style.display || ''
  };
  
  // Remove all padding/margins from parent and make it fill viewport
  if (parentContainer) {
    parentContainer.style.padding = '0';
    parentContainer.style.margin = '0';
    parentContainer.style.backgroundColor = '#ffffff';
    parentContainer.style.display = 'flex';
    parentContainer.style.justifyContent = 'center';
    parentContainer.style.alignItems = 'center';
    parentContainer.style.width = '100vw';
    parentContainer.style.height = '100vh';
    parentContainer.style.position = 'fixed';
    parentContainer.style.top = '0';
    parentContainer.style.left = '0';
    parentContainer.style.zIndex = '9999';
  }
  
  // Remove padding from container itself
  const originalContainerPadding = container.style.padding;
  const originalContainerMargin = container.style.margin;
  const originalContainerBorder = container.style.border;
  container.style.padding = '0';
  container.style.margin = '0';
  
  // Add black border for cropping reference
  container.style.border = '3px solid #000000';
  
  // Scroll to top
  window.scrollTo(0, 0);
  
  // Wait for layout to update
  await new Promise(resolve => setTimeout(resolve, 150));
  
  // Calculate zoom to fill entire viewport (no padding)
  const containerRect = container.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  
  const zoomX = viewportWidth / containerRect.width;
  const zoomY = viewportHeight / containerRect.height;
  const zoom = Math.min(zoomX, zoomY, 1); // Don't zoom in beyond 100%
  
  // Store original transform (before try block so it's accessible in finally)
  const originalTransform = container.style.transform;
  const originalTransformOrigin = container.style.transformOrigin;
  
  // Apply zoom to fill viewport
  container.style.transformOrigin = 'center center';
  container.style.transform = `scale(${zoom})`;
  
  // Wait for transform to apply
  await new Promise(resolve => setTimeout(resolve, 150));
  
  try {
    // Use Screen Capture API to get actual browser screenshot with highest resolution
    // Note: Browser will prompt for permission - this is a security feature and cannot be avoided
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { 
        displaySurface: 'browser',
        width: { ideal: 7680, max: 7680 }, // 8K resolution
        height: { ideal: 4320, max: 4320 },
        frameRate: { ideal: 30 }
      } as any,
      preferCurrentTab: true
    } as any);
    
    // Create video element to capture frame
    const video = document.createElement('video');
    video.srcObject = stream;
    await video.play();
    
    // Wait for video to be ready
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // Create canvas for the capture - since scoresheet fills viewport, capture full viewport
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get canvas context');
    ctx.drawImage(video, 0, 0);
    
    // Stop the stream
    stream.getTracks().forEach(track => track.stop());
    
    // Find the black border edges
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    
    // Find top edge (first row with black pixels)
    let top = 0;
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const idx = (y * canvas.width + x) * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        // Check if pixel is black (or very dark)
        if (r < 50 && g < 50 && b < 50) {
          top = y;
          break;
        }
      }
      if (top > 0) break;
    }
    
    // Find bottom edge (last row with black pixels)
    let bottom = canvas.height;
    for (let y = canvas.height - 1; y >= 0; y--) {
      for (let x = 0; x < canvas.width; x++) {
        const idx = (y * canvas.width + x) * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        if (r < 50 && g < 50 && b < 50) {
          bottom = y;
          break;
        }
      }
      if (bottom < canvas.height) break;
    }
    
    // Find left edge (first column with black pixels)
    let left = 0;
    for (let x = 0; x < canvas.width; x++) {
      for (let y = 0; y < canvas.height; y++) {
        const idx = (y * canvas.width + x) * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        if (r < 50 && g < 50 && b < 50) {
          left = x;
          break;
        }
      }
      if (left > 0) break;
    }
    
    // Find right edge (last column with black pixels)
    let right = canvas.width;
    for (let x = canvas.width - 1; x >= 0; x--) {
      for (let y = 0; y < canvas.height; y++) {
        const idx = (y * canvas.width + x) * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        if (r < 50 && g < 50 && b < 50) {
          right = x;
          break;
        }
      }
      if (right < canvas.width) break;
    }
    
    // Add small padding inside the border (skip the border itself)
    const borderWidth = 3; // Match the border width
    const cropX = left + borderWidth;
    const cropY = top + borderWidth;
    const cropWidth = right - left - (borderWidth * 2);
    const cropHeight = bottom - top - (borderWidth * 2);
    
    // Create cropped canvas
    const croppedCanvas = document.createElement('canvas');
    croppedCanvas.width = cropWidth;
    croppedCanvas.height = cropHeight;
    const croppedCtx = croppedCanvas.getContext('2d');
    if (!croppedCtx) throw new Error('Could not get cropped canvas context');
    croppedCtx.drawImage(canvas, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
    
    // Resize to A4 landscape (297mm x 210mm) at highest resolution
    // A4 landscape at 600 DPI for maximum quality
    const dpi = 600;
    const a4Width = Math.round(297 * dpi / 25.4); // 297mm at 600 DPI = 7016px
    const a4Height = Math.round(210 * dpi / 25.4); // 210mm at 600 DPI = 4961px
    
    // Calculate scaling to fit A4 while maintaining aspect ratio
    const scaleX = a4Width / cropWidth;
    const scaleY = a4Height / cropHeight;
    const scale = Math.min(scaleX, scaleY);
    
    const finalWidth = Math.round(cropWidth * scale);
    const finalHeight = Math.round(cropHeight * scale);
    
    // Create final canvas with A4 dimensions
    const finalCanvas = document.createElement('canvas');
    finalCanvas.width = a4Width;
    finalCanvas.height = a4Height;
    const finalCtx = finalCanvas.getContext('2d');
    if (!finalCtx) throw new Error('Could not get final canvas context');
    
    // Fill with white background
    finalCtx.fillStyle = '#ffffff';
    finalCtx.fillRect(0, 0, a4Width, a4Height);
    
    // Center the image
    const offsetX = (a4Width - finalWidth) / 2;
    const offsetY = (a4Height - finalHeight) / 2;
    
    // Draw the resized image
    finalCtx.drawImage(croppedCanvas, offsetX, offsetY, finalWidth, finalHeight);
    
    // Convert to PDF with highest quality
    // Use PNG with maximum quality (quality parameter doesn't affect PNG, but we use 1.0 for clarity)
    const imgData = finalCanvas.toDataURL('image/png', 1.0);
    const pdf = new jsPDF({
      orientation: 'landscape',
      unit: 'mm',
      format: 'a4'
    });
    
    // Add image to PDF (A4 landscape is 297mm x 210mm) with highest quality
    // PNG format already provides lossless compression
    pdf.addImage(imgData, 'PNG', 0, 0, 297, 210);
    
    // Download the PDF with naming convention: matchn_homeshort_awayshort_date.pdf
    const matchNum = match?.gameNumber || match?.externalId || match?.game_n?.toString() || 'match';
    const homeShort = match?.homeShortName || homeTeam?.name || 'Home';
    const awayShort = match?.awayShortName || awayTeam?.name || 'Away';
    const date = match?.scheduledAt 
      ? new Date(match.scheduledAt).toISOString().slice(0, 10).replace(/-/g, '')
      : new Date().toISOString().slice(0, 10).replace(/-/g, '');
    
    // Sanitize team names (remove special characters, spaces, etc.)
    const sanitize = (str: string) => str.replace(/[^a-zA-Z0-9]/g, '').substring(0, 20);
    const filename = `${matchNum}_${sanitize(homeShort)}_${sanitize(awayShort)}_${date}.pdf`;
    pdf.save(filename);
  } catch (error) {
    console.error('Screenshot failed:', error);
  } finally {
    // Restore container styles
    if (containerRef.current) {
      containerRef.current.style.transform = originalTransform;
      containerRef.current.style.transformOrigin = originalTransformOrigin;
      containerRef.current.style.padding = originalContainerPadding;
      containerRef.current.style.margin = originalContainerMargin;
      containerRef.current.style.border = originalContainerBorder;
    }
    // Restore parent container styles
    if (parentContainer) {
      parentContainer.style.padding = originalParentStyle.padding;
      parentContainer.style.margin = originalParentStyle.margin;
      parentContainer.style.backgroundColor = originalParentStyle.backgroundColor;
      parentContainer.style.display = originalParentStyle.display;
      parentContainer.style.width = '';
      parentContainer.style.height = '';
      parentContainer.style.position = '';
      parentContainer.style.top = '';
      parentContainer.style.left = '';
      parentContainer.style.zIndex = '';
      parentContainer.style.justifyContent = '';
      parentContainer.style.alignItems = '';
    }
    // Restore buttons visibility
    if (buttonsContainer) {
      buttonsContainer.style.display = originalDisplay || '';
    }
    // Restore cursor
    document.body.style.cursor = originalCursor;
    document.body.style.pointerEvents = originalPointerEvents;
  }
};

  return (
    <>
      <div ref={buttonsContainerRef} className="mb-2 flex justify-center items-center print:hidden w-full">
    <div className="space-x-2">
        <button 
            onClick={captureScreenshot}
            className="bg-green-500 hover:bg-green-700 text-white px-3 py-1 rounded text-sm shadow"
        >
            Save
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
                                firstServeTeamA={match?.coinTossServeA}
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
                                teamNameLeft={shouldShowSet4 ? teamBShortName : ''}
                                teamNameRight={shouldShowSet4 ? teamAShortName : ''}
                                firstServeTeamA={shouldShowSet4 ? match?.coinTossServeA : undefined}
                                {...(shouldShowSet4 ? set4Data : {
                                    startTime: '',
                                    endTime: '',
                                    leftLineup: ['', '', '', '', '', ''],
                                    rightLineup: ['', '', '', '', '', ''],
                                    leftPoints: 0,
                                    rightPoints: 0,
                                    leftMarkedPoints: [],
                                    rightMarkedPoints: [],
                                    leftCircledPoints: [],
                                    rightCircledPoints: [],
                                    leftServiceRounds: [],
                                    rightServiceRounds: [],
                                    leftTimeouts: ['', ''],
                                    rightTimeouts: ['', ''],
                                    leftSubs: [[], [], [], [], [], []],
                                    rightSubs: [[], [], [], [], [], []]
                                })}
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
                            teamNameA={hasSet5CoinToss && set5Data ? (set5LeftTeamIsB ? teamBShortName : teamAShortName) : ''}
                            teamNameB={hasSet5CoinToss && set5Data ? (set5LeftTeamIsB ? teamAShortName : teamBShortName) : ''}
                            teamALabel={hasSet5CoinToss && set5Data ? (set5LeftTeamIsB ? "B" : "A") : ''}
                            teamBLabel={hasSet5CoinToss && set5Data ? (set5LeftTeamIsB ? "A" : "B") : ''}
                            firstServeTeamA={hasSet5CoinToss && set5Data ? (() => {
                              // Determine which team serves first based on set5FirstServe
                              // SetFive expects firstServeTeamA to indicate if the team in Panel 1 serves
                              if (match?.set5FirstServe) {
                                const firstServeIsLeft = match.set5FirstServe === match?.set5LeftTeam;
                                // If Team B is on left, then firstServeTeamA should be true if B serves
                                return set5LeftTeamIsB 
                                  ? (match.set5FirstServe === 'B')
                                  : (match.set5FirstServe === 'A');
                              }
                              // Fallback to coin toss if set5FirstServe not set
                              return set5LeftTeamIsB 
                                ? !(match?.coinTossServeA || false)
                                : (match?.coinTossServeA || false);
                            })() : undefined}
                            startTime={hasSet5CoinToss && set5Data ? set5Data.startTime : ''}
                            endTime={hasSet5CoinToss && set5Data ? set5Data.endTime : ''}
                            lineupA={hasSet5CoinToss && set5Data ? set5Data.leftLineup : ['', '', '', '', '', '']}
                            subsA={hasSet5CoinToss && set5Data ? set5Data.leftSubs : [[], [], [], [], [], []]}
                            timeoutsA={hasSet5CoinToss && set5Data ? set5Data.leftTimeouts : ['', '']}
                            subsA_Right={hasSet5CoinToss && set5Data ? set5Data.leftSubs_After : [[], [], [], [], [], []]}
                            timeoutsA_Right={hasSet5CoinToss && set5Data ? set5Data.leftTimeouts_After : ['', '']}
                            lineupB={hasSet5CoinToss && set5Data ? set5Data.rightLineup : ['', '', '', '', '', '']}
                            subsB={hasSet5CoinToss && set5Data ? set5Data.rightSubs : [[], [], [], [], [], []]}
                            timeoutsB={hasSet5CoinToss && set5Data ? set5Data.rightTimeouts : ['', '']}
                            pointsA_Left={hasSet5CoinToss && set5Data ? (() => {
                              if (!set5Info || (!set5Info.homePoints && !set5Info.awayPoints && !set5Info.startTime)) return 0;
                              const leftTeamPoints = set5TeamOnLeft === 'home' ? (set5Info.homePoints || 0) : (set5Info.awayPoints || 0);
                              return Math.min(leftTeamPoints, 8);
                            })() : 0}
                            markedPointsA_Left={hasSet5CoinToss && set5Data ? markedPointsA_Left : []}
                            circledPointsA_Left={hasSet5CoinToss && set5Data ? circledPointsA_Left : []}
                            serviceRoundsA_Left={hasSet5CoinToss && set5Data ? set5ServiceRoundsLeftTeam_Before : []}
                            pointsB={hasSet5CoinToss && set5Data ? (() => {
                              if (!set5Info || (!set5Info.homePoints && !set5Info.awayPoints && !set5Info.startTime)) return 0;
                              const rightTeamPoints = set5TeamOnRight === 'home' ? (set5Info.homePoints || 0) : (set5Info.awayPoints || 0);
                              return rightTeamPoints;
                            })() : 0}
                            markedPointsB={hasSet5CoinToss && set5Data ? markedPointsB : []}
                            circledPointsB={hasSet5CoinToss && set5Data ? circledPointsB : []}
                            serviceRoundsB={hasSet5CoinToss && set5Data ? set5ServiceRoundsRightTeam : []}
                            pointsA_Right={hasSet5CoinToss && set5Data ? (() => {
                              if (!set5Info || (!set5Info.homePoints && !set5Info.awayPoints && !set5Info.startTime)) return 0;
                              const leftTeamPoints = set5TeamOnLeft === 'home' ? (set5Info.homePoints || 0) : (set5Info.awayPoints || 0);
                              return Math.max(leftTeamPoints - 8, 0);
                            })() : 0}
                            markedPointsA_Right={hasSet5CoinToss && set5Data ? markedPointsA_Right : []}
                            circledPointsA_Right={hasSet5CoinToss && set5Data ? circledPointsA_Right : []}
                            serviceRoundsA_Right={hasSet5CoinToss && set5Data ? set5ServiceRoundsLeftTeam_After : []}
                            pointsAtChange={hasSet5CoinToss && set5Data ? (() => {
                              // POINTS AT CHANGE: Total points scored by the team on the left at the moment of change (should be 8)
                              if (!set5Info || (!set5Info.homePoints && !set5Info.awayPoints && !set5Info.startTime)) return '';
                              const leftTeamPoints = set5TeamOnLeft === 'home' ? (set5Info.homePoints || 0) : (set5Info.awayPoints || 0);
                              // The change happens at 8 points, so we show 8 if the team has scored at least 8 points
                              // Otherwise, show the actual points if less than 8 (set not yet reached change point)
                              if (leftTeamPoints >= 8) {
                                return '8';
                              } else if (leftTeamPoints > 0) {
                                return String(leftTeamPoints);
                              }
                              return '';
                            })() : ''}
                                positionBoxRef={positionBoxSet5Ref}
                            />
                        </div>
                    </div>
                    
                    {/* Footer sections row - flex for horizontal control */}
                    <div ref={footerRef} className="flex gap-0.5 shrink-0" style={{ height: '8.4cm' }}>
                        {/* Sanctions - narrower width */}
                        <div ref={sanctionsRef} className="flex-col shrink-0" style={{ height: '8.4cm', width: '50mm' }}>
                            <Sanctions items={sanctionsInBox} improperRequests={improperRequests} />
                        </div>
                        
                        {/* Remarks and Approvals stacked - takes remaining space */}
                        <div className="flex-1 flex flex-col gap-2 min-h-0">
                            {/* Remarks - 30% height */}
                            <div ref={remarksRef} className="flex-[3] min-h-0">
                                <Remarks overflowSanctions={overflowSanctions} />
                            </div>
                            {/* Approvals - 70% height */}
                            <div ref={approvalsRef} className="flex-[5] min-h-0">
                                <Approvals officials={match?.officials} />
                            </div>
                        </div>
                        
                        {/* Results - adjust flex-[x] to change width proportion */}
                        <div ref={resultsRef} className="flex-[0.67] flex flex-col shrink-0" style={{ height: '8.4cm' }}>
                            <Results 
                                teamAShortName={teamAShortName} 
                                teamBShortName={teamBShortName}
                                setResults={setResults}
                                matchStart={matchStart}
                                matchEnd={matchEndFinal}
                                matchDuration={matchDuration}
                                winner={winner}
                                result={result}
                            />
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
                          preGameCaptainSignature={teamAKey === 'home' ? match?.homeCaptainSignature : match?.awayCaptainSignature}
                          preGameCoachSignature={teamAKey === 'home' ? match?.homeCoachSignature : match?.awayCoachSignature}
                        />
                    </div>
                    <div ref={rosterBRef} className="flex-1 min-w-0">
                        <Roster 
                          team={teamBShortName} 
                          side="B" 
                          players={teamBPlayers}
                          benchStaff={teamBKey === 'home' ? match?.bench_home : match?.bench_away}
                          preGameCaptainSignature={teamBKey === 'home' ? match?.homeCaptainSignature : match?.awayCaptainSignature}
                          preGameCoachSignature={teamBKey === 'home' ? match?.homeCoachSignature : match?.awayCoachSignature}
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
