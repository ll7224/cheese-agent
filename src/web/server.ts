import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { Runtime, RuntimeError } from '../runtime/service.js';

export function createApp(runtime: Runtime) {
  const app = new Hono();
  app.use('/api/*', async (context, next) => {
    const origin = context.req.header('origin');
    const url = new URL(context.req.url);
    if (origin && origin !== url.origin) return context.json({ error: '不允许跨站请求' }, 403);
    if (!['GET', 'HEAD'].includes(context.req.method) && !context.req.header('content-type')?.includes('application/json')) return context.json({ error: '需要 JSON 请求' }, 415);
    await next();
  });
  app.onError((error, context) => context.json({ error: error.message }, error instanceof RuntimeError ? error.status as 400 : 500));
  app.get('/api/v1/status', context => context.json({ status: 'ready' }));
  app.get('/api/v1/workspaces', context => context.json(runtime.listWorkspaces()));
  app.post('/api/v1/workspaces', async context => context.json(runtime.addWorkspace((await context.req.json()).path), 201));
  app.get('/api/v1/sessions', context => context.json(runtime.state.sessions.filter(session => session.workspaceId === context.req.query('workspaceId')).map(({ messages, ...session }) => session)));
  app.post('/api/v1/sessions', async context => context.json(runtime.createSession((await context.req.json()).workspaceId), 201));
  app.get('/api/v1/sessions/:id', context => context.json({ ...runtime.session(context.req.param('id')), runs: runtime.state.runs.filter(run => run.sessionId === context.req.param('id')) }));
  app.post('/api/v1/sessions/:id/runs', async context => {
    const body = await context.req.json();
    return context.json(runtime.submit(context.req.param('id'), body.text, body.key), 202);
  });
  app.get('/app.js', context => context.body(readFileSync(new URL('../../web/app.js', import.meta.url), 'utf8'), 200, { 'Content-Type': 'text/javascript' }));
  app.get('/style.css', context => context.body(readFileSync(new URL('../../web/style.css', import.meta.url), 'utf8'), 200, { 'Content-Type': 'text/css' }));
  app.get('*', context => context.html(readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8')));
  return app;
}

export function startWeb() {
  const runtime = new Runtime(resolve(process.env.CHEESE_DATA_DIR || join(homedir(), '.cheese-agent')), undefined, { configDir: process.cwd() });
  runtime.addWorkspace(process.cwd());
  const port = Number(process.env.CHEESE_PORT || 3210);
  const server = serve({ fetch: createApp(runtime).fetch, hostname: '127.0.0.1', port }, info => console.log(`Cheese Agent → http://127.0.0.1:${info.port}`));
  server.on('error', error => { console.error(`Web 服务启动失败: ${error.message}`); process.exitCode = 1; });
  return { runtime, server };
}
