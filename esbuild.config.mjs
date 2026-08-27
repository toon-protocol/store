/**
 * esbuild configuration for the TOON store Docker entrypoint.
 *
 * Bundles src/entrypoint-store.ts into a single ESM file and leaves every
 * dependency external (`packages: 'external'`). Dependencies are resolved
 * from node_modules at runtime, installed by `pnpm install --prod` in
 * Dockerfile.store's runtime stage — so package.json is the ONLY place a
 * runtime version is written down.
 *
 * This deliberately replaces a hand-maintained `external:` list. That list had
 * to name every package reachable through a dynamic or variable import
 * (@ardrive/turbo-sdk, arweave, @ar.io/sdk, @solana/kit, ...), and getting it
 * wrong failed at runtime in the container rather than at build time here.
 *
 * Usage: node esbuild.config.mjs
 */

import * as esbuild from 'esbuild';

const result = await esbuild.build({
  entryPoints: ['src/entrypoint-store.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outdir: 'dist',
  minify: true,
  sourcemap: false,
  metafile: true,

  // Bundle our own source only; every bare import stays a runtime import.
  packages: 'external',
});

console.log(await esbuild.analyzeMetafile(result.metafile));
