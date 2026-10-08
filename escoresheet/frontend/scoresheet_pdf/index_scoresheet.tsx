import React from 'react';
import ReactDOM from 'react-dom/client';
import './scoresheet.css'; // compiled Tailwind (was cdn.tailwindcss.com — broke offline)
import Dexie from 'dexie';
import { useLiveQuery } from 'dexie-react-hooks';
import '../src/i18n'; // App_Scoresheet calls useTranslation: this entry needs its own i18n init
import App from './App_Scoresheet';
import { describeScoresheetLoadError, findOwnScoresheet, parseScoresheetName, redactScoresheetPath, type ScoresheetLoadError } from './utils/scoresheetStorage';

// Initialize Dexie database (same as main app)
import { db } from '../src/db/db';
import { ClipboardIcon } from '../src/components/icons';
import { closeAppWindow, deliverPdfToOpener, getOpenerWindow, isInAppView } from '../src/utils/appWindowGuest';
import { openAppWindow } from '../src/utils/openAppWindow';
import { installPopupDiagnostics } from '../src/diagnostics';

// Diagnostics mode, in the desktop app's pop-up window only (opened from the
// scoretable): its lines go into the scoretable's diagnostics file
// (src/diagnostics/popupForward.js). Elsewhere this does nothing.
installPopupDiagnostics({ db, app: 'scoresheet' });

// Opened by the scorer app (a popup / app window, or the Android in-app view)?
const openedByTheApp = () => !!getOpenerWindow() || isInAppView();

// Back to the scorer app that opened this page: focus it, close this one.
const backToTheApp = () => {
  try { getOpenerWindow()?.focus(); } catch { /* ignore */ }
  closeAppWindow();
};

// Helper function to send errors to parent window
const sendErrorToParent = (error: Error | string, details?: string) => {
  try {
    // the opener (popup / desktop app window) or the app under the Android in-app view
    const opener = getOpenerWindow();
    if (opener) {
      opener.postMessage({
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

// Fetch scoresheet data from backend storage (/api/storage).
// Needs a signed-in session on this origin: apiClient sends the stored Bearer
// token. Only the account that uploaded a scoresheet may list or read it, and
// its name has a random part, so it is found by listing the date folder
// (approved game{n}_{key}_final.json first, else the in-match JSON).
// Returns { data } or { error } (storage error with status / code).
const fetchFromStorage = async (date: string, game: string): Promise<{ data: any | null, error: any | null }> => {
  try {
    // Import the backend storage client dynamically to avoid circular dependencies
    const { apiStorage } = await import('../src/lib/apiClient');
    const bucket = apiStorage.from('scoresheets');

    const found = await findOwnScoresheet(bucket, date, game, { final: false });
    if (found.error || !found.path) {
      console.warn('[Scoresheet] Storage lookup:', found.error?.code || found.error?.status, found.error?.message);
      return { data: null, error: found.error };
    }
    console.log('[Scoresheet] Fetching from storage:', redactScoresheetPath(found.path));

    const { data, error } = await bucket.download(found.path);
    if (error || !data) {
      console.warn('[Scoresheet] Storage fetch error:', error?.code || error?.status, error?.message);
      return { data: null, error };
    }

    const text = await data.text();
    return { data: JSON.parse(text), error: null };
  } catch (error) {
    console.error('[Scoresheet] Error fetching from storage:', error);
    return { data: null, error: { message: error instanceof Error ? error.message : 'Failed to load scoresheet' } };
  }
};

// Fetch all scoresheets from storage
const fetchAllScoresheets = async (): Promise<ScoresheetItem[]> => {
  try {
    const { apiStorage } = await import('../src/lib/apiClient');

    // List all folders (dates) in the scoresheets bucket
    const { data: folders, error: foldersError } = await apiStorage
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

      const { data: files, error: filesError } = await apiStorage
        .from('scoresheets')
        .list(folder.name, { limit: 50 });

      if (filesError) {
        console.error(`[Scoresheet] Error listing files in ${folder.name}:`, filesError);
        continue;
      }

      // One entry per game; the approved (_final) JSON wins over the in-match one.
      // The listing shows only this account's own files.
      const byGame = new Map<string, { path: string; final: boolean }>();
      for (const file of files || []) {
        // game123_k…_final.json / game123_k….json (older: game123_final.json) -> 123
        const parsed = file.id ? parseScoresheetName(file.name) : null;
        if (!parsed || parsed.ext !== 'json') continue;

        const final = parsed.final;
        const prev = byGame.get(parsed.game);
        if (prev && prev.final && !final) continue;
        byGame.set(parsed.game, { path: `${folder.name}/${file.name}`, final });
      }
      for (const [game, { path }] of byGame) {
        scoresheets.push({ date: folder.name, game, path });
      }
    }

    // Fetch metadata for each scoresheet (team names, score)
    // Do this in parallel but limit concurrency
    const enrichedScoresheets = await Promise.all(
      scoresheets.slice(0, 50).map(async (item) => {
        try {
          const { data, error } = await apiStorage
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

  // Version counter to force re-queries when notified of changes via BroadcastChannel
  const [refreshVersion, setRefreshVersion] = React.useState(0);

  React.useEffect(() => {
    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel('escoresheet-updates');
      channel.onmessage = (event) => {
        if (event.data?.type === 'MANUAL_ADJUSTMENT' || event.data?.type === 'DATA_CHANGED') {
          // If matchId matches or no matchId filter, force re-query all data
          if (!event.data.matchId || event.data.matchId === matchId) {
            setRefreshVersion(v => v + 1);
          }
        }
      };
    } catch (e) {
      // BroadcastChannel not supported, fall back to storage event
      const onStorage = () => setRefreshVersion(v => v + 1);
      window.addEventListener('storage', onStorage);
      return () => window.removeEventListener('storage', onStorage);
    }
    return () => { channel?.close(); };
  }, [matchId]);

  // Use live queries to get real-time data from IndexedDB
  // useLiveQuery returns undefined while loading, null/result after query completes
  // refreshVersion is included in deps to force re-query on BroadcastChannel notifications
  const match = useLiveQuery(
    async () => {
      if (!matchId) return null;
      const result = await (db as any).matches.get(matchId);
      return result || null; // Return null if not found (deleted)
    },
    [matchId, refreshVersion]
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
    [match, refreshVersion]
  );

  const awayTeam = useLiveQuery(
    async () => {
      // Use live match data, not initial data
      if (!match?.awayTeamId) return null;
      return await (db as any).teams.get(match.awayTeamId);
    },
    [match, refreshVersion]
  );

  const homePlayers = useLiveQuery(
    async () => {
      // Use live match data, not initial data
      if (!match?.homeTeamId) return [];
      return await (db as any).players.where('teamId').equals(match.homeTeamId).toArray();
    },
    [match, refreshVersion]
  );

  const awayPlayers = useLiveQuery(
    async () => {
      // Use live match data, not initial data
      if (!match?.awayTeamId) return [];
      return await (db as any).players.where('teamId').equals(match.awayTeamId).toArray();
    },
    [match, refreshVersion]
  );

  const sets = useLiveQuery(
    async () => {
      if (!matchId || isMatchDeleted) return [];
      return await (db as any).sets.where('matchId').equals(matchId).sortBy('index');
    },
    [matchId, isMatchDeleted, refreshVersion]
  );

  const events = useLiveQuery(
    async () => {
      if (!matchId || isMatchDeleted) return [];
      return await (db as any).events.where('matchId').equals(matchId).sortBy('seq');
    },
    [matchId, isMatchDeleted, refreshVersion]
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
  // Every query has answered (undefined = still loading): an automatic save /
  // getBlob waits for this, so the file name and the sheet have the teams.
  const dataReady = [match, homeTeam, awayTeam, homePlayers, awayPlayers, sets, events].every(v => v !== undefined);

  return <App matchData={liveMatchData} autoAction={action} dataReady={dataReady} matchMissing={isMatchDeleted} />;
};

// Static scoresheet component (fallback when no matchId available)
const StaticScoresheet: React.FC<{ matchData: any; action: 'preview' | 'print' | 'save' | 'getBlob' }> = ({ matchData, action }) => {
  return <App matchData={matchData} autoAction={action} />;
};

// URL matchId scoresheet component - loads from IndexedDB by matchId
const UrlMatchIdScoresheet: React.FC<{ matchId: string; action: 'preview' | 'print' | 'save' | 'getBlob' }> = ({ matchId, action }) => {
  // Convert matchId to number if it's a numeric string (IndexedDB uses auto-increment integer IDs)
  const numericMatchId = !isNaN(Number(matchId)) ? parseInt(matchId, 10) : matchId;
  // Use the LiveScoresheet component with a minimal initial data object
  const initialData = { match: { id: numericMatchId } };
  return <LiveScoresheet initialMatchData={initialData} action={action} />;
};

// Storage scoresheet component - fetches from backend storage (apiStorage)
const StorageScoresheet: React.FC<{ date: string; game: string; action: 'preview' | 'print' | 'save' | 'getBlob' }> = ({ date, game, action }) => {
  const [matchData, setMatchData] = React.useState<any>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<ScoresheetLoadError | null>(null);

  React.useEffect(() => {
    const loadData = async () => {
      try {
        const { data, error: loadError } = await fetchFromStorage(date, game);
        if (data) {
          setMatchData(data);
        } else {
          setError(describeScoresheetLoadError(loadError, `${date}, game ${game}`));
        }
      } catch (err) {
        setError(describeScoresheetLoadError({ message: err instanceof Error ? err.message : undefined }, `${date}, game ${game}`));
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
          {error.title}
        </div>
        <div style={{ color: '#666', maxWidth: '32rem', textAlign: 'center', padding: '0 16px' }}>{error.message}</div>
        {error.kind === 'signin' && (openedByTheApp() ? (
          // An app window / the Android in-app view over the scorer app: a
          // link to "/" would load a second scorer app (relay, database) in
          // here. Back to the app, which signs in.
          <button
            type="button"
            onClick={backToTheApp}
            style={{ display: 'inline-flex', alignItems: 'center', minHeight: '44px', padding: '0 20px', borderRadius: '12px', border: 0, background: '#0f172a', color: '#fff', fontWeight: 600, fontSize: '14px', cursor: 'pointer' }}
          >
            Close and sign in in the scorer app
          </button>
        ) : (
          // Same origin as the scorer app: its sign-in gives this page the session
          <a
            href="/"
            style={{ display: 'inline-flex', alignItems: 'center', minHeight: '44px', padding: '0 20px', borderRadius: '12px', background: '#0f172a', color: '#fff', fontWeight: 600, fontSize: '14px', textDecoration: 'none' }}
          >
            Open the scorer app to sign in
          </a>
        ))}
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
    openAppWindow(`?date=${item.date}&game=${item.game}&action=save`);
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
            <div style={{ marginBottom: '16px', color: '#94a3b8' }}><ClipboardIcon size={48} /></div>
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
    // The match-end approval waits for this window's PDF (?action=getBlob): tell it
    // now that there will be none, instead of letting it wait for its timeout
    if (initialAction === 'getBlob') {
      deliverPdfToOpener(null).catch(() => { /* opener gone */ });
    }
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
            onClick={() => closeAppWindow()}
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

// Import scoresheet component - allows uploading JSON data to render a scoresheet
const ImportScoresheet: React.FC<{ action: 'preview' | 'print' | 'save' | 'getBlob' }> = ({ action }) => {
  const [matchData, setMatchData] = React.useState<any>(null);
  const [error, setError] = React.useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setError(null);
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target?.result as string;
        const data = JSON.parse(text);

        // Basic validation: check that it has the expected structure
        if (!data.match && !data.sets && !data.events) {
          setError('Invalid scoresheet data: missing match, sets, or events fields.');
          return;
        }

        setMatchData(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to parse JSON file');
      }
    };
    reader.onerror = () => {
      setError('Failed to read file');
    };
    reader.readAsText(file);
  };

  if (matchData) {
    return <App matchData={matchData} autoAction={action} />;
  }

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
      <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#1e293b' }}>
        Scoresheet Viewer
      </div>
      <div style={{ color: '#666', textAlign: 'center', maxWidth: '400px' }}>
        Upload a scoresheet JSON file to view, print, or save it as a PDF.
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        onChange={handleFileUpload}
        style={{ display: 'none' }}
      />

      <button
        onClick={() => fileInputRef.current?.click()}
        style={{
          padding: '12px 24px',
          fontSize: '16px',
          fontWeight: '500',
          background: '#3b82f6',
          color: 'white',
          border: 'none',
          borderRadius: '8px',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: '8px'
        }}
      >
        Import game data
      </button>

      {error && (
        <div style={{
          color: '#ef4444',
          fontSize: '14px',
          textAlign: 'center',
          maxWidth: '500px',
          padding: '12px',
          background: '#fef2f2',
          borderRadius: '8px',
          border: '1px solid #fecaca'
        }}>
          {error}
        </div>
      )}
    </div>
  );
};

// Priority: 1. URL matchId param, 2. Storage params (?date=...&game=...), 3. List view (?list), 4. sessionStorage, 5. Import/No data
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
  // Load from backend storage (apiStorage)
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
          onClick={() => closeAppWindow()}
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
  // No data from any source - show import screen
  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <ImportScoresheet action={initialAction} />
      </ErrorBoundary>
    </React.StrictMode>
  );
}
