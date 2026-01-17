/**
 * Application Root Component
 *
 * Minimal wrapper that mounts the ChatApp component.
 * Imports global CSS and serves as the entry point for the React tree.
 */

import { ChatApp } from './components';
import './index.css';

/**
 * Root application component.
 * Delegates all rendering to ChatApp.
 *
 * @returns The ChatApp component
 */
function App() {
  return <ChatApp />;
}

export default App;
