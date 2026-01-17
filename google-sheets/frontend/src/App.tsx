/**
 * Main application component for the collaborative spreadsheet.
 * Handles connection initialization, routing, and layout.
 *
 * @module App
 */

import { useEffect } from 'react';
import { useSpreadsheetStore } from './stores/spreadsheet';
import { Toolbar } from './components/Toolbar';
import { SpreadsheetGrid } from './components/SpreadsheetGrid';
import './App.css';

/**
 * Root application component.
 * Manages WebSocket connection lifecycle and renders the spreadsheet UI.
 * Handles spreadsheet ID from URL and user name from localStorage/prompt.
 *
 * @returns The complete application UI
 */
function App() {
  const connect = useSpreadsheetStore((state) => state.connect);
  const isConnected = useSpreadsheetStore((state) => state.isConnected);

  /**
   * Effect to establish WebSocket connection on mount.
   * - Extracts or generates spreadsheet ID from URL
   * - Prompts for user name if not saved in localStorage
   * - Cleans up connection on unmount
   */
  useEffect(() => {
    // Get spreadsheet ID from URL or generate one
    const params = new URLSearchParams(window.location.search);
    let spreadsheetId = params.get('id');

    if (!spreadsheetId) {
      spreadsheetId = crypto.randomUUID();
      window.history.replaceState({}, '', `?id=${spreadsheetId}`);
    }

    // Get user name from prompt or localStorage
    let userName = localStorage.getItem('sheetsUserName');
    if (!userName) {
      userName = prompt('Enter your name:', 'Anonymous') || 'Anonymous';
      localStorage.setItem('sheetsUserName', userName);
    }

    connect(spreadsheetId, userName);

    return () => {
      useSpreadsheetStore.getState().disconnect();
    };
  }, [connect]);

  // Show loading state while connecting
  if (!isConnected) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          fontSize: 18,
          color: '#5f6368',
        }}
      >
        Connecting to spreadsheet...
      </div>
    );
  }

  return (
    <div className="app">
      <Toolbar />
      <SpreadsheetGrid />
    </div>
  );
}

export default App;
