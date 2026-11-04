// The keydown rules for terminal panes (Option-as-Meta, Shift+Enter, browser-
// reserved Ctrl combos). Pure logic; the wiring is covered by terminalKeysPane.
import assert from 'node:assert/strict';
import { terminalKeyAction, isMacPlatform } from '../src/lib/terminalKeys.ts';

const ev = (o) => ({ type: 'keydown', key: '', code: '', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...o });
const act = (o, mac = false) => terminalKeyAction(ev(o), mac);
const untouched = (a) => assert.deepEqual(a, { preventDefault: false, passToXterm: true });

assert.equal(isMacPlatform({ platform: 'MacIntel' }), true);
assert.equal(isMacPlatform({ platform: 'Linux x86_64' }), false);

// Option as Meta on macOS: the key is "∫", the physical key says it was B.
for (const [code, send] of [['KeyB', '\x1bb'], ['KeyF', '\x1bf'], ['KeyP', '\x1bp'], ['KeyT', '\x1bt'],
  ['KeyY', '\x1by'], ['KeyD', '\x1bd'], ['Backspace', '\x1b\x7f'], ['Enter', '\x1b\r'],
  ['ArrowLeft', '\x1bb'], ['ArrowRight', '\x1bf'], ['Delete', '\x1bd']]) {
  assert.deepEqual(act({ altKey: true, key: '∫', code }, true), { send, preventDefault: true, passToXterm: false }, code);
}
// Everything else with Option is left for the layout: German @ [ { | ~ and friends.
for (const [key, code] of [['@', 'KeyL'], ['[', 'Digit5'], ['{', 'Digit8'], ['|', 'Digit7'], ['~', 'KeyN'], ['Dead', 'KeyN'], ['å', 'KeyA']]) {
  untouched(act({ altKey: true, key, code }, true));
}
// Option+Shift and Ctrl+Option are different chords.
untouched(act({ altKey: true, shiftKey: true, key: 'Í', code: 'KeyB' }, true));
untouched(act({ altKey: true, ctrlKey: true, key: 'b', code: 'KeyB' }, true));
// Off macOS xterm already encodes Alt itself.
untouched(act({ altKey: true, key: 'b', code: 'KeyB' }, false));

// Newline: Shift+Enter and Ctrl+Enter; plain Enter and Alt+Enter off-mac are xterm's.
const nl = { send: '\x1b\r', preventDefault: true, passToXterm: false };
assert.deepEqual(act({ shiftKey: true, key: 'Enter', code: 'Enter' }), nl);
assert.deepEqual(act({ shiftKey: true, key: 'Enter', code: 'Enter' }, true), nl);
assert.deepEqual(act({ ctrlKey: true, key: 'Enter', code: 'Enter' }), nl);
untouched(act({ key: 'Enter', code: 'Enter' }));
untouched(act({ key: 'Enter', code: 'Enter' }, true));
untouched(act({ altKey: true, key: 'Enter', code: 'Enter' }, false));
untouched(act({ metaKey: true, key: 'Enter', code: 'Enter' }, true));

// Core TUI combos: the browser is stopped, xterm still sends the byte.
const keep = { preventDefault: true, passToXterm: true };
for (const k of ['r', 'l', 'k', 'u', 'y', 'd', 'j', 't', 'p', 'w', 'n']) {
  for (const mac of [true, false]) assert.deepEqual(act({ ctrlKey: true, key: k }, mac), keep, `Ctrl+${k}`);
}
assert.deepEqual(act({ ctrlKey: true, key: 'R' }), keep, 'caps lock');
assert.deepEqual(act({ key: 'Escape' }), keep);
assert.deepEqual(act({ key: 'Tab', shiftKey: true }), keep);
untouched(act({ key: 'Tab' }));
untouched(act({ key: 'a' }));
untouched(act({ ctrlKey: true, key: 'c' }), 'SIGINT/copy stay with the existing handler');
untouched(act({ ctrlKey: true, key: 'v' }));
untouched(act({ ctrlKey: true, shiftKey: true, key: 'V' }));
untouched(act({ ctrlKey: true, shiftKey: true, key: 'T' }));
untouched(act({ ctrlKey: true, altKey: true, key: 'r' }));

// iTerm2 "Natural Text Editing" Cmd keys on macOS: line start/end, delete to
// line start; Cmd+K clears the buffer.
for (const [key, send] of [['ArrowLeft', '\x01'], ['ArrowRight', '\x05'], ['Backspace', '\x15']]) {
  assert.deepEqual(act({ metaKey: true, key, code: key }, true), { send, preventDefault: true, passToXterm: false }, key);
  untouched(act({ metaKey: true, key, code: key }, false));
  untouched(act({ metaKey: true, shiftKey: true, key, code: key }, true));
}
assert.deepEqual(act({ metaKey: true, key: 'k', code: 'KeyK' }, true), { clear: true, preventDefault: true, passToXterm: false });
untouched(act({ metaKey: true, key: 'k', code: 'KeyK' }, false));
// Other Cmd combos on macOS (and the Windows key) are the browser's.
for (const k of ['r', 't', 'w', 'l', 'v', 'c', 'a']) untouched(act({ metaKey: true, key: k }, true));
untouched(act({ metaKey: true, key: 'ArrowUp', code: 'ArrowUp' }, true));
untouched(act({ metaKey: true, ctrlKey: true, key: 'r' }, true));
untouched(act({ metaKey: true, altKey: true, key: '∫', code: 'KeyB' }, true));

// IME composition and non-keydown events are never touched.
untouched(act({ isComposing: true, shiftKey: true, key: 'Enter', code: 'Enter' }));
untouched(act({ keyCode: 229, key: 'Process', code: 'Enter', shiftKey: true }));
untouched(act({ keyCode: 229, altKey: true, key: 'Process', code: 'KeyB' }, true));
untouched(act({ type: 'keyup', shiftKey: true, key: 'Enter', code: 'Enter' }));
untouched(act({ type: 'keyup', ctrlKey: true, key: 'r' }));
console.log('terminalKeys ok');
