/**
 * Pure, dependency-light helpers extracted from entrypoint-toon-client.ts.
 *
 * This module deliberately imports NOTHING heavy: no ajv/ajv-formats, no
 * fastify, no viem, no @toon-protocol/relay, no nostr-tools. The only import is
 * a TYPE-ONLY import of `ClientTransportConfig` from `@toon-protocol/client`
 * (erased at runtime). That keeps the unit-test module graph free of
 * docker-package-only runtime deps so the root vitest can load the suite even
 * though those deps aren't resolvable from the repo root.
 *
 * Behaviour here is IDENTICAL to the definitions that previously lived inline in
 * entrypoint-toon-client.ts — these are pure moves (parseEnv reads process.env
 * exactly as before; resolveBtpWiring returns the same shape).
 */

import type { ClientTransportConfig } from '@toon-protocol/client';

// ---------- Env parsing ----------

export interface PodEnv {
  faucetUrl: string;
  evmRpcUrl: string;
  solanaRpcUrl: string;
  podPort: number;
  publishRateLimitPerMin: number;
  logLevel: string;
  anyoneProxyUrl: string | null; // ator-public mode; null → ator-onion (local anon)
  anonSocksPort: number;
  /**
   * Direct-BTP mode (Phase 1). When true the pod connects straight to the apex
   * over a plain `ws://`/`wss://` BTP endpoint with `transport:{type:'direct'}`
   * and NO SOCKS proxy — no public ATOR proxy, no local anon daemon. Toggled by
   * the truthy `DIRECT_BTP` env. When enabled, `apexBtpUrl` (APEX_BTP_URL) is
   * REQUIRED and the SOCKS/anon envs (ANYONE_PROXY_URLS, ANON_SOCKS_PORT) are
   * OPTIONAL/unused. Default (unset) keeps the exact legacy HS/SOCKS behaviour.
   */
  directBtp: boolean;
  /**
   * Plain BTP endpoint for the apex (ws:// or wss://, host[:port], path /btp).
   * Present (and required) ONLY in direct-BTP mode; undefined otherwise.
   */
  apexBtpUrl?: string;
  fundPollDeadlineMs: number;
  chainKey: string;
  chainId: number;
  tokenAddress: `0x${string}`;
  tokenNetworkAddress: `0x${string}`;
  targetSettlementAddress: `0x${string}`;
  evmEthThresholdWei: bigint;
  solLamportThreshold: number;
  solanaUsdcMint: string;
  evmUsdcThreshold: bigint;
  solUsdcThreshold: number;
  feePerEvent: bigint; // ILP units per publish (0 = free relay)
  /**
   * Solana payment params. When `solana.enabled` is true the pod negotiates a
   * Solana-denominated claim (in ADDITION to the EVM path): it pays the apex on
   * Solana, opening a real on-chain channel and signing a connector-format
   * Solana balance proof (client lib post-#105). Enabled when SOLANA_PROGRAM_ID
   * and TARGET_SETTLEMENT_ADDRESS_SOLANA are both set. Default EVM path is
   * unchanged when these are unset.
   */
  solana: {
    enabled: boolean;
    chainKey: string; // e.g. "solana:devnet"
    programId: string;
    tokenMint: string; // SPL mint (base58) used for PDA derivation + as the negotiated token
    targetSettlementAddress: string; // apex Solana settlement pubkey (base58) — claim recipient / channel peer
    // Optional on-chain deposit when opening the channel: BOTH the amount (base
    // units) AND the payer's funded SPL token account (ATA, base58) must be set.
    // When omitted the channel opens without a deposit (connector accepts on
    // `opened` status + participant membership; deposit is consumed only at
    // on-chain claim/settle time).
    depositAmount: string | null;
    payerTokenAccount: string | null;
    challengeDuration: number;
  };
  /**
   * Mina payment params (Stage 3). When `mina.enabled` is true the pod
   * negotiates a Mina-denominated claim. Enabled when MINA_ZKAPP_ADDRESS and
   * TARGET_SETTLEMENT_ADDRESS_MINA are both set. Default EVM path is unchanged
   * when these are unset. NOTE: a live Mina loop is claim-validation gated (the
   * client claim diverges from connector 3.9.0's MinaClaimMessage contract); the
   * wiring is shipped so the negotiation path exists and is exercised by the
   * gated smoke.
   */
  mina: {
    enabled: boolean;
    chainKey: string; // e.g. "mina:devnet"
    graphqlUrl: string;
    zkAppAddress: string; // deployed payment-channel zkApp (B62 base58)
    targetSettlementAddress: string; // apex Mina settlement pubkey (B62 base58)
    /**
     * On-chain MINA deposit (base units) the client deposits into the channel
     * after `initializeChannel`. REQUIRED for the connector to settle on-chain:
     * the zkApp `claimFromChannel` enforces conservation
     * (`newBalanceA + newBalanceB == depositTotal`), so a 0-deposit channel can
     * only ever settle a 0-value claim. Default 0 (open without deposit — claim
     * verifies + stores off-chain but cannot land an on-chain claimFromChannel).
     */
    depositAmount: bigint;
  };
}

// Truthy env parse — accepts 1/true/yes/on (case-insensitive). Anything else
// (including unset / "0" / "false") is false, so legacy deployments that never
// set DIRECT_BTP keep the exact HS/SOCKS behaviour.
export function isTruthy(v: string | undefined): boolean {
  if (!v) return false;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}

/**
 * Direct-BTP URL validator (Phase 1). Accepts a plain BTP endpoint:
 *   ws://  | wss://   scheme,
 *   a host with an OPTIONAL :port,
 *   path === '/btp' (no query/fragment),
 *   sane length cap.
 *
 * This is SEPARATE from HOSTNAME_REGEX on purpose — the .anon/.anyone HS path
 * stays strict (a plain host like `apex` or `localhost` must NOT pass the HS
 * validator). Conversely the HS targetHostname (e.g. `abc.anon`) is NOT a URL
 * and must NOT pass this one.
 */
export function isValidDirectBtpUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length === 0 || url.length > 512) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return false;
  if (!parsed.hostname) return false;
  if (parsed.pathname !== '/btp') return false;
  if (parsed.search !== '' || parsed.hash !== '') return false;
  if (parsed.username !== '' || parsed.password !== '') return false;
  return true;
}

export function parseEnv(): PodEnv {
  const env = process.env;
  const need = (k: string): string => {
    const v = env[k];
    if (!v) throw new Error(`[toon-client] required env ${k} is unset`);
    return v;
  };
  const rateLimitPerMin = parseInt(
    env['PUBLISH_RATE_LIMIT_PER_MIN'] || '30',
    10
  );
  if (!Number.isInteger(rateLimitPerMin) || rateLimitPerMin < 1) {
    throw new Error(
      `[toon-client] PUBLISH_RATE_LIMIT_PER_MIN must be a positive integer, got: ${env['PUBLISH_RATE_LIMIT_PER_MIN']}`
    );
  }
  const anonSocksPort = parseInt(env['ANON_SOCKS_PORT'] || '9050', 10);
  if (
    !Number.isInteger(anonSocksPort) ||
    anonSocksPort < 1 ||
    anonSocksPort > 65535
  ) {
    throw new Error(
      `[toon-client] ANON_SOCKS_PORT must be a valid port, got: ${env['ANON_SOCKS_PORT']}`
    );
  }

  // Per-chain native-balance poll window for boot funding. Default 30s keeps the
  // historical behaviour, but Solana airdrop confirmation on a local validator
  // can exceed 30s when funding starts at boot (the `ator-public` proxy mode has
  // no anon-bootstrap buffer ahead of the poll), causing a false "never crossed
  // 1 lamport by deadline" boot failure even though the address gets funded.
  // Allow operators / E2E infra to widen it via FUND_POLL_DEADLINE_MS.
  const fundPollDeadlineMs = parseInt(
    env['FUND_POLL_DEADLINE_MS'] || '30000',
    10
  );
  if (!Number.isInteger(fundPollDeadlineMs) || fundPollDeadlineMs < 1000) {
    throw new Error(
      `[toon-client] FUND_POLL_DEADLINE_MS must be an integer >= 1000, got: ${env['FUND_POLL_DEADLINE_MS']}`
    );
  }
  // Direct-BTP mode (Phase 1): plain ws:// apex, no SOCKS proxy. When enabled,
  // APEX_BTP_URL is REQUIRED and the SOCKS/anon envs become optional/unused.
  const directBtp = isTruthy(env['DIRECT_BTP']);
  const apexBtpUrl = env['APEX_BTP_URL']?.trim() || undefined;
  if (directBtp) {
    if (!apexBtpUrl) {
      throw new Error(
        '[toon-client] DIRECT_BTP is enabled but APEX_BTP_URL is unset ' +
          '(direct-BTP mode requires a plain ws://host:port/btp apex endpoint)'
      );
    }
    if (!isValidDirectBtpUrl(apexBtpUrl)) {
      throw new Error(
        `[toon-client] APEX_BTP_URL must be a ws://|wss:// host[:port] /btp URL, got: ${apexBtpUrl}`
      );
    }
  }

  // ator-public mode: take the first URL from the comma-separated list. Optional
  // in direct-BTP mode (no proxy is resolved/spawned), so only validated when set.
  const rawProxy = env['ANYONE_PROXY_URLS']?.split(',')[0]?.trim() || null;
  if (rawProxy && !rawProxy.startsWith('socks5h://')) {
    throw new Error(
      `[toon-client] ANYONE_PROXY_URLS must use socks5h:// scheme, got: ${rawProxy}`
    );
  }

  // Solana payment: enabled only when both the program id and the apex's Solana
  // settlement address are present (you cannot open a channel / address a claim
  // without both). Everything else falls back to sensible local-devnet defaults.
  const solanaProgramId = env['SOLANA_PROGRAM_ID']?.trim() || '';
  const solanaTargetSettlement =
    (
      env['TARGET_SETTLEMENT_ADDRESS_SOLANA'] ||
      env['SOLANA_TARGET_SETTLEMENT_ADDRESS']
    )?.trim() || '';
  const solanaEnabled = solanaProgramId !== '' && solanaTargetSettlement !== '';
  const solanaTokenMint =
    env['SOLANA_TOKEN_MINT']?.trim() ||
    env['SOLANA_USDC_MINT']?.trim() ||
    '6GbdrVghwNKTz9raga7y3Y4qqX5Zgg3AC4d48Kt7C59Q';
  const solanaDepositAmount = env['SOLANA_DEPOSIT_AMOUNT']?.trim() || null;
  const solanaPayerTokenAccount =
    env['SOLANA_PAYER_TOKEN_ACCOUNT']?.trim() || null;
  const solanaChallengeDuration = parseInt(
    env['SOLANA_CHALLENGE_DURATION'] || '86400',
    10
  );
  if (
    !Number.isInteger(solanaChallengeDuration) ||
    solanaChallengeDuration < 1
  ) {
    throw new Error(
      `[toon-client] SOLANA_CHALLENGE_DURATION must be a positive integer, got: ${env['SOLANA_CHALLENGE_DURATION']}`
    );
  }

  // Mina payment (Stage 3): enabled only when both the zkApp address and the
  // apex's Mina settlement address are present. Mirrors the Solana enable gate.
  const minaZkAppAddress = env['MINA_ZKAPP_ADDRESS']?.trim() || '';
  const minaTargetSettlement =
    (
      env['TARGET_SETTLEMENT_ADDRESS_MINA'] ||
      env['MINA_TARGET_SETTLEMENT_ADDRESS']
    )?.trim() || '';
  const minaEnabled = minaZkAppAddress !== '' && minaTargetSettlement !== '';
  const minaGraphqlUrl =
    env['MINA_GRAPHQL_URL']?.trim() ||
    'http://host.docker.internal:28085/graphql';

  return {
    faucetUrl: need('FAUCET_URL'),
    evmRpcUrl: need('EVM_RPC_URL'),
    solanaRpcUrl: need('SOLANA_RPC_URL'),
    podPort: parseInt(env['POD_PORT'] || '8080', 10),
    publishRateLimitPerMin: rateLimitPerMin,
    logLevel: env['LOG_LEVEL'] || 'info',
    anyoneProxyUrl: rawProxy,
    anonSocksPort,
    directBtp,
    apexBtpUrl,
    fundPollDeadlineMs,
    chainKey: env['TOON_CHAIN_KEY'] || 'evm:base:31337',
    chainId: parseInt(env['TOON_CHAIN_ID'] || '31337', 10),
    tokenAddress:
      (env['TOON_TOKEN_ADDRESS'] as `0x${string}`) ||
      '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    tokenNetworkAddress:
      (env['TOON_TOKEN_NETWORK_ADDRESS'] as `0x${string}`) ||
      '0xCafac3dD18aC6c6e92c921884f9E4176737C052c',
    targetSettlementAddress:
      (env['TARGET_SETTLEMENT_ADDRESS'] as `0x${string}`) ||
      '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
    evmEthThresholdWei: 1n,
    solLamportThreshold: 1,
    solanaUsdcMint:
      env['SOLANA_USDC_MINT'] || '6GbdrVghwNKTz9raga7y3Y4qqX5Zgg3AC4d48Kt7C59Q',
    evmUsdcThreshold: 1_000_000n,
    solUsdcThreshold: 1_000_000,
    feePerEvent: BigInt(env['TOON_FEE_PER_EVENT'] || '0'),
    solana: {
      enabled: solanaEnabled,
      chainKey: env['SOLANA_CHAIN_KEY']?.trim() || 'solana:devnet',
      programId: solanaProgramId,
      tokenMint: solanaTokenMint,
      targetSettlementAddress: solanaTargetSettlement,
      depositAmount: solanaDepositAmount,
      payerTokenAccount: solanaPayerTokenAccount,
      challengeDuration: solanaChallengeDuration,
    },
    mina: {
      enabled: minaEnabled,
      chainKey: env['MINA_CHAIN_KEY']?.trim() || 'mina:devnet',
      graphqlUrl: minaGraphqlUrl,
      zkAppAddress: minaZkAppAddress,
      targetSettlementAddress: minaTargetSettlement,
      // On-chain channel deposit (base units). Defaults to 1_000_000 (matches
      // the apex's per-publish USDC-scale fee) so a single publish's claimed
      // balanceA fully consumes the deposit (balanceB=0) and conservation holds.
      depositAmount: BigInt(env['MINA_DEPOSIT_AMOUNT']?.trim() || '1000000'),
    },
  };
}

// ---------- BTP wiring resolution ----------

/**
 * Resolve the BTP endpoint + transport for a ToonClient based on transport mode.
 *
 * Direct-BTP: plain ws:// apex from APEX_BTP_URL + transport:{type:'direct'}
 *             (no SOCKS proxy). `cacheKey` is the apex URL.
 * HS/SOCKS:   ws://<targetHostname>:3000/btp + transport:{type:'socks5'} over
 *             the resolved proxy. `cacheKey` is the .anon targetHostname.
 *
 * Exported for unit coverage (deterministic; no network).
 */
export function resolveBtpWiring(args: {
  directBtp: boolean;
  apexBtpUrl?: string;
  targetHostname: string;
  resolvedProxy: string | null;
}): { btpUrl: string; transport: ClientTransportConfig; cacheKey: string } {
  if (args.directBtp) {
    if (!args.apexBtpUrl) {
      throw new Error(
        '[toon-client] resolveBtpWiring: direct-BTP mode requires apexBtpUrl'
      );
    }
    return {
      btpUrl: args.apexBtpUrl,
      transport: { type: 'direct' },
      cacheKey: args.apexBtpUrl,
    };
  }
  if (!args.resolvedProxy) {
    throw new Error(
      '[toon-client] resolveBtpWiring: HS/SOCKS mode requires a resolved proxy'
    );
  }
  return {
    btpUrl: `ws://${args.targetHostname}:3000/btp`,
    transport: { type: 'socks5', socksProxy: args.resolvedProxy },
    cacheKey: args.targetHostname,
  };
}
