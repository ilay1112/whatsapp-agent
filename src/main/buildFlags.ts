// src/main/buildFlags.ts - [signing-fix, D-078, signing-review MAJOR 1] compile-time build flags.
//
// __AUTHENTICODE_SIGNED_BUILD__ is replaced by electron.vite.config.ts (`define`) with `true` only when the signing-mode
// variable named a signing mode at `electron-vite build` (same "off" rule as scripts/sign-windows.mjs
// readSigningConfig); the same build emits out/main/build-flags.json, which sign-windows.mjs beforePack checks so
// packaging refuses a mode / flag mismatch. Anywhere the define is absent (vitest, tsc) the flag is false: the UNSIGNED
// default, which reads no pin file at all. (The define is not named WCA_*: TESTS 4.1 reserves that prefix in src/ for
// src/main/testSeams.ts.)
declare const __AUTHENTICODE_SIGNED_BUILD__: boolean | undefined;

/** True only in a build compiled for Authenticode signing (the launcher then trusts the bridge pin inside app.asar). */
export const SIGNED_BUILD: boolean =
  typeof __AUTHENTICODE_SIGNED_BUILD__ === 'boolean' ? __AUTHENTICODE_SIGNED_BUILD__ : false;
