// Browser proof for all four icon-frame states at the two production sizes.
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
        <StateLogo cli="codex" state="waiting" size={size} tint="#5eb6a6" />
        <StateLogo cli="codex" state="idle" size={size} tint="#5eb6a6" />
        <StateLogo cli="codex" state="stopped" size={size} tint="#5eb6a6" />
      </>;
      const Legend = () => <div className="legend fixture-legend">
        <span><StateLogo frameOnly state="working" size={12} /> working</span>
        <span><StateLogo frameOnly state="waiting" size={12} /> your turn</span>
        <span><StateLogo frameOnly state="idle" size={12} /> idle</span>
        <span><StateLogo frameOnly state="stopped" size={12} /> stopped</span>
      </div>;
      createRoot(document.getElementById('root')).render(<>
        <div className="row session fixture-sidebar"><States size={12} /><span className="name">codex-1</span></div>
        <div className="pane-head fixture-header">
          <div className="ph-left"><States size={16} /></div>
          <span className="ph-title"><span className="ph-name">codex-1</span></span>
          <div className="ph-right" />
        </div>
        <Legend />
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

    const inspect = () => page.evaluate(() => {
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
          logos: el.querySelectorAll('.cli-logo').length,
        };
      });
      return {
        sidebar: inspect('.fixture-sidebar'),
        header: inspect('.fixture-header'),
        legend: inspect('.fixture-legend'),
      };
    });
    const result = await inspect();

    for (const [surface, size] of [['sidebar', 18], ['header', 22], ['legend', 12]]) {
      const states = result[surface];
      assert.equal(states.length, 4);
      for (const mark of states) {
        assert.deepEqual(mark.box, [size, size], `${theme} ${surface} ${mark.state} box`);
        assert.equal(mark.viewBox, `0 0 ${size} ${size}`);
        assert.equal(mark.pathLength, '96');
        assert.deepEqual(mark.rect, [0.5, 0.5, size - 1, size - 1]);
        assert.equal(mark.stroke, '1px');
      }
      const byState = Object.fromEntries(states.map((mark) => [mark.state, mark]));
      assert.match(byState.working.dash, /20px,? 4px/);
      assert.equal(byState.working.animation, 'state-logo-trace');
      assert.equal(byState.working.animations, 1);
      assert.equal(byState.waiting.dash, 'none');
      assert.equal(byState.idle.dash, 'none');
      assert.equal(byState.stopped.dash, 'none');
      for (const mark of [byState.waiting, byState.idle, byState.stopped]) {
        assert.equal(mark.animation, 'none');
        assert.equal(mark.animations, 0);
      }
      assert.equal(byState.working.color, byState.waiting.color, `${theme} working and waiting share accent`);
      assert.notEqual(byState.waiting.color, byState.idle.color, `${theme} your-turn and idle colours differ`);
      assert.notEqual(byState.idle.color, byState.stopped.color, `${theme} stopped is muted`);
      const signatures = states.map((mark) => `${mark.dash}|${mark.animation}|${mark.color}`);
      assert.equal(new Set(signatures).size, 4, `${theme} ${surface} has four distinct treatments`);
      for (const mark of states) {
        assert.equal(mark.logos, surface === 'legend' ? 0 : 1,
          `${theme} ${surface} ${mark.state} ${surface === 'legend' ? 'is frame-only' : 'keeps its CLI logo'}`);
      }
    }

    // Motion is only an enhancement. When the operator asks the OS to reduce
    // it, working freezes as four long dashes and remains distinct from all
    // three solid frames.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForTimeout(20);
    const reduced = await inspect();
    for (const surface of ['sidebar', 'header', 'legend']) {
      const states = reduced[surface];
      const byState = Object.fromEntries(states.map((mark) => [mark.state, mark]));
      assert.match(byState.working.dash, /20px,? 4px/);
      assert.equal(byState.working.animation, 'none');
      assert.equal(byState.working.animations, 0);
      for (const mark of [byState.waiting, byState.idle, byState.stopped]) {
        assert.equal(mark.dash, 'none');
        assert.equal(mark.animation, 'none');
        assert.equal(mark.animations, 0);
      }
      const signatures = states.map((mark) => `${mark.dash}|${mark.color}`);
      assert.equal(new Set(signatures).size, 4, `${theme} reduced-motion ${surface} has four distinct treatments`);
    }
    await page.close();
  }
} finally {
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('state-logo render: frame-only legend stays distinct while real tiles keep their logos');
