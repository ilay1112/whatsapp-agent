// src/shared/update.test.ts - v5 W2: version comparator, release.json schema, GitHub answer schema, Node-free module.
import { describe, expect, it } from 'vitest';
import {
  GithubReleaseSchema,
  ReleaseManifestSchema,
  UPDATE_ASSET_PREFIX,
  UPDATE_HOST_ALLOWLIST,
  UPDATE_REPO,
  isVersion,
  semverCompare,
} from './update';
import links from '../../resources/links.json';

const SHA = 'ab'.repeat(32);
const manifest = (over: Record<string, unknown> = {}) => ({
  schema: 1,
  version: '0.1.7',
  commit: 'c'.repeat(40),
  publishedAt: '2026-10-20T12:00:00.000Z',
  asset: { name: `${UPDATE_ASSET_PREFIX}0.1.7.zip`, size: 1234, sha256: SHA },
  minVersion: '0.1.0',
  notes: 'Add X',
  ...over,
});

describe('semverCompare', () => {
  it.each([
    ['0.1.8', '0.1.7', 1],
    ['0.1.7', '0.1.8', -1],
    ['0.1.7', '0.1.7', 0],
    ['0.1.10', '0.1.9', 1], // numeric, not lexical
    ['0.2.0', '0.1.99', 1],
    ['1.0.0', '0.99.99', 1],
    ['0.1.0', '0.1.0', 0],
  ])('%s vs %s = %i', (a, b, sign) => {
    expect(Math.sign(semverCompare(a, b))).toBe(sign);
  });
  it('a malformed version sorts below every real one and never looks newer', () => {
    expect(semverCompare('v0.1.9', '0.1.0')).toBeLessThan(0);
    expect(semverCompare('0.1.0', '0.0.0-l3')).toBeGreaterThan(0);
    expect(semverCompare('0.1.9-beta', '0.1.0')).toBeLessThan(0);
    expect(semverCompare('garbage', 'other')).toBe(0);
  });
  it('isVersion is the plain MAJOR.MINOR.PATCH form only', () => {
    expect(isVersion('0.1.12')).toBe(true);
    for (const v of ['v0.1.1', '0.1', '0.1.01', '0.1.1-rc', '0.1.1 ', '', 1, null])
      expect(isVersion(v), String(v)).toBe(false);
  });
});

describe('ReleaseManifestSchema', () => {
  it('accepts what scripts/release-manifest.mjs writes', () => {
    expect(ReleaseManifestSchema.parse(manifest())).toEqual(manifest());
  });
  it('drops unknown keys (a later schema may add fields)', () => {
    expect(ReleaseManifestSchema.parse(manifest({ extra: 1 }))).not.toHaveProperty('extra');
  });
  it.each([
    ['schema 2', { schema: 2 }],
    ['v-prefixed version', { version: 'v0.1.7' }],
    ['short commit', { commit: 'abc' }],
    ['upper-case sha', { asset: { name: `${UPDATE_ASSET_PREFIX}0.1.7.zip`, size: 1, sha256: SHA.toUpperCase() } }],
    ['zero size', { asset: { name: `${UPDATE_ASSET_PREFIX}0.1.7.zip`, size: 0, sha256: SHA } }],
    ['asset of another version', { asset: { name: `${UPDATE_ASSET_PREFIX}0.1.6.zip`, size: 1, sha256: SHA } }],
    ['an exe as the asset', { asset: { name: 'WhatsApp Calendar Agent.exe', size: 1, sha256: SHA } }],
    ['traversal in the asset name', { asset: { name: `../${UPDATE_ASSET_PREFIX}0.1.7.zip`, size: 1, sha256: SHA } }],
    ['bad date', { publishedAt: 'yesterday' }],
    ['bad minVersion', { minVersion: '0.1' }],
  ])('rejects %s', (_label, over) => {
    expect(ReleaseManifestSchema.safeParse(manifest(over)).success).toBe(false);
  });
});

describe('GithubReleaseSchema', () => {
  it('reads tag_name + assets and ignores the rest', () => {
    const r = GithubReleaseSchema.parse({
      tag_name: 'v0.1.7',
      body: 'x',
      assets: [{ name: 'release.json', size: 10, browser_download_url: 'https://github.com/x', id: 1 }],
    });
    expect(r.assets[0]).toEqual({ name: 'release.json', size: 10, browser_download_url: 'https://github.com/x' });
  });
  it('rejects an answer without assets', () => {
    expect(GithubReleaseSchema.safeParse({ tag_name: 'v1' }).success).toBe(false);
  });
});

describe('constants', () => {
  it('UPDATE_REPO is the repo resources/links.json points at', () => {
    expect(links.project_readme).toBe(`https://github.com/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}#readme`);
  });
  it('the allow-list is exactly the spec one', () => {
    expect(UPDATE_HOST_ALLOWLIST).toEqual({
      exact: ['api.github.com', 'github.com'],
      suffix: ['.githubusercontent.com'],
    });
  });
});
