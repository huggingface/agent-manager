import type { BackupHealth, CheckpointHealth, StateLinkHealth } from '../api';
import BackupBanner from './BackupBanner';
import CheckpointBanner from './CheckpointBanner';
import StateLinkBanner from './StateLinkBanner';

/**
 * The warnings about work that is not being saved, in one chunk: App loads it
 * only when /api/info reports one, so neither banner is in the entry chunk
 * (which has a size budget — test/lazyPanels.test.mjs).
 */
export default function HealthBanners({ backup, checkpoint, stateLinks, onOpenSettings }: {
  backup: BackupHealth | null | undefined;
  checkpoint: CheckpointHealth | null | undefined;
  stateLinks?: StateLinkHealth | null;
  onOpenSettings: () => void;
}) {
  return (
    <>
      <StateLinkBanner health={stateLinks} />
      <CheckpointBanner health={checkpoint} />
      <BackupBanner health={backup} onOpenSettings={onOpenSettings} />
    </>
  );
}
