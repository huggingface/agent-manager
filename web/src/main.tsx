import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

// No StrictMode: it double-mounts in dev, which would open duplicate WebSockets.
createRoot(document.getElementById('root')!).render(<App />);
