// The model / effort selects of the create panels, behind a lazy boundary:
// the selects and their options load on first use (LaunchPicker.tsx), and a
// CLI that takes neither (per GET /api/clis) shows nothing at all.
import LazyPanel from './LazyPanel';
import type { Cli, LaunchChoice } from '../types';

const loadPicker = () => import('./LaunchPicker');

export default function LaunchField({ cli, value, onChange, disabled }: {
  cli: Cli | undefined;
  value: LaunchChoice;
  onChange: (next: LaunchChoice) => void;
  disabled?: boolean;
}) {
  if (!cli?.launch?.model && !cli?.launch?.effort) return null;
  return (
    <LazyPanel load={loadPicker} what="model options"
      render={(m) => <m.default cli={cli.id} value={value} onChange={onChange} disabled={disabled} />} />
  );
}
