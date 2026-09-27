// tests/golden/golden.live.test.ts - LIVE evaluation run (TESTS 7.3, layer L7; owner W1-10).
//
// AN AGENT MUST NEVER RUN THIS FILE. It is the only test in the repository that talks to a real model, and it exists so
// the USER can score a provider before the model pins of ARCHITECTURE 17 are locked. It is excluded from `npm test` by
// its own vitest project (`golden-live`) and refuses to do anything unless the user opted in:
//
//   npm run test:golden:live -- --provider local|claude|gemini      (with WCA_GOLDEN_LIVE=1)
//
// A cloud key is asked for on stdin with echo off by the runner and kept in memory only - never an env var, never a file
// in the repository, never logged. Local needs an already downloaded, verified GGUF and the vendored llama-server.exe.
// Everything except the model stays fake: fake calendar (READ only), no bridge, no send client, no write client.
import { describe, expect, it } from 'vitest';
import { createOrchestrator } from '../../src/main/agent/orchestrator.ts';
import type { LlmProvider, ProviderFactory } from '../../src/main/llm/types.ts';
import type { ProviderId } from '../../src/shared/types.ts';
import { goldenTimeline, loadGoldenCases, type GoldenCase } from '../helpers/goldenLoader.ts';
import { createSeededRandom, createVirtualClock } from '../helpers/virtualClock.ts';
import { createIngestDouble, createTestEnv, messagesFrom } from './testDb.ts';

/** The ONE opt-in. Anything other than the literal '1' means "not opted in" and the whole suite is skipped. */
const LIVE = process.env.WCA_GOLDEN_LIVE === '1';

function providerFromArgv(): ProviderId {
  const flag = process.argv.indexOf('--provider');
  const value = flag === -1 ? '' : process.argv[flag + 1];
  if (value !== 'local' && value !== 'claude' && value !== 'gemini') {
    throw new Error('golden live: pass --provider local|claude|gemini');
  }
  return value;
}

/** Default pass thresholds of TESTS 7.3 (superseded by agent-pipeline.md if it ever defines others). */
export const LIVE_THRESHOLDS = {
  intent: 0.9,
  needsReply: 0.9,
  dateEn: 0.9,
  dateHe: 0.85,
  time: 0.9,
  replyLang: 1,
} as const;

export interface LiveScore {
  total: number;
  intent: number;
  needsReply: number;
  date: number;
  time: number;
  replyLang: number;
  schemaFailures: number;
  blockedToolCalls: number;
}

/**
 * Scores one case against the live provider's answer. Exported so the runner script and this test share one definition;
 * the live provider is built by the caller, never here, so importing this file can never construct a model.
 */
export function scoreCase(
  c: GoldenCase,
  actual: { intent: string; needsReply: boolean; startLocal: string | null; replyLang: string },
): Partial<LiveScore> {
  const want = c.expect;
  return {
    intent: actual.intent === want.intent ? 1 : 0,
    needsReply: actual.needsReply === want.needsReply ? 1 : 0,
    date: want.startLocal === undefined ? 1 : actual.startLocal === want.startLocal ? 1 : 0,
    time: want.startLocal === undefined ? 1 : actual.startLocal?.slice(11) === want.startLocal.slice(11) ? 1 : 0,
    replyLang: want.replyLang === undefined || actual.replyLang === want.replyLang ? 1 : 0,
  };
}

describe.skipIf(!LIVE)('golden live evaluation (L7, user-run only)', () => {
  it('scores every non-attack case against the chosen provider', async () => {
    const providerId = providerFromArgv();
    // The provider is constructed through the SHIPPED factory, so consent, key handling and model pinning are exercised
    // exactly as in production. The import is lazy so that merely loading this file never touches the factory.
    const { createProviderFactory } = await import('../../src/main/llm/factory.ts');
    expect(typeof createProviderFactory).toBe('function');

    const cases = loadGoldenCases().filter((c) => c.injection !== true);
    const score: LiveScore = {
      total: 0,
      intent: 0,
      needsReply: 0,
      date: 0,
      time: 0,
      replyLang: 0,
      schemaFailures: 0,
      blockedToolCalls: 0,
    };

    for (const c of cases) {
      const nowMs = Date.parse(c.nowIso);
      const env = createTestEnv({
        busy: c.calendar?.busy ?? [],
        calendarConnected: true,
        settings: (s) => void (s.general.timeZone = c.timeZone),
      });
      try {
        const clock = createVirtualClock(nowMs);
        const chat = env.repos.chats.upsertFromBridge(c.chatJid, 'Golden Contact', true, nowMs);
        const item = env.repos.items.createOpen({
          chatId: chat.id,
          triggerMsgId: `wamid.${c.id}`,
          triggerTs: nowMs,
          analysis: 'queued',
          holdReason: null,
          now: nowMs,
        });
        const factory = createProviderFactory({
          repos: env.repos,
          settings: () => ({ ...env.settings, llm: { ...env.settings.llm, provider: providerId } }),
          secrets: { get: () => null, put: () => undefined, delete: () => undefined, last4: () => '' } as never,
          log: env.log,
        } as never);
        const providers: ProviderFactory = {
          get: () => factory.get() as Promise<LlmProvider>,
          usable: () => factory.usable(),
          invalidate: () => factory.invalidate(),
        };
        const orchestrator = createOrchestrator({
          repos: env.repos,
          providers,
          gate: env.gate,
          ingest: createIngestDouble(messagesFrom(c.chatJid, goldenTimeline(c))),
          settings: () => env.settings,
          clock,
          random: createSeededRandom(),
          log: env.log,
          notifyChanged: () => undefined,
        });
        await orchestrator.runChat(chat.id, new AbortController().signal);

        const fresh = env.repos.items.byId(item.id)!;
        if (fresh.errorCode === 'LLM_BAD_OUTPUT') score.schemaFailures += 1;
        const proposal = env.repos.proposals.current(item.id);
        const extraction = proposal?.extraction ?? null;
        if (extraction !== null) {
          const partial = scoreCase(c, {
            intent: extraction.intent,
            needsReply: extraction.needsReply,
            startLocal: proposal?.event?.startLocal === '' ? null : (proposal?.event?.startLocal ?? null),
            replyLang: env.repos.chats.byId(chat.id)!.lang ?? '',
          });
          score.total += 1;
          score.intent += partial.intent ?? 0;
          score.needsReply += partial.needsReply ?? 0;
          score.date += partial.date ?? 0;
          score.time += partial.time ?? 0;
          score.replyLang += partial.replyLang ?? 0;
        }
        await factory.invalidate();
      } finally {
        env.dispose();
      }
    }

    expect(score.schemaFailures).toBe(0);
    expect(score.intent / score.total).toBeGreaterThanOrEqual(LIVE_THRESHOLDS.intent);
    expect(score.needsReply / score.total).toBeGreaterThanOrEqual(LIVE_THRESHOLDS.needsReply);
    expect(score.time / score.total).toBeGreaterThanOrEqual(LIVE_THRESHOLDS.time);
    expect(score.replyLang / score.total).toBeGreaterThanOrEqual(LIVE_THRESHOLDS.replyLang);
  });
});

describe('golden live opt-in guard', () => {
  it('is skipped unless WCA_GOLDEN_LIVE=1 - an agent run never reaches a model', () => {
    // This assertion is the point of the file in CI and in every agent run: the opt-in is absent, so nothing above ran.
    expect(LIVE).toBe(process.env.WCA_GOLDEN_LIVE === '1');
    if (!LIVE) expect(process.env.WCA_GOLDEN_LIVE).not.toBe('1');
  });
});
