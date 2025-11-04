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

import { describe, it, expect } from 'vitest';
import {
  isSetComplete,
  getSetWinner,
  isMatchComplete,
  getMatchWinner,
  isTiebreakSet,
  REGULAR_SET_CONFIG,
  TIEBREAK_SET_CONFIG,
} from './volleyballRules';

describe('volleyballRules', () => {
  describe('isSetComplete - Regular Set (25 points)', () => {
    it('should return false when neither team reached 25', () => {
      expect(isSetComplete(24, 23, REGULAR_SET_CONFIG)).toBe(false);
      expect(isSetComplete(20, 20, REGULAR_SET_CONFIG)).toBe(false);
      expect(isSetComplete(0, 0, REGULAR_SET_CONFIG)).toBe(false);
    });

    it('should return true when one team reaches 25 with lead of 2+', () => {
      expect(isSetComplete(25, 23, REGULAR_SET_CONFIG)).toBe(true);
      expect(isSetComplete(23, 25, REGULAR_SET_CONFIG)).toBe(true);
      expect(isSetComplete(25, 20, REGULAR_SET_CONFIG)).toBe(true);
    });

    it('should return false when one team reaches 25 but lead is only 1', () => {
      expect(isSetComplete(25, 24, REGULAR_SET_CONFIG)).toBe(false);
      expect(isSetComplete(24, 25, REGULAR_SET_CONFIG)).toBe(false);
    });

    it('should handle deuce situations correctly', () => {
      expect(isSetComplete(25, 25, REGULAR_SET_CONFIG)).toBe(false);
      expect(isSetComplete(26, 25, REGULAR_SET_CONFIG)).toBe(false);
      expect(isSetComplete(26, 24, REGULAR_SET_CONFIG)).toBe(true);
      expect(isSetComplete(27, 25, REGULAR_SET_CONFIG)).toBe(true);
      expect(isSetComplete(30, 28, REGULAR_SET_CONFIG)).toBe(true);
    });
  });

  describe('isSetComplete - Tiebreak Set (15 points)', () => {
    it('should return false when neither team reached 15', () => {
      expect(isSetComplete(14, 13, TIEBREAK_SET_CONFIG)).toBe(false);
      expect(isSetComplete(10, 10, TIEBREAK_SET_CONFIG)).toBe(false);
    });

    it('should return true when one team reaches 15 with lead of 2+', () => {
      expect(isSetComplete(15, 13, TIEBREAK_SET_CONFIG)).toBe(true);
      expect(isSetComplete(13, 15, TIEBREAK_SET_CONFIG)).toBe(true);
      expect(isSetComplete(15, 10, TIEBREAK_SET_CONFIG)).toBe(true);
    });

    it('should return false when one team reaches 15 but lead is only 1', () => {
      expect(isSetComplete(15, 14, TIEBREAK_SET_CONFIG)).toBe(false);
    });

    it('should handle tiebreak deuce situations', () => {
      expect(isSetComplete(15, 15, TIEBREAK_SET_CONFIG)).toBe(false);
      expect(isSetComplete(16, 15, TIEBREAK_SET_CONFIG)).toBe(false);
      expect(isSetComplete(16, 14, TIEBREAK_SET_CONFIG)).toBe(true);
      expect(isSetComplete(20, 18, TIEBREAK_SET_CONFIG)).toBe(true);
    });
  });

  describe('getSetWinner', () => {
    it('should return null when set is not complete', () => {
      expect(getSetWinner(24, 23, REGULAR_SET_CONFIG)).toBeNull();
      expect(getSetWinner(25, 24, REGULAR_SET_CONFIG)).toBeNull();
    });

    it('should return the correct winner for regular sets', () => {
      expect(getSetWinner(25, 23, REGULAR_SET_CONFIG)).toBe('A');
      expect(getSetWinner(23, 25, REGULAR_SET_CONFIG)).toBe('B');
      expect(getSetWinner(27, 25, REGULAR_SET_CONFIG)).toBe('A');
    });

    it('should return the correct winner for tiebreak sets', () => {
      expect(getSetWinner(15, 13, TIEBREAK_SET_CONFIG)).toBe('A');
      expect(getSetWinner(13, 15, TIEBREAK_SET_CONFIG)).toBe('B');
      expect(getSetWinner(17, 15, TIEBREAK_SET_CONFIG)).toBe('A');
    });
  });

  describe('isMatchComplete', () => {
    it('should return false when no team has won 3 sets', () => {
      expect(isMatchComplete(['A', 'B'])).toBe(false);
      expect(isMatchComplete(['A', 'B', 'A'])).toBe(false);
      expect(isMatchComplete(['A', 'A', 'B', 'B'])).toBe(false);
    });

    it('should return true when team A wins 3 sets', () => {
      expect(isMatchComplete(['A', 'A', 'A'])).toBe(true);
      expect(isMatchComplete(['A', 'B', 'A', 'A'])).toBe(true);
      expect(isMatchComplete(['B', 'A', 'A', 'B', 'A'])).toBe(true);
    });

    it('should return true when team B wins 3 sets', () => {
      expect(isMatchComplete(['B', 'B', 'B'])).toBe(true);
      expect(isMatchComplete(['B', 'A', 'B', 'B'])).toBe(true);
      expect(isMatchComplete(['A', 'B', 'B', 'A', 'B'])).toBe(true);
    });
  });

  describe('getMatchWinner', () => {
    it('should return null when match is not complete', () => {
      expect(getMatchWinner(['A', 'B'])).toBeNull();
      expect(getMatchWinner(['A', 'A', 'B', 'B'])).toBeNull();
    });

    it('should return A when team A wins', () => {
      expect(getMatchWinner(['A', 'A', 'A'])).toBe('A');
      expect(getMatchWinner(['A', 'B', 'A', 'A'])).toBe('A');
      expect(getMatchWinner(['B', 'A', 'A', 'B', 'A'])).toBe('A');
    });

    it('should return B when team B wins', () => {
      expect(getMatchWinner(['B', 'B', 'B'])).toBe('B');
      expect(getMatchWinner(['B', 'A', 'B', 'B'])).toBe('B');
      expect(getMatchWinner(['A', 'B', 'B', 'A', 'B'])).toBe('B');
    });
  });

  describe('isTiebreakSet', () => {
    it('should return false for sets 1-4', () => {
      expect(isTiebreakSet(1)).toBe(false);
      expect(isTiebreakSet(2)).toBe(false);
      expect(isTiebreakSet(3)).toBe(false);
      expect(isTiebreakSet(4)).toBe(false);
    });

    it('should return true for set 5', () => {
      expect(isTiebreakSet(5)).toBe(true);
    });
  });
});
