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
}

// Sub event structure for the UI
export interface SubRecord {
  playerIn: string;
  score: string; // Format "12:15"
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
  pointsAtChange?: string;
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
