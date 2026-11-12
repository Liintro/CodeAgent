import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './app/App';
import { applyTheme } from './app/theme';
import './app/index.css';

void window.codeAgent.getPreferences().then(reply => { if (reply.ok) applyTheme(reply.value.theme); });

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
