import { agentLoop } from '../agent/loop.js';

export async function executeAgent(...args: Parameters<typeof agentLoop>) {
  return agentLoop(...args);
}
