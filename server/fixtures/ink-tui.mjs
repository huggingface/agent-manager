// A stand-in for an agent TUI built the way Claude Code is: Ink (React) on the
// PRIMARY screen, re-rendering its whole frame when the terminal resizes.
//
// This matters because Ink does not repaint by absolute positioning the way
// fixtures/repaint-tui.mjs does. It PRINTS its frame — cursor up by the previous
// frame's height, erase downward, print the lines — so a frame taller than the
// screen scrolls the excess into scrollback, and a frame whose height changed
// (which is exactly what a width change does, by rewrapping) erases the wrong
// region and leaves the difference behind. That is the artifact a real agent pane
// shows on zoom, and no hand-written repaint reproduces it.
//
// Every token is unique (`LLL.CC`), so a token appearing twice in the grid is a
// real duplicate and not two identical filler lines.
//
// NOT wired into resize.test.mjs, and ink is deliberately NOT a dependency:
// installing it here pruned @coder/libghostty-vt-node's native prebuild and broke
// every session until `npm install` put it back. Run it out of tree instead —
//
//   mkdir /tmp/inkbox && cd /tmp/inkbox
//   npm init -y && npm i ink react
//   cp .../fixtures/ink-tui.mjs . && node ink-tui.mjs
//
// The finding it produced is recorded where it matters: Ink erases its previous
// frame by height before reprinting, so an Ink app leaves no duplicates on resize.
// The artifacts a real agent pane shows come from a frame that OVERFLOWS the
// screen, which fixtures/repaint-tui.mjs reproduces with FIXED_LINES set.
import React from 'react';
import { render, Box, Text, useStdout } from 'ink';

const TRANSCRIPT = Array.from({ length: 60 }, (_, i) =>
  Array.from({ length: 22 }, (_, j) => `${String(i + 1).padStart(3, '0')}.${String(j).padStart(2, '0')}`).join(' '));

function App() {
  const { stdout } = useStdout();
  const [size, setSize] = React.useState({ cols: stdout.columns || 80, rows: stdout.rows || 24 });
  React.useEffect(() => {
    const onResize = () => setSize({ cols: stdout.columns || 80, rows: stdout.rows || 24 });
    stdout.on('resize', onResize);
    return () => stdout.off('resize', onResize);
  }, [stdout]);

  // A fixed number of transcript lines, NOT trimmed to fit — the important part.
  // An agent renders the tail of its conversation, so narrowing the pane wraps
  // those lines and the frame becomes TALLER than the screen. Printing it then
  // scrolls the overflow into scrollback, which is where the duplicates a user
  // sees after zooming in actually come from.
  const KEEP = 30;
  return React.createElement(
    Box,
    { flexDirection: 'column' },
    ...TRANSCRIPT.slice(-KEEP).map((line, i) => React.createElement(Text, { key: i }, line)),
    React.createElement(
      Box,
      { borderStyle: 'round', paddingX: 1 },
      React.createElement(Text, null, `[ink ${size.cols}x${size.rows}]`),
    ),
  );
}

render(React.createElement(App));
// Stay up like an agent waiting for input, so a resize has something to answer.
process.stdin.resume();
setInterval(() => {}, 1 << 30);
