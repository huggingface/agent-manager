import type { BackupHealth, CheckpointHealth } from '../api';
import BackupBanner from './BackupBanner';
import CheckpointBanner from './CheckpointBanner';

/**
 * The warnings about work that is not being saved, in one chunk: App loads it
 * only when /api/info reports one, so neither banner is in the entry chunk
 * (which has a size budget — test/lazyPanels.test.mjs).
 */
export default function HealthBanners({ backup, checkpoint, onOpenSettings }: {
  backup: BackupHealth | null | undefined;
  checkpoint: CheckpointHealth | null | undefined;
  onOpenSettings: () => void;
}) {
  return (
    <>
      <CheckpointBanner health={checkpoint} />
      <BackupBanner health={backup} onOpenSettings={onOpenSettings} />
    </>
  );
}
