// src/main/llm/local/hardware.ts - hardware probe + tier rule (build-plan section 3; owner W1-07). S-SPAWN for `--list-devices` / CIM.
import path from 'node:path';
import fs from 'node:fs';
import type { Logger, SpawnFn } from '../../deps';
import type { GpuInfo, HardwareInfo, ModelTier } from '../../../shared/types';

export interface ProbeHardwareDeps {
  totalMemBytes: () => number; // os.totalmem()
  freeDiskBytes: (dir: string) => Promise<number>; // fs.statfs on the userData drive
  userData: string;
  /** Text of `llama-server.exe --list-devices` (or a fixture); null when the exe is missing / fails. Parsed defensively. */
  listDevices: () => Promise<string | null>;
  spawn?: SpawnFn;
  log: Logger;
}

const GIB = 1024 ** 3;
/** bytes -> GiB with one decimal, so boundary comparisons (11.9 vs 12) are exact. */
export function toGiB(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.round((bytes / GIB) * 10) / 10;
}

/**
 * A device counts as DEDICATED only when its name matches a discrete-GPU family (ARCHITECTURE section 9):
 * NVIDIA GeForce/RTX/GTX/Quadro, AMD Radeon RX/Pro, Intel Arc A/B-series. Integrated shared memory never counts.
 */
export const DISCRETE_GPU_PATTERNS: readonly RegExp[] = [
  /\b(?:nvidia|geforce|rtx|gtx|quadro)\b/i,
  /\bradeon\s*(?:\(tm\)\s*)?(?:rx|pro)\b/i,
  // `Intel(R) Arc(TM) A770 Graphics` / `Intel Arc B580`: the optional `(TM)`/`(R)` marker may sit between the two tokens.
  // Integrated Arc parts (`Arc(TM) 140V`) have no A/B-series model number and therefore never match.
  /\barc\b(?:\s*\((?:tm|r)\))?[^a-z0-9]{0,4}[ab]\d{3}\b/i,
];

export function isDedicatedGpuName(name: string): boolean {
  return DISCRETE_GPU_PATTERNS.some((re) => re.test(name));
}

/**
 * Tolerant parser for `llama-server.exe --list-devices`. Any line of the shape
 *   `  Vulkan0: <name> (<total> MiB, <free> MiB free)`
 * is taken; everything else is ignored. A text with no such line yields [] ("no GPU", ARCH `[LR]`).
 */
export function parseListDevices(text: string | null): GpuInfo[] {
  if (text === null || text === '') return [];
  const gpus: GpuInfo[] = [];
  const line =
    /^\s*(?:Vulkan|CUDA|SYCL|ROCm|HIP|Metal|OpenCL)\d+\s*:\s*(.+?)\s*\((\d+)\s*(MiB|GiB|MB|GB)\b[^)]*\)\s*$/i;
  for (const raw of text.split(/\r?\n/)) {
    const m = line.exec(raw);
    if (!m) continue;
    const name = m[1]!.trim();
    if (name === '') continue;
    const amount = Number(m[2]);
    const unit = m[3]!.toLowerCase();
    const bytes = unit.startsWith('g') ? amount * GIB : amount * 1024 * 1024;
    const dedicated = isDedicatedGpuName(name);
    gpus.push({ name, dedicated, vramGiB: dedicated ? toGiB(bytes) : null });
  }
  return gpus;
}

/** ARCHITECTURE section 17 tier rule (first match wins; iGPU memory never counts). Pure. */
export function pickTier(hw: Omit<HardwareInfo, 'recommendedTier'>): ModelTier {
  const ram = hw.ramGiB;
  const disk = hw.freeDiskGiB;
  const dedicatedVram = hw.gpus.reduce(
    (best, g) => (g.dedicated && g.vramGiB !== null && g.vramGiB > best ? g.vramGiB : best),
    0,
  );
  const hasDedicated = hw.gpus.some((g) => g.dedicated);
  if (disk < 12) return ram >= 12 ? 'small' : 'tiny'; // 1
  if (dedicatedVram >= 7.5 && ram >= 15) return 'mid'; // 2
  if (dedicatedVram >= 5.5 && dedicatedVram < 7.5 && ram >= 15) return 'mid'; // 3
  if (!hasDedicated && ram >= 30) return 'mid'; // 4
  if (ram >= 12) return 'small'; // 5
  return 'tiny'; // 6
}

export function probeHardware(deps: ProbeHardwareDeps): Promise<HardwareInfo> {
  return (async () => {
    const ramGiB = toGiB(deps.totalMemBytes());
    let freeDiskGiB: number;
    try {
      freeDiskGiB = toGiB(await deps.freeDiskBytes(deps.userData));
    } catch {
      deps.log.warn('hw_free_disk_failed');
      freeDiskGiB = 0;
    }
    let gpus: GpuInfo[];
    try {
      gpus = parseListDevices(await deps.listDevices());
    } catch {
      deps.log.warn('hw_list_devices_failed');
      gpus = [];
    }
    const recommendedTier = pickTier({ ramGiB, gpus, freeDiskGiB });
    deps.log.info('hw_probed', {
      ramGiB,
      freeDiskGiB,
      gpus: gpus.length,
      dedicated: gpus.filter((g) => g.dedicated).length,
      recommendedTier,
    });
    return { ramGiB, gpus, freeDiskGiB, recommendedTier };
  })();
}

/**
 * `--device VulkanN` selection (ARCH section 9): only when BOTH an iGPU and a dGPU are listed; prefer the discrete one.
 * Returns null when there is nothing to disambiguate (llama.cpp's own `-ngl auto` / `--fit on` defaults are used).
 */
export function preferredDeviceArg(gpus: readonly GpuInfo[], listDevicesText: string | null): string | null {
  const hasDedicated = gpus.some((g) => g.dedicated);
  const hasIntegrated = gpus.some((g) => !g.dedicated);
  if (!hasDedicated || !hasIntegrated || listDevicesText === null) return null;
  const line = /^\s*((?:Vulkan|CUDA|SYCL|ROCm|HIP)\d+)\s*:\s*(.+?)\s*\(\d+\s*(?:MiB|GiB|MB|GB)\b[^)]*\)\s*$/i;
  for (const raw of listDevicesText.split(/\r?\n/)) {
    const m = line.exec(raw);
    if (!m) continue;
    if (isDedicatedGpuName(m[2]!.trim())) return m[1]!;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// [R2] VC++ 2015-2022 CRT pre-flight (ARCHITECTURE section 9). ADDITIVE to the frozen seam of wave0-seams.md section 7.
// ---------------------------------------------------------------------------------------------------------------------
/** The three DLLs the MSVC-built llama.cpp binaries import. Must exist app-locally or in %SystemRoot%\System32. */
export const VC_RUNTIME_DLLS: readonly string[] = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'];
/** 0xC0000135 STATUS_DLL_NOT_FOUND as Node reports it in `exit(code)`. */
export const VCREDIST_EXIT_CODE = -1073741515;

export interface VcRuntimeCheckDeps {
  /** <resources>\llama - where fetch-llama.mjs may have copied the app-local CRT. */
  llamaDir: string;
  /** %SystemRoot% (default: process.env.SystemRoot ?? 'C:\\Windows'). */
  systemRoot?: string;
  /** Injected so the test can describe a machine without the redistributable (S-FS). */
  exists?: (p: string) => boolean;
}
export type VcRuntimeCheck = { ok: true } | { ok: false; code: 'LLM_VCREDIST_MISSING'; missing: string[] };

/** Deterministic pre-flight run before the first llama-server spawn. */
export function checkVcRuntime(deps: VcRuntimeCheckDeps): VcRuntimeCheck {
  const exists = deps.exists ?? ((p: string) => fs.existsSync(p));
  const systemRoot = deps.systemRoot ?? process.env.SystemRoot ?? 'C:\\Windows';
  const system32 = path.win32.join(systemRoot, 'System32');
  const missing = VC_RUNTIME_DLLS.filter(
    (dll) => !exists(path.win32.join(deps.llamaDir, dll)) && !exists(path.win32.join(system32, dll)),
  );
  if (missing.length === 0) return { ok: true };
  return { ok: false, code: 'LLM_VCREDIST_MISSING', missing };
}

/** A child that died at load because the CRT is absent (ARCH section 9): every retry fails identically. */
export function isVcRuntimeExitCode(code: number | null): boolean {
  return code === VCREDIST_EXIT_CODE;
}
