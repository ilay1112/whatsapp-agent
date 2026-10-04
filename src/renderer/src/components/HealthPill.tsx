// src/renderer/src/components/HealthPill.tsx - one pill in the header; clicking it expands three rows (UX 5.2, 14.2;
// ARCH section 14, A17; owner W1-14). Colour is never the only carrier of meaning: every state has an icon SHAPE and a
// text label. Every red state offers exactly one action.
// [V2] V2-W1-12 (UX2 2.2, C13/C14): each row keeps ONE sentence + at most one action and gains at most ONE muted sub-line;
// several facts are joined into that line with " · ". Sub-line facts are app facts only (states, numbers, a time).
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { type AppHealth, overallOf } from '@shared/health';
import { ERROR_ACTION, ERROR_SEVERITY, type ErrorCode } from '@shared/errors';
import { VOICE_TIERS, type CliProviderId, type ModelPlan, type ProviderId } from '@shared/types';
import type { Settings } from '@shared/settings';
import { formatResetTime } from '@shared/i18n/format';
import { api } from '../api';
import { useHealthStore } from '../store/health';
import { useSettingsStore } from '../store/settings';
import { useAutoStore } from '../store/auto';
import { useCliStore } from '../store/cli';

export type HealthPart = 'whatsapp' | 'llm' | 'calendar';
type PartStatus = 'ok' | 'working' | 'attention';

export interface HealthPillProps {
  health: AppHealth;
  onAction(part: HealthPart, code?: ErrorCode): void;
  /** [V2] Sub-line click (UX2 2.2): WhatsApp -> Working rules, AI -> AI engine, Calendar -> Automatic mode. */
  onSubline?(part: HealthPart): void;
}

type TFn = (key: string, values?: Record<string, unknown>) => string;

const isCliProvider = (p: ProviderId): p is CliProviderId => p === 'claude_cli' || p === 'antigravity_cli';
/** Providers that read pictures in the cloud when `images.cloud` is on (B19; antigravity never, local reads locally). */
const CLOUD_PICTURE_PROVIDERS: readonly ProviderId[] = ['claude', 'gemini', 'claude_cli'];

/** [V2] The values every ErrorCode deck string may interpolate ({{cli}}, {{vendor}}, {{version}}, {{min}}). */
export function errorValuesOf(
  provider: ProviderId,
  t: TFn,
  version: string | null = null,
  min = '',
): Record<string, string> {
  const cli = isCliProvider(provider) ? t(`cli.name.${provider}`) : '';
  const vendor = isCliProvider(provider)
    ? t(`cli.vendor.${provider}`)
    : provider === 'claude'
      ? t('cli.vendor.claude_cli')
      : provider === 'gemini'
        ? t('cli.vendor.antigravity_cli')
        : '';
  return { cli, vendor, version: version ?? '?', min };
}

/** [V2] UX2 2.2 "AI" sub-line fragments (each only when true), in order: quota reset, voice notes, pictures. */
export function aiSublineParts(
  health: AppHealth,
  settings: Settings | null,
  opts: { t: TFn; now: number; lang: 'en' | 'he'; voicePercent: number | null; mmprojReady: boolean | null },
): string[] {
  const { t, now, lang } = opts;
  const parts: string[] = [];
  const tz = settings?.general.timeZone ?? 'Asia/Jerusalem';
  if (health.llm.quota?.resetsAt != null) {
    parts.push(t('cli.usageResetsPlain', { time: formatResetTime(health.llm.quota.resetsAt, now, lang, tz) }));
  }
  const voice = health.voice.state;
  if (voice === 'downloading') parts.push(t('health.sub.voice.downloading', { percent: opts.voicePercent ?? 0 }));
  else if (voice === 'ready' || voice === 'transcribing') parts.push(t('health.sub.voice.ready'));
  else if (voice === 'off') parts.push(t('health.sub.voice.off'));
  if (settings) {
    if (!settings.images.enabled) parts.push(t('health.sub.images.off'));
    else if (settings.images.cloud && CLOUD_PICTURE_PROVIDERS.includes(health.llm.provider))
      parts.push(t('health.sub.images.ready'));
    else if (opts.mmprojReady !== null)
      parts.push(opts.mmprojReady ? t('health.sub.images.ready') : t('health.sub.images.missing'));
  }
  return parts;
}

/** [V2] UX2 2.2 "Calendar" sub-line fragments: the update-surface guard (B4) and the automatic-mode state. */
export function calendarSublineParts(health: AppHealth, t: TFn, now: number, shadowSeen: number): string[] {
  const parts: string[] = [];
  if (!health.calendar.updatesAvailable) parts.push(t('health.calendar.update_unavailable'));
  const a = health.auto;
  if (a.state === 'on') {
    const days = a.expiresAt !== null ? Math.max(0, Math.ceil((a.expiresAt - now) / 86_400_000)) : 0;
    parts.push(t('health.sub.auto.on', { count: days }));
  } else if (a.state === 'shadow') {
    parts.push(t('health.sub.auto.shadow', { seen: shadowSeen }));
  } else if (a.state === 'paused') {
    parts.push(t('health.sub.auto.paused', { reason: t(`auto.pausedReason.${a.pausedReason ?? 'user'}`) }));
  } else if (a.state === 'disabled' || a.state === 'expired') {
    // 'off' means no policy has ever existed: then the fragment is omitted entirely (UX2 2.2)
    parts.push(t('health.sub.auto.off'));
  }
  return parts;
}

const PARTS: readonly HealthPart[] = ['whatsapp', 'llm', 'calendar'];
const severityOf = (code: ErrorCode): 'working' | 'attention' => ERROR_SEVERITY[code] ?? 'attention';

/** A healthy stand-in for the two parts we are not asking about, so the frozen truth table of shared/health is reused. */
const HEALTHY: Pick<AppHealth, 'whatsapp' | 'llm' | 'calendar'> = {
  whatsapp: { state: 'online', since: 0 },
  llm: { state: 'ready', since: 0, provider: 'local', model: '', quota: null },
  calendar: { state: 'connected', since: 0, updatesAvailable: true },
};

export function partStatus(health: AppHealth, part: HealthPart): PartStatus {
  return overallOf({ ...HEALTHY, [part]: health[part] }, severityOf);
}

/** UX 5.2: when exactly one part is failing the pill names it. Paused overrides ok/working. */
export function pillLabelKey(health: AppHealth): string {
  if (health.paused && health.overall !== 'attention') return 'health.paused';
  if (health.overall === 'attention') {
    const failing = PARTS.filter((p) => partStatus(health, p) === 'attention');
    if (failing.length === 1) return `health.attentionPart.${failing[0]}`;
  }
  return `health.${health.overall}`;
}

function pillTone(health: AppHealth): PartStatus | 'paused' {
  if (health.paused && health.overall !== 'attention') return 'paused';
  return health.overall;
}

/** "for 12 min" - duration since the part entered its current state; shown for non-ok states only. */
export function sinceLabel(since: number, now: number, locale: string): string | null {
  const ms = now - since;
  if (!Number.isFinite(ms) || ms < 60_000) return null;
  const minutes = Math.floor(ms / 60_000);
  const [value, unit] =
    minutes < 60
      ? [minutes, 'minute']
      : minutes < 60 * 24
        ? [Math.floor(minutes / 60), 'hour']
        : [Math.floor(minutes / 1440), 'day'];
  return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'short' }).format(value);
}

function StatusIcon({ tone }: { tone: PartStatus | 'paused' }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    'aria-hidden': true,
  } as const;
  if (tone === 'ok')
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="6.25" />
        <path d="M5 8.2 7.2 10.4 11 6.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (tone === 'working')
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="6.25" />
        <path d="M8 4.5V8l2.4 1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (tone === 'paused')
    return (
      <svg {...common}>
        <path d="M6 4v8M10 4v8" strokeLinecap="round" />
      </svg>
    );
  return (
    <svg {...common}>
      <path d="M5.4 1.8h5.2l3.6 3.6v5.2l-3.6 3.6H5.4L1.8 10.6V5.4z" strokeLinejoin="round" />
      <path d="M8 5v3.6" strokeLinecap="round" />
      <circle cx="8" cy="11" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

const TONE_CLASS: Record<PartStatus | 'paused', string> = {
  ok: 'bg-ok-soft text-ok',
  working: 'bg-warn-soft text-warn',
  paused: 'bg-warn-soft text-warn',
  attention: 'bg-danger-soft text-danger',
};

interface RowModel {
  part: HealthPart;
  status: PartStatus;
  sentence: string;
  note: string | null;
  detail: string | null;
  since: number;
  code?: ErrorCode;
  actionLabel: string | null;
  /** [V2] one muted line, facts joined with " · " (UX2 2.2). */
  subline: ReactNode | null;
}

export function HealthPill({ health, onAction, onSubline }: HealthPillProps) {
  const { t, i18n } = useTranslation();
  const progress = useHealthStore((s) => s.progress);
  const downloads = useHealthStore((s) => s.downloads);
  const settings = useSettingsStore((s) => s.settings);
  const shadowSeen = useAutoStore((s) => s.state?.shadowTally?.decisions ?? 0);
  const cliStatus = useCliStore((s) =>
    isCliProvider(health.llm.provider) ? s.status[health.llm.provider] : undefined,
  );
  const [plan, setPlan] = useState<ModelPlan | null>(null);
  const [open, setOpen] = useState(false);
  // Sampled when the panel opens: "for 12 min" must not drift on every unrelated re-render (and render must stay pure).
  const [openedAt, setOpenedAt] = useState(0);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const firstRowRef = useRef<HTMLLIElement>(null);

  // [V2] C14: the pictures fact needs the projector state, which only the model plan carries - read when the panel opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void api.getModelPlan().then((r) => {
      if (!cancelled && r.ok) setPlan(r.value);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    firstRowRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onPointer = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [open]);

  const locale = i18n.language === 'he' ? 'he-IL' : 'en-IL';
  const percent =
    progress && progress.bytesTotal > 0
      ? Math.min(100, Math.floor((progress.bytesDone / progress.bytesTotal) * 100))
      : 0;
  const providerName = t(`health.provider.${health.llm.provider}`);
  const lang = i18n.language === 'he' ? 'he' : 'en';
  const timeZone = settings?.general.timeZone ?? 'Asia/Jerusalem';
  const values = errorValuesOf(health.llm.provider, t, cliStatus?.version ?? null, cliStatus?.minVersion ?? '');
  const voiceDownload = VOICE_TIERS.map((tier) => downloads[tier]).find((d) => d !== undefined);
  const voicePercent =
    voiceDownload && voiceDownload.bytesTotal > 0
      ? Math.min(100, Math.floor((voiceDownload.bytesDone / voiceDownload.bytesTotal) * 100))
      : null;
  const clock = openedAt;

  const sublineOf = (part: HealthPart): string | null => {
    let parts: string[];
    if (part === 'whatsapp') {
      const rt = settings?.whatsapp.readTools;
      parts = rt?.enabled ? [t(`health.sub.readTools.${rt.scope}`)] : [];
    } else if (part === 'llm') {
      parts = aiSublineParts(health, settings, {
        t,
        now: clock,
        lang,
        voicePercent,
        mmprojReady: plan ? plan.mmproj?.status === 'ready' : null,
      });
    } else {
      parts = calendarSublineParts(health, t, clock, shadowSeen);
    }
    return parts.length > 0 ? parts.join(' · ') : null;
  };

  const rows: RowModel[] = PARTS.map((part) => {
    const status = partStatus(health, part);
    const code = health[part].code;
    const state = health[part].state;
    let sentence: string;
    let note: string | null = null;
    let detail: string | null = null;
    let actionLabel: string | null = null;

    if (code) {
      sentence = t(`errors.${code}.title`, values);
      note =
        code === 'CLOUD_QUOTA' && part === 'llm' && health.llm.quota?.resetsAt != null
          ? t('errors.CLOUD_QUOTA.bodyReset', {
              vendor: values.vendor,
              time: formatResetTime(health.llm.quota.resetsAt, clock, lang, timeZone),
            })
          : t(`errors.${code}.body`, values);
      if (ERROR_ACTION[code] !== 'none')
        actionLabel =
          code === 'CLOUD_QUOTA' && health.llm.provider === 'claude_cli'
            ? t('label.errorAction.open_usage_page')
            : t(`errors.${code}.action`, values);
    } else if (part === 'llm') {
      sentence =
        isCliProvider(health.llm.provider) && (state === 'not_installed' || state === 'not_signed_in')
          ? t(`health.llm.cliState.${state}`, { provider: providerName })
          : t(`health.llm.${state}`, { provider: providerName, percent });
      if (health.paused) sentence = t('health.paused');
      if (state === 'downloading' || state === 'starting' || state === 'verifying') note = t('health.llm.waitingNote');
      if (health.llm.provider !== 'local' && health.llm.model) detail = health.llm.model;
    } else {
      sentence = t(`health.${part}.${state}`);
      if (part === 'whatsapp' && state === 'needs_pairing') actionLabel = t('health.action.link');
      if (part === 'calendar' && (state === 'not_configured' || state === 'needs_sign_in'))
        actionLabel = t('health.action.connect');
    }
    return {
      part,
      status,
      sentence,
      note,
      detail,
      since: health[part].since,
      code,
      actionLabel,
      subline: sublineOf(part),
    };
  });

  const analysing = health.queue.pending + health.queue.running;
  const tone = pillTone(health);
  const now = openedAt;

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        type="button"
        data-testid="health-pill"
        data-overall={health.overall}
        data-paused={health.paused ? '1' : '0'}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) setOpenedAt(Date.now());
        }}
        className={`pill ${TONE_CLASS[tone]}`}
      >
        <StatusIcon tone={tone} />
        <span>{t(pillLabelKey(health))}</span>
      </button>

      {open ? (
        <div
          id={panelId}
          role="dialog"
          aria-label={t('health.panelTitle')}
          data-testid="health-panel"
          className="absolute start-0 z-20 mt-1 w-90 max-w-full rounded-md border border-line bg-surface p-2 shadow-pop"
        >
          <ul className="m-0 list-none p-0">
            {rows.map((row, index) => {
              const since = row.status === 'ok' ? null : sinceLabel(row.since, now, locale);
              return (
                <li
                  key={row.part}
                  ref={index === 0 ? firstRowRef : undefined}
                  tabIndex={-1}
                  data-testid={`health-row-${row.part}`}
                  data-status={row.status}
                  className="focus-ring flex items-start gap-2 border-b border-line p-2 last:border-b-0"
                >
                  <span
                    className={`mt-0.5 ${row.status === 'ok' ? 'text-ok' : row.status === 'working' ? 'text-warn' : 'text-danger'}`}
                  >
                    <StatusIcon tone={row.status} />
                  </span>
                  <span className="min-w-0 grow">
                    <span className="block text-md font-semibold">{t(`health.part.${row.part}`)}</span>
                    <span className="block">{row.sentence}</span>
                    {row.detail ? <span className="block text-xs text-text-muted">{row.detail}</span> : null}
                    {row.note ? <span className="block text-sm text-text-muted">{row.note}</span> : null}
                    {since ? (
                      <span className="block text-xs text-text-muted tnum">{t('health.since', { value: since })}</span>
                    ) : null}
                    {row.subline && onSubline ? (
                      <button
                        type="button"
                        data-testid={`health-subline-${row.part}`}
                        className="focus-ring block cursor-pointer border-0 bg-transparent p-0 text-start text-xs text-text-muted hover:underline"
                        onClick={() => {
                          setOpen(false);
                          onSubline(row.part);
                        }}
                      >
                        {row.subline}
                      </button>
                    ) : row.subline ? (
                      <span data-testid={`health-subline-${row.part}`} className="block text-xs text-text-muted">
                        {row.subline}
                      </span>
                    ) : null}
                  </span>
                  {row.actionLabel ? (
                    <button
                      type="button"
                      data-testid={`health-action-${row.part}`}
                      className="btn btn-outline shrink-0"
                      onClick={() => {
                        setOpen(false);
                        onAction(row.part, row.code);
                      }}
                    >
                      {row.actionLabel}
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {analysing > 0 ? (
            <p className="m-0 p-2 text-sm text-text-muted" data-testid="health-analysing">
              {t('list.analysing', { count: analysing })}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
