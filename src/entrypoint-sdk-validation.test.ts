/**
 * Entrypoint SDK Static Analysis Tests (Story 11-6, AC-9)
 *
 * File-content assertion pattern: reads source files as strings and asserts
 * that expected imports, registrations, and configuration are present.
 * This validates integration wiring without requiring runtime dependencies.
 *
 * TDD RED PHASE: These tests fail until the entrypoint, docker-compose,
 * and package.json are updated with pet DVM integration points.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Resolve paths relative to the docker/ directory (two levels up from src/)
const dockerRoot = resolve(import.meta.dirname, '..');
const projectRoot = resolve(dockerRoot, '..');

function readSource(relativePath: string): string {
  return readFileSync(resolve(projectRoot, relativePath), 'utf-8');
}

describe('entrypoint-sdk.ts Pet DVM integration (Story 11-6, AC-9)', () => {
  const entrypoint = () => readSource('docker/src/entrypoint-sdk.ts');

  it('imports createPetDvmHandler from @toon-protocol/pet-dvm', () => {
    // Given: the entrypoint source
    const source = entrypoint();

    // Then: it should import createPetDvmHandler from pet-dvm
    expect(source).toContain('createPetDvmHandler');
    expect(source).toMatch(/@toon-protocol\/pet-dvm/);
  });

  it('imports PET_INTERACTION_REQUEST_KIND from @toon-protocol/core', () => {
    // Given: the entrypoint source
    const source = entrypoint();

    // Then: it should import PET_INTERACTION_REQUEST_KIND from core
    expect(source).toContain('PET_INTERACTION_REQUEST_KIND');
    expect(source).toMatch(
      /import\s*\{[^}]*PET_INTERACTION_REQUEST_KIND[^}]*\}\s*from\s*['"]@toon-protocol\/core['"]/
    );
  });

  it('registers handler on PET_INTERACTION_REQUEST_KIND (kind:5900)', () => {
    // Given: the entrypoint source
    const source = entrypoint();

    // Then: it should register via node.on() with the pet kind constant or literal 5900
    const hasConstantRegistration = source.includes(
      'node.on(PET_INTERACTION_REQUEST_KIND'
    );
    const hasLiteralRegistration = source.includes('node.on(5900');
    expect(hasConstantRegistration || hasLiteralRegistration).toBe(true);
  });

  it('guards pet DVM registration with config.petDvmEnabled', () => {
    // Given: the entrypoint source
    const source = entrypoint();

    // Then: handler registration should be guarded by petDvmEnabled check
    expect(source).toMatch(/if\s*\(\s*config\.petDvmEnabled\s*\)/);
  });

  it('creates brain storage directory with mkdirSync', () => {
    // Given: the entrypoint source
    const source = entrypoint();

    // Then: it should call mkdirSync for brain storage
    expect(source).toContain('mkdirSync');
    expect(source).toContain('petBrainStoragePath');
  });

  it('includes pet DVM log message for kind:5900', () => {
    // Given: the entrypoint source
    const source = entrypoint();

    // Then: it should log pet DVM handler registration
    expect(source).toMatch(/Pet DVM handler registered/);
  });
});

describe('docker-compose-sdk-e2e.yml Pet DVM env vars (Story 11-6, AC-9)', () => {
  const compose = () => readSource('docker-compose-sdk-e2e.yml');

  it('contains PET_DVM_ENABLED environment variable', () => {
    // Given: the docker-compose file
    const source = compose();

    // Then: PET_DVM_ENABLED should be present
    expect(source).toContain('PET_DVM_ENABLED');
  });

  it('enables PET_DVM on peer1', () => {
    // Given: the docker-compose file
    const source = compose();

    // Then: peer1 should have PET_DVM_ENABLED: 'true'
    // We verify the string appears in the file (peer1 section precedes peer2)
    const peer1Section = source.split(/peer2:/)[0];
    expect(peer1Section).toMatch(/PET_DVM_ENABLED:\s*['"]?true['"]?/);
  });

  it('contains PET_BRAIN_STORAGE_PATH for peer1', () => {
    // Given: the docker-compose file
    const source = compose();
    const peer1Section = source.split(/peer2:/)[0];

    // Then: peer1 should have PET_BRAIN_STORAGE_PATH
    expect(peer1Section).toContain('PET_BRAIN_STORAGE_PATH');
  });

  it('contains PET_PROOF_BATCH_SIZE for peer1', () => {
    // Given: the docker-compose file
    const source = compose();
    const peer1Section = source.split(/peer2:/)[0];

    // Then: peer1 should have PET_PROOF_BATCH_SIZE
    expect(peer1Section).toContain('PET_PROOF_BATCH_SIZE');
  });
});

describe('docker/package.json Pet DVM dependency (Story 11-6, AC-9)', () => {
  it('contains @toon-protocol/pet-dvm workspace dependency', () => {
    // Given: the docker package.json
    const source = readSource('docker/package.json');

    // Then: it should declare pet-dvm as a dependency
    expect(source).toContain('@toon-protocol/pet-dvm');
  });
});

describe('entrypoint-sdk.ts service discovery Pet DVM (Story 11-6, AC-3)', () => {
  const entrypoint = () => readSource('docker/src/entrypoint-sdk.ts');

  it('adds PET_INTERACTION_REQUEST_KIND to supportedKinds when pet DVM enabled', () => {
    // Given: the entrypoint source
    const source = entrypoint();

    // Then: the service discovery block should reference PET_INTERACTION_REQUEST_KIND in supportedKinds
    expect(source).toMatch(
      /supportedKinds\.push\(\s*PET_INTERACTION_REQUEST_KIND\s*\)/
    );
  });

  it('adds pet-dvm to capabilities when pet DVM enabled', () => {
    // Given: the entrypoint source
    const source = entrypoint();

    // Then: capabilities should include 'pet-dvm'
    expect(source).toContain("'pet-dvm'");
  });

  it('adds petSkill descriptor to service discovery content', () => {
    // Given: the entrypoint source
    const source = entrypoint();

    // Then: serviceDiscoveryContent should have petSkill field
    expect(source).toContain('petSkill');
  });
});

describe('entrypoint-sdk.ts health endpoint Pet DVM (Story 11-6, AC-7)', () => {
  it('includes petDvm in health response when enabled', () => {
    // Given: the entrypoint source
    const source = readSource('docker/src/entrypoint-sdk.ts');

    // Then: health endpoint should conditionally include petDvm status
    expect(source).toContain('petDvm');
    expect(source).toMatch(/petDvmEnabled/);
  });
});
