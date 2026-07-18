/**
 * esbuild configuration for the TOON store Docker entrypoint.
 *
 * Bundles entrypoint-store.ts into a self-contained ESM file. Native modules
 * (better-sqlite3) and dynamically-required packages (ethers, express) are
 * marked external since they use variable `require()` calls in the connector's
 * `requireOptional()` that esbuild can't resolve.
 *
 * Usage: node esbuild.config.mjs
 */

import * as esbuild from 'esbuild';

const result = await esbuild.build({
  entryPoints: [
    'src/entrypoint-store.ts',
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
  // - fastify: deep dynamic-require graph (avvio, find-my-way); ship as flat
  //   node_modules so the toon-client entrypoint can require() it at runtime
  // - @noble/curves: dynamic import inside packages/client/dist causes esbuild
  //   to fail resolving the subpath export in Docker's pnpm store layout
  // - @ar.io/sdk: OPTIONAL kind:5095 ArNS-buy dependency, loaded lazily via a
  //   variable import specifier (see src/arns-buy-handler.ts); kept external
  //   alongside its @solana/kit companion
  external: ['better-sqlite3', 'ethers', 'express', '@ardrive/turbo-sdk', 'arweave', 'o1js', '@ar.io/sdk', '@solana/kit', '@solana-program/token', '@toon-protocol/mina-zkapp', 'mina-signer', 'mina-fungible-token', 'socks-proxy-agent', 'fastify', '@fastify/cors', '@noble/curves'],

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
