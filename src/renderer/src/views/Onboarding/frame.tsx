// src/renderer/src/views/Onboarding/frame.tsx - the shared chrome of the five wizard steps (UX section 8 "Shared frame";
// owner W1-16). Not a component of the UX 14.2 inventory: it is a private part of `views/Onboarding/**`, colocated with
// the five steps that use it so none of them re-implements the rail, the column width or the footer.
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import '../setup.css';

/** The four named stages of the rail. Welcome (index 0) has no rail - it is the step before the sequence starts. */
export const RAIL_KEYS = ['step1', 'step2', 'step3', 'step4'] as const;
export type StepIndex = 0 | 1 | 2 | 3 | 4;

/** Locale-aware number (ARCH 12.3: every number and date goes through Intl with an explicit locale). */
export function num(value: number, lang: string, digits = 0): string {
  return new Intl.NumberFormat(lang === 'he' ? 'he-IL' : 'en-IL', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

/** Bytes -> "4.6" in the UI language (UX 8.1: pinned bytes / 2^30, one decimal). */
export function gib(bytes: number, lang: string): string {
  return num(bytes / 2 ** 30, lang, 1);
}

export function ShieldIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
      className="shrink-0"
    >
      <path d="M8 1.8 3.2 3.6v4.1c0 3 2 5.1 4.8 6.5 2.8-1.4 4.8-3.5 4.8-6.5V3.6L8 1.8Z" strokeLinejoin="round" />
      <path d="m5.9 7.9 1.5 1.6 2.9-3.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The always-visible privacy note of a provider card (UX 8.1: a note, never a tooltip). */
export function PrivacyNote({ children }: { children: ReactNode }) {
  return (
    <p className="m-0 flex items-start gap-2 text-sm text-text-muted">
      <ShieldIcon />
      <span>{children}</span>
    </p>
  );
}

export function CheckIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      aria-hidden="true"
      className="shrink-0"
    >
      <path d="m3.2 8.4 3.2 3.3 6.4-7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * The four numbered stages after Welcome. `current` is 1-based. Done stages are ok-coloured, the current one accent,
 * upcoming ones hairline - and the current one carries `aria-current="step"` (UX section 8).
 */
export function ProgressRail({ current }: { current: 1 | 2 | 3 | 4 }) {
  const { t } = useTranslation();
  return (
    <ol
      aria-label={t('onboarding.rail.label')}
      data-testid="onboarding-rail"
      className="m-0 flex list-none items-center gap-2 border-b border-line bg-surface px-4 py-2"
    >
      {RAIL_KEYS.map((key, i) => {
        const n = i + 1;
        const state = n < current ? 'done' : n === current ? 'current' : 'upcoming';
        return (
          <li
            key={key}
            className="flex min-w-0 grow items-center gap-2"
            {...(state === 'current' ? { 'aria-current': 'step' as const } : {})}
          >
            <span
              data-testid={`onboarding-rail-${n}`}
              data-state={state}
              className={`chip tnum whitespace-nowrap ${
                state === 'done' ? 'bg-ok-soft text-ok' : state === 'current' ? 'bg-accent-soft text-accent' : ''
              }`}
            >
              {n} {t(`onboarding.rail.${key}`)}
            </span>
            {n < RAIL_KEYS.length ? (
              <span aria-hidden="true" className="rail-connector" data-done={n < current ? '1' : '0'} />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

export interface StepFrameProps {
  /** 0 = Welcome ... 4 = Ready. Drives `data-testid="onboarding-step-<n>"` (UX 16 item 6). */
  index: StepIndex;
  /** The id `App.tsx` routes on, kept from the Wave 0 stubs. */
  testId: string;
  title: string;
  children: ReactNode;
  onBack?: () => void;
  /** Rendered before the primary button (e.g. "Later - replies only", "Waiting for your phone..."). */
  footerStart?: ReactNode;
  primary?: ReactNode;
}

/** Content column 560 px max, start-aligned, one primary button at the bottom inline-end, quiet Back at the inline-start. */
export function StepFrame({ index, testId, title, children, onBack, footerStart, primary }: StepFrameProps) {
  const { t } = useTranslation();
  return (
    <section data-testid={testId} className="flex min-h-full flex-col">
      {index > 0 ? <ProgressRail current={index as 1 | 2 | 3 | 4} /> : null}
      <div
        data-testid={`onboarding-step-${index}`}
        className="mx-auto flex w-full max-w-[35rem] grow flex-col gap-4 px-4 py-5"
      >
        <h1 className="m-0 text-xl">{title}</h1>
        {children}
        <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
          {onBack ? (
            <button type="button" className="btn btn-quiet" data-testid="onboarding-back" onClick={onBack}>
              {t('app.back')}
            </button>
          ) : null}
          <span className="grow" />
          {footerStart}
          {primary}
        </div>
      </div>
    </section>
  );
}
