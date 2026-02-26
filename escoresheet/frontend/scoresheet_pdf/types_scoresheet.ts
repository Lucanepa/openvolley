export interface TeamData {
  name: string;
  code: string; // A or B
}

export interface Player {
  number: string | number;
  name: string;
  license?: string;
  dob?: string;
  role?: string;
  firstName?: string;
  lastName?: string;
  libero?: string;
  isCaptain?: boolean;
  isLfp?: boolean;
}

// Sub event structure for the UI
export interface SubRecord {
  playerOut: number; // Player leaving the court
  playerIn: number; // Player coming in
  score: string; // Format "substitutingTeam:otherTeam" (e.g., "3:7")
  isCircled?: boolean; // True if playerOut is circled (can't reenter)
}

// Data required to render a single Set
export interface SetData {
  setNumber: number;
  startTime?: string;
  endTime?: string;
  
  // Team A specific set data
  teamA_Lineup: string[]; // Array of 6 player numbers (I-VI)
  teamA_Subs: SubRecord[][]; // Array of 6 arrays (one list of subs per position)
  teamA_Timeouts: [string, string]; // Two timeout scores
  teamA_Points: number; // Current score (fills boxes 1..N)

  // Team B specific set data
  teamB_Lineup: string[];
  teamB_Subs: SubRecord[][];
  teamB_Timeouts: [string, string];
  teamB_Points: number;
  
  // For Set 5 logic
  pointsAtChangeA?: number; // Left panel team's points at court change
  pointsAtChangeB?: number; // Middle panel team's points at court change
}

export interface SanctionRecord {
  team: 'A' | 'B';
  playerNr: string; // or Coach 'C'
  type: 'warning' | 'penalty' | 'expulsion' | 'disqualification'; // W, P, E, D
  set: number;
  score: string;
}

export interface MatchResult {
  sets: {
    a: number;
    b: number;
    duration: number;
  }[];
  winner: string;
  result: string; // e.g. 3-1
}

// Libero Control Sheet types
export interface LiberoReplacement {
  liberoNumber: number;
  replacedPlayer: number;
  score: string; // "teamScore:opponentScore"
  isExchange?: boolean; // true if this is part of a libero-to-libero exchange
}

export interface LiberoSetData {
  setNumber: number;
  teamAReplacements: LiberoReplacement[];
  teamBReplacements: LiberoReplacement[];
  // For Set 5: after court change at 8 points
  teamAReplacements_After?: LiberoReplacement[];
  teamBReplacements_After?: LiberoReplacement[];
}

export interface LiberoRedesignation {
  team: 'A' | 'B';
  outNumber: number;
  inNumber: number;
  setNumber: number;
  score: string;
}

export interface LCSData {
  teamALiberos: { number: number; type: string }[];
  teamBLiberos: { number: number; type: string }[];
  sets: LiberoSetData[];
  redesignations: LiberoRedesignation[];
}
