import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App_Scoresheet';

// Load match data from sessionStorage
const loadMatchData = () => {
  try {
    const dataStr = sessionStorage.getItem('scoresheetData');
    if (!dataStr) {
      console.error('No scoresheet data found in sessionStorage');
      return null;
    }
    const data = JSON.parse(dataStr);
    // Clean up sessionStorage after loading
    sessionStorage.removeItem('scoresheetData');
    return data;
  } catch (error) {
    console.error('Error loading scoresheet data:', error);
    return null;
  }
};

const matchData = loadMatchData();

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);

if (matchData) {
  root.render(
    <React.StrictMode>
      <App matchData={matchData} />
    </React.StrictMode>
  );
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