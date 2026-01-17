/**
 * Application entry point.
 *
 * Renders the React application into the DOM using React 18's
 * createRoot API with StrictMode enabled for development checks.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
