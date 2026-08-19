// Browser proof for the selected icon-frame status at its two production sizes.
// am-test: manual — needs Chromium; run with `npm run test:render`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../../scripts/test-chromium.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'state-logo-render-'));
const bundle = path.join(tmp, 'app.js');

await build({
  stdin: {
    resolveDir: WEB,
    loader: 'tsx',
    contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import StateLogo from './src/components/StateLogo.tsx';
      const States = ({ size }) => <>
        <StateLogo cli="codex" state="working" size={size} tint="#5eb6a6" />
        <StateLogo cli="codex" state="idle" size={size} tint="#5eb6a6" />
        <StateLogo cli="codex" state="stopped" size={size} tint="#5eb6a6" />
      </>;
      createRoot(document.getElementById('root')).render(<>
        <div className="row session fixture-sidebar"><States size={12} /><span className="name">codex-1</span></div>
        <div className="pane-head fixture-header">
          <div className="ph-left"><States size={16} /></div>
          <span className="ph-title"><span className="ph-name">codex-1</span></span>
          <div className="ph-right" />
        </div>
      </>);
    `,
  },
  outfile: bundle, bundle: true, format: 'iife', platform: 'browser', logLevel: 'error',
});

const css = fs.readFileSync(path.join(WEB, 'src/styles.css'), 'utf8');
const browser = await chromium.launch(chromiumLaunchOptions());

try {
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 700, height: 260 } });
    await page.setContent(`<style>${css}</style><div id="root" data-theme="${theme}"></div>`);
    await page.addScriptTag({ path: bundle });
    await page.waitForSelector('.fixture-header .state-logo');

    const result = await page.evaluate(() => {
      const inspect = (surface) => [...document.querySelectorAll(`${surface} .state-logo`)].map((el) => {
        const svg = el.querySelector('svg');
        const rect = el.querySelector('rect:last-child');
        const es = getComputedStyle(el);
        const rs = getComputedStyle(rect);
        const box = el.getBoundingClientRect();
        return {
          state: el.classList[1], box: [box.width, box.height],
          viewBox: svg.getAttribute('viewBox'), pathLength: rect.getAttribute('pathLength'),
          rect: [rect.x.baseVal.value, rect.y.baseVal.value, rect.width.baseVal.value, rect.height.baseVal.value],
          stroke: rs.strokeWidth, dash: rs.strokeDasharray, animation: rs.animationName,
          color: es.color, animations: el.getAnimations({ subtree: true }).length,
        };
      });
      return { sidebar: inspect('.fixture-sidebar'), header: inspect('.fixture-header') };
    });

    for (const [surface, size] of [['sidebar', 18], ['header', 22]]) {
      const states = result[surface];
      assert.equal(states.length, 3);
      for (const mark of states) {
        assert.deepEqual(mark.box, [size, size], `${theme} ${surface} ${mark.state} box`);
        assert.equal(mark.viewBox, `0 0 ${size} ${size}`);
        assert.equal(mark.pathLength, '96');
        assert.deepEqual(mark.rect, [0.5, 0.5, size - 1, size - 1]);
        assert.equal(mark.stroke, '1px');
      }
      assert.match(states[0].dash, /20px,? 4px/);
      assert.equal(states[0].animation, 'state-logo-trace');
      assert.equal(states[0].animations, 1);
      for (const mark of states.slice(1)) {
        assert.equal(mark.animation, 'none');
        assert.equal(mark.animations, 0);
      }
      assert.equal(states[0].color, states[1].color, `${theme} working and idle share accent`);
      assert.notEqual(states[1].color, states[2].color, `${theme} stopped is muted`);
    }
    await page.close();
  }
} finally {
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('state-logo render: exact frame geometry and motion pass in both themes');
