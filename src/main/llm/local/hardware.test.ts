// src/main/llm/local/hardware.test.ts - tier table of ARCH 17 (one case per row + every boundary), device parser,
// iGPU never counted, parse failure => no GPU, and the [R2] VC++ CRT pre-flight (owner W1-07).
import { describe, expect, it, vi } from 'vitest';
import { listDevicesFixture } from '../../../../tests/fakes/fake-llama-server';
import { ERROR_ACTION } from '../../../shared/errors';
import { EXTERNAL_TARGETS } from '../../../shared/ipc';
import type { GpuInfo, HardwareInfo } from '../../../shared/types';
import type { Logger } from '../../deps';
import {
  VCREDIST_EXIT_CODE,
  VC_RUNTIME_DLLS,
  checkVcRuntime,
  isDedicatedGpuName,
  isVcRuntimeExitCode,
  parseListDevices,
  pickTier,
  preferredDeviceArg,
  probeHardware,
  toGiB,
} from './hardware';

const GIB = 1024 ** 3;
const silentLog = (): Logger => {
  const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => log };
  return log;
};
const hw = (ramGiB: number, freeDiskGiB: number, gpus: GpuInfo[] = []): Omit<HardwareInfo, 'recommendedTier'> => ({
  ramGiB,
  gpus,
  freeDiskGiB,
});
const dGpu = (vramGiB: number): GpuInfo => ({ name: 'NVIDIA GeForce RTX 4060 Laptop GPU', dedicated: true, vramGiB });
const iGpu = (): GpuInfo => ({ name: 'Intel(R) Iris(R) Xe Graphics', dedicated: false, vramGiB: null });

describe('pickTier - ARCHITECTURE section 17, first match wins', () => {
  it('row 1: low disk, RAM >= 12 => small (a dedicated GPU does not override it)', () => {
    expect(pickTier(hw(32, 11.9, [dGpu(16)]))).toBe('small');
  });
  it('row 1: low disk, RAM < 12 => tiny', () => {
    expect(pickTier(hw(11.9, 0.5))).toBe('tiny');
  });
  it('row 2: dedicated VRAM >= 7.5 and RAM >= 15 => mid', () => {
    expect(pickTier(hw(15, 100, [dGpu(7.5)]))).toBe('mid');
  });
  it('row 3: dedicated VRAM 5.5-7.5 and RAM >= 15 => mid', () => {
    expect(pickTier(hw(16, 100, [dGpu(6)]))).toBe('mid');
  });
  it('row 4: no dedicated GPU and RAM >= 30 => mid', () => {
    expect(pickTier(hw(30, 100, [iGpu()]))).toBe('mid');
  });
  it('row 5: RAM >= 12 => small', () => {
    expect(pickTier(hw(12, 100, [iGpu()]))).toBe('small');
  });
  it('row 6: otherwise => tiny', () => {
    expect(pickTier(hw(8, 100))).toBe('tiny');
  });

  it.each([
    ['disk 11.9 vs 12 (RAM 32, no GPU)', hw(32, 11.9), 'small'],
    ['disk 12 (RAM 32, no GPU)', hw(32, 12), 'mid'],
    ['RAM 11.9 low disk', hw(11.9, 11.9), 'tiny'],
    ['RAM 12 low disk', hw(12, 11.9), 'small'],
    ['RAM 14.9 with 8 GiB dGPU', hw(14.9, 100, [dGpu(8)]), 'small'],
    ['RAM 15 with 8 GiB dGPU', hw(15, 100, [dGpu(8)]), 'mid'],
    ['RAM 29.9 no GPU', hw(29.9, 100), 'small'],
    ['RAM 30 no GPU', hw(30, 100), 'mid'],
    ['VRAM 5.4 RAM 16', hw(16, 100, [dGpu(5.4)]), 'small'],
    ['VRAM 5.5 RAM 16', hw(16, 100, [dGpu(5.5)]), 'mid'],
    ['VRAM 7.4 RAM 16', hw(16, 100, [dGpu(7.4)]), 'mid'],
    ['VRAM 7.5 RAM 16', hw(16, 100, [dGpu(7.5)]), 'mid'],
  ] as const)('boundary %s', (_name, input, expected) => {
    expect(pickTier(input)).toBe(expected);
  });

  it('integrated GPU memory is never counted as VRAM', () => {
    const shared: GpuInfo = { name: 'Intel(R) UHD Graphics', dedicated: false, vramGiB: null };
    expect(pickTier(hw(16, 100, [shared]))).toBe('small'); // not `mid` despite 16 GiB of shared memory
  });
});

describe('parseListDevices', () => {
  it('reads a dedicated NVIDIA device with its VRAM', () => {
    const gpus = parseListDevices(listDevicesFixture('nvidia_8g'));
    expect(gpus).toHaveLength(1);
    expect(gpus[0]?.dedicated).toBe(true);
    expect(gpus[0]?.vramGiB).toBeCloseTo(8.0, 1);
  });
  it('an Intel iGPU is not dedicated and reports no VRAM', () => {
    const gpus = parseListDevices(listDevicesFixture('intel_igpu_only'));
    expect(gpus).toEqual([{ name: 'Intel(R) Iris(R) Xe Graphics', dedicated: false, vramGiB: null }]);
  });
  it('iGPU + dGPU: only the discrete one counts', () => {
    const gpus = parseListDevices(listDevicesFixture('igpu_plus_dgpu'));
    expect(gpus.map((g) => g.dedicated)).toEqual([false, true]);
    expect(gpus[1]?.vramGiB).toBeCloseTo(6.0, 1);
  });
  it('parse failure => no GPU', () => {
    expect(parseListDevices(listDevicesFixture('unparseable'))).toEqual([]);
    expect(parseListDevices(null)).toEqual([]);
    expect(parseListDevices('')).toEqual([]);
  });

  it.each([
    ['NVIDIA GeForce RTX 4060 Laptop GPU', true],
    ['NVIDIA Quadro P2000', true],
    ['AMD Radeon RX 7600M XT', true],
    ['AMD Radeon Pro W6600', true],
    ['Intel(R) Arc(TM) A770 Graphics', true],
    ['Intel(R) Arc(TM) B580 Graphics', true],
    ['Intel(R) Iris(R) Xe Graphics', false],
    ['Intel(R) UHD Graphics 620', false],
    ['AMD Radeon(TM) Graphics', false],
    ['Intel(R) Arc(TM) 140V GPU', false],
    ['Microsoft Basic Render Driver', false],
  ] as const)('isDedicatedGpuName(%s) === %s', (name, expected) => {
    expect(isDedicatedGpuName(name)).toBe(expected);
  });
});

describe('preferredDeviceArg', () => {
  it('picks the discrete device only when an iGPU and a dGPU are both listed', () => {
    const text = listDevicesFixture('igpu_plus_dgpu');
    expect(preferredDeviceArg(parseListDevices(text), text)).toBe('Vulkan1');
  });
  it('returns null with a single device of either kind', () => {
    const only = listDevicesFixture('nvidia_8g');
    expect(preferredDeviceArg(parseListDevices(only), only)).toBeNull();
    const igpu = listDevicesFixture('intel_igpu_only');
    expect(preferredDeviceArg(parseListDevices(igpu), igpu)).toBeNull();
  });
});

describe('probeHardware', () => {
  it('merges RAM, free disk and devices into a HardwareInfo with the recommended tier', async () => {
    const info = await probeHardware({
      totalMemBytes: () => 32 * GIB,
      freeDiskBytes: () => Promise.resolve(200 * GIB),
      userData: 'C:\\users\\t\\AppData\\Roaming\\app',
      listDevices: () => Promise.resolve(listDevicesFixture('nvidia_8g')),
      log: silentLog(),
    });
    expect(info.ramGiB).toBe(32);
    expect(info.freeDiskGiB).toBe(200);
    expect(info.gpus).toHaveLength(1);
    expect(info.recommendedTier).toBe('mid');
  });

  it('survives a failing device probe and a failing statfs (=> no GPU, 0 free disk)', async () => {
    const info = await probeHardware({
      totalMemBytes: () => 8 * GIB,
      freeDiskBytes: () => Promise.reject(new Error('statfs failed')),
      userData: 'C:\\x',
      listDevices: () => Promise.reject(new Error('exe missing')),
      log: silentLog(),
    });
    expect(info.gpus).toEqual([]);
    expect(info.freeDiskGiB).toBe(0);
    expect(info.recommendedTier).toBe('tiny');
  });

  it('toGiB rounds to one decimal and clamps nonsense to 0', () => {
    expect(toGiB(12 * GIB)).toBe(12);
    expect(toGiB(11.94 * GIB)).toBe(11.9);
    expect(toGiB(-1)).toBe(0);
    expect(toGiB(Number.NaN)).toBe(0);
  });
});

describe('[R2] VC++ CRT pre-flight', () => {
  const llamaDir = 'C:\\app\\resources\\llama';
  const systemRoot = 'C:\\Windows';

  it('passes when all three DLLs are app-local', () => {
    const appLocal = new Set(VC_RUNTIME_DLLS.map((d) => `${llamaDir}\\${d}`));
    expect(checkVcRuntime({ llamaDir, systemRoot, exists: (p) => appLocal.has(p) })).toEqual({ ok: true });
  });

  it('passes when all three DLLs are in System32', () => {
    const system32 = new Set(VC_RUNTIME_DLLS.map((d) => `${systemRoot}\\System32\\${d}`));
    expect(checkVcRuntime({ llamaDir, systemRoot, exists: (p) => system32.has(p) })).toEqual({ ok: true });
  });

  it('fails with LLM_VCREDIST_MISSING when one DLL is absent in both places', () => {
    const present = new Set([`${systemRoot}\\System32\\msvcp140.dll`, `${llamaDir}\\vcruntime140.dll`]);
    const result = checkVcRuntime({ llamaDir, systemRoot, exists: (p) => present.has(p) });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('LLM_VCREDIST_MISSING');
    expect(result.missing).toEqual(['vcruntime140_1.dll']);
  });

  it('fails on a machine with no redistributable at all', () => {
    const result = checkVcRuntime({ llamaDir, systemRoot, exists: () => false });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.missing).toEqual([...VC_RUNTIME_DLLS]);
  });

  it('maps the loader exit code 0xC0000135 to the same condition', () => {
    expect(VCREDIST_EXIT_CODE).toBe(-1073741515);
    expect(isVcRuntimeExitCode(VCREDIST_EXIT_CODE)).toBe(true);
    expect(isVcRuntimeExitCode(1)).toBe(false);
    expect(isVcRuntimeExitCode(null)).toBe(false);
  });

  it('[R2] the only action offered for it opens the Microsoft page - the app never downloads an exe', () => {
    expect(ERROR_ACTION.LLM_VCREDIST_MISSING).toBe('install_vcredist');
    expect(EXTERNAL_TARGETS).toContain('vcredist_download');
  });
});
