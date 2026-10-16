import type { DevPreviewPr } from '../api';

const who = (p: DevPreviewPr) => {
  const role = p.association ? p.association.toLowerCase() : 'unknown role';
  return `#${p.number} by ${p.author || 'unknown'} (${role}), branch on ${p.headRepo || 'unknown repo'}`;
};

/**
 * The one confirmation before a switch: who wrote the code, where it lives,
 * and plainly what running it grants. Main gets its own wording.
 */
export function switchConfirmText(prs: DevPreviewPr[]): string {
  if (!prs.length) return 'Switch this Space back to main (the image build)? The app server restarts, and so does every running agent.';
  return [
    `Run ${prs.length > 1 ? 'these PRs' : 'this PR'} on this Space?`,
    '',
    ...prs.map(who),
    '',
    'This code will run with this Space\'s secrets, bucket and agents: its install scripts and build as soon as you confirm, then as the app server itself. The app server restarts, and so does every running agent.',
  ].join('\n');
}
