// src/renderer/src/components/RefreshButton.tsx - [v4 T3] the dashboard toolbar's Refresh (v4-calendar-handover 2.1).
// One click = one `dashboard:refreshNow`. Main scans the bridge, re-queues the chats active in the last 24 h (inside the existing
// rate limits) and invalidates the calendar cache; it never approves, sends or writes anything. The dashboard lists follow by
// themselves on main's `dashboard:changed` push. The 30 s cooldown is main's: a press inside it answers `cooldown: true`.
// The result line is this component's own polite status (the global toast carries no interpolation values).
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api';

const STATUS_MS = 6_000;

type Status =
  | { kind: 'done'; newRows: number; queued: number; skipped: number; nothing: number }
  | { kind: 'cooldown' }
  | { kind: 'error'; code: string };

export function RefreshButton() {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const pendingRef = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (status === null) return;
    const timer = setTimeout(() => setStatus(null), STATUS_MS);
    return () => clearTimeout(timer);
  }, [status]);

  const onClick = useCallback(async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    try {
      const r = await api.refreshNow();
      if (!mounted.current) return;
      if (!r.ok) setStatus({ kind: 'error', code: r.error.code });
      else if (r.value.cooldown) setStatus({ kind: 'cooldown' });
      else
        setStatus({
          kind: 'done',
          newRows: r.value.newRows,
          queued: r.value.queued,
          skipped: r.value.skippedRateLimited + r.value.skippedInCalendar,
          nothing: r.value.skippedNothingToAnalyse,
        });
    } catch {
      if (mounted.current) setStatus({ kind: 'error', code: 'INTERNAL' });
    } finally {
      pendingRef.current = false;
      if (mounted.current) setPending(false);
    }
  }, []);

  const text =
    status === null
      ? null
      : status.kind === 'done'
        ? t('refresh.done', {
            newRows: status.newRows,
            queued: status.queued,
            skipped: status.skipped,
            nothing: status.nothing,
          })
        : status.kind === 'cooldown'
          ? t('refresh.cooldown')
          : t(`errors.${status.code}.title`);

  return (
    <>
      <span role="status" className="text-sm text-text-muted" data-testid="refresh-status">
        {text !== null ? <span data-testid="refresh-toast">{text}</span> : null}
      </span>
      <button
        type="button"
        className="btn btn-quiet inline-flex items-center gap-1"
        data-testid="refresh-now"
        disabled={pending}
        aria-busy={pending}
        onClick={() => void onClick()}
      >
        {pending ? (
          <span
            aria-hidden="true"
            data-testid="refresh-spinner"
            className="inline-block size-3 rounded-full border-2 border-current border-e-transparent motion-safe:animate-spin"
          />
        ) : null}
        {pending ? t('refresh.running') : t('refresh.now')}
      </button>
    </>
  );
}
