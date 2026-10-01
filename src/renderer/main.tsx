import { createRoot } from 'react-dom/client';
import { App } from './App';
import { store } from './lib/store';
import './styles.css';

void store.init().then(() => {
  createRoot(document.getElementById('root')!).render(<App />);
});
