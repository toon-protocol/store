/**
 * esbuild configuration for the Arweave DVM entrypoint.
 *
 * Bundles entrypoint-dvm.ts into a self-contained ESM file.
 * @ardrive/turbo-sdk is marked external because the DVM dynamically imports
 * it (import('@ardrive/turbo-sdk/node')) at runtime.
 *
 * Usage: node esbuild.config.mjs
 */

import * as esbuild from 'esbuild';

const result = await esbuild.build({
  entryPoints: [
    'src/entrypoint-dvm.ts',
  ],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outdir: 'dist',
  minify: true,
  sourcemap: false,
  metafile: true,

  // @ardrive/turbo-sdk and arweave are dynamically imported at runtime;
  // better-sqlite3 is a native binary that cannot be statically bundled.
  external: ['@ardrive/turbo-sdk', 'arweave', 'better-sqlite3'],

  // Some CJS modules in the dependency graph need a working require() in ESM
  // output. This banner provides one via Node's createRequire().
  banner: {
    js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`,
  },
});

// Report bundle sizes
const analysis = await esbuild.analyzeMetafile(result.metafile);
console.log(analysis);
