# Dev Fixtures

Mill config files for the Townhouse dev stack (`docker-compose-townhouse-dev.yml`).

## Files

| File | Swap Pair | Story |
|------|-----------|-------|
| `mill-01.config.json` | EVM (Anvil chain-id 31337) ↔ Solana (devnet) | 21.8.0, used by 21.11 |
| `mill-02.config.json` | EVM (Anvil chain-id 31337) ↔ Mina (devnet) | 21.8.0, used by 21.11 |

## Notes

- **Dev only.** These files are NOT for production use. They contain fake-but-valid-shape channel state seeded with non-zero `cumulativeAmount` and `nonce` so the Mill starts with channels ready to handle swaps.
- **Not secret.** Channel state in a dev fixture has no monetary value. The deterministic keys come from `scripts/townhouse-dev-infra.sh` via `NODE_NOSTR_SECRET_KEY`.
- **JSON with `_comment` field.** The `_comment` key is ignored by the Mill entrypoint (it only reads known fields). If future schema validation rejects unknown keys, move the comment to this README.

## Regenerating

If the Mill config schema changes (new required fields, renamed fields), update both JSON files to match the new `MillConfig` shape in `packages/mill/src/mill.ts` and re-run the unit test:

```bash
pnpm --filter @toon-protocol/townhouse test -- dev-fixtures
```

Channel `cumulativeAmount` / `nonce` values are arbitrary non-zero integers. The Mill entrypoint (`docker/src/entrypoint-mill.ts`) converts them to `bigint` via `toBigInt()`, so JSON numbers are fine.
