// src/shared/update.ts - v5 in-app updates (docs/specs/v5-updates-handover.md 2.2; owner v5 W2). Shared by main AND the renderer:
// zod + plain TypeScript only, never a Node import (eslint enforces it for src/shared). Main is the only process that talks to GitHub.
import { z } from 'zod';

/** The public repository the releases come from (resources/links.json `project_readme` names the same repo). */
export const UPDATE_REPO = { owner: 'ilay1112', repo: 'whatsapp-agent' } as const;

/** Production API base. The e2e seam WCA_UPDATE_BASE_URL (loopback only) replaces it; nothing else ever does. */
export const UPDATE_API_BASE = 'https://api.github.com';

/** Hosts an update request (API, release.json, zip, and the one redirect hop of each download) may reach. https only. */
export const UPDATE_HOST_ALLOWLIST = {
  exact: ['api.github.com', 'github.com'],
  suffix: ['.githubusercontent.com'],
} as const;

/** The release asset that describes a release (written by scripts/release-manifest.mjs in CI). */
export const RELEASE_MANIFEST_ASSET = 'release.json';
/** `WhatsAppCalendarAgent-win-x64-<version>.zip` - the only zip name an update will download. */
export const UPDATE_ASSET_PREFIX = 'WhatsAppCalendarAgent-win-x64-';
/** The packaged exe (electron-builder productName). The updater refuses a staged folder without exactly this file. */
export const UPDATE_EXE_NAME = 'WhatsApp Calendar Agent.exe';
/** The ONE top-level folder of the release zip (CI zips win-unpacked under this name). "Extract here" then always makes its own
 *  folder, so the install folder is never Downloads or Desktop; the stager refuses any other layout. */
export const UPDATE_ZIP_TOP_FOLDER = 'WhatsAppCalendarAgent';

/** Hard caps: release.json is a few hundred bytes; the zip is a few hundred MB. */
export const RELEASE_MANIFEST_MAX_BYTES = 64 * 1024;
export const UPDATE_ZIP_MAX_BYTES = 2 * 1024 * 1024 * 1024;

const VERSION_RE = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;

/** True for a plain `MAJOR.MINOR.PATCH` (no `v`, no pre-release, no build metadata, no leading zeros). */
export function isVersion(v: unknown): v is string {
  return typeof v === 'string' && VERSION_RE.test(v);
}

/**
 * Compares two plain versions numerically: >0 when `a` is newer, <0 when older, 0 when equal. A string that is not a plain
 * version (dev builds such as `0.0.0-l3`) sorts BELOW every real version, so a malformed tag can never look newer than
 * what is installed (and a dev build is offered every release, which it then refuses to install - canInstall is false).
 */
export function semverCompare(a: string, b: string): number {
  const pa = VERSION_RE.exec(a);
  const pb = VERSION_RE.exec(b);
  if (pa === null || pb === null) return (pa === null ? 0 : 1) - (pb === null ? 0 : 1);
  for (let i = 1; i <= 3; i += 1) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export const VersionSchema = z.string().regex(VERSION_RE);

/** `release.json` schema 1 (spec 2.1). Unknown keys are dropped (a later schema may add fields); every known field is checked. */
export const ReleaseManifestSchema = z
  .object({
    schema: z.literal(1),
    version: VersionSchema,
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    publishedAt: z
      .string()
      .max(40)
      .refine((s) => Number.isFinite(Date.parse(s)), 'publishedAt'),
    asset: z.object({
      name: z.string().max(120),
      size: z.number().int().positive().max(UPDATE_ZIP_MAX_BYTES),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }),
    minVersion: VersionSchema,
    notes: z.string().max(2000),
  })
  .refine((m) => m.asset.name === `${UPDATE_ASSET_PREFIX}${m.version}.zip`, {
    message: 'asset name must be the zip of this version',
    path: ['asset', 'name'],
  });
export type ReleaseManifest = z.infer<typeof ReleaseManifestSchema>;

/** The slice of GitHub's `GET /repos/{owner}/{repo}/releases/latest` answer the app reads (everything else is ignored). */
export const GithubReleaseSchema = z.object({
  tag_name: z.string().max(64),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
  assets: z
    .array(
      z.object({
        name: z.string().max(200),
        size: z.number().int().nonnegative(),
        browser_download_url: z.string().max(2048),
      }),
    )
    .max(50),
});
export type GithubRelease = z.infer<typeof GithubReleaseSchema>;
