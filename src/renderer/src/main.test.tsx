// main.tsx is the renderer entry: i18n is initialised from the language main resolved BEFORE the window existed, and only
// then is React mounted - so the first paint is already in the right language and direction (i18n-rtl.md 4.2).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

beforeEach(() => {
  vi.resetModules();
  document.body.replaceChildren();
});

describe('main.tsx', () => {
  it('initialises i18n and mounts the app into #root', async () => {
    const root = document.createElement('div');
    root.id = 'root';
    document.body.append(root);

    await import('./main');

    await waitFor(() =>
      expect(document.querySelector('[data-testid="app-loading"], [data-testid="app"]')).not.toBeNull(),
    );
    expect(document.documentElement.lang).toBe('en');
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('fails loudly when the mount point is missing', async () => {
    await expect(import('./main')).rejects.toThrow('#root missing');
  });
});
