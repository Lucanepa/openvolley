import React from 'react';
import ReactDOM from 'react-dom/client';
import Dexie from 'dexie';
import { useLiveQuery } from 'dexie-react-hooks';
import App from './App_Scoresheet';

// Initialize Dexie database (same as main app)
import { db } from '../src/db/db';

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

// Check if we're loading from storage URL parameters
const getStorageParams = () => {
  const params = new URLSearchParams(window.location.search);
  const date = params.get('date');
  const game = params.get('game');
  if (date && game) {
    return { date, game };
  }
  return null;
};

// Check if matchId is passed via URL parameter
const getMatchIdFromUrl = () => {
  const params = new URLSearchParams(window.location.search);
  return params.get('matchId');
};

// Check if we should show the list view
const shouldShowList = () => {
  const params = new URLSearchParams(window.location.search);
  return params.has('list') || window.location.pathname.includes('/storage');
};

// Scoresheet item type for the list
interface ScoresheetItem {
  date: string;
  game: string;
  path: string;
  homeTeam?: string;
  awayTeam?: string;
  finalScore?: string;
  uploadedAt?: string;
}

// Fetch scoresheet data from Supabase storage
const fetchFromStorage = async (date: string, game: string): Promise<any | null> => {
  try {
    // Import supabase client dynamically to avoid circular dependencies
    const { supabase } = await import('../src/lib/supabaseClient');
    if (!supabase) {
      console.error('Supabase client not available');
      return null;
    }

    const storagePath = `${date}/game${game}.json`;
    console.log('[Scoresheet] Fetching from storage:', storagePath);

    const { data, error } = await supabase.storage
      .from('scoresheets')
      .download(storagePath);

    if (error) {
      console.error('[Scoresheet] Storage fetch error:', error);
      return null;
    }

    const text = await data.text();
    return JSON.parse(text);
  } catch (error) {
    console.error('[Scoresheet] Error fetching from storage:', error);
    return null;
  }
};

// Fetch all scoresheets from storage
const fetchAllScoresheets = async (): Promise<ScoresheetItem[]> => {
  try {
    const { supabase } = await import('../src/lib/supabaseClient');
    if (!supabase) {
      console.error('Supabase client not available');
      return [];
    }

    // List all folders (dates) in the scoresheets bucket
    const { data: folders, error: foldersError } = await supabase.storage
      .from('scoresheets')
      .list('', { limit: 100, sortBy: { column: 'name', order: 'desc' } });

    if (foldersError) {
      console.error('[Scoresheet] Error listing folders:', foldersError);
      return [];
    }

    const scoresheets: ScoresheetItem[] = [];

    // For each date folder, list the game files
    for (const folder of folders || []) {
      if (!folder.name || folder.name.startsWith('.')) continue;

      const { data: files, error: filesError } = await supabase.storage
        .from('scoresheets')
        .list(folder.name, { limit: 50 });

      if (filesError) {
        console.error(`[Scoresheet] Error listing files in ${folder.name}:`, filesError);
        continue;
      }

      for (const file of files || []) {
        if (!file.name.endsWith('.json')) continue;

        // Extract game number from filename (game123.json -> 123)
        const gameMatch = file.name.match(/game(\d+)\.json/);
        if (!gameMatch) continue;

        scoresheets.push({
          date: folder.name,
          game: gameMatch[1],
          path: `${folder.name}/${file.name}`
        });
      }
    }

    // Fetch metadata for each scoresheet (team names, score)
    // Do this in parallel but limit concurrency
    const enrichedScoresheets = await Promise.all(
      scoresheets.slice(0, 50).map(async (item) => {
        try {
          const { data, error } = await supabase.storage
            .from('scoresheets')
            .download(item.path);

          if (error || !data) return item;

          const text = await data.text();
          const json = JSON.parse(text);

          return {
            ...item,
            homeTeam: json.homeTeam?.name || json.match?.homeTeamName || 'Team A',
            awayTeam: json.awayTeam?.name || json.match?.awayTeamName || 'Team B',
            finalScore: json.match?.final_score || '',
            uploadedAt: json.uploadedAt
          };
        } catch {
          return item;
        }
      })
    );

    return enrichedScoresheets;
  } catch (error) {
    console.error('[Scoresheet] Error fetching scoresheets:', error);
    return [];
  }
};

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

// Get action from URL parameters (preview, print, save, getBlob)
const getActionFromUrl = (): 'preview' | 'print' | 'save' | 'getBlob' => {
  const params = new URLSearchParams(window.location.search);
  const action = params.get('action');
  if (action === 'print' || action === 'save' || action === 'getBlob') {
    return action;
  }
  return 'preview';
};

const initialAction = getActionFromUrl();

// Live scoresheet component that updates in real-time from IndexedDB
const LiveScoresheet: React.FC<{ initialMatchData: any; action: 'preview' | 'print' | 'save' | 'getBlob' }> = ({ initialMatchData, action }) => {
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
const StaticScoresheet: React.FC<{ matchData: any; action: 'preview' | 'print' | 'save' | 'getBlob' }> = ({ matchData, action }) => {
  return <App matchData={matchData} autoAction={action} />;
};

// URL matchId scoresheet component - loads from IndexedDB by matchId
const UrlMatchIdScoresheet: React.FC<{ matchId: string; action: 'preview' | 'print' | 'save' | 'getBlob' }> = ({ matchId, action }) => {
  // Use the LiveScoresheet component with a minimal initial data object
  const initialData = { match: { id: matchId } };
  return <LiveScoresheet initialMatchData={initialData} action={action} />;
};

// Storage scoresheet component - fetches from Supabase storage
const StorageScoresheet: React.FC<{ date: string; game: string; action: 'preview' | 'print' | 'save' | 'getBlob' }> = ({ date, game, action }) => {
  const [matchData, setMatchData] = React.useState<any>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const loadData = async () => {
      try {
        const data = await fetchFromStorage(date, game);
        if (data) {
          setMatchData(data);
        } else {
          setError(`Scoresheet not found: ${date}/game${game}.json`);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load scoresheet');
      } finally {
        setLoading(false);
      }
    };
    loadData();
  }, [date, game]);

  if (loading) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        fontFamily: 'system-ui, sans-serif'
      }}>
        <div style={{ fontSize: '18px', color: '#666' }}>Loading scoresheet from storage...</div>
      </div>
    );
  }

  if (error) {
    return (
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
          Scoresheet Not Found
        </div>
        <div style={{ color: '#666' }}>{error}</div>
      </div>
    );
  }

  return <App matchData={matchData} autoAction={action} />;
};

// Scoresheet list component - shows all available scoresheets
const ScoresheetList: React.FC = () => {
  const [scoresheets, setScoresheets] = React.useState<ScoresheetItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const loadList = async () => {
      try {
        const items = await fetchAllScoresheets();
        setScoresheets(items);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load scoresheets');
      } finally {
        setLoading(false);
      }
    };
    loadList();
  }, []);

  const handleView = (item: ScoresheetItem) => {
    window.location.href = `?date=${item.date}&game=${item.game}`;
  };

  const handleDownload = async (item: ScoresheetItem) => {
    // Open in new tab with save action
    window.open(`?date=${item.date}&game=${item.game}&action=save`, '_blank');
  };

  // Group scoresheets by date
  const groupedByDate = scoresheets.reduce((acc, item) => {
    if (!acc[item.date]) acc[item.date] = [];
    acc[item.date].push(item);
    return acc;
  }, {} as Record<string, ScoresheetItem[]>);

  const formatDate = (dateStr: string) => {
    try {
      const date = new Date(dateStr + 'T12:00:00');
      return date.toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });
    } catch {
      return dateStr;
    }
  };

  if (loading) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        fontFamily: 'system-ui, sans-serif'
      }}>
        <div style={{ fontSize: '18px', color: '#666' }}>Loading scoresheets...</div>
      </div>
    );
  }

  if (error) {
    return (
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
          Error Loading Scoresheets
        </div>
        <div style={{ color: '#666' }}>{error}</div>
      </div>
    );
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: '#f8fafc',
      fontFamily: 'system-ui, sans-serif',
      padding: '20px'
    }}>
      <div style={{
        maxWidth: '800px',
        margin: '0 auto'
      }}>
        <h1 style={{
          fontSize: '28px',
          fontWeight: 'bold',
          color: '#1e293b',
          marginBottom: '8px'
        }}>
          Scoresheets
        </h1>
        <p style={{ color: '#64748b', marginBottom: '24px' }}>
          {scoresheets.length} scoresheet{scoresheets.length !== 1 ? 's' : ''} available
        </p>

        {scoresheets.length === 0 ? (
          <div style={{
            textAlign: 'center',
            padding: '60px 20px',
            background: 'white',
            borderRadius: '12px',
            border: '1px solid #e2e8f0'
          }}>
            <div style={{ fontSize: '48px', marginBottom: '16px' }}>📋</div>
            <div style={{ fontSize: '18px', color: '#64748b' }}>
              No scoresheets uploaded yet
            </div>
          </div>
        ) : (
          Object.entries(groupedByDate)
            .sort(([a], [b]) => b.localeCompare(a)) // Sort dates descending
            .map(([date, items]) => (
              <div key={date} style={{ marginBottom: '24px' }}>
                <h2 style={{
                  fontSize: '16px',
                  fontWeight: '600',
                  color: '#475569',
                  marginBottom: '12px',
                  paddingBottom: '8px',
                  borderBottom: '1px solid #e2e8f0'
                }}>
                  {formatDate(date)}
                </h2>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {items
                    .sort((a, b) => parseInt(a.game) - parseInt(b.game))
                    .map((item) => (
                      <div
                        key={item.path}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '16px',
                          background: 'white',
                          borderRadius: '8px',
                          border: '1px solid #e2e8f0',
                          transition: 'box-shadow 0.2s'
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.08)';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.boxShadow = 'none';
                        }}
                      >
                        <div style={{ flex: 1 }}>
                          <div style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '12px',
                            marginBottom: '4px'
                          }}>
                            <span style={{
                              fontSize: '12px',
                              fontWeight: '600',
                              color: '#3b82f6',
                              background: '#eff6ff',
                              padding: '2px 8px',
                              borderRadius: '4px'
                            }}>
                              Game {item.game}
                            </span>
                            {item.finalScore && (
                              <span style={{
                                fontSize: '14px',
                                fontWeight: '600',
                                color: '#059669'
                              }}>
                                {item.finalScore}
                              </span>
                            )}
                          </div>
                          <div style={{
                            fontSize: '15px',
                            fontWeight: '500',
                            color: '#1e293b'
                          }}>
                            {item.homeTeam || 'Team A'} vs {item.awayTeam || 'Team B'}
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: '8px' }}>
                          <button
                            onClick={() => handleView(item)}
                            style={{
                              padding: '8px 16px',
                              fontSize: '14px',
                              fontWeight: '500',
                              background: '#3b82f6',
                              color: 'white',
                              border: 'none',
                              borderRadius: '6px',
                              cursor: 'pointer'
                            }}
                          >
                            View
                          </button>
                          <button
                            onClick={() => handleDownload(item)}
                            style={{
                              padding: '8px 16px',
                              fontSize: '14px',
                              fontWeight: '500',
                              background: '#f1f5f9',
                              color: '#475569',
                              border: '1px solid #e2e8f0',
                              borderRadius: '6px',
                              cursor: 'pointer'
                            }}
                          >
                            Download PDF
                          </button>
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            ))
        )}
      </div>
    </div>
  );
};

const storageParams = getStorageParams();
const showList = shouldShowList();
const urlMatchId = getMatchIdFromUrl();
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

// Priority: 1. URL matchId param, 2. Storage params (?date=...&game=...), 3. List view (?list), 4. sessionStorage, 5. No data
if (urlMatchId) {
  // Load from IndexedDB using matchId from URL
  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <UrlMatchIdScoresheet matchId={urlMatchId} action={initialAction} />
      </ErrorBoundary>
    </React.StrictMode>
  );
} else if (storageParams) {
  // Load from Supabase storage
  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <StorageScoresheet
          date={storageParams.date}
          game={storageParams.game}
          action={initialAction}
        />
      </ErrorBoundary>
    </React.StrictMode>
  );
} else if (showList) {
  // Show list of all scoresheets
  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <ScoresheetList />
      </ErrorBoundary>
    </React.StrictMode>
  );
} else if (initialMatchData) {
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
