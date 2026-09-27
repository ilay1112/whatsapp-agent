// TESTS 5.3 row `app/autostart.ts`: packaged only, always `--hidden`.
import { describe, expect, it, vi } from 'vitest';
import { applyAutostart, LOGIN_ARGS } from './autostart';

const facade = () => ({ setLoginItem: vi.fn() });

describe('applyAutostart', () => {
  it('registers with --hidden when packaged and enabled', () => {
    const electron = facade();
    applyAutostart({ electron, enabled: true, isPackaged: true });
    expect(electron.setLoginItem).toHaveBeenCalledWith({ openAtLogin: true, args: ['--hidden'] });
  });

  it('unregisters when packaged and disabled - with the SAME args, so the entry matches', () => {
    const electron = facade();
    applyAutostart({ electron, enabled: false, isPackaged: true });
    expect(electron.setLoginItem).toHaveBeenCalledWith({ openAtLogin: false, args: ['--hidden'] });
  });

  it.each([true, false])('is a no-op in an unpackaged build (enabled=%s)', (enabled) => {
    const electron = facade();
    applyAutostart({ electron, enabled, isPackaged: false });
    expect(electron.setLoginItem).not.toHaveBeenCalled();
  });

  it('the argument list is exactly ["--hidden"]', () => {
    expect([...LOGIN_ARGS]).toEqual(['--hidden']);
  });
});
