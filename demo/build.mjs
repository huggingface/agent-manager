// Bundles the demo against the production reader. `../../web/src/api` is
// aliased to the fixture transport so the reader's own code runs unchanged.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const web = path.join(HERE, '../web');
const dist = path.join(HERE, 'dist');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

const rawLoader = {
  name: 'raw',
  setup(b) {
    b.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: path.resolve(args.resolveDir, args.path.replace(/\?raw$/, '')), namespace: 'raw',
    }));
    b.onLoad({ filter: /.*/, namespace: 'raw' },
      (args) => ({ contents: fs.readFileSync(args.path, 'utf8'), loader: 'text' }));
  },
};
// Every reader import of the app's api module resolves to the fixture, so the
// demo exercises the real store against a local file instead of a server.
const apiAlias = {
  name: 'api-alias',
  setup(b) {
    b.onResolve({ filter: /(^|\/)api$/ }, (args) => {
      if (args.importer.includes(path.join('web', 'src'))) {
        return { path: path.join(HERE, 'src/fixtureApi.ts') };
      }
      return undefined;
    });
  },
};

await build({
  entryPoints: [path.join(HERE, 'src/main.tsx')],
  outfile: path.join(dist, 'demo.js'),
  bundle: true, format: 'iife', platform: 'browser', target: 'es2020',
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.jsonl': 'text' },
  plugins: [rawLoader, apiAlias],
  logLevel: 'info',
});

fs.writeFileSync(path.join(dist, 'demo.css'),
  fs.readFileSync(path.join(web, 'src/styles.css'), 'utf8')
  + fs.readFileSync(path.join(web, 'src/conversation.css'), 'utf8')
  + fs.readFileSync(path.join(HERE, 'demo.css'), 'utf8'));
fs.copyFileSync(path.join(HERE, 'index.html'), path.join(dist, 'index.html'));
// The fixture ships beside the page so it can be swapped without a rebuild of
// anything but this bundle.
fs.copyFileSync(path.join(HERE, 'session.jsonl'), path.join(dist, 'session.jsonl'));
fs.copyFileSync(path.join(HERE, 'icon.svg'), path.join(dist, 'icon.svg'));
for (const font of fs.readdirSync(path.join(web, 'public/fonts'))) {
  fs.mkdirSync(path.join(dist, 'fonts'), { recursive: true });
  fs.copyFileSync(path.join(web, 'public/fonts', font), path.join(dist, 'fonts', font));
}
console.log('demo built ->', dist);
