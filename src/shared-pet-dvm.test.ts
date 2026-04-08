/**
 * Pet DVM Config Parsing Tests (Story 11-6, AC-1, AC-8)
 *
 * Unit tests for pet DVM configuration parsing in shared.ts.
 * Tests petDvmEnabled, petBrainStoragePath, and petProofBatchSize
 * environment variable handling with defaults and validation.
 *
 * TDD RED PHASE: These tests fail until shared.ts is updated with
 * pet DVM config fields (petDvmEnabled, petBrainStoragePath, petProofBatchSize).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock nostr-tools/pure to avoid native crypto dependency in tests
vi.mock('nostr-tools/pure', () => ({
  getPublicKey: vi.fn(() => 'a'.repeat(64)),
}));

import { parseConfig } from './shared.js';

describe('parseConfig — Pet DVM configuration (Story 11-6, AC-1, AC-8)', () => {
  const requiredEnv = {
    NODE_ID: 'test-node',
    NOSTR_SECRET_KEY: 'a'.repeat(64),
    ILP_ADDRESS: 'g.test',
  };

  const petDvmEnvKeys = [
    'NODE_ID',
    'NOSTR_SECRET_KEY',
    'ILP_ADDRESS',
    'PET_DVM_ENABLED',
    'PET_BRAIN_STORAGE_PATH',
    'PET_PROOF_BATCH_SIZE',
  ];

  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of petDvmEnvKeys) {
      savedEnv[key] = process.env[key];
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of petDvmEnvKeys) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete process.env[key];
      }
    }
  });

  // --- AC-8: PET_DVM_ENABLED ---

  it('sets petDvmEnabled to true when PET_DVM_ENABLED=true', () => {
    // Given: environment with PET_DVM_ENABLED set to 'true'
    Object.assign(process.env, requiredEnv, { PET_DVM_ENABLED: 'true' });

    // When: parsing config
    const config = parseConfig();

    // Then: petDvmEnabled should be true
    expect(config.petDvmEnabled).toBe(true);
  });

  it('sets petDvmEnabled to false when PET_DVM_ENABLED is omitted (default disabled)', () => {
    // Given: environment without PET_DVM_ENABLED
    Object.assign(process.env, requiredEnv);

    // When: parsing config
    const config = parseConfig();

    // Then: petDvmEnabled should default to false (x402Enabled pattern, NOT ardriveEnabled pattern)
    expect(config.petDvmEnabled).toBe(false);
  });

  it('sets petDvmEnabled to false when PET_DVM_ENABLED=false', () => {
    // Given: environment with PET_DVM_ENABLED set to 'false'
    Object.assign(process.env, requiredEnv, { PET_DVM_ENABLED: 'false' });

    // When: parsing config
    const config = parseConfig();

    // Then: petDvmEnabled should be false
    expect(config.petDvmEnabled).toBe(false);
  });

  // --- AC-8: PET_BRAIN_STORAGE_PATH ---

  it('parses custom PET_BRAIN_STORAGE_PATH correctly', () => {
    // Given: environment with custom brain storage path
    Object.assign(process.env, requiredEnv, {
      PET_BRAIN_STORAGE_PATH: '/custom/brains',
    });

    // When: parsing config
    const config = parseConfig();

    // Then: petBrainStoragePath should reflect the custom value
    expect(config.petBrainStoragePath).toBe('/custom/brains');
  });

  it('defaults petBrainStoragePath to /data/pet-brains when PET_BRAIN_STORAGE_PATH is omitted', () => {
    // Given: environment without PET_BRAIN_STORAGE_PATH
    Object.assign(process.env, requiredEnv);

    // When: parsing config
    const config = parseConfig();

    // Then: petBrainStoragePath should default to /data/pet-brains
    expect(config.petBrainStoragePath).toBe('/data/pet-brains');
  });

  // --- AC-8: PET_PROOF_BATCH_SIZE ---

  it('parses PET_PROOF_BATCH_SIZE=5 as number 5', () => {
    // Given: environment with PET_PROOF_BATCH_SIZE set to '5'
    Object.assign(process.env, requiredEnv, { PET_PROOF_BATCH_SIZE: '5' });

    // When: parsing config
    const config = parseConfig();

    // Then: petProofBatchSize should be the number 5
    expect(config.petProofBatchSize).toBe(5);
  });

  it('defaults petProofBatchSize to 10 when PET_PROOF_BATCH_SIZE is omitted', () => {
    // Given: environment without PET_PROOF_BATCH_SIZE
    Object.assign(process.env, requiredEnv);

    // When: parsing config
    const config = parseConfig();

    // Then: petProofBatchSize should default to 10
    expect(config.petProofBatchSize).toBe(10);
  });

  it('throws descriptive error when PET_PROOF_BATCH_SIZE=abc (non-numeric)', () => {
    // Given: environment with non-numeric PET_PROOF_BATCH_SIZE
    Object.assign(process.env, requiredEnv, { PET_PROOF_BATCH_SIZE: 'abc' });

    // When/Then: parsing should throw with descriptive message
    expect(() => parseConfig()).toThrow(
      'PET_PROOF_BATCH_SIZE must be a positive integer'
    );
  });

  it('throws descriptive error when PET_PROOF_BATCH_SIZE=0 (not positive)', () => {
    // Given: environment with zero PET_PROOF_BATCH_SIZE
    Object.assign(process.env, requiredEnv, { PET_PROOF_BATCH_SIZE: '0' });

    // When/Then: parsing should throw since 0 is not positive
    expect(() => parseConfig()).toThrow(
      'PET_PROOF_BATCH_SIZE must be a positive integer'
    );
  });

  it('throws descriptive error when PET_PROOF_BATCH_SIZE=-1 (negative)', () => {
    // Given: environment with negative PET_PROOF_BATCH_SIZE
    Object.assign(process.env, requiredEnv, { PET_PROOF_BATCH_SIZE: '-1' });

    // When/Then: parsing should throw since -1 is not positive
    expect(() => parseConfig()).toThrow(
      'PET_PROOF_BATCH_SIZE must be a positive integer'
    );
  });
});
