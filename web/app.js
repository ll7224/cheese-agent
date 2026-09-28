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

/* --- Lightweight Safe Markdown & Syntax Highlighter --- */
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, m => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[m]));
}

function highlightCode(code, lang) {
  let safe = escapeHtml(code);
  // Comments
  safe = safe.replace(/(\/\/[^\n]*|#[^\n]*)/g, '<span class="hl-comment">$1</span>');
  // Strings
  safe = safe.replace(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g, '<span class="hl-string">$1</span>');
  // Numbers
  safe = safe.replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="hl-number">$1</span>');
  // Common keywords
  const keywords = /\b(const|let|var|function|return|import|export|from|default|class|extends|if|else|switch|case|break|try|catch|finally|throw|new|typeof|instanceof|async|await|def|for|in|of|while|do|continue|type|interface|enum|public|private|protected|static|readonly|true|false|null|undefined|None|self)\b/g;
  safe = safe.replace(keywords, '<span class="hl-keyword">$1</span>');
  // Function calls
  safe = safe.replace(/\b([a-zA-Z_$][a-zA-Z0-9_$]*)(?=\s*\()/g, '<span class="hl-function">$1</span>');
  return safe;
}

function parseMarkdown(md) {
  if (!md) return '';
  const text = md.replace(/\r\n/g, '\n');
  const codeBlocks = [];
  const placeholder = '___CODEBLOCK_' + Math.random().toString(36).slice(2) + '___';

  const processed = text.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (match, lang, code) => {
    const idx = codeBlocks.length;
    const cleanLang = (lang || 'code').trim();
    const cleanCode = code.trimEnd();
    const highlighted = highlightCode(cleanCode, cleanLang);
    const blockHtml = `
      <div class="code-block-wrapper">
        <div class="code-header">
          <span class="code-lang">${escapeHtml(cleanLang)}</span>
          <button class="copy-button" type="button" data-code="${encodeURIComponent(cleanCode)}">复制</button>
        </div>
        <pre><code class="language-${escapeHtml(cleanLang)}">${highlighted}</code></pre>
      </div>`;
    codeBlocks.push(blockHtml);
    return `\n\n${placeholder}${idx}\n\n`;
  });

  const lines = processed.split('\n');
  const out = [];
  let inList = false;
  let listType = 'ul';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const blockMatch = line.trim().match(new RegExp(`^${placeholder}(\\d+)$`));
    if (blockMatch) {
      if (inList) { out.push(`</${listType}>`); inList = false; }
      out.push(codeBlocks[Number(blockMatch[1])]);
      continue;
    }

    if (/^(---|___|\*\*\*)$/.test(line.trim())) {
      if (inList) { out.push(`</${listType}>`); inList = false; }
      out.push('<hr>');
      continue;
    }

    const hMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (hMatch) {
      if (inList) { out.push(`</${listType}>`); inList = false; }
      const level = hMatch[1].length;
      out.push(`<h${level}>${formatInline(hMatch[2])}</h${level}>`);
      continue;
    }

    const bqMatch = line.match(/^>\s?(.*)$/);
    if (bqMatch) {
      if (inList) { out.push(`</${listType}>`); inList = false; }
      out.push(`<blockquote><p>${formatInline(bqMatch[1])}</p></blockquote>`);
      continue;
    }

    const ulMatch = line.match(/^[\*\-]\s+(.+)$/);
    if (ulMatch) {
      if (!inList || listType !== 'ul') {
        if (inList) out.push(`</${listType}>`);
        out.push('<ul>');
        inList = true;
        listType = 'ul';
      }
      out.push(`<li>${formatInline(ulMatch[1])}</li>`);
      continue;
    }

    const olMatch = line.match(/^\d+\.\s+(.+)$/);
    if (olMatch) {
      if (!inList || listType !== 'ol') {
        if (inList) out.push(`</${listType}>`);
        out.push('<ol>');
        inList = true;
        listType = 'ol';
      }
      out.push(`<li>${formatInline(olMatch[1])}</li>`);
      continue;
    }

    if (inList) {
      out.push(`</${listType}>`);
      inList = false;
    }

    if (!line.trim()) continue;
    out.push(`<p>${formatInline(line)}</p>`);
  }

  if (inList) out.push(`</${listType}>`);
  return out.join('\n');
}

function formatInline(str) {
  let s = escapeHtml(str);
  s = s.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  s = s.replace(/_([^_]+)_/g, '<em>$1</em>');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return s;
}

// Global one-click code copy handler
document.addEventListener('click', event => {
  const btn = event.target.closest('.copy-button');
  if (!btn) return;
  const raw = decodeURIComponent(btn.dataset.code || '');
  if (!raw) return;
  navigator.clipboard.writeText(raw).then(() => {
    btn.textContent = '已复制 ✓';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = '复制';
      btn.classList.remove('copied');
    }, 1800);
  }).catch(() => {
    btn.textContent = '复制失败';
  });
});

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
  element('connection').replaceChildren(node('span', 'status-dot'), document.createTextNode(connected ? '本机已连接' : '连接已断开 · 重连中'));
  element('connection').title = connected ? '本机服务已连接' : '断线不会停止后台运行的任务';
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
    const author = node('div', 'message-author');
    if (message.role === 'user') {
      author.textContent = 'YOU / 用户';
    } else {
      author.append(node('span', 'assistant-avatar', '🧀'), document.createTextNode(' CHEESE'));
    }
    const content = node('div', `message-content ${message.role === 'assistant' ? 'markdown-body' : ''}`);
    if (message.role === 'assistant') {
      content.innerHTML = parseMarkdown(messageText(message));
    } else {
      content.textContent = messageText(message);
    }
    article.append(author, content);
    return article;
  }));
}

/* Tool icon and summary mapping */
function toolIcon(name) {
  if (!name) return '⚙️';
  const n = String(name).toLowerCase();
  if (n.includes('bash') || n.includes('shell') || n.includes('exec') || n.includes('cmd')) return '⚡';
  if (n.includes('file') || n.includes('read') || n.includes('write') || n.includes('edit')) return '📄';
  if (n.includes('search') || n.includes('find') || n.includes('grep')) return '🔍';
  if (n.includes('subagent') || n.includes('spawn') || n.includes('agent')) return '🤖';
  if (n.includes('git')) return '🌿';
  return '🔧';
}

function formatToolBrief(event) {
  if (event.input) {
    if (event.input.command) return event.input.command;
    if (event.input.path || event.input.file_path) return event.input.path || event.input.file_path;
    if (event.input.query) return event.input.query;
  }
  return '';
}

function renderEvents() {
  const all = [...events.values()].sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.sequence - right.sequence);
  const current = all.filter(event => event.runId === currentRun?.id);
  const attempts = new Map();
  current.filter(event => !event.childRunId && ['text', 'retry'].includes(event.type)).forEach(event => attempts.set(event.step, Math.max(attempts.get(event.step) || 0, Number(event.attempt || 1) + (event.type === 'retry' ? 1 : 0))));
  const liveRaw = current.filter(event => !event.childRunId && event.type === 'text' && Number(event.attempt || 1) === attempts.get(event.step)).map(event => event.text).join('');
  element('live-text').innerHTML = parseMarkdown(liveRaw);

  const details = all.filter(event => event.type !== 'text');
  for (const event of details) {
    if (element('events').querySelector(`[data-event="${event.id}"]`)) continue;
    const detail = node('details', 'tool-card event');
    detail.dataset.event = event.id;

    const summary = node('summary', 'tool-summary');
    const isError = event.type === 'tool-error' || event.status === 'failed' || event.status === 'error';
    const icon = node('span', 'tool-icon', toolIcon(event.name || event.type));
    const name = node('span', 'tool-name', event.name || event.type);
    const brief = node('span', 'tool-brief', formatToolBrief(event));
    const statusText = event.type === 'tool-start' ? '执行中…' :
      event.type === 'tool-error' ? '失败' :
      event.type === 'tool-result' ? '已完成' :
      event.type === 'child-status' ? `子任务 ${labels[event.status] || event.status}` :
      event.type === 'retry' ? `重试 #${event.attempt}` :
      labels[event.status] || event.status || '事件';
    const statusTag = node('span', `tool-status-tag ${isError ? 'error' : ''}`, statusText);

    summary.append(icon, name, brief, statusTag);
    const timeStr = new Date(event.timestamp).toLocaleTimeString();
    const meta = node('div', 'tool-meta', `${timeStr} · 运行 ID: ${event.runId.slice(0, 6)}${event.childRunId ? ` / 子任务: ${String(event.childRunId).slice(0, 6)}` : ''}`);

    const body = node('div', 'tool-details-body');
    const visible = { ...event };
    delete visible.id; delete visible.workspaceId; delete visible.sessionId; delete visible.runId;
    body.append(node('pre', '', JSON.stringify(visible, null, 2)));

    detail.append(summary, meta, body);
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
      button.append(node('span', 'session-symbol', '●'), node('span', 'session-name', item.title));
      if (active(item.run?.status)) button.append(node('span', 'session-state', labels[item.run.status]));
      button.title = item.title; button.onclick = () => navigate(item.id);
      return button;
    }));
    if (!sessions.length) element('sessions').append(node('p', 'empty-history', '还没有会话。\n从一个任务开始吧。'));
    element('load-more').hidden = sessions.length < sessionLimit;
    const others = sessions.filter(item => item.id !== sessionId && active(item.run?.status));
    const unavailable = !workspaces.find(workspace => workspace.id === workspaceId)?.available;
    element('notice').hidden = !others.length && !unavailable && !['interrupted', 'cancelled'].includes(currentRun?.status);
    element('notice').textContent = unavailable ? '目录不可用。你仍可查看历史；恢复目录或选择其他目录后再开始任务。' : others.length ? `此目录另有 ${others.length} 个待完成任务。会话共享实际文件，修改可能互相覆盖。` : '上次执行已停止或中断，已完成修改会保留。输入补充要求即可继续，不会自动重放旧工具操作。';
    const metric = (id, count, limit) => { element(id).replaceChildren(document.createTextNode(String(count)), ...(limit ? [node('span', '', `/ ${limit}`)] : [])); };
    metric('main-count', status.active, status.limit); metric('child-count', status.children.active, status.children.limit); metric('queued-count', status.queued);
    element('core-status').textContent = status.status === 'storage-error' ? 'STORAGE ERROR' : status.active ? `${status.active} 运行中` : 'SYSTEM READY';
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
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    element('composer').requestSubmit();
  }
});

element('stop').onclick = async () => {
  if (!currentRun) return;
  try { currentRun = await api(`/runs/${currentRun.id}/stop`, {}); renderControls(); await refresh(); } catch (error) { report(error); }
};

element('new-task').onclick = () => { navigate(); element('prompt').focus(); };
element('workspaces').onchange = event => { workspaceId = event.target.value; sessionLimit = 50; navigate(); };
element('load-more').onclick = () => { sessionLimit += 50; refresh(); };

document.querySelectorAll('[data-prompt]').forEach(button => {
  button.onclick = () => {
    element('prompt').value = button.dataset.prompt;
    element('prompt').dispatchEvent(new Event('input'));
    element('prompt').focus();
  };
});

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

function setSidebar(open) {
  document.body.classList.toggle('sidebar-collapsed', !open);
  element('toggle-sidebar').setAttribute('aria-expanded', String(open));
}
element('toggle-sidebar').onclick = () => setSidebar(document.body.classList.contains('sidebar-collapsed'));

function setDetails(open) {
  element('inspector').hidden = !open;
  document.body.classList.toggle('with-details', open);
  element('toggle-details').setAttribute('aria-expanded', String(open));
  if (open) { detailsFocus = document.activeElement; element('close-details').focus(); }
  else detailsFocus?.focus();
}
element('toggle-details').onclick = () => setDetails(element('inspector').hidden);
element('close-details').onclick = () => setDetails(false);

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    setDetails(false);
    if (matchMedia('(max-width:850px)').matches) {
      setSidebar(false);
      element('toggle-sidebar').focus();
    }
  }
});
if (matchMedia('(max-width:850px)').matches) setSidebar(false);
matchMedia('(max-width:850px)').addEventListener('change', event => setSidebar(!event.matches));
/* --- Theme Management (Impeccable Kinpaku Light & Instrument Dark) --- */
const themeToggle = element('theme-toggle');
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('cheese.theme', theme);
  if (themeToggle) {
    const isDark = theme === 'dark';
    const icon = themeToggle.querySelector('.theme-icon');
    const text = themeToggle.querySelector('.theme-text');
    if (icon) icon.textContent = isDark ? '🌙' : '☀️';
    if (text) text.textContent = isDark ? '仪器暗色' : '和纸白';
    themeToggle.setAttribute('aria-label', isDark ? '切换至和纸白主题' : '切换至仪器暗色主题');
    themeToggle.setAttribute('title', isDark ? '切换至和纸白主题' : '切换至仪器暗色主题');
  }
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) metaTheme.content = theme === 'dark' ? '#141518' : '#f8f8fa';
}

const savedTheme = localStorage.getItem('cheese.theme') || 'light';
applyTheme(savedTheme);

if (themeToggle) {
  themeToggle.onclick = () => {
    const current = document.documentElement.dataset.theme;
    applyTheme(current === 'dark' ? 'light' : 'dark');
    if (typeof startOrb === 'function') startOrb();
  };
}

setInterval(refresh, 2000);
changeRoute();

/* Compact Radar Core Animation */
const canvas = element('orb');
if (canvas) {
  const context = canvas.getContext('2d');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const points = Array.from({ length: 320 }, (_, index) => {
    const vertical = 1 - 2 * index / 319;
    const radius = Math.sqrt(1 - vertical * vertical);
    const angle = index * Math.PI * (3 - Math.sqrt(5));
    return [Math.cos(angle) * radius, vertical, Math.sin(angle) * radius];
  });
  let frame;

  function draw(time = 0) {
    if (document.hidden || sessionId) { frame = undefined; return; }
    const size = canvas.clientWidth || 110;
    const ratio = Math.min(devicePixelRatio || 1, 2);
    if (canvas.width !== size * ratio) {
      canvas.width = size * ratio;
      canvas.height = size * ratio;
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, size, size);
    const center = size / 2;
    const scale = size * 0.36;
    const rotation = reducedMotion.matches ? 0.6 : time * 0.0001;
    const isDark = document.documentElement.dataset.theme === 'dark';

    context.strokeStyle = isDark ? 'rgba(242, 180, 59, 0.25)' : 'rgba(194, 125, 5, 0.3)';
    context.lineWidth = 0.8;
    context.beginPath();
    context.ellipse(center, center, scale * 1.25, scale * 0.4, -0.4, 0, Math.PI * 2);
    context.stroke();

    const transformed = points.map(([h, v, d]) => [
      h * Math.cos(rotation) + d * Math.sin(rotation),
      v,
      d * Math.cos(rotation) - h * Math.sin(rotation)
    ]).sort((a, b) => a[2] - b[2]);

    for (const [h, v, d] of transformed) {
      const perspective = 2.4 / (2.4 - d * 0.3);
      const alpha = 0.2 + (d + 1) * 0.35;
      context.fillStyle = isDark
        ? `rgba(242, 180, 59, ${Math.min(0.92, alpha)})`
        : `rgba(184, 116, 5, ${Math.min(0.92, alpha)})`;
      context.beginPath();
      context.arc(center + h * scale * perspective, center + v * scale * perspective, d > 0.5 ? 1.2 : 0.7, 0, Math.PI * 2);
      context.fill();
    }

    if (!reducedMotion.matches) frame = requestAnimationFrame(draw);
    else frame = undefined;
  }

  function startOrb() {
    if (frame) cancelAnimationFrame(frame);
    draw();
  }

  document.addEventListener('visibilitychange', startOrb);
  window.addEventListener('hashchange', startOrb);
  window.addEventListener('resize', startOrb);
  reducedMotion.addEventListener('change', startOrb);
  startOrb();
}
