import type { ExecutionOptions } from '../runtime/events.js';

export type StopReason = 'step-limit' | 'token-budget' | 'loop-detected' | 'empty-response' | 'model-length' | 'content-filter' | 'model-error';

export class AgentStoppedError extends Error {
  constructor(public readonly reason: StopReason, message: string) {
    super(message);
    this.name = 'AgentStoppedError';
  }
}

/** A safety limit or an empty model response is not successful task completion. */
export function stopExecution(
  options: ExecutionOptions,
  reason: StopReason,
  message: string,
  step: number,
  details: Record<string, unknown> = {},
): never {
  options.emit?.({ type: 'execution-stopped', reason, message, step, ...details });
  throw new AgentStoppedError(reason, message);
}
