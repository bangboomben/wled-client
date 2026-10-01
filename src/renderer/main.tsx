import { createRoot } from 'react-dom/client';
import { language } from '../shared/i18n';
import { App } from './App';
import { store, useSettings } from './lib/store';
import './styles.css';

/** Sprachwechsel baut die Oberfläche neu auf, damit alle Texte in der neuen Sprache erscheinen. */
function Root() {
  useSettings();
  return <App key={language()} />;
}

void store.init().then(() => {
  createRoot(document.getElementById('root')!).render(<Root />);
});
