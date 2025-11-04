/*
 * OpenVolley - Open Source Volleyball PWA
 * Copyright (C) 2025 OpenVolley Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

export type SetType = 'regular' | 'tiebreak';

export interface SetConfig {
  type: SetType;
  pointsToWin: number;
  minLeadToWin: number;
}

export const REGULAR_SET_CONFIG: SetConfig = {
  type: 'regular',
  pointsToWin: 25,
  minLeadToWin: 2,
};

export const TIEBREAK_SET_CONFIG: SetConfig = {
  type: 'tiebreak',
  pointsToWin: 15,
  minLeadToWin: 2,
};

/**
 * Check if a set is complete based on volleyball rules
 * @param teamAScore Score of team A
 * @param teamBScore Score of team B
 * @param config Set configuration (regular 25 or tiebreak 15)
 * @returns true if the set is complete
 */
export function isSetComplete(
  teamAScore: number,
  teamBScore: number,
  config: SetConfig = REGULAR_SET_CONFIG
): boolean {
  const { pointsToWin, minLeadToWin } = config;
  
  // Check if either team reached the minimum points
  const maxScore = Math.max(teamAScore, teamBScore);
  const minScore = Math.min(teamAScore, teamBScore);
  
  // Must reach points to win and have the required lead
  return maxScore >= pointsToWin && (maxScore - minScore) >= minLeadToWin;
}

/**
 * Get the winner of a set
 * @param teamAScore Score of team A
 * @param teamBScore Score of team B
 * @param config Set configuration
 * @returns 'A' | 'B' | null
 */
export function getSetWinner(
  teamAScore: number,
  teamBScore: number,
  config: SetConfig = REGULAR_SET_CONFIG
): 'A' | 'B' | null {
  if (!isSetComplete(teamAScore, teamBScore, config)) {
    return null;
  }
  return teamAScore > teamBScore ? 'A' : 'B';
}

/**
 * Check if a match is complete (best of 5 sets)
 * @param setWinners Array of set winners
 * @returns true if match is complete
 */
export function isMatchComplete(setWinners: ('A' | 'B' | null)[]): boolean {
  const teamAWins = setWinners.filter(w => w === 'A').length;
  const teamBWins = setWinners.filter(w => w === 'B').length;
  
  // Match is complete when one team wins 3 sets
  return teamAWins >= 3 || teamBWins >= 3;
}

/**
 * Get the winner of a match
 * @param setWinners Array of set winners
 * @returns 'A' | 'B' | null
 */
export function getMatchWinner(setWinners: ('A' | 'B' | null)[]): 'A' | 'B' | null {
  if (!isMatchComplete(setWinners)) {
    return null;
  }
  
  const teamAWins = setWinners.filter(w => w === 'A').length;
  const teamBWins = setWinners.filter(w => w === 'B').length;
  
  return teamAWins > teamBWins ? 'A' : 'B';
}

/**
 * Determine if the next set should be a tiebreak (5th set)
 * @param setNumber Current set number (1-based)
 * @returns true if this is a tiebreak set
 */
export function isTiebreakSet(setNumber: number): boolean {
  return setNumber === 5;
}
