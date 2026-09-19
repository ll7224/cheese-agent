import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { streamSSE } from 'hono/streaming';
import { bodyLimit } from 'hono/body-limit';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { Runtime, RuntimeError } from '../runtime/service.js';
import { acquireServiceLock } from '../runtime/service-lock.js';
import { captureConfig, resolveConfig } from '../runtime/config.js';
import { ChannelGateway } from '../channels/gateway.js';
import { FeishuChannel } from '../channels/feishu.js';

export function createApp(runtime: Runtime) {
  const app = new Hono();
  app.use('/api/*', bodyLimit({ maxSize: 1_048_576, onError: context => context.json({ error: '请求超过 1 MiB 限制' }, 413) }));
  app.use('/api/*', async (context, next) => {
    const origin = context.req.header('origin');
    const url = new URL(context.req.url);
    const local = (hostname: string) => ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
    let host: URL;
    try { host = new URL(`http://${context.req.header('host') || url.host}`); }
    catch { return context.json({ error: '无效主机名' }, 403); }
    if (!local(url.hostname) || !local(host.hostname)) return context.json({ error: '仅允许本机访问' }, 403);
    if (origin && origin !== url.origin) return context.json({ error: '不允许跨站请求' }, 403);
    if (!['GET', 'HEAD'].includes(context.req.method) && !context.req.header('content-type')?.includes('application/json')) return context.json({ error: '需要 JSON 请求' }, 415);
    if (!['GET', 'HEAD'].includes(context.req.method) && !context.req.path.endsWith('/stop')) {
      let body: unknown;
      try { body = await context.req.json(); }
      catch { return context.json({ error: '无效 JSON 请求' }, 400); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return context.json({ error: '请求必须为 JSON 对象' }, 400);
    }
    await next();
  });
  app.onError((error, context) => context.json({ error: error.message }, error instanceof RuntimeError ? error.status as 400 : 500));
  app.get('/api/v1/status', context => context.json(runtime.status()));
  app.get('/api/v1/workspaces', context => context.json(runtime.listWorkspaces()));
  app.post('/api/v1/workspaces', async context => context.json(runtime.addWorkspace((await context.req.json()).path), 201));
  app.get('/api/v1/sessions', context => {
    const offset = Number(context.req.query('offset') || 0);
    const requestedLimit = Number(context.req.query('limit') || 50);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(requestedLimit) || requestedLimit < 1) throw new RuntimeError('无效分页参数');
    const limit = Math.min(100, requestedLimit);
    return context.json(runtime.state.sessions.filter(session => session.workspaceId === context.req.query('workspaceId')).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(offset, offset + limit).map(({ messages, ...session }) => ({ ...session, run: runtime.state.runs.filter(run => run.sessionId === session.id).at(-1) })));
  });
  app.post('/api/v1/sessions', async context => context.json(runtime.createSession((await context.req.json()).workspaceId), 201));
  app.get('/api/v1/sessions/:id', context => context.json({ ...runtime.session(context.req.param('id')), runs: runtime.state.runs.filter(run => run.sessionId === context.req.param('id')), events: runtime.state.events.filter(event => event.sessionId === context.req.param('id')) }));
  app.get('/api/v1/runs/:id/events', context => {
    const id = context.req.param('id');
    const after = Number(context.req.header('last-event-id') || context.req.query('after') || 0);
    if (!Number.isSafeInteger(after) || after < 0) throw new RuntimeError('无效事件游标');
    runtime.events(id, after);
    return streamSSE(context, async stream => {
      let pending = Promise.resolve();
      const send = (event: any) => { pending = pending.then(() => stream.writeSSE({ data: JSON.stringify(event), id: String(event.sequence) })).catch(() => {}); };
      const unsubscribe = runtime.subscribe(id, send);
      try {
        runtime.events(id, after).forEach(send);
        await new Promise<void>(resolve => { stream.onAbort(resolve); });
      } finally { unsubscribe(); await pending.catch(() => {}); }
    });
  });
  app.post('/api/v1/sessions/:id/runs', async context => {
    const body = await context.req.json();
    return context.json(runtime.submit(context.req.param('id'), body.text, body.key), 202);
  });
  app.post('/api/v1/runs/:id/stop', context => context.json(runtime.stop(context.req.param('id'))));
  app.all('/api/*', context => context.json({ error: '接口不存在' }, 404));
  app.get('/app.js', context => context.body(readFileSync(new URL('../../web/app.js', import.meta.url), 'utf8'), 200, { 'Content-Type': 'text/javascript' }));
  app.get('/style.css', context => context.body(readFileSync(new URL('../../web/style.css', import.meta.url), 'utf8'), 200, { 'Content-Type': 'text/css' }));
  app.get('*', context => context.html(readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8')));
  return app;
}

export async function startWeb() {
  const port = Number(process.env.CHEESE_PORT || 3210);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('无效端口');
  const dataDir = resolve(process.env.CHEESE_DATA_DIR || join(homedir(), '.cheese-agent'));
  const release = acquireServiceLock(dataDir);
  let runtime: Runtime;
  try {
    runtime = new Runtime(dataDir, undefined, { configDir: process.cwd(), maxConcurrent: Number(process.env.CHEESE_MAX_RUNS || 3), maxChildren: Number(process.env.CHEESE_MAX_CHILDREN || 3) });
    runtime.addWorkspace(process.cwd());
  } catch (error) { release(); throw error; }
  const workspace = runtime.addWorkspace(process.cwd());
  const gateway = new ChannelGateway({ run: (name, message) => runtime.runPrompt(workspace.id, message.text, `${name}:${message.channelId}:${message.senderId}`) });
  const server = serve({ fetch: createApp(runtime).fetch, hostname: '127.0.0.1', port });
  try {
    await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const snapshot = captureConfig(process.cwd(), process.cwd());
    if (snapshot.values.channels.feishu.enabled) gateway.register(new FeishuChannel(resolveConfig(snapshot).channels.feishu));
    await gateway.startAll();
    runtime.enableSchedules();
  } catch (error) { await gateway.stopAll(); await runtime.close(); server.close(); release(); throw error; }
  let closing: Promise<void> | undefined;
  const close = () => closing ||= (async () => {
    server.close();
    try { await gateway.stopAll(); await runtime.close(); }
    finally { if ('closeAllConnections' in server) server.closeAllConnections(); release(); }
  })();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
    void close().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
  });
  const address = server.address();
  console.log(`Cheese Agent → http://127.0.0.1:${typeof address === 'object' && address ? address.port : port}`);
  return { runtime, server, close };
}
