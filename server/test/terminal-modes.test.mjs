import assert from 'node:assert/strict';
import { createTerminalModeTracker } from '../src/terminal-modes.js';

const tracker = createTerminalModeTracker();

// OpenCode enables these modes during its startup paint. Split the sequences at
// awkward boundaries to match real node-pty chunking.
tracker.feed('\x1b[?1h\x1b[?10');
tracker.feed('00h\x1b[?1002;10');
tracker.feed('03h\x1b[?1006h\x1b[?1004h\x1b[?2004h');
assert.equal(
  tracker.restoreAnsi(),
  '\x1b[?1h\x1b[?1003h\x1b[?1006h\x1b[?1004h\x1b[?2004h',
  'restore keeps the effective interaction modes, not every superseded mouse protocol',
);

tracker.feed('\x1b[?1003l\x1b[?1006l\x1b[?1;1004;2004l');
assert.equal(tracker.restoreAnsi(), '', 'DECRST returns tracked modes to their defaults');

tracker.feed('\x1b[?1003;1006;2004h');
tracker.feed('\x1b');
tracker.feed('c');
assert.equal(tracker.restoreAnsi(), '', 'RIS resets interaction modes across chunks');

console.log('terminal mode restore checks passed');
