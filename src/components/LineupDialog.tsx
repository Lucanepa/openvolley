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

interface LineupDialogProps {
  isOpen: boolean;
  onClose: () => void;
  team: 'A' | 'B';
  teamName: string;
  players: Player[];
  onSave: (players: Player[]) => void;
}

export function LineupDialog({
  isOpen,
  onClose,
  team,
  teamName,
  players: initialPlayers,
  onSave,
}: LineupDialogProps) {
  const { t } = useTranslation();
  const [players, setPlayers] = useState(initialPlayers);

  if (!isOpen) return null;

  const handleAddPlayer = () => {
    setPlayers([
      ...players,
      {
        teamId: team,
        number: players.length + 1,
        name: '',
        position: 'setter',
      },
    ]);
  };

  const handlePlayerChange = (index: number, field: keyof Player, value: string | number) => {
    const updated = [...players];
    updated[index] = { ...updated[index], [field]: value };
    setPlayers(updated);
  };

  const handleSave = () => {
    onSave(players);
    onClose();
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
          maxWidth: '600px',
          width: '90%',
          maxHeight: '80vh',
          overflow: 'auto',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 style={{ marginTop: 0 }}>
          {t('lineup.title')} - {teamName}
        </h2>
        <div style={{ marginBottom: '16px' }}>
          {players.map((player, index) => (
            <div
              key={index}
              style={{
                display: 'grid',
                gridTemplateColumns: '80px 1fr 150px',
                gap: '8px',
                marginBottom: '8px',
              }}
            >
              <input
                type="number"
                placeholder={t('lineup.number')}
                value={player.number}
                onChange={(e) =>
                  handlePlayerChange(index, 'number', parseInt(e.target.value) || 0)
                }
                style={{ padding: '8px', borderRadius: '4px', border: '1px solid #ccc' }}
              />
              <input
                type="text"
                placeholder={t('lineup.player')}
                value={player.name}
                onChange={(e) => handlePlayerChange(index, 'name', e.target.value)}
                style={{ padding: '8px', borderRadius: '4px', border: '1px solid #ccc' }}
              />
              <select
                value={player.position}
                onChange={(e) => handlePlayerChange(index, 'position', e.target.value)}
                style={{ padding: '8px', borderRadius: '4px', border: '1px solid #ccc' }}
              >
                <option value="setter">{t('lineup.positions.setter')}</option>
                <option value="oppositeHitter">{t('lineup.positions.oppositeHitter')}</option>
                <option value="outsideHitter">{t('lineup.positions.outsideHitter')}</option>
                <option value="middleBlocker">{t('lineup.positions.middleBlocker')}</option>
                <option value="libero">{t('lineup.positions.libero')}</option>
              </select>
            </div>
          ))}
        </div>
        <button
          onClick={handleAddPlayer}
          style={{
            padding: '8px 16px',
            marginRight: '8px',
            borderRadius: '4px',
            border: '1px solid #ccc',
            backgroundColor: '#f0f0f0',
            cursor: 'pointer',
          }}
        >
          {t('lineup.addPlayer')}
        </button>
        <div style={{ marginTop: '16px', display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
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
            onClick={handleSave}
            style={{
              padding: '8px 16px',
              borderRadius: '4px',
              border: 'none',
              backgroundColor: '#2196f3',
              color: 'white',
              cursor: 'pointer',
            }}
          >
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
