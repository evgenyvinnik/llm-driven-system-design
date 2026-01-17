/**
 * @fileoverview Entry point for the collaborative editor frontend application.
 *
 * Initializes the React application and mounts it to the DOM.
 * Uses React.StrictMode for additional development-time checks.
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
