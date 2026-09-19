const element = id => document.getElementById(id);
const labels = { queued: '排队中', running: '运行中', stopping: '正在停止', completed: '已完成', failed: '执行失败', error: '失败', timeout: '已超时', cancelled: '已停止', interrupted: '已中断' };
const active = status => ['queued', 'running', 'stopping'].includes(status);
let sessionId = location.hash.slice(1);
let workspaceId = localStorage.getItem('cheese.workspace') || '';
let currentSession;
let currentRun;
let workspaceList = [];
let eventSource;
let streamingRun;
let events = new Map();
let submitting = false;
let refreshing = false;
let pendingRefresh = false;
let sessionLimit = 50;
let messagesSignature = '';
let detailsFocus;

const node = (tag, className, text) => {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
};
async function api(path, body) {
  const response = await fetch(`/api/v1${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `请求失败 (${response.status})`);
  return result;
}
function report(error) {
  element('error').textContent = error.message;
  element('error').hidden = false;
}
function connection(connected) {
  element('connection').classList.toggle('offline', !connected);
  element('connection').replaceChildren(node('span', 'status-dot'), document.createTextNode(connected ? '本机已连接' : '连接已断开 · 正在重连'));
  element('connection').title = connected ? '本机服务已连接' : '页面断线不会停止后台任务';
}
function draftKey() { return `cheese.draft.${sessionId || `home-${workspaceId}`}`; }
function restoreDraft() { element('prompt').value = sessionStorage.getItem(draftKey()) || ''; }
element('prompt').addEventListener('input', () => sessionStorage.setItem(draftKey(), element('prompt').value));
function navigate(id = '') {
  if (location.hash.slice(1) === id) changeRoute();
  else location.hash = id;
}
function changeRoute() {
  sessionId = location.hash.slice(1);
  currentSession = undefined; currentRun = undefined; messagesSignature = '';
  eventSource?.close(); eventSource = undefined; streamingRun = undefined; events.clear(); element('events').replaceChildren();
  element('error').hidden = true;
  document.body.classList.toggle('workbench', !!sessionId);
  element('hero').hidden = !!sessionId;
  element('home-bottom').hidden = !!sessionId;
  element('conversation').hidden = !sessionId;
  element('toggle-details').hidden = !sessionId;
  if (!sessionId) setDetails(false);
  if (matchMedia('(max-width:850px)').matches) setSidebar(false);
  restoreDraft(); renderControls(); refresh();
}
window.addEventListener('hashchange', changeRoute);

function renderControls() {
  const busy = active(currentRun?.status);
  const workspace = workspaceList.find(item => item.id === workspaceId);
  element('send').disabled = submitting || busy || !workspace?.available;
  element('send-label').textContent = submitting ? '提交中' : sessionId ? '发送消息' : '开始任务';
  element('stop').hidden = !busy;
  element('stop').disabled = currentRun?.status === 'stopping';
  element('stop').textContent = currentRun?.status === 'stopping' ? '正在停止…' : currentRun?.status === 'queued' ? '取消排队' : '停止任务';
  element('directory-label').textContent = workspace?.name || '请接入目录';
  element('directory-label').title = workspace?.path || '';
  const model = currentSession?.config?.values.model;
  element('model-label').replaceChildren(node('span', 'mini-core'), document.createTextNode(model ? (model.provider === 'mock' ? '离线模拟模型' : model.name) : '目录配置 · 新会话'));
  element('run-status').textContent = currentRun ? labels[currentRun.status] || currentRun.status : '准备好开始了';
  element('live').hidden = !busy || !element('live-text').textContent;
}

function messageText(message) {
  return typeof message.content === 'string' ? message.content : message.content.filter(part => part.type === 'text').map(part => part.text).join('');
}
function renderMessages(session) {
  const signature = JSON.stringify(session.messages);
  if (signature === messagesSignature) return;
  messagesSignature = signature;
  element('messages').replaceChildren(...session.messages.filter(message => ['user', 'assistant'].includes(message.role) && messageText(message)).map(message => {
    const article = node('article', `message ${message.role}`);
    const author = node('div', 'message-author', message.role === 'user' ? 'YOU / 你' : 'CHEESE');
    if (message.role === 'assistant') author.prepend(node('span', 'mini-core'));
    article.append(author, node('div', 'message-content', messageText(message)));
    return article;
  }));
}
function renderEvents() {
  const all = [...events.values()].sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.sequence - right.sequence);
  const current = all.filter(event => event.runId === currentRun?.id);
  const attempts = new Map();
  current.filter(event => !event.childRunId && ['text', 'retry'].includes(event.type)).forEach(event => attempts.set(event.step, Math.max(attempts.get(event.step) || 0, Number(event.attempt || 1) + (event.type === 'retry' ? 1 : 0))));
  element('live-text').textContent = current.filter(event => !event.childRunId && event.type === 'text' && Number(event.attempt || 1) === attempts.get(event.step)).map(event => event.text).join('');
  const details = all.filter(event => event.type !== 'text');
  for (const event of details) {
    if (element('events').querySelector(`[data-event="${event.id}"]`)) continue;
    const detail = node('details', 'event'); detail.dataset.event = event.id;
    const title = event.type === 'child-status' ? `子 Agent · ${labels[event.status] || event.status}` : event.type === 'status' ? labels[event.status] || event.status : event.name ? `${event.name} · ${event.type === 'tool-start' ? '开始执行' : event.type === 'tool-error' ? '失败' : '执行结果'}` : event.type === 'retry' ? `正在重试 · 第 ${event.attempt} 次` : event.type;
    detail.append(node('summary', '', title), node('small', '', `${new Date(event.timestamp).toLocaleTimeString()} · ${event.runId.slice(0, 6)}${event.childRunId ? ` / ${String(event.childRunId).slice(0, 6)}` : ''}`));
    const visible = { ...event }; delete visible.id; delete visible.workspaceId; delete visible.sessionId; delete visible.runId;
    detail.append(node('pre', '', JSON.stringify(visible, null, 2)));
    element('events').append(detail);
  }
  renderControls();
}
function connectEvents(run, snapshot) {
  if (streamingRun !== run?.id) {
    eventSource?.close(); eventSource = undefined; streamingRun = run?.id; events.clear(); element('events').replaceChildren();
  }
  for (const event of snapshot) events.set(event.id, event);
  renderEvents();
  if (!run || !active(run.status)) { eventSource?.close(); eventSource = undefined; return; }
  if (eventSource) return;
  const id = run.id;
  const after = Math.max(0, ...[...events.values()].filter(event => event.runId === id).map(event => event.sequence));
  eventSource = new EventSource(`/api/v1/runs/${id}/events?after=${after}`);
  eventSource.onopen = () => connection(true);
  eventSource.onerror = () => connection(false);
  eventSource.onmessage = message => {
    if (streamingRun !== id) return;
    const event = JSON.parse(message.data);
    events.set(event.id, event);
    if (event.type === 'status' && currentRun?.id === id) {
      currentRun.status = event.status;
      if (!active(event.status)) { eventSource?.close(); eventSource = undefined; refresh(); }
    }
    renderEvents();
  };
}

async function refresh() {
  if (refreshing) { pendingRefresh = true; return; }
  refreshing = true;
  const requestedSession = sessionId;
  const requestedWorkspace = workspaceId;
  try {
    const [workspaces, status, session] = await Promise.all([api('/workspaces'), api('/status'), requestedSession ? api(`/sessions/${requestedSession}`) : undefined]);
    if (sessionId !== requestedSession || workspaceId !== requestedWorkspace) return;
    workspaceList = workspaces;
    if (session) workspaceId = session.workspaceId;
    if (!workspaces.some(workspace => workspace.id === workspaceId)) workspaceId = workspaces[0]?.id || '';
    localStorage.setItem('cheese.workspace', workspaceId);
    element('workspaces').replaceChildren(...workspaces.map(workspace => new Option(`${workspace.name}${workspace.available ? '' : ' · 不可用'}`, workspace.id, false, workspace.id === workspaceId)));
    element('workspaces').title = workspaces.find(workspace => workspace.id === workspaceId)?.path || '';
    currentSession = session; currentRun = session?.runs.at(-1);
    element('breadcrumb').textContent = session ? session.title : '总览';
    if (session) {
      element('session-title').textContent = session.title;
      element('session-meta').textContent = `${workspaces.find(workspace => workspace.id === workspaceId)?.path || ''} · ${session.config?.values.model.name || 'Agent'}`;
      renderMessages(session); connectEvents(currentRun, session.events || []);
      if (currentRun?.error) report(new Error(currentRun.error));
    }
    const sessions = workspaceId ? (await Promise.all(Array.from({ length: Math.ceil(sessionLimit / 50) }, (_, page) => api(`/sessions?workspaceId=${workspaceId}&limit=50&offset=${page * 50}`)))).flat() : [];
    if (sessionId !== requestedSession) return;
    element('sessions').replaceChildren(...sessions.map(item => {
      const button = node('button', item.id === sessionId ? 'selected' : '');
      button.append(node('span', 'session-symbol', '◌'), node('span', 'session-name', item.title));
      if (active(item.run?.status)) button.append(node('span', 'session-state', labels[item.run.status]));
      button.title = item.title; button.onclick = () => navigate(item.id);
      return button;
    }));
    if (!sessions.length) element('sessions').append(node('p', 'empty-history', '还没有会话。\n从一个想法开始吧。'));
    element('load-more').hidden = sessions.length < sessionLimit;
    const others = sessions.filter(item => item.id !== sessionId && active(item.run?.status));
    const unavailable = !workspaces.find(workspace => workspace.id === workspaceId)?.available;
    element('notice').hidden = !others.length && !unavailable && !['interrupted', 'cancelled'].includes(currentRun?.status);
    element('notice').textContent = unavailable ? '目录不可用。你仍可查看历史；恢复目录或选择其他目录后再开始任务。' : others.length ? `此目录另有 ${others.length} 个待完成任务。会话共享实际文件，修改可能互相覆盖。` : '上次执行已停止或中断，已完成修改会保留。输入补充要求即可继续，不会自动重放旧工具操作。';
    const metric = (id, count, limit) => { element(id).replaceChildren(document.createTextNode(String(count)), ...(limit ? [node('span', '', `/ ${limit}`)] : [])); };
    metric('main-count', status.active, status.limit); metric('child-count', status.children.active, status.children.limit); metric('queued-count', status.queued);
    element('core-status').textContent = status.status === 'storage-error' ? 'STORAGE ERROR' : status.active ? `${status.active} TASKS ACTIVE` : 'SYSTEM READY';
    if (status.status === 'storage-error') report(new Error('执行记录无法保存，服务已停止接收任务。请检查磁盘后重启。'));
    document.body.dataset.active = String(status.active > 0);
    connection(true); renderControls();
  } catch (error) { connection(false); report(error); }
  finally { refreshing = false; if (pendingRefresh) { pendingRefresh = false; queueMicrotask(refresh); } }
}

element('composer').addEventListener('submit', async event => {
  event.preventDefault();
  const text = element('prompt').value.trim();
  if (!text || submitting || active(currentRun?.status)) return;
  submitting = true; renderControls(); element('error').hidden = true;
  const previousDraft = draftKey();
  try {
    if (!sessionId) {
      const session = await api('/sessions', { workspaceId });
      sessionId = session.id;
      history.replaceState(null, '', `#${sessionId}`);
      sessionStorage.setItem(draftKey(), text);
      changeRoute();
    }
    const pendingKey = `cheese.pending.${sessionId}`;
    const previous = JSON.parse(sessionStorage.getItem(pendingKey) || 'null');
    const request = previous?.text === text ? previous : { text, key: crypto.randomUUID() };
    sessionStorage.setItem(pendingKey, JSON.stringify(request));
    currentRun = await api(`/sessions/${sessionId}/runs`, request);
    sessionStorage.removeItem(pendingKey); sessionStorage.removeItem(previousDraft); sessionStorage.removeItem(draftKey());
    element('prompt').value = ''; await refresh();
  } catch (error) { report(error); }
  finally { submitting = false; renderControls(); }
});
element('prompt').addEventListener('keydown', event => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); element('composer').requestSubmit(); }
});
element('stop').onclick = async () => {
  if (!currentRun) return;
  try { currentRun = await api(`/runs/${currentRun.id}/stop`, {}); renderControls(); await refresh(); } catch (error) { report(error); }
};
element('new-task').onclick = () => { navigate(); element('prompt').focus(); };
element('workspaces').onchange = event => { workspaceId = event.target.value; sessionLimit = 50; navigate(); };
element('load-more').onclick = () => { sessionLimit += 50; refresh(); };
document.querySelectorAll('[data-prompt]').forEach(button => { button.onclick = () => { element('prompt').value = button.dataset.prompt; element('prompt').dispatchEvent(new Event('input')); element('prompt').focus(); }; });
let choosingDirectory = false;
element('add-workspace').onclick = () => {
  element('directory-error').textContent = '';
  element('directory-status').textContent = '';
  element('directory-manual').open = false;
  element('directory-dialog').showModal();
  element('pick-directory').focus();
};
element('close-directory').onclick = () => element('directory-dialog').close();
element('directory-dialog').addEventListener('close', () => element('add-workspace').focus());
element('directory-dialog').addEventListener('cancel', event => { if (choosingDirectory) event.preventDefault(); });
async function connectDirectory(path) {
  const workspace = await api('/workspaces', { path });
  workspaceId = workspace.id; sessionLimit = 50;
  element('directory-dialog').close(); navigate();
}
element('pick-directory').onclick = async () => {
  if (choosingDirectory) return;
  choosingDirectory = true;
  for (const id of ['pick-directory', 'connect-directory', 'close-directory']) element(id).disabled = true;
  element('directory-error').textContent = '';
  element('directory-status').textContent = '请在系统窗口中选择文件夹…';
  try {
    const { path } = await api('/workspaces/pick-directory', {});
    if (path) await connectDirectory(path);
    else element('directory-status').textContent = '已取消选择，可以重新选择文件夹。';
  } catch (error) {
    element('directory-status').textContent = '';
    element('directory-error').textContent = error.message;
    element('directory-manual').open = true;
    element('directory-path').focus();
  } finally {
    choosingDirectory = false;
    for (const id of ['pick-directory', 'connect-directory', 'close-directory']) element(id).disabled = false;
    if (element('directory-dialog').open && !element('directory-manual').open) element('pick-directory').focus();
  }
};
element('directory-form').onsubmit = async event => {
  event.preventDefault();
  if (choosingDirectory) return;
  try {
    await connectDirectory(element('directory-path').value.trim());
  } catch (error) { element('directory-error').textContent = error.message; }
};
function setSidebar(open) { document.body.classList.toggle('sidebar-collapsed', !open); element('toggle-sidebar').setAttribute('aria-expanded', String(open)); }
element('toggle-sidebar').onclick = () => setSidebar(document.body.classList.contains('sidebar-collapsed'));
function setDetails(open) {
  element('inspector').hidden = !open; document.body.classList.toggle('with-details', open); element('toggle-details').setAttribute('aria-expanded', String(open));
  if (open) { detailsFocus = document.activeElement; element('close-details').focus(); }
  else detailsFocus?.focus();
}
element('toggle-details').onclick = () => setDetails(element('inspector').hidden);
element('close-details').onclick = () => setDetails(false);
document.addEventListener('keydown', event => { if (event.key === 'Escape') { setDetails(false); if (matchMedia('(max-width:850px)').matches) { setSidebar(false); element('toggle-sidebar').focus(); } } });
if (matchMedia('(max-width:850px)').matches) setSidebar(false);
matchMedia('(max-width:850px)').addEventListener('change', event => setSidebar(!event.matches));
setInterval(refresh, 2000);
changeRoute();

const canvas = element('orb');
const context = canvas.getContext('2d');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const motionButton = node('button', 'text-button', '静态视觉');
motionButton.type = 'button';
let staticVisual = localStorage.getItem('cheese.staticVisual') === 'true';
motionButton.setAttribute('aria-pressed', String(staticVisual));
element('home-bottom').append(motionButton);
motionButton.onclick = () => {
  staticVisual = !staticVisual;
  localStorage.setItem('cheese.staticVisual', String(staticVisual));
  motionButton.setAttribute('aria-pressed', String(staticVisual));
  document.body.dataset.reduced = String(staticVisual);
  startOrb();
};
document.body.dataset.reduced = String(staticVisual);
const points = Array.from({ length: 740 }, (_, index) => {
  const vertical = 1 - 2 * index / 739;
  const radius = Math.sqrt(1 - vertical * vertical);
  const angle = index * Math.PI * (3 - Math.sqrt(5));
  return [Math.cos(angle) * radius, vertical, Math.sin(angle) * radius];
});
let frame;
function draw(time = 0) {
  if (document.hidden || sessionId) { frame = undefined; return; }
  const size = canvas.clientWidth;
  const ratio = Math.min(devicePixelRatio || 1, 2);
  if (canvas.width !== size * ratio) { canvas.width = size * ratio; canvas.height = size * ratio; }
  context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, size, size);
  const center = size / 2;
  const scale = size * .32;
  const rotation = reducedMotion.matches || staticVisual ? .6 : time * .00009;
  context.strokeStyle = '#3f674a55'; context.lineWidth = .6;
  context.beginPath(); context.ellipse(center, center, scale * 1.35, scale * .35, -.4, 0, Math.PI * 2); context.stroke();
  const transformed = points.map(([horizontal, vertical, depth]) => [horizontal * Math.cos(rotation) + depth * Math.sin(rotation), vertical, depth * Math.cos(rotation) - horizontal * Math.sin(rotation)]).sort((left, right) => left[2] - right[2]);
  for (const [horizontal, vertical, depth] of transformed) {
    const perspective = 2.6 / (2.6 - depth * .35);
    const alpha = .18 + (depth + 1) * .32;
    context.fillStyle = `rgba(190,238,188,${Math.min(1, alpha + (element('prompt').value || document.body.dataset.active === 'true' ? .15 : 0))})`;
    context.beginPath(); context.arc(center + horizontal * scale * perspective, center + vertical * scale * perspective, depth > .6 ? 1.5 : .8, 0, Math.PI * 2); context.fill();
  }
  const glow = context.createRadialGradient(center, center, 0, center, center, scale);
  glow.addColorStop(0, '#b4efaa0b'); glow.addColorStop(1, '#b4efaa00'); context.fillStyle = glow; context.fillRect(0, 0, size, size);
  context.fillStyle = '#668772'; context.font = '9px monospace'; context.fillText('N', center - 3, center - scale * 1.22);
  if (!reducedMotion.matches && !staticVisual) frame = requestAnimationFrame(draw); else frame = undefined;
}
function startOrb() { if (frame) cancelAnimationFrame(frame); draw(); }
document.addEventListener('visibilitychange', startOrb); window.addEventListener('hashchange', startOrb); window.addEventListener('resize', startOrb); reducedMotion.addEventListener('change', startOrb);
startOrb();
