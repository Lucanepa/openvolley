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

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Player } from '../db/database';

interface SubstitutionDialogProps {
  isOpen: boolean;
  onClose: () => void;
  team: 'A' | 'B';
  teamName: string;
  players: Player[];
  remainingSubstitutions: number;
  onExecute: (playerOut: number, playerIn: number) => void;
}

export function SubstitutionDialog({
  isOpen,
  onClose,
  teamName,
  players,
  remainingSubstitutions,
  onExecute,
}: SubstitutionDialogProps) {
  const { t } = useTranslation();
  const [playerOut, setPlayerOut] = useState('');
  const [playerIn, setPlayerIn] = useState('');

  if (!isOpen) return null;

  const handleExecute = () => {
    if (playerOut && playerIn) {
      onExecute(parseInt(playerOut), parseInt(playerIn));
      setPlayerOut('');
      setPlayerIn('');
      onClose();
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        style={{
          backgroundColor: 'white',
          padding: '24px',
          borderRadius: '8px',
          maxWidth: '400px',
          width: '90%',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 style={{ marginTop: 0 }}>
          {t('substitution.title')} - {teamName}
        </h2>
        <p>
          {remainingSubstitutions > 0
            ? t('substitution.remaining', { count: remainingSubstitutions })
            : t('substitution.maxReached')}
        </p>
        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', marginBottom: '8px' }}>
            {t('substitution.playerOut')}
          </label>
          <select
            value={playerOut}
            onChange={(e) => setPlayerOut(e.target.value)}
            style={{
              width: '100%',
              padding: '8px',
              borderRadius: '4px',
              border: '1px solid #ccc',
            }}
            disabled={remainingSubstitutions === 0}
          >
            <option value="">Select player</option>
            {players.map((player) => (
              <option key={player.id} value={player.number}>
                #{player.number} - {player.name}
              </option>
            ))}
          </select>
        </div>
        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', marginBottom: '8px' }}>
            {t('substitution.playerIn')}
          </label>
          <select
            value={playerIn}
            onChange={(e) => setPlayerIn(e.target.value)}
            style={{
              width: '100%',
              padding: '8px',
              borderRadius: '4px',
              border: '1px solid #ccc',
            }}
            disabled={remainingSubstitutions === 0}
          >
            <option value="">Select player</option>
            {players.map((player) => (
              <option key={player.id} value={player.number}>
                #{player.number} - {player.name}
              </option>
            ))}
          </select>
        </div>
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button
            onClick={onClose}
            style={{
              padding: '8px 16px',
              borderRadius: '4px',
              border: '1px solid #ccc',
              backgroundColor: '#f0f0f0',
              cursor: 'pointer',
            }}
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleExecute}
            disabled={!playerOut || !playerIn || remainingSubstitutions === 0}
            style={{
              padding: '8px 16px',
              borderRadius: '4px',
              border: 'none',
              backgroundColor: playerOut && playerIn && remainingSubstitutions > 0 ? '#2196f3' : '#ccc',
              color: 'white',
              cursor: playerOut && playerIn && remainingSubstitutions > 0 ? 'pointer' : 'not-allowed',
            }}
          >
            {t('substitution.execute')}
          </button>
        </div>
      </div>
    </div>
  );
}
