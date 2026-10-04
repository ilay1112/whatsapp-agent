// src/renderer/src/components/RawCard.tsx - held / failed card (UX 6.9, 14.2; owner W1-15).
//
// Used for `analysis IN ('held','failed')`, i.e. `item.card === 'raw'`. No AI text is involved, so:
//   - the DraftBox carries label="own" ("Your reply", solid edge - the dashed edge means "the AI wrote this");
//   - the reason chip comes from `holdReason` / `errorCode` through `Badges` (enum -> locale key, never model text);
//   - "Send" exists ONLY while a pending `send_reply` action exists AND the chat is sendable; otherwise the card is
//     copy-only with the one-line reason (an `@lid` chat or an offline bridge can never be sent to from here).
//
// Approval rules are not re-implemented here: every send goes through `useCardController` / `ApproveButton`, which own
// the focus guard, the single-flight lock and the `shownHash` echo (ARCH 6.6, UX 6.8).
//
// [V2] (owner V2-W1-11; UX2 3.5, 3.6, 9, 10): the "Voice message" and "Photo" raw cards. The trigger renders as the
// VoiceBubble / picture header (inert text); the card carries exactly ONE media action chosen by the ErrorCode / cause
// (`MediaActions` in RawCard.media.tsx, shared with ItemCard for a picture whose text analysis still ran). A voice raw card is never offered
// "Analyse this chat": an untranscribed voice note has nothing to analyse (an empty transcript is never a trigger).
// None of these actions writes anywhere: they download a model, re-queue a transcript / an analysis, or open Settings.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ItemCard as ItemVM } from '@shared/types';
import { MediaActions } from './RawCard.media';
import { Badges } from './Badges';
import { DraftBox } from './DraftBox';
import { QuotedBubble } from './QuotedBubble';
import {
  ApproveButton,
  CardHeader,
  OverflowMenu,
  ResultRowView,
  pendingAction,
  useCardController,
  useCardStrings,
} from './ItemCard';
import { useSettingsStore } from '../store/settings';
import { useDashboardStore } from '../store/dashboard';

export interface RawCardProps {
  item: ItemVM;
  onOpen(): void;
}

/**
 * UX 6.9: "Analyse this chat" explains itself ONCE per provider kind before the first use. Renderer memory only - the
 * explanation is a courtesy, not a consent record (real consent for a cloud provider lives in `consent:accept`).
 */
const explained = new Set<'local' | 'cloud'>();
/** Test seam: each test file starts from a clean slate. */
export function resetAnalyseExplanations(): void {
  explained.clear();
}

export function RawCard(props: RawCardProps) {
  const { t } = useTranslation();
  const item = props.item;
  const controller = useCardController(item);
  const { timeShort, timeFull } = useCardStrings(item);
  const titleId = `card-title-${item.itemId}`;
  const provider = useSettingsStore((s) => s.settings?.llm.provider) ?? 'local';
  const providerKind = provider === 'local' ? 'local' : 'cloud';
  const [confirmAnalyse, setConfirmAnalyse] = useState(false);

  const sendAction = pendingAction(item, 'send_reply');
  const sendable = item.chat.sendable;
  const canSend = sendAction !== null && sendable;

  // UX 2.4: a raw card arrives in the same columns as a full one, so it gets the same fading edge.
  const arrived = useDashboardStore((s) => s.arrivedItemIds.has(item.itemId));

  const runAnalyse = (): void => {
    explained.add(providerKind);
    setConfirmAnalyse(false);
    controller.retriage();
  };

  return (
    <article
      data-card-root
      data-testid={`card-${item.itemId}`}
      data-card="raw"
      data-list={item.status}
      tabIndex={0}
      aria-labelledby={titleId}
      className={`focus-ring flex flex-col gap-1 rounded-md border border-line bg-surface p-3${arrived ? ' card-arrival' : ''}`}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' || e.target !== e.currentTarget) return;
        props.onOpen();
      }}
    >
      <CardHeader
        item={item}
        titleId={titleId}
        timeShort={timeShort}
        timeFull={timeFull}
        menu={<OverflowMenu item={item} onOpen={props.onOpen} onDismiss={controller.dismiss} onRetriage={runAnalyse} />}
      />

      <QuotedBubble
        text={item.trigger.text}
        from="contact"
        clampLines={3}
        isTrigger
        mediaKind={item.trigger.text === '' && item.triggerKind === 'text' ? 'other' : undefined}
        triggerKind={item.triggerKind}
        voice={item.voice}
        image={item.image}
        contactName={item.chat.displayName !== '' ? item.chat.displayName : item.chat.phoneDisplay}
        itemId={item.itemId}
      />

      {/* The reason chip: hold reason ("New contact - not analysed") or the failure title. Enum -> locale key only. */}
      <Badges
        codes={item.badges}
        holdReason={item.holdReason ?? undefined}
        errorCode={item.errorCode ?? undefined}
        scope="card"
      />

      <DraftBox
        value={controller.draft}
        suggestion={null}
        onChange={controller.setDraft}
        onEditingChange={controller.onInputFocus}
        label="own"
      />

      <div className="mt-2 flex flex-wrap items-start gap-2">
        {canSend ? (
          <ApproveButton
            action={sendAction}
            controller={controller}
            label={t('action.send')}
            busyLabel={t('action.sending')}
            testId={`approve-send-${item.itemId}`}
            primary
            disabled={controller.draft.length === 0 || sendAction.disabledReason !== null}
            disabledReason={
              controller.draft.length === 0
                ? t('card.writeReplyFirst')
                : sendAction.disabledReason === 'wa_offline' || sendAction.disabledReason === 'bridge_outdated'
                  ? t('card.waOffline')
                  : undefined
            }
          />
        ) : null}

        <MediaActions item={item} />

        {item.triggerKind !== 'voice' ? (
          <button
            type="button"
            className="btn btn-quiet"
            data-testid={`analyse-${item.itemId}`}
            onClick={() => (explained.has(providerKind) ? runAnalyse() : setConfirmAnalyse(true))}
          >
            {item.analysis === 'failed' ? t('action.analyseAgain') : t('action.analyseChat')}
          </button>
        ) : null}

        <button
          type="button"
          className="btn btn-quiet"
          data-testid={`copy-${item.itemId}`}
          disabled={controller.draft.length === 0}
          onClick={controller.copy}
          aria-live="polite"
        >
          {controller.copied ? t('action.copied') : sendable ? t('action.copy') : t('action.copyReply')}
        </button>
      </div>

      {/* One-time inline explanation before the first analysis with this provider kind (UX 6.9). */}
      {confirmAnalyse ? (
        <div className="mt-2 rounded-sm bg-quote p-2 text-sm" data-testid={`analyse-explain-${item.itemId}`}>
          <p className="m-0">
            {providerKind === 'local'
              ? t('card.analyseExplain.local')
              : t('card.analyseExplain.cloud', { vendor: t(`health.provider.${provider}`) })}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-primary"
              data-testid={`analyse-confirm-${item.itemId}`}
              onClick={runAnalyse}
            >
              {t('action.analyse')}
            </button>
            <button
              type="button"
              className="btn btn-quiet"
              data-testid={`analyse-cancel-${item.itemId}`}
              onClick={() => setConfirmAnalyse(false)}
            >
              {t('card.analyseCancel')}
            </button>
          </div>
        </div>
      ) : null}

      {!sendable ? (
        <p className="m-0 text-xs text-text-muted" data-testid="copy-only-reason">
          {t('card.lidCopyOnly')}
        </p>
      ) : null}

      {controller.busyKind !== null && controller.stillSending ? (
        <p className="m-0 text-xs text-text-muted" data-testid={`still-sending-${item.itemId}`}>
          {t('card.stillSending')}
        </p>
      ) : null}

      {controller.result ? (
        <ResultRowView row={controller.result} controller={controller} itemId={item.itemId} />
      ) : null}
    </article>
  );
}
