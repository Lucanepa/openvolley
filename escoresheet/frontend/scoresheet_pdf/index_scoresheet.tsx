import React from 'react';
import ReactDOM from 'react-dom/client';
import Dexie from 'dexie';
import { useLiveQuery } from 'dexie-react-hooks';
import App from './App_Scoresheet';

// Initialize Dexie database (same as main app)
const db = new Dexie('escoresheet');
db.version(11).stores({
  teams: '++id,name,createdAt',
  players: '++id,teamId,number,name,role,createdAt',
  matches: '++id,homeTeamId,awayTeamId,scheduledAt,status,createdAt,externalId,test',
  sets: '++id,matchId,index,homePoints,awayPoints,finished,startTime,endTime',
  events: '++id,matchId,setIndex,ts,type,payload,seq',
  sync_queue: '++id,resource,action,payload,ts,status',
  match_setup: '++id,updatedAt',
  referees: '++id,seedKey,lastName,createdAt',
  scorers: '++id,seedKey,lastName,createdAt'
});

// Helper function to send errors to parent window
const sendErrorToParent = (error: Error | string, details?: string) => {
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage({
        type: 'SCORESHEET_ERROR',
        error: typeof error === 'string' ? error : error.message,
        details: details || (error instanceof Error ? error.stack : ''),
        stack: error instanceof Error ? error.stack : undefined
      }, '*');
    }
  } catch (e) {
    console.error('Failed to send error to parent:', e);
  }
};

// Global error handler
window.addEventListener('error', (event) => {
  sendErrorToParent(event.error || new Error(event.message), event.filename + ':' + event.lineno);
});

// Unhandled promise rejection handler
window.addEventListener('unhandledrejection', (event) => {
  const error = event.reason instanceof Error ? event.reason : new Error(String(event.reason));
  sendErrorToParent(error);
});

// Load match data from sessionStorage (for initial load and fallback)
const loadMatchData = () => {
  try {
    const dataStr = sessionStorage.getItem('scoresheetData');
    if (!dataStr) {
      return null;
    }
    const data = JSON.parse(dataStr);
    // Don't remove from sessionStorage - we need matchId for live queries
    return data;
  } catch (error) {
    console.error('Error loading scoresheet data:', error);
    sendErrorToParent(error instanceof Error ? error : new Error(String(error)));
    return null;
  }
};

// Get action from URL parameters (preview, print, save)
const getActionFromUrl = (): 'preview' | 'print' | 'save' => {
  const params = new URLSearchParams(window.location.search);
  const action = params.get('action');
  if (action === 'print' || action === 'save') {
    return action;
  }
  return 'preview';
};

const initialAction = getActionFromUrl();

// Live scoresheet component that updates in real-time from IndexedDB
const LiveScoresheet: React.FC<{ initialMatchData: any; action: 'preview' | 'print' | 'save' }> = ({ initialMatchData, action }) => {
  const matchId = initialMatchData?.match?.id;

  // Use live queries to get real-time data from IndexedDB
  // useLiveQuery returns undefined while loading, null/result after query completes
  const match = useLiveQuery(
    async () => {
      if (!matchId) return null;
      const result = await (db as any).matches.get(matchId);
      return result || null; // Return null if not found (deleted)
    },
    [matchId]
  );

  // Track if initial load is complete (match query has run at least once)
  const isMatchLoading = match === undefined;
  const isMatchDeleted = match === null && !isMatchLoading;

  const homeTeam = useLiveQuery(
    async () => {
      // Use live match data, not initial data
      if (!match?.homeTeamId) return null;
      return await (db as any).teams.get(match.homeTeamId);
    },
    [match]
  );

  const awayTeam = useLiveQuery(
    async () => {
      // Use live match data, not initial data
      if (!match?.awayTeamId) return null;
      return await (db as any).teams.get(match.awayTeamId);
    },
    [match]
  );

  const homePlayers = useLiveQuery(
    async () => {
      // Use live match data, not initial data
      if (!match?.homeTeamId) return [];
      return await (db as any).players.where('teamId').equals(match.homeTeamId).toArray();
    },
    [match]
  );

  const awayPlayers = useLiveQuery(
    async () => {
      // Use live match data, not initial data
      if (!match?.awayTeamId) return [];
      return await (db as any).players.where('teamId').equals(match.awayTeamId).toArray();
    },
    [match]
  );

  const sets = useLiveQuery(
    async () => {
      if (!matchId || isMatchDeleted) return [];
      return await (db as any).sets.where('matchId').equals(matchId).sortBy('index');
    },
    [matchId, isMatchDeleted]
  );

  const events = useLiveQuery(
    async () => {
      if (!matchId || isMatchDeleted) return [];
      return await (db as any).events.where('matchId').equals(matchId).sortBy('seq');
    },
    [matchId, isMatchDeleted]
  );

  // Show loading state while initial data is being fetched
  if (isMatchLoading) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        fontFamily: 'system-ui, sans-serif'
      }}>
        <div style={{ fontSize: '18px', color: '#666' }}>Loading scoresheet...</div>
      </div>
    );
  }

  // Build match data from live queries (use empty values if match is deleted)
  const liveMatchData = {
    match: match || {},
    homeTeam: homeTeam || null,
    awayTeam: awayTeam || null,
    homePlayers: homePlayers || [],
    awayPlayers: awayPlayers || [],
    sets: sets || [],
    events: events || [],
    sanctions: []
  };

  return <App matchData={liveMatchData} autoAction={action} />;
};

// Static scoresheet component (fallback when no matchId available)
const StaticScoresheet: React.FC<{ matchData: any; action: 'preview' | 'print' | 'save' }> = ({ matchData, action }) => {
  return <App matchData={matchData} autoAction={action} />;
};

const initialMatchData = loadMatchData();

const rootElement = document.getElementById('root');
if (!rootElement) {
  const error = new Error("Could not find root element to mount to");
  sendErrorToParent(error);
  throw error;
}

const root = ReactDOM.createRoot(rootElement);

// Error boundary component
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Scoresheet Error Boundary caught:', error, errorInfo);
    sendErrorToParent(error, errorInfo.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          flexDirection: 'column',
          gap: '20px',
          fontFamily: 'system-ui, sans-serif',
          padding: '20px'
        }}>
          <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#ef4444' }}>
            Scoresheet Error
          </div>
          <div style={{ color: '#666', textAlign: 'center', maxWidth: '600px' }}>
            {this.state.error?.message || 'An error occurred while rendering the scoresheet'}
          </div>
          {this.state.error?.stack && (
            <details style={{
              width: '100%',
              maxWidth: '800px',
              background: '#1e293b',
              padding: '12px',
              borderRadius: '6px',
              color: '#cbd5e1',
              fontFamily: 'monospace',
              fontSize: '12px'
            }}>
              <summary style={{ cursor: 'pointer', marginBottom: '8px' }}>Error Details</summary>
              <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }}>
                {this.state.error.stack}
              </pre>
            </details>
          )}
          <button
            onClick={() => window.close()}
            style={{
              padding: '10px 20px',
              fontSize: '16px',
              background: '#3b82f6',
              color: 'white',
              border: 'none',
              borderRadius: '8px',
              cursor: 'pointer'
            }}
          >
            Close Window
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

if (initialMatchData) {
  try {
    // Check if we have a matchId for live updates
    const hasMatchId = initialMatchData?.match?.id;

    root.render(
      <React.StrictMode>
        <ErrorBoundary>
          {hasMatchId ? (
            <LiveScoresheet initialMatchData={initialMatchData} action={initialAction} />
          ) : (
            <StaticScoresheet matchData={initialMatchData} action={initialAction} />
          )}
        </ErrorBoundary>
      </React.StrictMode>
    );
  } catch (error) {
    console.error('Error rendering scoresheet:', error);
    sendErrorToParent(error instanceof Error ? error : new Error(String(error)));
    root.render(
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        flexDirection: 'column',
        gap: '20px',
        fontFamily: 'system-ui, sans-serif'
      }}>
        <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#ef4444' }}>
          Rendering Error
        </div>
        <div style={{ color: '#666' }}>
          {error instanceof Error ? error.message : String(error)}
        </div>
        <button
          onClick={() => window.close()}
          style={{
            padding: '10px 20px',
            fontSize: '16px',
            background: '#3b82f6',
            color: 'white',
            border: 'none',
            borderRadius: '8px',
            cursor: 'pointer'
          }}
        >
          Close Window
        </button>
      </div>
    );
  }
} else {
  root.render(
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100vh',
      flexDirection: 'column',
      gap: '20px',
      fontFamily: 'system-ui, sans-serif'
    }}>
      <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#ef4444' }}>
        No Match Data Found
      </div>
      <div style={{ color: '#666' }}>
        Please generate the scoresheet from the match end screen.
      </div>
      <button
        onClick={() => window.close()}
        style={{
          padding: '10px 20px',
          fontSize: '16px',
          background: '#3b82f6',
          color: 'white',
          border: 'none',
          borderRadius: '8px',
          cursor: 'pointer'
        }}
      >
        Close Window
      </button>
    </div>
  );
}
