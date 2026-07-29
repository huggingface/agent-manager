import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

// Deliberately no StrictMode: its dev-only double mount would attach every panel
// twice and poison the very timings this lab exists to measure.
createRoot(document.getElementById('root')!).render(<App />);
