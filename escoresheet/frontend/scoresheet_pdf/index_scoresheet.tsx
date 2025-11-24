import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App_Scoresheet';

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

// Load match data from sessionStorage
const loadMatchData = () => {
  try {
    const dataStr = sessionStorage.getItem('scoresheetData');
    if (!dataStr) {
      const error = 'No scoresheet data found in sessionStorage';
      console.error(error);
      sendErrorToParent(new Error(error));
      return null;
    }
    const data = JSON.parse(dataStr);
    // Clean up sessionStorage after loading
    sessionStorage.removeItem('scoresheetData');
    return data;
  } catch (error) {
    console.error('Error loading scoresheet data:', error);
    sendErrorToParent(error instanceof Error ? error : new Error(String(error)));
    return null;
  }
};

const matchData = loadMatchData();

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

if (matchData) {
  try {
    root.render(
      <React.StrictMode>
        <ErrorBoundary>
          <App matchData={matchData} />
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