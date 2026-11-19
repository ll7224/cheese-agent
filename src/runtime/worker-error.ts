import type { ModelMessage } from 'ai';

/** Includes only completed model/tool steps, so a stopped run can be continued safely. */
export class WorkerExecutionError extends Error {
  constructor(message: string, public readonly messages?: ModelMessage[]) {
    super(message);
    this.name = 'WorkerExecutionError';
  }
}
