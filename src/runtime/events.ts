export interface AgentEvent { type: string; [key: string]: unknown }
export interface ExecutionEvent extends AgentEvent { id: string; runId: string; sessionId: string; workspaceId: string; sequence: number; timestamp: string }
export interface ExecutionOptions { emit?: (event: AgentEvent) => void; signal?: AbortSignal; acquireChild?: (id: string) => Promise<() => void> }

export function redact(value: any, secrets: string[] = []): any {
  if (typeof value === 'string') {
    let text = value;
    for (const secret of secrets) if (secret.length > 3) text = text.split(secret).join('[已隐藏]');
    return text.replace(/(Bearer\s+)[\w.\-]+/gi, '$1[已隐藏]');
  }
  if (Array.isArray(value)) return value.map(entry => redact(entry, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, /apiKey|appSecret|password|token|secret/i.test(key) ? '[已隐藏]' : redact(entry, secrets)]));
  return value;
}

export function collectSecrets(value: any): string[] {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, entry]) => /apiKey|appSecret|password|token|secret/i.test(key) && typeof entry === 'string' ? [entry] : collectSecrets(entry));
}

export function partialText(events: AgentEvent[]): string {
  const attempts = new Map<unknown, number>();
  for (const event of events) if (!event.childRunId && (event.type === 'text' || event.type === 'retry')) attempts.set(event.step, Math.max(attempts.get(event.step) || 0, Number(event.attempt || 1) + (event.type === 'retry' ? 1 : 0)));
  return events.filter(event => !event.childRunId && event.type === 'text' && Number(event.attempt || 1) === attempts.get(event.step)).map(event => String(event.text || '')).join('');
}
