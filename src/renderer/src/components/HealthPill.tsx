// src/renderer/src/components/HealthPill.tsx - one pill in the header; clicking it expands three rows (UX 5.2, 14.2;
// ARCH section 14, A17; owner W1-14). Colour is never the only carrier of meaning: every state has an icon SHAPE and a
// text label. Every red state offers exactly one action.
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type AppHealth, overallOf } from '@shared/health';
import { ERROR_ACTION, ERROR_SEVERITY, type ErrorCode } from '@shared/errors';
import { useHealthStore } from '../store/health';

export type HealthPart = 'whatsapp' | 'llm' | 'calendar';
type PartStatus = 'ok' | 'working' | 'attention';

export interface HealthPillProps {
  health: AppHealth;
  onAction(part: HealthPart, code?: ErrorCode): void;
}

const PARTS: readonly HealthPart[] = ['whatsapp', 'llm', 'calendar'];
const severityOf = (code: ErrorCode): 'working' | 'attention' => ERROR_SEVERITY[code] ?? 'attention';

/** A healthy stand-in for the two parts we are not asking about, so the frozen truth table of shared/health is reused. */
const HEALTHY: Pick<AppHealth, 'whatsapp' | 'llm' | 'calendar'> = {
  whatsapp: { state: 'online', since: 0 },
  llm: { state: 'ready', since: 0, provider: 'local', model: '' },
  calendar: { state: 'connected', since: 0 },
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
}

export function HealthPill({ health, onAction }: HealthPillProps) {
  const { t, i18n } = useTranslation();
  const progress = useHealthStore((s) => s.progress);
  const [open, setOpen] = useState(false);
  // Sampled when the panel opens: "for 12 min" must not drift on every unrelated re-render (and render must stay pure).
  const [openedAt, setOpenedAt] = useState(0);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const firstRowRef = useRef<HTMLLIElement>(null);

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

  const rows: RowModel[] = PARTS.map((part) => {
    const status = partStatus(health, part);
    const code = health[part].code;
    const state = health[part].state;
    let sentence: string;
    let note: string | null = null;
    let detail: string | null = null;
    let actionLabel: string | null = null;

    if (code) {
      sentence = t(`errors.${code}.title`);
      note = t(`errors.${code}.body`);
      if (ERROR_ACTION[code] !== 'none') actionLabel = t(`errors.${code}.action`);
    } else if (part === 'llm') {
      sentence = t(`health.llm.${state}`, { provider: providerName, percent });
      if (health.paused) sentence = t('health.paused');
      if (state === 'downloading' || state === 'starting' || state === 'verifying') note = t('health.llm.waitingNote');
      if (health.llm.provider !== 'local' && health.llm.model) detail = health.llm.model;
    } else {
      sentence = t(`health.${part}.${state}`);
      if (part === 'whatsapp' && state === 'needs_pairing') actionLabel = t('health.action.link');
      if (part === 'calendar' && (state === 'not_configured' || state === 'needs_sign_in'))
        actionLabel = t('health.action.connect');
    }
    return { part, status, sentence, note, detail, since: health[part].since, code, actionLabel };
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
