/**
 * Application entry point.
 * Initializes React and mounts the App component to the DOM.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

/**
 * Mounts the React application in StrictMode for development warnings.
 */
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
