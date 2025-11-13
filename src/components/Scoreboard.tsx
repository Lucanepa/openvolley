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

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { db, type Match, type Player, type SetScore, type Substitution } from '../db/database';
import { 
  isSetComplete, 
  getSetWinner, 
  isMatchComplete, 
  getMatchWinner,
  isTiebreakSet,
  REGULAR_SET_CONFIG,
  TIEBREAK_SET_CONFIG,
} from '../lib/volleyballRules';
import { exportMatchToPDF } from '../lib/pdfExport';
import { LineupDialog } from './LineupDialog';
import { SubstitutionDialog } from './SubstitutionDialog';
import { supabase, isSupabaseConfigured } from '../db/supabase';

const MAX_SUBSTITUTIONS_PER_SET = 6;

export function Scoreboard() {
  const { t, i18n } = useTranslation();
  const [currentMatch, setCurrentMatch] = useState<Match | null>(null);
  const [currentSet, setCurrentSet] = useState<SetScore>({
    setNumber: 1,
    teamAScore: 0,
    teamBScore: 0,
    isTiebreak: false,
  });
  const [teamAPlayers, setTeamAPlayers] = useState<Player[]>([]);
  const [teamBPlayers, setTeamBPlayers] = useState<Player[]>([]);
  const [substitutions, setSubstitutions] = useState<Substitution[]>([]);
  const [lineupDialogOpen, setLineupDialogOpen] = useState<{ open: boolean; team: 'A' | 'B' | null }>({ open: false, team: null });
  const [subDialogOpen, setSubDialogOpen] = useState<{ open: boolean; team: 'A' | 'B' | null }>({ open: false, team: null });
  const [isSyncing, setIsSyncing] = useState(false);

  const handleRealtimeUpdate = async (payload: unknown) => {
    console.log('Realtime update:', payload);
    setIsSyncing(true);
    // Handle sync from Supabase
    setTimeout(() => setIsSyncing(false), 1000);
  };

  const initMatch = () => {
    const match: Match = {
      teamAName: t('scoreboard.teamA'),
      teamBName: t('scoreboard.teamB'),
      sets: [],
      startTime: Date.now(),
    };
    setCurrentMatch(match);
  };

  useEffect(() => {
    initMatch();
    
    // Setup Supabase realtime if configured
    if (isSupabaseConfigured && supabase) {
      const channel = supabase
        .channel('matches')
        .on('postgres_changes', 
          { event: '*', schema: 'public', table: 'matches' }, 
          handleRealtimeUpdate
        )
        .subscribe();

      return () => {
        if (supabase) {
          supabase.removeChannel(channel);
        }
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addPoint = (team: 'A' | 'B') => {
    if (!currentMatch) return;

    const newSet = { ...currentSet };
    if (team === 'A') {
      newSet.teamAScore++;
    } else {
      newSet.teamBScore++;
    }

    const config = newSet.isTiebreak ? TIEBREAK_SET_CONFIG : REGULAR_SET_CONFIG;
    
    if (isSetComplete(newSet.teamAScore, newSet.teamBScore, config)) {
      newSet.winner = getSetWinner(newSet.teamAScore, newSet.teamBScore, config) || undefined;
      const updatedSets = [...currentMatch.sets, newSet];
      
      const updatedMatch = { ...currentMatch, sets: updatedSets };
      
      if (isMatchComplete(updatedSets.map(s => s.winner || null))) {
        updatedMatch.endTime = Date.now();
      }
      
      setCurrentMatch(updatedMatch);
      saveMatch(updatedMatch);
      
      // Start new set if match not complete
      if (!updatedMatch.endTime) {
        const nextSetNumber = newSet.setNumber + 1;
        setCurrentSet({
          setNumber: nextSetNumber,
          teamAScore: 0,
          teamBScore: 0,
          isTiebreak: isTiebreakSet(nextSetNumber),
        });
        setSubstitutions([]); // Reset substitutions for new set
      }
    } else {
      setCurrentSet(newSet);
    }
  };

  const saveMatch = async (match: Match) => {
    try {
      const id = await db.matches.add(match);
      console.log('Match saved to IndexedDB:', id);
      
      // Sync to Supabase if configured
      if (isSupabaseConfigured && supabase) {
        setIsSyncing(true);
        const { error } = await supabase.from('matches').insert({
          ...match,
          id: undefined, // Let Supabase generate ID
        });
        if (error) {
          console.error('Supabase sync error:', error);
        } else {
          console.log('Match synced to Supabase');
          await db.matches.update(id, { syncedAt: Date.now() });
        }
        setIsSyncing(false);
      }
    } catch (error) {
      console.error('Error saving match:', error);
    }
  };

  const newMatch = () => {
    initMatch();
    setCurrentSet({
      setNumber: 1,
      teamAScore: 0,
      teamBScore: 0,
      isTiebreak: false,
    });
    setSubstitutions([]);
  };

  const resetSet = () => {
    setCurrentSet({
      ...currentSet,
      teamAScore: 0,
      teamBScore: 0,
    });
  };

  const handleExportPDF = () => {
    if (currentMatch) {
      exportMatchToPDF(currentMatch);
    }
  };

  const handleSaveLineup = async (players: Player[]) => {
    try {
      // Clear existing players for this team
      const team = lineupDialogOpen.team;
      if (team === 'A') {
        await db.players.where('teamId').equals('A').delete();
        await db.players.bulkAdd(players);
        setTeamAPlayers(players);
      } else if (team === 'B') {
        await db.players.where('teamId').equals('B').delete();
        await db.players.bulkAdd(players);
        setTeamBPlayers(players);
      }
    } catch (error) {
      console.error('Error saving lineup:', error);
    }
  };

  const handleExecuteSubstitution = async (playerOut: number, playerIn: number) => {
    if (!currentMatch?.id) return;
    
    const sub: Substitution = {
      matchId: currentMatch.id,
      setNumber: currentSet.setNumber,
      team: subDialogOpen.team!,
      playerOut,
      playerIn,
      timestamp: Date.now(),
    };
    
    try {
      await db.substitutions.add(sub);
      setSubstitutions([...substitutions, sub]);
    } catch (error) {
      console.error('Error recording substitution:', error);
    }
  };

  const getRemainingSubstitutions = (team: 'A' | 'B') => {
    const currentSetSubs = substitutions.filter(
      s => s.setNumber === currentSet.setNumber && s.team === team
    );
    return MAX_SUBSTITUTIONS_PER_SET - currentSetSubs.length;
  };

  const changeLanguage = (lng: string) => {
    i18n.changeLanguage(lng);
  };

  if (!currentMatch) return null;

  const matchWinner = getMatchWinner(currentMatch.sets.map(s => s.winner || null));
  const teamASets = currentMatch.sets.filter(s => s.winner === 'A').length;
  const teamBSets = currentMatch.sets.filter(s => s.winner === 'B').length;

  return (
    <div style={{ padding: '20px', fontFamily: 'Arial, sans-serif' }}>
      {/* Language Selector */}
      <div style={{ position: 'absolute', top: 10, left: 10, display: 'flex', gap: '8px' }}>
        <button onClick={() => changeLanguage('en')} style={langButtonStyle}>EN</button>
        <button onClick={() => changeLanguage('de')} style={langButtonStyle}>DE</button>
        <button onClick={() => changeLanguage('it')} style={langButtonStyle}>IT</button>
      </div>

      {/* Sync Status */}
      {isSyncing && (
        <div style={{ position: 'fixed', top: 50, right: 10, padding: '8px 16px', backgroundColor: '#ff9800', color: 'white', borderRadius: '4px', fontSize: '14px' }}>
          {t('status.syncing')}
        </div>
      )}

      <h1 style={{ textAlign: 'center', marginTop: '40px' }}>{t('app.title')}</h1>
      <h2 style={{ textAlign: 'center', color: '#666' }}>{t('app.subtitle')}</h2>

      {/* Match Status */}
      <div style={{ textAlign: 'center', margin: '20px 0' }}>
        {matchWinner ? (
          <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#4caf50' }}>
            {t('match.complete')} - {t('match.winner', { team: matchWinner === 'A' ? currentMatch.teamAName : currentMatch.teamBName })}
          </div>
        ) : (
          <div style={{ fontSize: '18px', color: '#2196f3' }}>
            {t('match.inProgress')} - {currentSet.isTiebreak ? t('match.tiebreak') : t('match.regular')}
          </div>
        )}
      </div>

      {/* Scoreboard */}
      <div style={{ display: 'flex', justifyContent: 'center', gap: '40px', margin: '40px 0' }}>
        {/* Team A */}
        <div style={{ textAlign: 'center' }}>
          <h2>{currentMatch.teamAName}</h2>
          <div style={{ fontSize: '72px', fontWeight: 'bold', color: '#2196f3' }}>
            {currentSet.teamAScore}
          </div>
          <div style={{ fontSize: '24px', marginTop: '10px' }}>
            {t('scoreboard.sets')}: {teamASets}
          </div>
          <button onClick={() => addPoint('A')} style={scoreButtonStyle} disabled={!!matchWinner}>
            +1
          </button>
          <div style={{ marginTop: '16px', display: 'flex', gap: '8px', justifyContent: 'center' }}>
            <button onClick={() => setLineupDialogOpen({ open: true, team: 'A' })} style={smallButtonStyle}>
              {t('scoreboard.lineup')}
            </button>
            <button onClick={() => setSubDialogOpen({ open: true, team: 'A' })} style={smallButtonStyle}>
              {t('scoreboard.substitution')}
            </button>
          </div>
        </div>

        {/* Team B */}
        <div style={{ textAlign: 'center' }}>
          <h2>{currentMatch.teamBName}</h2>
          <div style={{ fontSize: '72px', fontWeight: 'bold', color: '#f44336' }}>
            {currentSet.teamBScore}
          </div>
          <div style={{ fontSize: '24px', marginTop: '10px' }}>
            {t('scoreboard.sets')}: {teamBSets}
          </div>
          <button onClick={() => addPoint('B')} style={scoreButtonStyle} disabled={!!matchWinner}>
            +1
          </button>
          <div style={{ marginTop: '16px', display: 'flex', gap: '8px', justifyContent: 'center' }}>
            <button onClick={() => setLineupDialogOpen({ open: true, team: 'B' })} style={smallButtonStyle}>
              {t('scoreboard.lineup')}
            </button>
            <button onClick={() => setSubDialogOpen({ open: true, team: 'B' })} style={smallButtonStyle}>
              {t('scoreboard.substitution')}
            </button>
          </div>
        </div>
      </div>

      {/* Sets History */}
      {currentMatch.sets.length > 0 && (
        <div style={{ margin: '40px auto', maxWidth: '600px' }}>
          <h3>{t('scoreboard.sets')} {t('match.complete')}</h3>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #ccc' }}>
                <th style={{ padding: '8px' }}>{t('scoreboard.set')}</th>
                <th style={{ padding: '8px' }}>{currentMatch.teamAName}</th>
                <th style={{ padding: '8px' }}>{currentMatch.teamBName}</th>
                <th style={{ padding: '8px' }}>Winner</th>
              </tr>
            </thead>
            <tbody>
              {currentMatch.sets.map((set, idx) => (
                <tr key={idx} style={{ borderBottom: '1px solid #eee' }}>
                  <td style={{ padding: '8px', textAlign: 'center' }}>
                    {set.setNumber}{set.isTiebreak ? ' (TB)' : ''}
                  </td>
                  <td style={{ padding: '8px', textAlign: 'center' }}>{set.teamAScore}</td>
                  <td style={{ padding: '8px', textAlign: 'center' }}>{set.teamBScore}</td>
                  <td style={{ padding: '8px', textAlign: 'center' }}>
                    {set.winner === 'A' ? currentMatch.teamAName : currentMatch.teamBName}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Controls */}
      <div style={{ display: 'flex', justifyContent: 'center', gap: '16px', marginTop: '40px' }}>
        <button onClick={newMatch} style={buttonStyle}>
          {t('scoreboard.newMatch')}
        </button>
        <button onClick={resetSet} style={buttonStyle} disabled={!!matchWinner}>
          {t('scoreboard.resetSet')}
        </button>
        <button onClick={handleExportPDF} style={buttonStyle}>
          {t('scoreboard.exportPDF')}
        </button>
      </div>

      {/* Dialogs */}
      <LineupDialog
        isOpen={lineupDialogOpen.open}
        onClose={() => setLineupDialogOpen({ open: false, team: null })}
        team={lineupDialogOpen.team || 'A'}
        teamName={lineupDialogOpen.team === 'A' ? currentMatch.teamAName : currentMatch.teamBName}
        players={lineupDialogOpen.team === 'A' ? teamAPlayers : teamBPlayers}
        onSave={handleSaveLineup}
      />
      
      <SubstitutionDialog
        isOpen={subDialogOpen.open}
        onClose={() => setSubDialogOpen({ open: false, team: null })}
        team={subDialogOpen.team || 'A'}
        teamName={subDialogOpen.team === 'A' ? currentMatch.teamAName : currentMatch.teamBName}
        players={subDialogOpen.team === 'A' ? teamAPlayers : teamBPlayers}
        remainingSubstitutions={getRemainingSubstitutions(subDialogOpen.team || 'A')}
        onExecute={handleExecuteSubstitution}
      />
    </div>
  );
}

const scoreButtonStyle: React.CSSProperties = {
  fontSize: '32px',
  padding: '16px 32px',
  marginTop: '20px',
  borderRadius: '8px',
  border: 'none',
  backgroundColor: '#4caf50',
  color: 'white',
  cursor: 'pointer',
  fontWeight: 'bold',
};

const buttonStyle: React.CSSProperties = {
  padding: '12px 24px',
  fontSize: '16px',
  borderRadius: '4px',
  border: 'none',
  backgroundColor: '#2196f3',
  color: 'white',
  cursor: 'pointer',
};

const smallButtonStyle: React.CSSProperties = {
  padding: '8px 16px',
  fontSize: '14px',
  borderRadius: '4px',
  border: '1px solid #2196f3',
  backgroundColor: 'white',
  color: '#2196f3',
  cursor: 'pointer',
};

const langButtonStyle: React.CSSProperties = {
  padding: '4px 8px',
  fontSize: '12px',
  borderRadius: '4px',
  border: '1px solid #ccc',
  backgroundColor: 'white',
  cursor: 'pointer',
};
