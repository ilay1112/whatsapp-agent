// src/renderer/src/main.tsx - renderer entry (owner W1-14). Initialises i18n from the preload-provided initial language, then mounts App.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { initI18n } from './i18n';
import { initialLanguage } from './api';
import { App } from './App';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');

void initI18n(initialLanguage().lang).then(() => {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
