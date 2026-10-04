// src/renderer/src/views/settings/CliLimits.tsx - the "Usage limits" disclosure under the subscription cards (UX2 4.1;
// B13, B23, F11; owner V2-W1-12). Both CLIs share it (`settings.llm.cli`).
//
//   - "Up to N AI runs per hour" = `settings:set {llm:{cli:{maxRunsPerHour}}}` (1..60; main re-clamps);
//   - "Allow paid extra usage" = `cli:setOverage {allow}` - NEVER `settings:set` (F11: the patch schema has no allowOverage
//     key). {allow:true} shows MAIN's native confirmation; a cancelled dialog answers the unchanged status. The switch shows
//     the value main stored (re-read after the call), never an optimistic guess;
//   - "Claude Code location" = `cli:pickExe` (MAIN's native file picker, the only writer of llm.cli.claudeExePath). The page
//     never shows the path itself (a path never crosses IPC in a response the renderer renders - ARCH-v2 10).
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LlmConfig } from '@shared/types';
import { api } from '../../api';
import { useCliStore } from '../../store/cli';
import { isActivationBlocked } from '../../store/health';
import { useSettingsStore } from '../../store/settings';
import { Disclosure, Row, Toggle } from './parts';

export const RUNS_PER_HOUR_MIN = 1;
export const RUNS_PER_HOUR_MAX = 60;

export function CliLimits({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const { t } = useTranslation();
  const settings = useSettingsStore((s) => s.settings);
  const setSettings = useSettingsStore((s) => s.set);
  const [open, setOpen] = useState(defaultOpen);
  const [config, setConfig] = useState<LlmConfig | null>(null);
  const [busy, setBusy] = useState(false);

  const reloadConfig = useCallback(async () => {
    const r = await api.getLlmConfig();
    if (r.ok) setConfig(r.value);
  }, []);
  useEffect(() => {
    if (!open) return;
    void Promise.resolve().then(() => reloadConfig());
  }, [open, reloadConfig]);

  /** Main owns both values; after the dedicated channel the page re-reads settings + config instead of guessing. */
  const reloadSettings = useCallback(async () => {
    const r = await api.getSettings();
    if (r.ok) useSettingsStore.getState().hydrate(r.value);
    await reloadConfig();
  }, [reloadConfig]);

  if (!settings) return null;
  const cli = settings.llm.cli;

  const setOverage = async (allow: boolean) => {
    // Turning it ON is the money direction: focus-steal guarded here, focus-gated + native dialog in main (F11).
    if (allow && isActivationBlocked()) return;
    setBusy(true);
    const r = await api.setCliOverage(allow);
    setBusy(false);
    if (r.ok) useCliStore.getState().setStatus(r.value);
    await reloadSettings();
  };

  const pickExe = async () => {
    if (isActivationBlocked()) return;
    const r = await api.pickCliExe();
    if (r.ok) useCliStore.getState().setStatus(r.value);
    await reloadSettings();
  };

  const exePicked = config?.cli.claudeExePathSet ?? cli.claudeExePath !== '';

  return (
    <div className="flex flex-col gap-1">
      <Disclosure
        open={open}
        onToggle={() => setOpen((v) => !v)}
        label={t('cli.limits.title')}
        testId="settings-cli-limits"
        controls="settings-cli-limits-body"
      />
      {open ? (
        <div id="settings-cli-limits-body" className="flex flex-col ps-4">
          <Row
            label={t('cli.limits.runsPerHour', { count: cli.maxRunsPerHour })}
            desc={t('cli.limits.runsDesc', { vendor: t('cli.vendor.claude_cli') })}
            htmlFor="settings-cli-runs"
            testId="settings-row-cli-runs"
          >
            <input
              id="settings-cli-runs"
              type="number"
              inputMode="numeric"
              className="field tnum w-24"
              data-testid="settings-cli-runs-per-hour"
              min={RUNS_PER_HOUR_MIN}
              max={RUNS_PER_HOUR_MAX}
              step={1}
              defaultValue={cli.maxRunsPerHour}
              onBlur={(e) => {
                const value = Number(e.target.value);
                if (
                  Number.isInteger(value) &&
                  value >= RUNS_PER_HOUR_MIN &&
                  value <= RUNS_PER_HOUR_MAX &&
                  value !== cli.maxRunsPerHour
                ) {
                  void setSettings({ llm: { cli: { maxRunsPerHour: value } } });
                }
              }}
            />
          </Row>

          <Row
            id="row-cli-overage"
            label={t('cli.limits.overage')}
            desc={t('cli.limits.overageDesc')}
            testId="settings-row-cli-overage"
          >
            <Toggle
              checked={cli.allowOverage}
              onChange={(next) => void setOverage(next)}
              labelledBy="row-cli-overage"
              testId="settings-cli-overage"
              disabled={busy}
            />
          </Row>

          <Row label={t('cli.exePath')} testId="settings-row-cli-exe">
            <span className="text-sm" data-testid="settings-cli-exe-path" data-picked={exePicked ? '1' : '0'}>
              {exePicked ? t('cli.exePicked') : t('cli.exeAutomatic')}
            </span>
            <button
              type="button"
              className="btn btn-outline"
              data-testid="settings-cli-exe-change"
              onClick={() => void pickExe()}
            >
              {t('cli.exeChange')}
            </button>
          </Row>
        </div>
      ) : null}
    </div>
  );
}
