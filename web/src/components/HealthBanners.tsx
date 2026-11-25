import type { BackupHealth, CheckpointHealth, DiskHealth } from '../api';
import BackupBanner from './BackupBanner';
import CheckpointBanner from './CheckpointBanner';
import DiskBanner from './DiskBanner';

/**
 * The warnings about work that is not being saved or a local disk running out
 * of boot headroom, in one chunk: App loads it only when /api/info reports one,
 * so none of these banners is in the entry chunk (test/lazyPanels.test.mjs).
 */
export default function HealthBanners({ backup, checkpoint, disk, onOpenSettings }: {
  backup: BackupHealth | null | undefined;
  checkpoint: CheckpointHealth | null | undefined;
  disk?: DiskHealth | null | undefined;
  onOpenSettings: () => void;
}) {
  return (
    <>
      <DiskBanner health={disk} />
      <CheckpointBanner health={checkpoint} />
      <BackupBanner health={backup} onOpenSettings={onOpenSettings} />
    </>
  );
}
