const element = id => document.getElementById(id);
let workspaceId = '';
let sessionId = location.hash.slice(1);
let stream;
let streamingRun;
let streamEvents = new Map();
const stopButton = document.createElement('button'); stopButton.type = 'button'; stopButton.textContent = '停止任务'; stopButton.hidden = true;
element('composer').append(stopButton);
stopButton.onclick = async () => { try { await api(`/runs/${streamingRun}/stop`, {}); await refresh(); } catch (error) { report(error); } };
function renderEvents() {
  const events = [...streamEvents.values()].sort((left, right) => left.sequence - right.sequence);
  element('live').textContent = events.filter(event => event.type === 'text').map(event => event.text).join('');
  element('events').replaceChildren(...events.filter(event => event.type !== 'text').map(event => {
    const detail = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = `${event.name || event.type} · ${event.status || event.type}`;
    const content = document.createElement('pre'); content.textContent = JSON.stringify(event, null, 2);
    detail.append(summary, content); return detail;
  }));
}
async function api(path, body) {
  const response = await fetch(`/api/v1${path}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}
function report(error) { element('error').textContent = error.message; }
async function refresh() {
  const workspaces = await api('/workspaces');
  if (!workspaceId) workspaceId = workspaces[0]?.id || '';
  if (sessionId) {
    const session = await api(`/sessions/${sessionId}`);
    workspaceId = session.workspaceId;
    element('title').textContent = session.title;
    element('messages').replaceChildren(...session.messages.filter(message => ['user', 'assistant'].includes(message.role)).map(message => {
      const article = document.createElement('article');
      article.className = message.role;
      article.textContent = typeof message.content === 'string' ? message.content : message.content.filter(part => part.type === 'text').map(part => part.text).join('');
      return article;
    }));
    const run = session.runs.at(-1);
    if (run?.id !== streamingRun) {
      stream?.close(); streamingRun = run?.id;
      streamEvents = new Map((session.events || []).filter(event => event.runId === run?.id).map(event => [event.sequence, event]));
      if (run) {
        const after = Math.max(0, ...streamEvents.keys());
        stream = new EventSource(`/api/v1/runs/${run.id}/events?after=${after}`);
        stream.onmessage = message => { const event = JSON.parse(message.data); streamEvents.set(event.sequence, event); renderEvents(); };
      }
    }
    renderEvents();
    element('live').hidden = !run || !['running', 'stopping'].includes(run.status);
    element('send').disabled = run && ['running', 'queued', 'stopping'].includes(run.status);
    stopButton.hidden = !element('send').disabled;
    stopButton.disabled = run?.status === 'stopping';
    stopButton.textContent = run?.status === 'stopping' ? '正在停止…' : run?.status === 'queued' ? '取消排队' : '停止任务';
    element('connection').textContent = `${session.config?.values.model.name || 'Agent'} · ${run?.status || '就绪'}`;
    if (run?.error) element('error').textContent = run.error;
  } else {
    stopButton.hidden = true;
    stream?.close(); streamingRun = undefined; streamEvents.clear(); renderEvents();
    element('title').textContent = '有什么值得一起探索？';
    element('messages').replaceChildren();
    element('send').disabled = false;
  }
  element('workspaces').replaceChildren(...workspaces.map(workspace => new Option(`${workspace.path}${workspace.available ? '' : ' · 不可用'}`, workspace.id, false, workspace.id === workspaceId)));
  const sessions = workspaceId ? await api(`/sessions?workspaceId=${workspaceId}`) : [];
  const status = await api('/status');
  element('connection').title = `运行 ${status.active}/${status.limit} · 排队 ${status.queued}；同目录会话共享文件，可能覆盖彼此修改`;
  element('sessions').replaceChildren(...sessions.map(session => {
    const button = document.createElement('button');
    button.textContent = session.title;
    button.onclick = () => { location.hash = session.id; };
    return button;
  }));
}
element('composer').onsubmit = async event => {
  event.preventDefault();
  element('send').disabled = true;
  try {
    if (!sessionId) sessionId = (await api('/sessions', { workspaceId })).id;
    await api(`/sessions/${sessionId}/runs`, { text: element('prompt').value, key: crypto.randomUUID() });
    element('prompt').value = '';
    location.hash = sessionId;
    await refresh();
  } catch (error) { report(error); element('send').disabled = false; }
};
element('home').onclick = () => { location.hash = ''; };
element('workspaces').onchange = event => { workspaceId = event.target.value; sessionId = ''; location.hash = ''; refresh().catch(report); };
element('add').onclick = async () => {
  const path = prompt('输入已有本机文件夹的绝对路径');
  if (!path) return;
  try { workspaceId = (await api('/workspaces', { path })).id; location.hash = ''; sessionId = ''; await refresh(); } catch (error) { report(error); }
};
window.onhashchange = () => { sessionId = location.hash.slice(1); element('error').textContent = ''; refresh().catch(report); };
setInterval(() => refresh().catch(report), 1500);
refresh().catch(report);
