import { createRoot } from 'react-dom/client';
import { Flyout } from './Flyout';
import { store } from './lib/store';
import './styles.css';

document.body.classList.add('is-flyout');
void store.init().then(() => {
  createRoot(document.getElementById('root')!).render(<Flyout />);
});
