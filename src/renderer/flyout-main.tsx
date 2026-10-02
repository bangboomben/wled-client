import { createRoot } from 'react-dom/client';
import { language } from '../shared/i18n';
import { Flyout } from './Flyout';
import { ErrorBoundary } from './components/controls';
import { store, useSettings } from './lib/store';
import './styles.css';

document.body.classList.add('is-flyout');
function Root() {
  useSettings();
  return (
    <ErrorBoundary>
      <Flyout key={language()} />
    </ErrorBoundary>
  );
}

void store.init().then(() => {
  createRoot(document.getElementById('root')!).render(<Root />);
});
