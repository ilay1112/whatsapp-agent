// [V2] V2-W0-scaffold: the Wave-0 renderer stubs load, take their final UX2 12 props and render their UX2 13 test-id
// placeholder. Each owner (V2-W1-11 / V2-W1-12) replaces the matching block with real tests when the body lands.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { AutoState, CliStatus, EventContentView } from '@shared/types';
import { AutoStrip } from './components/AutoStrip';
import { ChangeLine } from './components/ChangeLine';
import { UndoControl } from './components/UndoControl';
import { VoiceBubble } from './components/VoiceBubble';
import { ImageBubble } from './components/ImageBubble';
import { ConnectCard } from './components/ConnectCard';
import { AutomaticMode } from './views/settings/AutomaticMode';
import { AutoActivity } from './views/AutoActivity';
import { useAutoStore } from './store/auto';
import { useCliStore } from './store/cli';

const EVENT: EventContentView = {
  title: 'x',
  startLocal: '2026-09-23T15:00:00',
  endLocal: '2026-09-23T16:00:00',
  timeZone: 'Asia/Jerusalem',
  location: '',
  status: 'confirmed',
};
const noop = (): void => undefined;
const CLI: CliStatus = {
  provider: 'claude_cli',
  state: 'not_installed',
  version: null,
  minVersion: '2.1.248',
  quota: null,
  lastTest: null,
  workspaceTrusted: null,
};
const AUTO: AutoState = {
  policy: null,
  preconditions: {
    calendarConnected: false,
    calendarOwned: false,
    approvedCreates: 0,
    approvedCreatesNeeded: 3,
    providerAllowsAuto: true,
    updatesAvailable: false,
  },
  shadowTally: null,
  usedToday: { writes: 0, limit: 0 },
  undoableCount: 0,
};

describe('Wave-0 renderer stubs (UX2 12 props, UX2 13 test ids)', () => {
  it('render their placeholders', () => {
    render(
      <>
        <AutoStrip rows={[]} policyState={null} onUndo={noop} onShow={noop} onPause={noop} />
        <ChangeLine
          change={{ kind: 'reschedule', from: EVENT, to: EVENT, confidence: 'high', baseRevision: 1 }}
          lang="en"
        />
        <UndoControl
          undo={{ revisionId: 1, until: 0, state: 'available', automatic: false }}
          itemId={7}
          door="card"
          onUndo={() => Promise.resolve({ ok: true, value: null })}
        />
        <VoiceBubble voice={{ seconds: 3, language: null, transcript: null, status: 'pending' }} />
        <ImageBubble
          image={{
            thumbDataUrl: null,
            readText: '',
            dateText: '',
            timeText: '',
            location: '',
            confidence: 'high',
            kind: 'none',
          }}
          contactName=""
          mode="card"
        />
        <ConnectCard provider="claude_cli" size="full" status={CLI} selected={false} onUse={noop} />
        <AutomaticMode state={AUTO} />
        <AutoActivity onBack={noop} />
      </>,
    );
    // [V2-W1-11] the AutoStrip body landed: with no row it leaves the DOM (UX2 3.1) - its tests are AutoStrip.test.tsx.
    expect(screen.queryByTestId('autostrip')).toBeNull();
    for (const id of [
      'change-line',
      'undo-state-7',
      'voice-bubble',
      'image-bubble',
      'connect-claude_cli',
      'settings-group-auto',
      'auto-activity',
    ])
      expect(screen.getByTestId(id)).toBeInTheDocument();
    expect(screen.getByTestId('connect-claude_cli')).toHaveAttribute('data-state', 'not_installed');
  });

  it('stores keep what they are given; hydration is the owners’ (rejects until then)', async () => {
    useAutoStore.getState().setState(AUTO);
    expect(useAutoStore.getState().state).toBe(AUTO);
    // [V2-W1-11] hydrate landed (store/auto.test.ts): it reads auto:getState + auto:listWrites and never rejects.
    await expect(useAutoStore.getState().hydrate()).resolves.toBeUndefined();
    useCliStore.getState().setStatus(CLI);
    expect(useCliStore.getState().status.claude_cli).toBe(CLI);
    // [V2-W1-12] refresh landed (store/cli.test.ts): cli:getStatus for both providers, never rejects (errors land in `error`).
    await expect(useCliStore.getState().refresh()).resolves.toBeUndefined();
  });
});
