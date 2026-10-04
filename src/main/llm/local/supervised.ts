// src/main/llm/local/supervised.ts - the LlamaRuntime facade the composition root hands to the local LLM provider.
// Starting llama through the Supervisor is what writes <userData>\run\llama.pid.json for the reaper (ARCH 3, A3) and
// what enforces the section 14 breaker/backoff contract, so this wrapper must NEVER reach past a refused start into the
// raw runtime: a child spawned that way carries no pid file, so killAllSync() and reapOrphans() can never reach it.
import { LlamaRuntimeError, type LlamaRuntime } from './llamaServer';
import type { ChildState, Supervisor } from '../../proc/supervisor';

/** The supervisor states from which the raw runtime may be consulted: the child is up, or a supervised start is in flight. */
const STARTABLE: readonly ChildState[] = ['running', 'starting'];

export interface SupervisedLlamaInput {
  /** [V2] `restart` is optional: with it, a child whose picture flags went stale (images toggled, projector downloaded) is
   *  restarted through the Supervisor (pid file + backoff table stay authoritative, B19 / C2 9.1). */
  supervisor: Pick<Supervisor, 'start' | 'state'> & Partial<Pick<Supervisor, 'restart'>>;
  runtime: LlamaRuntime;
}

/**
 * `supervisor.start()` is typed `Promise<void>` and resolves silently when it refuses (open breaker, terminal failure,
 * a stop in flight), so the refusal is only observable through `state()`. Anything other than a live/starting child is
 * therefore reported to the caller as the runtime's own ErrorCode instead of being overridden by a direct spawn; the
 * local provider maps the rejection to `not_ready`, and the supervisor's backoff timer owns the retry.
 */
export function createSupervisedLlama(input: SupervisedLlamaInput): LlamaRuntime {
  const { supervisor, runtime } = input;
  return {
    ...runtime,
    async ensureStarted() {
      if (supervisor.restart !== undefined && runtime.vision?.().stale === true) await supervisor.restart('llama');
      else await supervisor.start('llama');
      if (!STARTABLE.includes(supervisor.state('llama'))) {
        throw new LlamaRuntimeError(runtime.status().code ?? 'LLM_LOCAL_FAILED');
      }
      return runtime.ensureStarted();
    },
  };
}
