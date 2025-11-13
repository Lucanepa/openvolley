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

import Dexie, { type EntityTable } from 'dexie';

export interface Player {
  id?: number;
  teamId: string;
  number: number;
  name: string;
  position: string;
}

export interface Match {
  id?: number;
  teamAName: string;
  teamBName: string;
  sets: SetScore[];
  startTime: number;
  endTime?: number;
  syncedAt?: number;
}

export interface SetScore {
  setNumber: number;
  teamAScore: number;
  teamBScore: number;
  winner?: 'A' | 'B';
  isTiebreak: boolean;
}

export interface Substitution {
  id?: number;
  matchId: number;
  setNumber: number;
  team: 'A' | 'B';
  playerOut: number;
  playerIn: number;
  timestamp: number;
}

const db = new Dexie('OpenVolleyDB') as Dexie & {
  matches: EntityTable<Match, 'id'>;
  players: EntityTable<Player, 'id'>;
  substitutions: EntityTable<Substitution, 'id'>;
};

db.version(1).stores({
  matches: '++id, startTime, endTime, syncedAt',
  players: '++id, teamId, number',
  substitutions: '++id, matchId, setNumber, team, timestamp',
});

export { db };
