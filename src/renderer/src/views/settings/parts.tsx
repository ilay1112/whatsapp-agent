// src/renderer/src/views/settings/parts.tsx - the small shared parts of the settings page (UX 9, UX 10; v1 owner W1-16,
// moved here by V2-W1-12 so that the v2 settings sub-views can use them without importing Settings.tsx back).
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { CheckIcon } from '../Onboarding/frame';

/** UX 9: 36 x 20 track, role="switch", the thumb carries a check when on - never colour alone. */
export function Toggle({
  checked,
  onChange,
  labelledBy,
  testId,
  disabled,
  describedBy,
}: {
  checked: boolean;
  onChange(next: boolean): void;
  labelledBy: string;
  testId: string;
  disabled?: boolean;
  describedBy?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      data-testid={testId}
      className="switch"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-thumb">{checked ? <CheckIcon size={12} /> : null}</span>
    </button>
  );
}

export function Row({
  id,
  label,
  desc,
  htmlFor,
  testId,
  children,
}: {
  id?: string;
  label: string;
  desc?: ReactNode;
  htmlFor?: string;
  testId: string;
  children?: ReactNode;
}) {
  const text = (
    <div className="flex min-w-60 grow basis-60 flex-col">
      {htmlFor ? (
        <label htmlFor={htmlFor} id={id} className="font-semibold">
          {label}
        </label>
      ) : (
        <span id={id} className="font-semibold">
          {label}
        </span>
      )}
      {desc ? <span className="text-sm text-text-muted">{desc}</span> : null}
    </div>
  );
  return (
    <div data-testid={testId} className="flex flex-wrap items-center gap-3 border-b border-line py-3 last:border-b-0">
      {text}
      {children ? <div className="flex flex-wrap items-center gap-2">{children}</div> : null}
    </div>
  );
}

/** A group of the one settings page; `id` = `settings-group-<group>` is the in-page nav target. */
export function Group({ group, title, children }: { group: string; title: string; children: ReactNode }) {
  return (
    <section
      id={`settings-group-${group}`}
      data-testid={`settings-group-${group}`}
      aria-labelledby={`settings-h-${group}`}
      className="border-t border-line pt-4"
    >
      <h2 id={`settings-h-${group}`} className="mt-0 mb-1 text-md font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** A sub-heading inside a group (AI engine > Voice notes / Pictures). */
export function SubGroup({
  id,
  title,
  testId,
  children,
}: {
  id: string;
  title: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} data-testid={testId} className="flex flex-col gap-1 border-t border-line pt-3">
      <h3 id={id} className="m-0 text-base font-semibold">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** UX 10: alertdialog, scrim, Escape = cancel, initial focus on the LEAST destructive button, primary at the inline-end. */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel,
  danger,
  testId,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
  testId: string;
  onConfirm(): void;
  onCancel(): void;
}) {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onCancel]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-scrim p-4">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={testId}
        className="flex w-120 max-w-full flex-col gap-3 rounded-lg bg-surface p-5 shadow-sheet"
      >
        <h2 id={titleId} className="m-0 text-lg">
          {title}
        </h2>
        <p className="m-0 text-text-muted">{body}</p>
        <div className="flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            className="btn btn-outline"
            data-testid={`${testId}-cancel`}
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
            data-testid={`${testId}-confirm`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** A collapsed-by-default disclosure button (`aria-expanded`), e.g. "Show experimental" / "Advanced" (UX2 4.1). */
export function Disclosure({
  open,
  onToggle,
  label,
  testId,
  controls,
}: {
  open: boolean;
  onToggle(): void;
  label: string;
  testId: string;
  controls: string;
}) {
  return (
    <button
      type="button"
      className="btn btn-quiet self-start"
      aria-expanded={open}
      aria-controls={controls}
      data-testid={testId}
      onClick={onToggle}
    >
      <span className={open ? 'inline-block' : 'icon-dir inline-block'} aria-hidden="true">
        {open ? '⌄' : '›'}
      </span>
      {label}
    </button>
  );
}

/** The UI language as the shared formatters take it. */
export function uiLang(language: string): 'en' | 'he' {
  return language === 'he' ? 'he' : 'en';
}
