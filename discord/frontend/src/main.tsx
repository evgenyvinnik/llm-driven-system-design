/**
 * Application Entry Point
 *
 * Creates the React root and mounts the application into the DOM.
 * Uses React 19's createRoot API with StrictMode for development checks.
 * The root element must exist in index.html with id="root".
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
