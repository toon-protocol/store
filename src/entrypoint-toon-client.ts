/**
 * TOON-client pod entrypoint (Story 49.3).
 *
 * Wraps 49.1's proven in-process publish flow in a Fastify HTTP control plane,
 * shipped as a long-lived Akash deployment. Runs a LOCAL `anon` daemon
 * (ator-onion mode) in-process and uses its SOCKS5 port (127.0.0.1:9050) for
 * outbound BTP to the operator's .anyone hidden service. The datacenter's
 * anon daemon builds better circuits than routing through a potentially
 * overloaded public proxy. Boot sequence:
 *
 *   1. Generate ephemeral signer keypairs (EVM secp256k1 + Solana ed25519) in
 *      memory ONLY — never persisted to disk, never logged as private keys.
 *   2. Start Fastify on 0.0.0.0:8080 IMMEDIATELY (clearnet ingress, Akash L7).
 *      /healthz is reachable within ~100ms — `anyoneReady` flag flips true
 *      asynchronously once steps 3-5 complete.
 *   3. Spawn `anon` as a child process with a SOCKS-only torrc (no
 *      HiddenServiceDir — the pod is a CLIENT of the operator's .anyone HS,
 *      it does not host one). Wait for SOCKS5 bind on 127.0.0.1:9050.
 *   4. POST the public keys to the 49.2 faucet (FAUCET_URL) and poll for
 *      native + USDC balance confirmation on both chains (30s per chain).
 *   5. Flip `bootComplete = true` — /publish now accepts requests.
 *
 * HTTP surface:
 *   GET  /healthz       — `{ anyoneReady, evmAddr, solAddr, balances, bootedAt }`
 *   GET  /signer-info   — same + `{ transport: { type, socksProxy } }`
 *   POST /publish       — ajv-validates body { event, targetHostname }; builds
 *                         a ToonClient with SOCKS5 transport and `btpUrl =
 *                         ws://<targetHostname>:3000/btp`; opens a payment
 *                         channel on Akash-Anvil; signs a balance proof; calls
 *                         `publishEvent(event, { claim })`; returns 202 with
 *                         `{ eventId, claimHash, chainId, publishedAt, durationMs }`.
 *
 * Schema contract: packages/townhouse/contracts/foreign-publish.schema.json.
 * Drift between this entrypoint's request/response shape and the schema =
 * build break (the schema-contract test fails in the townhouse unit suite).
 *
 * Idempotency: Nostr layer (event.id = SHA-256 of canonical event). Pod is
 * stateless w.r.t. replay — retries MUST reuse the same signed event object.
 *
 * AC mapping (see _bmad-output/implementation-artifacts/49-3-persistent-akash-toon-client-pod.md):
 *   AC #1   /healthz + boot + faucet auto-fund + USDC balance
 *   AC #2   POST /publish round-trip
 *   AC #3   Runtime-mutable targetHostname (cached ToonClient map keyed by hostname)
 *   AC #6   Real .anyone transport (socks5h:// via local anon daemon, no clearnet relay dial)
 *   AC #7   No app-layer idempotency (trust Nostr event-id dedup)
 *   AC #9   Rate limit (in-memory windowed counter per source IP, default 30/min)
 *
 * Transport mode (mutually exclusive — DIRECT_BTP takes precedence, then ANYONE_PROXY_URLS):
 *   DIRECT_BTP            (optional)  — truthy (1/true/yes/on) enables direct-BTP
 *                                        mode: connect straight to the apex over a
 *                                        plain ws://|wss:// endpoint with
 *                                        transport:{type:'direct'} and NO SOCKS
 *                                        proxy (no public ATOR proxy, no local anon
 *                                        daemon). Requires APEX_BTP_URL. When unset
 *                                        the legacy HS/SOCKS path is byte-identical.
 *   APEX_BTP_URL          (required in direct mode) — plain BTP endpoint
 *                                        (ws://|wss:// host[:port] /btp). Validated
 *                                        by isValidDirectBtpUrl (NOT the strict
 *                                        .anon/.anyone HOSTNAME_REGEX).
 *   ANYONE_PROXY_URLS     (optional)  — comma-separated public ATOR proxy URL(s) in
 *                                        socks5h://host:port form.  When set, the pod
 *                                        skips the local anon daemon and routes outbound
 *                                        BTP directly through the first listed proxy
 *                                        (ator-public mode, Epic 23 D23-003).  The
 *                                        smoke test's beforeAll SOCKS5 probe confirms
 *                                        the proxy can reach the local apex HS before
 *                                        POST /publish runs.
 *   ANON_SOCKS_PORT       (default 9050)  — used only when ANYONE_PROXY_URLS is unset
 *                                        (ator-onion mode: local anon daemon SOCKS5).
 *
 * Environment:
 *   FAUCET_URL            (required)  — 49.2 faucet ingress
 *   EVM_RPC_URL           (required)  — Akash-Anvil ingress (clearnet HTTPS)
 *   SOLANA_RPC_URL        (required)  — Akash-Solana ingress (clearnet HTTPS)
 *   POD_PORT              (default 8080)
 *   PUBLISH_RATE_LIMIT_PER_MIN (default 30, AC #9)
 *   TOON_FEE_PER_EVENT    (default 0) — ILP units per publish event.
 *                                       0 = free relay (connector skips
 *                                       per-packet claim generation).
 *   LOG_LEVEL             (default info)
 *
 * Solana payment (Stage 2c — opt-in; default path stays EVM-only):
 *   SOLANA_PROGRAM_ID                 — payment-channel program id (base58).
 *   TARGET_SETTLEMENT_ADDRESS_SOLANA  — apex Solana settlement pubkey (base58),
 *                                       claim recipient / channel peer.
 *     (Solana payment is ENABLED only when BOTH of the above are set. The pod
 *      then derives EVM + Solana from a single mnemonic, negotiates
 *      SOLANA_CHAIN_KEY, opens a real on-chain Solana channel at the
 *      connector-parity PDA, and signs a connector-format Solana claim.)
 *   SOLANA_CHAIN_KEY      (default solana:devnet)
 *   SOLANA_TOKEN_MINT     (default SOLANA_USDC_MINT) — SPL mint for PDA derivation.
 *   SOLANA_DEPOSIT_AMOUNT + SOLANA_PAYER_TOKEN_ACCOUNT (optional, both required
 *                                       to deposit on open; else open w/o deposit).
 *   SOLANA_CHALLENGE_DURATION (default 86400)
 *
 * Mina payment (Stage 3 — opt-in; default path stays EVM-only):
 *   MINA_ZKAPP_ADDRESS                — payment-channel zkApp address (B62 base58).
 *   TARGET_SETTLEMENT_ADDRESS_MINA    — apex Mina settlement pubkey (B62 base58),
 *                                       claim recipient / channel peer.
 *     (Mina payment is ENABLED only when BOTH of the above are set. The pod then
 *      derives EVM + Mina from a single mnemonic, negotiates MINA_CHAIN_KEY, and
 *      signs a Mina balance proof.)
 *   MINA_CHAIN_KEY        (default mina:devnet)
 *   MINA_GRAPHQL_URL      — Mina GraphQL endpoint (zkApp state reads).
 *
 *   ────────────────────────────────────────────────────────────────────────────
 *   PHASE-2 STAGE-3 GATE (claim-validation divergence — NOT the #88 settle gate):
 *   This wiring is additive + safely shippable, but a LIVE Mina loop does NOT
 *   FULFILL: the client's Mina claim does not satisfy connector 3.9.0's
 *   `MinaClaimMessage` contract (it lacks `tokenId`/`balanceCommitment`/`proof`/
 *   `salt` and signs the `balanceProofFieldsMina` Schnorr message rather than the
 *   connector's `Poseidon([balA,balB,salt]) / Poseidon(zkApp.x)` commitment), and
 *   the client never opens a real on-chain zkApp channel for `getChannelState`.
 *   So a `mina:*` publish is REJECTED at the connector's `validateClaimMessage`
 *   (before settlement). See the Stage-3 PR / the gated Mina smoke for the gap.
 *   ────────────────────────────────────────────────────────────────────────────
 */

import { createConnection } from 'node:net';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
// `fastify` is imported dynamically at its use site inside main() (below) so
// that unit tests importing this module's pure helpers (parseEnv /
// isValidDirectBtpUrl / resolveBtpWiring) don't pull fastify into their module
// graph — the root vitest can't resolve the docker-package dep, and main() is
// VITEST-gated anyway. The type-only import is erased at runtime.
import type { FastifyReply, FastifyRequest } from 'fastify';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { privateKeyToAddress, generatePrivateKey } from 'viem/accounts';
import { createPublicClient, http as viemHttp } from 'viem';
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';
import { encodeEventToToon, decodeEventFromToon } from '@toon-protocol/relay';
import {
  ToonClient,
  generateMnemonic,
  deriveFullIdentity,
} from '@toon-protocol/client';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';
// Pure env/wiring helpers live in a deps-free sibling module so the unit suite
// (entrypoint-toon-client.test.ts) can import them without pulling docker-only
// runtime deps (ajv/viem/@toon-protocol/relay/nostr-tools/fastify) into its
// module graph — the root vitest can't resolve those from the repo root.
// Re-exported below for back-compat with any importer that reaches for them on
// this module.
import {
  isTruthy,
  isValidDirectBtpUrl,
  parseEnv,
  resolveBtpWiring,
  type PodEnv,
} from './entrypoint-toon-client-helpers.js';

// Back-compat re-exports (the test now targets the helpers module directly, but
// keep these so existing importers of the entrypoint still resolve the helpers).
export {
  isTruthy,
  isValidDirectBtpUrl,
  parseEnv,
  resolveBtpWiring,
  type PodEnv,
};

// Schema is loaded at runtime from a known on-image path.
const SCHEMA_PATH =
  process.env['FOREIGN_PUBLISH_SCHEMA_PATH'] ||
  '/runtime/contracts/foreign-publish.schema.json';

// Anon data directory (matches the Dockerfile.toon-client `mkdir -p
// /var/lib/anon` step). Owned by root since the container runs as root —
// same convention as docker/townhouse-ator-sidecar/Dockerfile.
const ANON_DATA_DIR = '/var/lib/anon';
const ANON_TORRC_PATH = '/etc/anon/torrc';

// ---------- Key generation (memory-only) ----------

interface EphemeralKeys {
  /**
   * BIP-39 mnemonic — present ONLY in Solana-payment mode. When set, the
   * ToonClient is constructed from this phrase so the EVM (secp256k1) and Solana
   * (Ed25519) identities derive consistently and the client registers a Solana
   * signer + opens the on-chain Solana channel with the SAME key it signs claims
   * with. In EVM-only mode this is undefined and `evmPrivateKey` is used.
   */
  mnemonic?: string;
  evmPrivateKey: `0x${string}`;
  evmAddress: `0x${string}`;
  solSecretKey: Uint8Array;
  solPublicKeyBase58: string;
  /**
   * Mina (Pallas) public key (B62 base58) — present ONLY in mnemonic mode AND
   * when `mina-signer` is installed (optional dep). Undefined otherwise.
   */
  minaAddressBase58?: string;
  nostrPubkey: string; // BTP peer identity (64-char hex secp256k1 x-coord)
}

/**
 * EVM-only ephemeral keys: random EVM + random Solana (Solana key is funded but
 * not used to pay — the EVM path negotiates EVM). Unchanged legacy behaviour.
 */
function generateEphemeralKeys(): EphemeralKeys {
  const evmPrivateKey = generatePrivateKey();
  const evmAddress = privateKeyToAddress(evmPrivateKey);
  const solSecretKey = randomBytes(32);
  const solPub = ed25519.getPublicKey(solSecretKey);
  const solPublicKeyBase58 = bs58.encode(solPub);
  const nostrPrivKey = generateSecretKey();
  const nostrPubkey = getPublicKey(nostrPrivKey);
  return {
    evmPrivateKey,
    evmAddress,
    solSecretKey,
    solPublicKeyBase58,
    nostrPubkey,
  };
}

/**
 * Solana-payment ephemeral keys: derive EVM + Solana from a single ephemeral
 * BIP-39 mnemonic via the client's own derivation (so the funded Solana pubkey,
 * the on-chain channel keypair, and the claim-signing key are all the same).
 */
async function generateMnemonicKeys(): Promise<EphemeralKeys> {
  const mnemonic = generateMnemonic();
  const identity = await deriveFullIdentity(mnemonic);
  if (!identity.solana.publicKey) {
    throw new Error(
      '[toon-client] Solana payment enabled but Solana key derivation failed ' +
        '(is the Ed25519 optional dep present in the image?)'
    );
  }
  return {
    mnemonic,
    evmPrivateKey:
      `0x${Buffer.from(identity.evm.privateKey).toString('hex')}` as `0x${string}`,
    evmAddress: identity.evm.address as `0x${string}`,
    solSecretKey: identity.solana.secretKey, // 64-byte keypair (seed||pubkey)
    solPublicKeyBase58: identity.solana.publicKey,
    // Mina pubkey is present only when mina-signer is installed (optional dep);
    // deriveFullIdentity leaves it '' otherwise. Normalise '' → undefined.
    minaAddressBase58: identity.mina.publicKey || undefined,
    nostrPubkey: getPublicKey(identity.nostr.secretKey),
  };
}

// ---------- Local anon daemon ----------

// Simple TCP connect — confirms the anon SOCKS5 port has bound and is
// accepting connections. Mirrors packages/client/src/transport/socks5.ts.
async function tcpProbe(
  host: string,
  port: number,
  timeoutMs: number
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const sock = createConnection({ host, port }, () => {
      sock.destroy();
      resolve();
    });
    sock.once('error', reject);
    sock.setTimeout(timeoutMs, () => {
      sock.destroy();
      reject(new Error('timeout'));
    });
  });
}

// Write a SOCKS-only torrc (no HiddenServiceDir — this pod is a CLIENT of the
// operator's .anyone HS, not a host). DataDirectory is /var/lib/anon (created
// by the Dockerfile). SOCKS bound to 127.0.0.1 (loopback only).
function writeTorrc(socksPort: number): void {
  mkdirSync(ANON_DATA_DIR, { recursive: true });
  mkdirSync('/etc/anon', { recursive: true });
  const torrc = [
    'AgreeToTerms 1',
    `DataDirectory ${ANON_DATA_DIR}`,
    `SOCKSPort 127.0.0.1:${socksPort}`,
    'SOCKSPolicy accept *',
    'Log notice stdout',
    'RunAsDaemon 0',
    '',
  ].join('\n');
  writeFileSync(ANON_TORRC_PATH, torrc, { mode: 0o644 });
}

// Spawn anon as a child process. Inherits stdout/stderr so its bootstrap
// progress shows up in `kubectl logs` / `provider-services logs`. Returns the
// ChildProcess so the shutdown handler can SIGTERM it.
function spawnAnon(log: (msg: string) => void): ChildProcess {
  log(`[anon] spawning: anon -f ${ANON_TORRC_PATH}`);
  const child = spawn('anon', ['-f', ANON_TORRC_PATH], {
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: false,
  });
  child.on('error', (err) => {
    log(`[anon] spawn error: ${err.message}`);
  });
  return child;
}

// Poll for the SOCKS5 port to bind. anon typically takes 30-90s to bootstrap
// (build a 3-hop circuit and consensus) before SOCKS5 accepts connections.
async function waitForAnonSocks(
  socksPort: number,
  deadlineMs: number,
  log: (msg: string) => void
): Promise<void> {
  log(`[anon] waiting for SOCKS5 bind on 127.0.0.1:${socksPort}…`);
  let lastErr: string | null = null;
  while (Date.now() < deadlineMs) {
    try {
      await tcpProbe('127.0.0.1', socksPort, 2_000);
      log(`[anon] SOCKS5 bound on 127.0.0.1:${socksPort}`);
      return;
    } catch (err) {
      const msg = (err as Error).message;
      if (msg !== lastErr) {
        log(`[anon] SOCKS5 not ready: ${msg}`);
        lastErr = msg;
      }
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(
    `[anon] SOCKS5 never bound on 127.0.0.1:${socksPort} by deadline`
  );
}

// ---------- Faucet calls (49.2 contract) ----------

async function dripFromFaucet(
  faucetUrl: string,
  chain: 'evm' | 'solana',
  recipient: string,
  log: (msg: string) => void
): Promise<void> {
  const url = `${faucetUrl.replace(/\/+$/, '')}/faucet`;
  log(
    `[faucet] POST ${url} chain=${chain} recipient=${recipient.slice(0, 10)}…`
  );
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chain, recipient }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `[faucet] ${chain} drip failed: HTTP ${res.status} ${body.slice(0, 200)}`
    );
  }
  const json = (await res.json()) as Record<string, unknown>;
  log(
    `[faucet] ${chain} drip tx=${(json['tx'] as string)?.slice(0, 20) ?? '?'}…`
  );
}

async function pollEvmBalance(
  rpcUrl: string,
  address: `0x${string}`,
  thresholdWei: bigint,
  deadlineMs: number,
  log: (msg: string) => void
): Promise<bigint> {
  const client = createPublicClient({ transport: viemHttp(rpcUrl) });
  while (Date.now() < deadlineMs) {
    try {
      const balance = await client.getBalance({ address });
      if (balance >= thresholdWei) {
        log(`[balance] EVM ${address.slice(0, 10)}… = ${balance} wei`);
        return balance;
      }
    } catch (err) {
      log(`[balance] EVM probe err: ${(err as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(
    `[balance] EVM ${address} never crossed ${thresholdWei} wei by deadline`
  );
}

async function pollSolBalance(
  rpcUrl: string,
  pubkeyBase58: string,
  thresholdLamports: number,
  deadlineMs: number,
  log: (msg: string) => void
): Promise<number> {
  while (Date.now() < deadlineMs) {
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getBalance',
          params: [pubkeyBase58],
        }),
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) {
        const json = (await res.json()) as {
          result?: { value?: number };
          error?: unknown;
        };
        if (json.error) {
          log(`[balance] SOL RPC error: ${JSON.stringify(json.error)}`);
        } else {
          const value = json.result?.value ?? 0;
          if (value >= thresholdLamports) {
            log(
              `[balance] SOL ${pubkeyBase58.slice(0, 10)}… = ${value} lamports`
            );
            return value;
          }
        }
      }
    } catch (err) {
      log(`[balance] SOL probe err: ${(err as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(
    `[balance] SOL ${pubkeyBase58} never crossed ${thresholdLamports} lamports by deadline`
  );
}

// ERC-20 balanceOf via raw eth_call; selector = keccak256("balanceOf(address)")[0:4]
async function pollEvmUsdcBalance(
  rpcUrl: string,
  tokenAddress: `0x${string}`,
  ownerAddress: `0x${string}`,
  thresholdUnits: bigint,
  deadlineMs: number,
  log: (msg: string) => void
): Promise<bigint> {
  const client = createPublicClient({ transport: viemHttp(rpcUrl) });
  const data =
    `0x70a08231${ownerAddress.slice(2).padStart(64, '0')}` as `0x${string}`;
  while (Date.now() < deadlineMs) {
    try {
      const result = await client.call({ to: tokenAddress, data });
      const balance =
        result.data && result.data !== '0x' ? BigInt(result.data) : 0n;
      if (balance >= thresholdUnits) {
        log(
          `[balance] EVM USDC ${ownerAddress.slice(0, 10)}… = ${balance} units`
        );
        return balance;
      }
    } catch (err) {
      log(`[balance] EVM USDC probe err: ${(err as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(
    `[balance] EVM USDC ${ownerAddress} never crossed ${thresholdUnits} units by deadline`
  );
}

// SPL token balance via getTokenAccountsByOwner (jsonParsed encoding).
async function pollSolUsdcBalance(
  rpcUrl: string,
  usdcMint: string,
  ownerBase58: string,
  thresholdUnits: number,
  deadlineMs: number,
  log: (msg: string) => void
): Promise<number> {
  while (Date.now() < deadlineMs) {
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTokenAccountsByOwner',
          params: [ownerBase58, { mint: usdcMint }, { encoding: 'jsonParsed' }],
        }),
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) {
        interface TResp {
          result?: {
            value?: {
              account?: {
                data?: {
                  parsed?: { info?: { tokenAmount?: { amount?: string } } };
                };
              };
            }[];
          };
          error?: unknown;
        }
        const json = (await res.json()) as TResp;
        if (json.error) {
          log(`[balance] SOL USDC RPC error: ${JSON.stringify(json.error)}`);
        } else {
          const amount = Number(
            json.result?.value?.[0]?.account?.data?.parsed?.info?.tokenAmount
              ?.amount ?? '0'
          );
          if (amount >= thresholdUnits) {
            log(
              `[balance] SOL USDC ${ownerBase58.slice(0, 10)}… = ${amount} units`
            );
            return amount;
          }
        }
      }
    } catch (err) {
      log(`[balance] SOL USDC probe err: ${(err as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(
    `[balance] SOL USDC ${ownerBase58} never crossed ${thresholdUnits} units by deadline`
  );
}

// ---------- Rate limit (windowed counter per source IP) ----------

interface BucketState {
  count: number;
  windowStart: number;
}

class IpRateLimiter {
  private readonly buckets = new Map<string, BucketState>();
  private static readonly MAX_BUCKETS = 50_000;
  constructor(private readonly perMin: number) {}

  consume(
    ip: string,
    now = Date.now()
  ): { ok: true } | { ok: false; retryAfterSec: number } {
    const windowMs = 60_000;
    const bucket = this.buckets.get(ip);
    if (!bucket || now - bucket.windowStart >= windowMs) {
      if (this.buckets.size >= IpRateLimiter.MAX_BUCKETS) {
        const oldest = this.buckets.keys().next().value;
        if (oldest !== undefined) this.buckets.delete(oldest);
      }
      this.buckets.set(ip, { count: 1, windowStart: now });
      return { ok: true };
    }
    if (bucket.count < this.perMin) {
      bucket.count += 1;
      return { ok: true };
    }
    const retryAfterSec = Math.ceil(
      (bucket.windowStart + windowMs - now) / 1000
    );
    return { ok: false, retryAfterSec: Math.max(1, retryAfterSec) };
  }
}

// ---------- ToonClient cache (per targetHostname, AC #3) ----------

interface ClientCacheEntry {
  client: ToonClient;
  channelId: string;
  createdAt: number;
}

const HOSTNAME_REGEX = /^[a-z2-7]+\.(anyone|anon)$/;
function isValidHostname(s: unknown): s is string {
  return typeof s === 'string' && s.length <= 80 && HOSTNAME_REGEX.test(s);
}

interface PublishRequestBody {
  event: NostrEvent;
  targetHostname: string;
}

// ---------- Main ----------

async function main(): Promise<void> {
  const env = parseEnv();
  const log = (msg: string): void =>
    console.log(`[${new Date().toISOString()}] ${msg}`);
  log(`[toon-client] booting — log level ${env.logLevel}`);

  // Step 1: generate ephemeral signer keys (memory only, log PUBLIC only).
  // Solana-payment mode derives EVM + Solana from a single mnemonic so the
  // funded Solana account, the on-chain channel keypair, and the claim-signing
  // key are identical; EVM-only mode keeps the legacy random-key behaviour.
  const keys =
    env.solana.enabled || env.mina.enabled
      ? await generateMnemonicKeys()
      : generateEphemeralKeys();
  log(`[keys] EVM address: ${keys.evmAddress}`);
  log(`[keys] Solana pubkey: ${keys.solPublicKeyBase58}`);
  if (env.solana.enabled) {
    log(
      `[keys] Solana payment ENABLED — chain=${env.solana.chainKey} ` +
        `program=${env.solana.programId} mint=${env.solana.tokenMint} ` +
        `apexRecipient=${env.solana.targetSettlementAddress}`
    );
  }
  if (env.mina.enabled) {
    log(
      `[keys] Mina payment ENABLED — chain=${env.mina.chainKey} ` +
        `zkApp=${env.mina.zkAppAddress} graphql=${env.mina.graphqlUrl} ` +
        `apexRecipient=${env.mina.targetSettlementAddress} ` +
        `(NOTE: live loop is claim-validation gated — see entrypoint header)`
    );
  }

  // Mutable boot state — updated asynchronously by the boot sequence below.
  // Routes read from this state so Fastify can serve /healthz immediately.
  let socks5ProxyUrl: string | null = null;
  let anyoneReady = false;
  let evmBalance = 0n;
  let solBalance = 0;
  let bootComplete = false;
  let isShuttingDown = false;
  let anonChild: ChildProcess | null = null;
  const startedAt = new Date().toISOString();

  // Step 2: ajv compile the schema (synchronous, fast)
  const ajv = new Ajv({
    strict: false,
    allErrors: true,
    allowUnionTypes: true,
  });
  addFormats(ajv);
  const schemaJson = JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8')) as object;
  ajv.addSchema(schemaJson, 'foreign-publish');
  const validateRequest = ajv.getSchema(
    'foreign-publish#/definitions/PublishRequest'
  );
  if (!validateRequest)
    throw new Error(
      'foreign-publish.schema.json missing definitions/PublishRequest'
    );

  // Step 3: rate limiter + ToonClient cache + creation lock
  const rateLimiter = new IpRateLimiter(env.publishRateLimitPerMin);
  const clientCache = new Map<string, ClientCacheEntry>();
  const clientCreating = new Map<string, Promise<ClientCacheEntry>>();

  // Step 4: start Fastify IMMEDIATELY so /healthz is reachable within ~100ms
  // of pod startup (before the proxy probe + faucet calls complete).
  const { default: Fastify } = await import('fastify');
  const fastify = Fastify({
    logger: { level: env.logLevel },
    bodyLimit: 64 * 1024,
  });

  // NOTE: balances reflect the boot-time faucet drip and are NOT refreshed
  // after boot. Use for readiness signalling only.
  // anyoneReady = local anon daemon SOCKS5 bound AND faucet funding complete.
  fastify.get('/healthz', () => ({
    anyoneReady: anyoneReady && bootComplete,
    evmAddr: keys.evmAddress,
    solAddr: keys.solPublicKeyBase58,
    // Mina (Pallas) B62 address — present only in mnemonic mode with mina-signer
    // installed. Surfaced so the e2e harness can fund this address (it must pay
    // its own on-chain initializeChannel + deposit tx fees on the Mina channel).
    minaAddr: keys.minaAddressBase58 ?? '',
    balances: { evm: String(evmBalance), sol: solBalance },
    bootedAt: startedAt,
  }));

  fastify.get('/signer-info', () => ({
    evm: keys.evmAddress,
    sol: keys.solPublicKeyBase58,
    // Mina (Pallas) B62 address (see /healthz note). Empty when unavailable.
    mina: keys.minaAddressBase58 ?? '',
    nostrPubkey: keys.nostrPubkey,
    balances: { evm: String(evmBalance), sol: solBalance },
    bootedAt: startedAt,
    transport: env.directBtp
      ? { type: 'direct', socksProxy: '' }
      : socks5ProxyUrl
        ? { type: 'socks5', socksProxy: socks5ProxyUrl }
        : { type: 'none', socksProxy: '' },
  }));

  fastify.post('/publish', async (req: FastifyRequest, reply: FastifyReply) => {
    // AC #9: rate limit per source IP. XFF is set by the Akash L7 ingress.
    // LIMITATION: callers can spoof X-Forwarded-For to bypass per-IP limiting.
    // Acceptable for a dev fixture; production fix: validate XFF against a
    // known-proxy IP range or set TRUST_PROXY=0 to use req.socket.remoteAddress.
    const ip =
      (req.headers['x-forwarded-for'] as string | undefined)
        ?.split(',')[0]
        ?.trim() ||
      req.ip ||
      'unknown';
    const verdict = rateLimiter.consume(ip);
    if (!verdict.ok) {
      reply.header('retry-after', String(verdict.retryAfterSec));
      return reply
        .status(429)
        .send({ error: 'rate_limited', retryAfterSec: verdict.retryAfterSec });
    }

    const body = req.body as PublishRequestBody;
    if (!validateRequest(body)) {
      const errors = validateRequest.errors ?? [];
      const missingTarget = errors.find(
        (e) =>
          e.keyword === 'required' &&
          (e.params as { missingProperty?: string })?.missingProperty ===
            'targetHostname'
      );
      if (missingTarget) {
        return reply
          .status(400)
          .send({ error: 'targetHostname required', field: 'targetHostname' });
      }
      return reply.status(400).send({
        error: 'invalid_request',
        ajvErrors: errors.map((e) => ({
          path: e.instancePath,
          message: e.message,
          keyword: e.keyword,
        })),
      });
    }
    // In direct-BTP mode routing is env-driven (APEX_BTP_URL); the request's
    // targetHostname is NOT a .anon hostname and is not used to build the URL,
    // so skip the strict HS hostname check. The HS path stays strict.
    if (!env.directBtp && !isValidHostname(body.targetHostname)) {
      return reply.status(400).send({
        error: 'targetHostname must match /^[a-z2-7]+\\.(anyone|anon)$/',
        field: 'targetHostname',
      });
    }

    // Return 503 while boot sequence (anon SOCKS5 bind + faucet fund) is still running.
    if (!bootComplete) {
      return reply.status(503).send({ error: 'booting', retryable: true });
    }
    // Direct-BTP mode has no SOCKS proxy to wait for — readiness is faucet-only
    // (bootComplete). The HS/SOCKS path still requires a resolved proxy.
    if (!env.directBtp && (!anyoneReady || !socks5ProxyUrl)) {
      return reply.status(503).send({
        error: 'anon_not_ready',
        detail: 'local anon daemon SOCKS5 port not bound',
        retryable: true,
      });
    }
    // Resolve BTP endpoint + transport + cache key once for this mode. Direct:
    // plain ws:// apex (cache keyed by URL). HS/SOCKS: ws://<host>:3000/btp over
    // the resolved proxy (cache keyed by the .anon targetHostname).
    const wiring = resolveBtpWiring({
      directBtp: env.directBtp,
      apexBtpUrl: env.apexBtpUrl,
      targetHostname: body.targetHostname,
      resolvedProxy: socks5ProxyUrl,
    });
    const targetHostname = wiring.cacheKey;
    const event = body.event;
    const startMs = Date.now();

    try {
      let entry = clientCache.get(targetHostname);
      if (!entry) {
        // Per-hostname creation lock — prevents concurrent first-publishes from
        // each creating a ToonClient, leaking a BTP socket + double openChannel.
        let creating = clientCreating.get(targetHostname);
        if (!creating) {
          creating = (async () => {
            // Multi-chain settlement maps. EVM is always present; Solana is
            // added (and chosen as the negotiated chain) when SOLANA_PROGRAM_ID +
            // TARGET_SETTLEMENT_ADDRESS_SOLANA are set. The default (EVM-only)
            // path is byte-for-byte the legacy single-chain config.
            const supportedChains = [env.chainKey];
            const chainRpcUrls: Record<string, string> = {
              [env.chainKey]: env.evmRpcUrl,
            };
            const settlementAddresses: Record<string, string> = {
              [env.chainKey]: keys.evmAddress,
            };
            const preferredTokens: Record<string, string> = {
              [env.chainKey]: env.tokenAddress,
            };
            const tokenNetworks: Record<string, string> = {
              [env.chainKey]: env.tokenNetworkAddress,
            };

            if (env.solana.enabled) {
              supportedChains.push(env.solana.chainKey);
              chainRpcUrls[env.solana.chainKey] = env.solanaRpcUrl;
              settlementAddresses[env.solana.chainKey] =
                keys.solPublicKeyBase58;
              preferredTokens[env.solana.chainKey] = env.solana.tokenMint;
              // For Solana the "tokenNetwork" slot carries the program id — it is
              // what the ChannelManager records and the connector reads as the
              // payment-channel program (ChainMetadata.programId).
              tokenNetworks[env.solana.chainKey] = env.solana.programId;
            }

            if (env.mina.enabled) {
              supportedChains.push(env.mina.chainKey);
              // Mina reads zkApp state over GraphQL; reuse the rpc-url slot for
              // the GraphQL endpoint (the Mina channel client reads graphqlUrl
              // from minaChannel config below, but keeping the map symmetric with
              // Solana/EVM avoids "no rpc url for chain" surprises elsewhere).
              chainRpcUrls[env.mina.chainKey] = env.mina.graphqlUrl;
              settlementAddresses[env.mina.chainKey] =
                keys.minaAddressBase58 ?? '';
              // Mina "tokenNetwork" slot carries the zkApp address (the
              // ChainMetadata.zkAppAddress the connector verifies against).
              tokenNetworks[env.mina.chainKey] = env.mina.zkAppAddress;
            }

            // BTP endpoint + transport resolved above (resolveBtpWiring): direct
            // ws:// apex + {type:'direct'} OR ws://<host>:3000/btp + socks5.
            const { btpUrl, transport } = wiring;

            const client = new ToonClient({
              connectorUrl: 'http://127.0.0.1:1', // required by validateConfig, unused at runtime
              // Solana/Mina mode: drive from a mnemonic so the client derives +
              // registers the corresponding chain signer (Solana Ed25519 / Mina
              // Pallas) consistent with the funded account and the channel key.
              // EVM-only mode: explicit EVM key (legacy).
              ...(env.solana.enabled || env.mina.enabled
                ? { mnemonic: keys.mnemonic }
                : { evmPrivateKey: keys.evmPrivateKey }),
              ilpInfo: {
                pubkey: '00'.repeat(32),
                ilpAddress: `g.toon.client.${keys.evmAddress.slice(2, 18).toLowerCase()}`,
                btpEndpoint: btpUrl,
                assetCode: 'USD',
                assetScale: 6,
              },
              toonEncoder: encodeEventToToon,
              toonDecoder: decodeEventFromToon,
              btpUrl,
              btpPeerId: keys.evmAddress,
              btpAuthToken: '',
              transport,
              destinationAddress: 'g.townhouse.town',
              knownPeers: [],
              relayUrl: '',
              supportedChains,
              chainRpcUrls,
              settlementAddresses,
              preferredTokens,
              tokenNetworks,
              // Solana payment-channel params — wired into the on-chain channel
              // client so negotiating solana:* opens a REAL on-chain channel
              // (connector-parity PDA) and signs a connector-format claim.
              ...(env.solana.enabled
                ? {
                    solanaChannel: {
                      rpcUrl: env.solanaRpcUrl,
                      programId: env.solana.programId,
                      tokenMint: env.solana.tokenMint,
                      challengeDuration: env.solana.challengeDuration,
                      ...(env.solana.depositAmount &&
                      env.solana.payerTokenAccount
                        ? {
                            deposit: {
                              amount: env.solana.depositAmount,
                              // The payer's funded SPL token account (ATA for
                              // owner=client Solana pubkey, mint), created/funded
                              // out-of-band by the e2e bootstrap.
                              payerTokenAccount: env.solana.payerTokenAccount,
                            },
                          }
                        : {}),
                    },
                  }
                : {}),
              // Mina payment-channel params (Stage 3) — wired into the on-chain
              // channel client so negotiating mina:* routes through openMinaChannel
              // and signs a Mina balance proof. GATE: the resulting claim does not
              // yet satisfy connector 3.9.0's MinaClaimMessage contract, so a live
              // loop is claim-validation gated (see the entrypoint header).
              ...(env.mina.enabled
                ? {
                    minaChannel: {
                      graphqlUrl: env.mina.graphqlUrl,
                      zkAppAddress: env.mina.zkAppAddress,
                      // On-chain deposit so the zkApp's claimFromChannel
                      // conservation check (balanceA + balanceB == depositTotal)
                      // can be satisfied by the client's first claim. Omitted
                      // when depositAmount=0 (open-only, off-chain-store only).
                      ...(env.mina.depositAmount > 0n
                        ? {
                            deposit: {
                              amount: env.mina.depositAmount.toString(),
                            },
                          }
                        : {}),
                    },
                  }
                : {}),
            });
            await client.start();

            // Inject peer negotiation — bootstrap returns 0 peers (no relayUrl),
            // so we tell the channel manager the apex's settlement address manually.
            // Mirrors 49.1 Step 17. In Solana mode we negotiate the Solana chain
            // (chainType 'solana', programId in tokenNetwork, apex Solana pubkey as
            // recipient) so openChannel() opens the on-chain Solana channel and the
            // balance proof is a Solana-denominated claim; otherwise EVM as before.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const negotiations = (client as any).peerNegotiations as
              | Map<string, unknown>
              | undefined;
            if (!(negotiations instanceof Map))
              throw new Error('ToonClient.peerNegotiations layout changed');
            if (env.solana.enabled) {
              negotiations.set('town', {
                chain: env.solana.chainKey,
                chainType: 'solana' as const,
                chainId: 0,
                settlementAddress: env.solana.targetSettlementAddress,
                tokenAddress: env.solana.tokenMint,
                tokenNetwork: env.solana.programId,
              });
            } else if (env.mina.enabled) {
              // Mina negotiation: chainType 'mina', the zkApp address in the
              // tokenNetwork slot, apex Mina pubkey as recipient. openChannel()
              // then routes through openMinaChannel and the balance proof is a
              // Mina-denominated claim. GATE: claim diverges from connector 3.9.0's
              // MinaClaimMessage contract → REJECTED at validateClaimMessage.
              negotiations.set('town', {
                chain: env.mina.chainKey,
                chainType: 'mina' as const,
                chainId: 0,
                settlementAddress: env.mina.targetSettlementAddress,
                tokenAddress: env.mina.zkAppAddress,
                tokenNetwork: env.mina.zkAppAddress,
              });
            } else {
              negotiations.set('town', {
                chain: env.chainKey,
                chainType: 'evm' as const,
                chainId: env.chainId,
                settlementAddress: env.targetSettlementAddress,
                tokenAddress: env.tokenAddress,
                tokenNetwork: env.tokenNetworkAddress,
              });
            }

            const channelId = await client.openChannel('g.townhouse.town');
            const newEntry: ClientCacheEntry = {
              client,
              channelId,
              createdAt: Date.now(),
            };
            clientCache.set(targetHostname, newEntry);
            req.log.info(
              { targetHostname, channelId },
              '[publish] new ToonClient cached'
            );
            return newEntry;
          })();
          clientCreating.set(targetHostname, creating);
          creating
            .finally(() => clientCreating.delete(targetHostname))
            .catch(() => {
              /* logged below */
            });
        }
        // Race client creation against a 45s deadline so the pod returns a JSON
        // 503+retryable before the Akash nginx ingress times out at ~60s.
        // The creating promise keeps running in the background and will populate
        // clientCache when it eventually resolves, so the next retry gets a cache hit.
        const createDeadline = new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error('publish_timeout')), 45_000)
        );
        try {
          entry = await Promise.race([creating, createDeadline]);
        } catch (createErr) {
          const createMsg =
            createErr instanceof Error ? createErr.message : String(createErr);
          if (createMsg === 'publish_timeout') {
            return reply
              .status(503)
              .send({ error: 'publish_timeout', retryable: true });
          }
          throw createErr;
        }
      }

      const _toonBytes = encodeEventToToon(event);
      // Use env.feePerEvent (TOON_FEE_PER_EVENT, default 0) as both the
      // cumulative balance-proof amount and the ILP PREPARE amount.  When
      // fee=0 the relay accepts the event for free and the connector skips
      // per-packet claim generation (amount===0n guard in packet-handler.ts).
      const paymentAmount = env.feePerEvent;
      const proof = await entry.client.signBalanceProof(
        entry.channelId,
        paymentAmount
      );

      // AC #7: caller controls retries; pod has no replay cache.
      const publishResult = await entry.client.publishEvent(event, {
        claim: proof,
        ilpAmount: env.feePerEvent,
      });
      const durationMs = Date.now() - startMs;

      if (!publishResult.success) {
        return reply.status(502).send({
          error: publishResult.error || 'relay rejected event',
          relayAck: publishResult.error,
          retryable: true,
        });
      }

      return reply.status(202).send({
        eventId: publishResult.eventId,
        claimHash: `0x${Buffer.from(proof.signature.slice(2), 'hex').slice(0, 32).toString('hex')}`,
        chainId: env.chainId,
        publishedAt: new Date().toISOString(),
        durationMs,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const cause =
        err instanceof Error && err.cause instanceof Error
          ? err.cause.message
          : null;
      const detail = cause ? `${msg}: ${cause}` : msg;
      req.log.error({ err: detail, targetHostname }, '[publish] failed');
      return reply.status(502).send({ error: detail, retryable: true });
    }
  });

  // Step 5: listen immediately — /healthz is now reachable
  await fastify.listen({ host: '0.0.0.0', port: env.podPort });
  log(`[fastify] listening on 0.0.0.0:${env.podPort}`);

  // Step 6: configure transport + faucet fund run ASYNC after Fastify is up.
  // Transport modes (mutually exclusive — ANYONE_PROXY_URLS takes precedence):
  //   ator-public (ANYONE_PROXY_URLS set):  use public ATOR proxy directly — fast boot
  //   ator-onion  (ANYONE_PROXY_URLS unset): spawn local anon daemon — 30-90s bootstrap
  // /healthz returns anyoneReady:false until transport is ready AND boot completes.
  void (async () => {
    try {
      if (env.directBtp) {
        // direct-BTP mode (Phase 1): plain ws:// apex, no SOCKS proxy. No public
        // ATOR proxy is resolved and no local anon daemon is spawned. The pod
        // dials the apex BTP endpoint directly; readiness gates on faucet funding
        // only (socks5ProxyUrl stays null and is unused on the direct path).
        log(`[transport] direct-BTP mode — apex ${env.apexBtpUrl}`);
      } else if (env.anyoneProxyUrl) {
        // ator-public mode: the smoke test's beforeAll SOCKS5 probe confirms the
        // public proxy can reach the local apex .anon HS BEFORE /publish runs.
        // No local anon daemon needed — faster boot, simpler operation.
        socks5ProxyUrl = env.anyoneProxyUrl;
        log(`[proxy] ator-public mode — ${socks5ProxyUrl}`);
      } else {
        // ator-onion mode: spawn local anon daemon; wait for SOCKS5 bind.
        // 6a: write torrc + spawn anon daemon.
        writeTorrc(env.anonSocksPort);
        anonChild = spawnAnon(log);
        anonChild.on('exit', (code, signal) => {
          // If anon dies unexpectedly the pod is unusable — flip anyoneReady so
          // /publish 503s, and exit non-zero so the Akash provider restarts us.
          // During intentional shutdown isShuttingDown=true and we skip exit().
          anyoneReady = false;
          log(`[anon] child exited code=${code} signal=${signal}`);
          if (!isShuttingDown) {
            log('[anon] unexpected exit — exiting pod for provider restart');
            process.exit(code ?? 1);
          }
        });

        // 6b: wait for SOCKS5 bind (180s deadline — anon bootstrap is slow).
        await waitForAnonSocks(env.anonSocksPort, Date.now() + 180_000, log);
        socks5ProxyUrl = `socks5h://127.0.0.1:${env.anonSocksPort}`;
        log(`[anon] using ${socks5ProxyUrl} for outbound BTP`);
      }

      // 6c: faucet drip + native balance polling (each chain gets its own
      // env.fundPollDeadlineMs window; default 30s, override FUND_POLL_DEADLINE_MS).
      //
      // Drip is BEST-EFFORT: if the faucet is unreachable (cross-provider HTTPS
      // can be flaky on Akash — see story 49.4 carry-forward #4), the pod still
      // boots provided an operator pre-funds the addresses out-of-band (e.g.
      // anvil_setBalance for EVM, solana airdrop / spl-token mint-to for SOL).
      // The poll is what actually unlocks anyoneReady=true; the drip just makes
      // the happy path automatic. USDC polls are best-effort regardless.
      const [evmBal, solBal] = await Promise.all([
        (async () => {
          dripFromFaucet(env.faucetUrl, 'evm', keys.evmAddress, log).catch(
            (err: Error) =>
              log(
                `[faucet] EVM drip non-fatal: ${err.message} — relying on out-of-band funding`
              )
          );
          const deadline = Date.now() + env.fundPollDeadlineMs;
          const bal = await pollEvmBalance(
            env.evmRpcUrl,
            keys.evmAddress,
            env.evmEthThresholdWei,
            deadline,
            log
          );
          pollEvmUsdcBalance(
            env.evmRpcUrl,
            env.tokenAddress,
            keys.evmAddress,
            env.evmUsdcThreshold,
            deadline,
            log
          ).catch((err: Error) =>
            log(`[balance] EVM USDC (non-fatal): ${err.message}`)
          );
          return bal;
        })(),
        (async () => {
          dripFromFaucet(
            env.faucetUrl,
            'solana',
            keys.solPublicKeyBase58,
            log
          ).catch((err: Error) =>
            log(
              `[faucet] SOL drip non-fatal: ${err.message} — relying on out-of-band funding`
            )
          );
          const deadline = Date.now() + env.fundPollDeadlineMs;
          const bal = await pollSolBalance(
            env.solanaRpcUrl,
            keys.solPublicKeyBase58,
            env.solLamportThreshold,
            deadline,
            log
          );
          pollSolUsdcBalance(
            env.solanaRpcUrl,
            env.solanaUsdcMint,
            keys.solPublicKeyBase58,
            env.solUsdcThreshold,
            deadline,
            log
          ).catch((err: Error) =>
            log(`[balance] SOL USDC (non-fatal): ${err.message}`)
          );
          return bal;
        })(),
      ]);
      evmBalance = evmBal;
      solBalance = Number(solBal);
      bootComplete = true;
      anyoneReady = true;
      log(
        `[boot] complete — EVM=${evmBalance} wei, SOL=${solBalance} lamports, proxy=${socks5ProxyUrl}`
      );
    } catch (err) {
      log(
        `[boot] ERROR: ${(err as Error).message} — pod running but boot failed; /publish will 503`
      );
    }
  })();

  const shutdown = async (signal: string): Promise<void> => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    log(`[shutdown] received ${signal}`);
    try {
      await fastify.close();
    } catch (err) {
      log(`[shutdown] fastify: ${(err as Error).message}`);
    }
    for (const [hostname, entry] of clientCache.entries()) {
      try {
        await entry.client.stop();
      } catch (err) {
        log(`[shutdown] stop ${hostname}: ${(err as Error).message}`);
      }
    }
    if (anonChild && !anonChild.killed) {
      try {
        log('[shutdown] SIGTERM anon child');
        anonChild.kill('SIGTERM');
      } catch (err) {
        log(`[shutdown] anon: ${(err as Error).message}`);
      }
    }
    setTimeout(() => process.exit(0), 2_000).unref();
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

// Gated so importing this module from a test (Vitest sets VITEST=true) does NOT
// trigger main() — tests drive parseEnv/isValidDirectBtpUrl directly.
if (!process.env['VITEST']) {
  main().catch((err: unknown) => {
    console.error(
      `[toon-client] fatal: ${err instanceof Error ? err.stack || err.message : String(err)}`
    );
    process.exit(1);
  });
}
