/**
 * esbuild configuration for TOON Docker entrypoints.
 *
 * Bundles entrypoint-sdk.ts and attestation-server.ts into self-contained ESM
 * files. Native modules (better-sqlite3) and dynamically-required packages
 * (ethers, express) are marked external since they use variable `require()`
 * calls in the connector's `requireOptional()` that esbuild can't resolve.
 *
 * Usage: node esbuild.config.mjs
 */

import * as esbuild from 'esbuild';

const result = await esbuild.build({
  entryPoints: [
    'src/entrypoint-sdk.ts',
    'src/attestation-server.ts',
  ],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outdir: 'dist',
  minify: true,
  sourcemap: false,
  metafile: true,

  // Packages that cannot be statically bundled:
  // - better-sqlite3: native .node binary (used by relay SqliteEventStore + connector claims)
  // - ethers: dynamic require(packageName) in connector's requireOptional()
  // - express: dynamic require(packageName) in connector's AdminServer/HealthServer
  external: ['better-sqlite3', 'ethers', 'express', '@ardrive/turbo-sdk'],

  // The connector (@crosstown/connector) is CJS and its requireOptional() uses
  // require(packageName). When esbuild bundles CJS into ESM output, these
  // dynamic require() calls need a working require function. This banner
  // provides one via Node's createRequire().
  banner: {
    js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`,
  },
});

// Report bundle sizes
const analysis = await esbuild.analyzeMetafile(result.metafile);
console.log(analysis);
