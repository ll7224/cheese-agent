import { agentLoop } from '../agent/loop.js';
import { Pool } from './pool.js';

const pool = new Pool(Number(process.env.CHEESE_MAX_RUNS || 3));

export async function executeAgent(...args: Parameters<typeof agentLoop>) {
  const release = await pool.acquire();
  try { return await agentLoop(...args); }
  finally { release(); }
}
