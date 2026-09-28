const element = id => document.getElementById(id);
const labels = { queued: '排队中', running: '运行中', stopping: '正在停止', completed: '已完成', failed: '执行失败', error: '失败', timeout: '已超时', cancelled: '已停止', interrupted: '已中断' };
const active = status => ['queued', 'running', 'stopping'].includes(status);
let sessionId = location.hash.slice(1);
let workspaceId = localStorage.getItem('cheese.workspace') || '';
let currentSession;
let currentRun;
let workspaceList = [];
let expandedWorkspaces = new Set();
let eventSource;
let streamingRun;
let events = new Map();
let submitting = false;
let refreshing = false;
let pendingRefresh = false;
let sessionLimit = 50;
let messagesSignature = '';
let detailsFocus;
let modelsList = [];
let presetsList = {};
let selectedModelId = localStorage.getItem('cheese.selectedModel') || '';
let activeModelName = localStorage.getItem('cheese.activeModelName') || '';
let editingModelId = null;
let availableModelsForForm = [];
let enabledModelsForForm = new Set();

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

function updateModelCapsuleDisplay() {
  const modelNameEl = element('current-model-name');
  if (!modelNameEl) return;
  if (currentSession) {
    const sessionModel = currentSession.config?.values.model;
    const displayName = sessionModel?.name || 'Agent';
    modelNameEl.textContent = displayName;
    element('model-label').title = `当前会话模型: ${displayName} (${sessionModel?.provider || 'default'})`;
  } else {
    const activeConfig = modelsList.find(m => m.id === selectedModelId) || modelsList.find(m => m.isDefault) || modelsList[0];
    if (activeConfig) {
      const displayName = activeModelName || activeConfig.name || activeConfig.label;
      modelNameEl.textContent = displayName;
      element('model-label').title = `新建任务模型: ${displayName} (${activeConfig.label || activeConfig.provider}) · 点击切换`;
    } else {
      modelNameEl.textContent = '系统默认';
      element('model-label').title = '使用系统默认或项目配置文件中的模型';
    }
  }
}

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
  updateModelCapsuleDisplay();
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
    const [workspaces, status, session] = await Promise.all([
      api('/workspaces'),
      api('/status'),
      requestedSession ? api(`/sessions/${requestedSession}`) : undefined
    ]);
    if (sessionId !== requestedSession || workspaceId !== requestedWorkspace) return;
    workspaceList = workspaces;
    if (session) workspaceId = session.workspaceId;
    if (!workspaces.some(workspace => workspace.id === workspaceId)) workspaceId = workspaces[0]?.id || '';
    if (workspaceId) expandedWorkspaces.add(workspaceId);
    localStorage.setItem('cheese.workspace', workspaceId);

    currentSession = session;
    currentRun = session?.runs.at(-1);
    element('breadcrumb').textContent = session ? session.title : '总览';
    if (session) {
      element('session-title').textContent = session.title;
      element('session-meta').textContent = `${workspaces.find(workspace => workspace.id === workspaceId)?.path || ''} · ${session.config?.values.model.name || 'Agent'}`;
      renderMessages(session);
      connectEvents(currentRun, session.events || []);
      if (currentRun?.error) report(new Error(currentRun.error));
    }

    // Fetch sessions for all expanded workspaces in parallel
    const expandedList = workspaces.filter(w => expandedWorkspaces.has(w.id));
    const sessionsMap = new Map();
    await Promise.all(expandedList.map(async w => {
      try {
        const list = await api(`/sessions?workspaceId=${w.id}&limit=50&offset=0`);
        sessionsMap.set(w.id, list);
      } catch {
        sessionsMap.set(w.id, []);
      }
    }));

    if (sessionId !== requestedSession) return;

    const shortenPath = p => (p ? p.replace(/^\/Users\/[^\/]+/, '~') : '');

    element('workspaces').replaceChildren(...workspaces.map(workspace => {
      const isSelected = workspace.id === workspaceId;
      const isExpanded = expandedWorkspaces.has(workspace.id);
      const group = node('div', `workspace-group ${isSelected ? 'active' : ''} ${isExpanded ? 'expanded' : ''}`);

      const header = node('button', 'workspace-header');
      header.type = 'button';
      header.title = workspace.available
        ? `${workspace.name} · 点击在此项目发起新任务`
        : `${workspace.name} (${workspace.path}) · 目录不可用`;

      const chevron = node('span', 'ws-chevron', '›');
      chevron.title = isExpanded ? '收起会话' : '展开会话';
      chevron.onclick = (e) => {
        e.stopPropagation();
        if (expandedWorkspaces.has(workspace.id)) {
          expandedWorkspaces.delete(workspace.id);
        } else {
          expandedWorkspaces.add(workspace.id);
        }
        refresh();
      };

      const meta = node('div', 'ws-meta');
      meta.append(
        node('span', 'ws-name', workspace.name),
        node('span', 'ws-path', shortenPath(workspace.path))
      );

      const count = workspace.sessionCount !== undefined ? workspace.sessionCount : (sessionsMap.get(workspace.id)?.length || 0);
      const badge = node('span', 'ws-badge', workspace.available ? `${count}` : '不可用');
      badge.title = `${count} 个会话`;

      header.append(chevron, meta, badge);

      header.onclick = () => {
        workspaceId = workspace.id;
        expandedWorkspaces.add(workspace.id);
        localStorage.setItem('cheese.workspace', workspaceId);
        navigate();
        element('prompt').focus();
      };

      group.append(header);

      if (isExpanded) {
        const sessionsContainer = node('div', 'workspace-sessions');
        const wsSessions = sessionsMap.get(workspace.id) || [];
        if (wsSessions.length) {
          for (const item of wsSessions) {
            const isCurrent = item.id === sessionId;
            const isRunning = active(item.run?.status);
            const sessionBtn = node('button', `session-item ${isCurrent ? 'selected' : ''} ${isRunning ? 'active-run' : ''}`);
            sessionBtn.type = 'button';
            sessionBtn.title = item.title;

            const dot = node('span', 'session-dot');
            const title = node('span', 'session-title', item.title);
            sessionBtn.append(dot, title);

            if (isRunning) {
              sessionBtn.append(node('span', 'session-state', labels[item.run.status]));
            }

            sessionBtn.onclick = (e) => {
              e.stopPropagation();
              workspaceId = workspace.id;
              localStorage.setItem('cheese.workspace', workspaceId);
              navigate(item.id);
            };

            sessionsContainer.append(sessionBtn);
          }
        } else {
          sessionsContainer.append(node('div', 'empty-ws-sessions', '暂无历史会话'));
        }

        group.append(sessionsContainer);
      }

      return group;
    }));

    const currentWsSessions = sessionsMap.get(workspaceId) || [];
    const others = currentWsSessions.filter(item => item.id !== sessionId && active(item.run?.status));
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
      const sessionPayload = { workspaceId };
      if (selectedModelId) {
        sessionPayload.modelId = activeModelName ? `${selectedModelId}:${activeModelName}` : selectedModelId;
      }
      const session = await api('/sessions', sessionPayload);
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

document.querySelectorAll('[data-prompt]').forEach(button => {
  button.onclick = () => {
    element('prompt').value = button.dataset.prompt;
    element('prompt').dispatchEvent(new Event('input'));
    element('prompt').focus();
  };
});

let choosingDirectory = false;
async function connectDirectory(path) {
  const workspace = await api('/workspaces', { path });
  workspaceId = workspace.id; sessionLimit = 50;
  if (element('directory-dialog').open) element('directory-dialog').close();
  navigate();
}

async function pickFolderDirectly() {
  if (choosingDirectory) return;
  choosingDirectory = true;
  const addBtn = element('add-workspace');
  const prevText = addBtn ? addBtn.textContent : '';
  if (addBtn) { addBtn.disabled = true; addBtn.textContent = '选择中…'; }
  for (const id of ['pick-directory', 'connect-directory', 'close-directory']) {
    const el = element(id); if (el) el.disabled = true;
  }
  element('directory-error').textContent = '';
  element('directory-status').textContent = '请在系统窗口中选择文件夹…';

  try {
    const { path } = await api('/workspaces/pick-directory', {});
    if (path) {
      await connectDirectory(path);
    } else {
      element('directory-status').textContent = '已取消选择文件夹。';
    }
  } catch (error) {
    element('directory-status').textContent = '';
    element('directory-error').textContent = error.message;
    element('directory-manual').open = true;
    element('directory-dialog').showModal();
    element('directory-path').focus();
  } finally {
    choosingDirectory = false;
    if (addBtn) { addBtn.disabled = false; addBtn.textContent = prevText; }
    for (const id of ['pick-directory', 'connect-directory', 'close-directory']) {
      const el = element(id); if (el) el.disabled = false;
    }
  }
}

element('add-workspace').onclick = pickFolderDirectly;
element('pick-directory').onclick = pickFolderDirectly;
element('close-directory').onclick = () => element('directory-dialog').close();
element('directory-dialog').addEventListener('close', () => element('add-workspace').focus());
element('directory-dialog').addEventListener('cancel', event => { if (choosingDirectory) event.preventDefault(); });

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

/* --- LLM & API Key Configuration Management --- */

async function loadModels() {
  try {
    const [models, presets] = await Promise.all([
      api('/models'),
      api('/models/presets')
    ]);
    modelsList = Array.isArray(models) ? models : [];
    presetsList = presets || {};

    const def = modelsList.find(m => m.isDefault);
    if (!modelsList.some(m => m.id === selectedModelId)) {
      selectedModelId = def ? def.id : (modelsList[0]?.id || '');
      if (selectedModelId) localStorage.setItem('cheese.selectedModel', selectedModelId);
    }

    const activeConfig = modelsList.find(m => m.id === selectedModelId);
    if (activeConfig) {
      const enabled = (activeConfig.models && activeConfig.models.length > 0)
        ? activeConfig.models
        : (activeConfig.name ? [activeConfig.name] : []);
      if (!activeModelName || !enabled.includes(activeModelName)) {
        activeModelName = enabled.includes(activeConfig.name) ? activeConfig.name : (enabled[0] || '');
        if (activeModelName) localStorage.setItem('cheese.activeModelName', activeModelName);
      }
    }

    renderModelPicker();
    renderModelDialogList();
    renderControls();
  } catch (err) {
    console.warn('Failed to load models:', err);
  }
}

function renderModelPicker() {
  const listEl = element('model-popover-list');
  const badgeEl = element('popover-config-badge');
  const configRowEl = element('popover-config-row');
  const configSelectEl = element('popover-config-select');
  if (!listEl) return;
  listEl.replaceChildren();

  if (modelsList.length === 0) {
    if (badgeEl) badgeEl.textContent = '未配置';
    if (configRowEl) configRowEl.hidden = true;
    listEl.append(node('div', 'empty-ws-sessions', '尚未配置模型，请点击下方管理模型配置。'));
    return;
  }

  // Find active API configuration
  let activeConfig = modelsList.find(m => m.id === selectedModelId);
  if (!activeConfig) {
    activeConfig = modelsList.find(m => m.isDefault) || modelsList[0];
    selectedModelId = activeConfig.id;
    localStorage.setItem('cheese.selectedModel', selectedModelId);
  }

  if (badgeEl) {
    badgeEl.textContent = activeConfig.label || activeConfig.name;
    badgeEl.title = `供应商: ${activeConfig.provider} · BaseURL: ${activeConfig.baseURL}`;
  }

  // Render API config switcher if there is more than 1 config
  if (configRowEl && configSelectEl) {
    if (modelsList.length > 1) {
      configRowEl.hidden = false;
      configSelectEl.replaceChildren();
      for (const m of modelsList) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = `${m.label || m.name} (${m.provider})`;
        if (m.id === activeConfig.id) opt.selected = true;
        configSelectEl.append(opt);
      }
      configSelectEl.onchange = () => {
        selectedModelId = configSelectEl.value;
        localStorage.setItem('cheese.selectedModel', selectedModelId);
        const newConfig = modelsList.find(m => m.id === selectedModelId);
        if (newConfig) {
          const newModels = (newConfig.models && newConfig.models.length > 0) ? newConfig.models : [newConfig.name];
          activeModelName = newModels[0] || newConfig.name;
          localStorage.setItem('cheese.activeModelName', activeModelName);
        }
        renderModelPicker();
        renderControls();
      };
    } else {
      configRowEl.hidden = true;
    }
  }

  // Get enabled models for the active configuration
  const enabledModels = (activeConfig.models && activeConfig.models.length > 0)
    ? activeConfig.models
    : (activeConfig.name ? [activeConfig.name] : []);

  if (enabledModels.length === 0) {
    listEl.append(node('div', 'empty-ws-sessions', '此配置未勾选启用任何模型，请在配置页面勾选。'));
    return;
  }

  if (!activeModelName || !enabledModels.includes(activeModelName)) {
    activeModelName = enabledModels.includes(activeConfig.name) ? activeConfig.name : enabledModels[0];
    localStorage.setItem('cheese.activeModelName', activeModelName);
  }

  // Render each enabled model under the active API configuration
  for (const modelName of enabledModels) {
    const isCurrentActive = modelName === activeModelName;
    const isPrimary = modelName === activeConfig.name;

    const item = node('button', `popover-item ${isCurrentActive ? 'active' : ''}`);
    item.type = 'button';

    const labelSpan = node('span', 'popover-item-label', modelName);
    item.append(labelSpan);

    if (isCurrentActive) {
      item.append(node('span', 'popover-item-tag', '✓ 当前'));
    } else if (isPrimary) {
      item.append(node('span', 'popover-item-tag', '主'));
    }

    item.onclick = () => {
      activeModelName = modelName;
      localStorage.setItem('cheese.activeModelName', activeModelName);
      closeModelPopover();
      renderControls();
    };

    listEl.append(item);
  }
}

function toggleModelPopover() {
  const popover = element('model-popover');
  const btn = element('model-label');
  if (!popover || !btn) return;
  const willOpen = popover.hidden;
  popover.hidden = !willOpen;
  btn.setAttribute('aria-expanded', String(willOpen));
  if (willOpen) renderModelPicker();
}

function closeModelPopover() {
  const popover = element('model-popover');
  const btn = element('model-label');
  if (popover) popover.hidden = true;
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

document.addEventListener('click', event => {
  const wrapper = event.target.closest('.model-picker-wrapper');
  if (!wrapper) closeModelPopover();
});

function openModelDialog(modelToEditId) {
  closeModelPopover();
  const dialog = element('model-dialog');
  if (!dialog) return;
  dialog.showModal();
  renderModelDialogList();
  if (modelToEditId) {
    selectModelForEditing(modelToEditId);
  } else {
    resetModelForm(element('model-provider-select')?.value || 'deepseek');
  }
}

function closeModelDialog() {
  const dialog = element('model-dialog');
  if (dialog && dialog.open) dialog.close();
}

function renderModelDialogList() {
  const listEl = element('configured-models-list');
  if (!listEl) return;
  listEl.replaceChildren();

  if (modelsList.length === 0) {
    listEl.append(node('div', 'empty-ws-sessions', '暂无已配置模型，请在右侧表单添加。'));
    return;
  }

  for (const m of modelsList) {
    const card = node('button', `model-card-item ${editingModelId === m.id ? 'selected' : ''}`);
    card.type = 'button';

    const topRow = node('div', 'model-card-top');
    topRow.append(node('span', 'model-card-label', m.label || m.name));
    if (m.isDefault) {
      topRow.append(node('span', 'default-pill', '默认'));
    }

    const count = Array.isArray(m.models) && m.models.length > 0 ? m.models.length : 1;
    const sub = node('div', 'model-card-sub', `${m.provider} · ${count} 个可用模型`);
    const keyInfo = node('div', 'model-card-key', m.maskedKey ? `密钥: ${m.maskedKey}` : (m.hasKey ? '已配置密钥' : '未提供密钥'));

    card.append(topRow, sub, keyInfo);
    card.onclick = () => selectModelForEditing(m.id);
    listEl.append(card);
  }
}

function selectModelForEditing(id) {
  const m = modelsList.find(item => item.id === id);
  if (!m) return;
  editingModelId = id;
  element('edit-model-id').value = m.id;
  element('model-provider-select').value = m.provider || 'custom';
  element('model-label-input').value = m.label || '';
  element('model-baseurl-input').value = m.baseURL || '';
  element('model-apikey-input').value = '';
  element('key-hint').textContent = m.maskedKey ? `当前已保存密钥: ${m.maskedKey}（留空表示不修改）` : '修改时若不修改密钥请留空';
  element('model-default-checkbox').checked = !!m.isDefault;
  element('delete-model-btn').hidden = false;
  element('save-model-btn').textContent = '更新配置';
  clearTestStatus();

  const preset = presetsList[m.provider];
  const recs = preset?.recommendedModels || [];
  const savedModels = Array.isArray(m.models) && m.models.length > 0 ? m.models : (m.name ? [m.name] : []);

  availableModelsForForm = Array.from(new Set([...savedModels, ...recs]));
  enabledModelsForForm = new Set(savedModels);
  if (m.name) enabledModelsForForm.add(m.name);

  populateModelSelect(availableModelsForForm, m.name, '-- 点击右侧「拉取模型」或手动输入 --');
  renderModelsChecklist();
  renderModelDialogList();
}

function resetModelForm(provider = 'deepseek') {
  editingModelId = null;
  element('edit-model-id').value = '';
  element('model-provider-select').value = provider;
  element('model-apikey-input').value = '';
  element('key-hint').textContent = '输入供应商 API Key，安全保存在本机';
  element('model-default-checkbox').checked = modelsList.length === 0;
  element('delete-model-btn').hidden = true;
  element('save-model-btn').textContent = '保存配置';
  clearTestStatus();
  applyPresetToForm(provider);
  renderModelDialogList();
}

function applyPresetToForm(provider) {
  const preset = presetsList[provider];
  if (preset) {
    element('model-label-input').value = preset.label || '';
    element('model-baseurl-input').value = preset.defaultBaseURL || preset.baseURL || '';
    const recs = preset.recommendedModels || [];
    availableModelsForForm = [...recs];
    enabledModelsForForm = new Set(recs);
    const defModel = preset.defaultModel || (recs[0] || '');
    if (defModel) enabledModelsForForm.add(defModel);
    populateModelSelect(recs, defModel, '-- 点击右侧「拉取模型」或手动输入 --');
  } else {
    element('model-label-input').value = '';
    element('model-baseurl-input').value = '';
    availableModelsForForm = [];
    enabledModelsForForm = new Set();
    populateModelSelect([], '', '-- 点击右侧「拉取模型」或手动输入 --');
  }
  renderModelsChecklist();
}

function populateModelSelect(models = [], selectedValue = '', defaultPlaceholder = '-- 请选择模型 --') {
  const select = element('model-name-select');
  if (!select) return;
  select.replaceChildren();

  if (models.length === 0) {
    const emptyOpt = document.createElement('option');
    emptyOpt.value = '';
    emptyOpt.textContent = defaultPlaceholder;
    select.append(emptyOpt);
  } else {
    for (const m of models) {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      select.append(opt);
    }
  }

  // Always append custom option at bottom
  const customOpt = document.createElement('option');
  customOpt.value = '__custom__';
  customOpt.textContent = '➕ 手动输入其它模型 ID...';
  select.append(customOpt);

  if (selectedValue) {
    if (models.includes(selectedValue)) {
      select.value = selectedValue;
    } else {
      const existingOpt = document.createElement('option');
      existingOpt.value = selectedValue;
      existingOpt.textContent = selectedValue;
      select.insertBefore(existingOpt, customOpt);
      select.value = selectedValue;
    }
  } else if (models.length > 0) {
    select.value = models[0];
  } else {
    select.value = '';
  }

  updateCustomModelVisibility();
}

function updateCustomModelVisibility() {
  const select = element('model-name-select');
  const customWrap = element('model-custom-input-wrap');
  const customInput = element('model-name-custom-input');
  if (!select || !customWrap) return;

  const isCustom = select.value === '__custom__';
  customWrap.hidden = !isCustom;
  if (isCustom && customInput) {
    customInput.focus();
  }
}

function getSelectedModelName() {
  const select = element('model-name-select');
  if (!select) return '';
  if (select.value === '__custom__') {
    return element('model-name-custom-input')?.value.trim() || '';
  }
  return select.value.trim();
}

function onModelSelectChange() {
  updateCustomModelVisibility();
  const selected = getSelectedModelName();
  if (selected) {
    // Auto-sync label to the selected model! (User Image #4 requirement)
    element('model-label-input').value = selected;
    enabledModelsForForm.add(selected);
    renderModelsChecklist();
  }
}

function renderModelsChecklist() {
  const container = element('models-checklist-container');
  if (!container) return;
  container.replaceChildren();

  if (availableModelsForForm.length === 0) {
    container.append(node('div', 'models-empty-hint', '点击上方「拉取模型」或下拉框选择以加载可用模型'));
    return;
  }

  const primaryName = getSelectedModelName();

  for (const m of availableModelsForForm) {
    const isChecked = enabledModelsForForm.has(m);
    const isPrimary = m === primaryName;
    const chip = node('label', `model-chip-item ${isChecked ? 'checked' : ''}`);

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = isChecked;
    checkbox.onchange = (e) => {
      e.stopPropagation();
      if (checkbox.checked) {
        enabledModelsForForm.add(m);
      } else {
        enabledModelsForForm.delete(m);
      }
      chip.classList.toggle('checked', checkbox.checked);
    };

    const nameSpan = node('span', 'model-chip-name', m);
    chip.append(checkbox, nameSpan);

    if (isPrimary) {
      chip.append(node('span', 'model-chip-tag', '主'));
    }

    container.append(chip);
  }
}

function clearTestStatus() {
  const el = element('test-status-msg');
  if (el) { el.hidden = true; el.className = 'test-status-msg'; el.textContent = ''; }
}

function showTestStatus(type, text) {
  const el = element('test-status-msg');
  if (!el) return;
  el.hidden = false;
  el.className = `test-status-msg ${type}`;
  el.textContent = text;
}

async function testCurrentModel() {
  const testBtn = element('test-model-btn');
  testBtn.disabled = true;
  showTestStatus('loading', '正在测试连通性，发起 ping 探测…');

  const provider = element('model-provider-select').value;
  const baseURL = element('model-baseurl-input').value.trim();
  const apiKey = element('model-apikey-input').value.trim();
  const name = getSelectedModelName();
  const id = element('edit-model-id').value;

  if (!name) {
    testBtn.disabled = false;
    showTestStatus('error', '请先在下拉框选择或输入模型 ID (Model)');
    element('model-name-select').focus();
    return;
  }

  try {
    const res = await api('/models/test', {
      provider,
      baseURL,
      apiKey: apiKey || undefined,
      name,
      id: id || undefined
    });

    if (res.ok) {
      showTestStatus('success', `✓ 连通性测试通过！响应延迟: ${res.latencyMs}ms`);
    } else {
      showTestStatus('error', `✗ 连接失败: ${res.error || '无法连通指定端点'}`);
    }
  } catch (err) {
    const raw = err.message || '未知错误';
    const msg = raw.replace(/^(✗\s*测试出错:\s*|✗\s*连接失败:\s*|请求失败:\s*)+/, '');
    showTestStatus('error', `✗ 测试出错: ${msg}`);
  } finally {
    testBtn.disabled = false;
  }
}

async function fetchRemoteModelsList() {
  const btn = element('fetch-remote-models-btn');
  btn.disabled = true;
  const prevText = btn.textContent;
  btn.textContent = '拉取中…';

  let baseURL = element('model-baseurl-input').value.trim();
  if (baseURL.endsWith('/v')) {
    baseURL = `${baseURL}1`;
    element('model-baseurl-input').value = baseURL;
  }
  const apiKey = element('model-apikey-input').value.trim();
  const id = element('edit-model-id').value;

  try {
    const res = await api('/models/fetch-remote', {
      baseURL,
      apiKey: apiKey || undefined,
      id: id || undefined
    });
    const models = Array.isArray(res) ? res : (res?.models || []);
    if (models.length > 0) {
      availableModelsForForm = Array.from(new Set([...availableModelsForForm, ...models]));
      // Enable all fetched models by default
      models.forEach(m => enabledModelsForForm.add(m));
      populateModelSelect(availableModelsForForm, models[0]);
      // Auto-sync label to the selected model
      element('model-label-input').value = models[0];
      renderModelsChecklist();
      showTestStatus('success', `✓ 成功从端点拉取到 ${models.length} 个模型！已勾选并同步至下拉列表`);
      element('model-name-select').focus();
    } else {
      showTestStatus('error', '端点未返回可用模型列表，可切换为「手动输入其它模型 ID」');
    }
  } catch (err) {
    const raw = err.message || '未知错误';
    const msg = raw.replace(/^(拉取模型失败:\s*)+/, '');
    showTestStatus('error', `拉取模型失败: ${msg}`);
    if (msg.includes('API Key') || msg.includes('鉴权') || msg.includes('密钥')) {
      element('model-apikey-input').focus();
    }
  } finally {
    btn.disabled = false;
    btn.textContent = prevText;
  }
}

// Model Event Listeners
element('open-model-settings')?.addEventListener('click', () => openModelDialog());
element('popover-open-settings')?.addEventListener('click', () => openModelDialog());
element('close-model-dialog')?.addEventListener('click', closeModelDialog);
element('model-label')?.addEventListener('click', toggleModelPopover);
element('test-model-btn')?.addEventListener('click', testCurrentModel);
element('fetch-remote-models-btn')?.addEventListener('click', fetchRemoteModelsList);
element('add-model-btn')?.addEventListener('click', () => resetModelForm(element('model-provider-select')?.value || 'deepseek'));
element('model-name-select')?.addEventListener('change', onModelSelectChange);

element('model-name-custom-input')?.addEventListener('input', () => {
  const val = element('model-name-custom-input').value.trim();
  if (val) {
    element('model-label-input').value = val;
    enabledModelsForForm.add(val);
    renderModelsChecklist();
  }
});

element('select-all-models-btn')?.addEventListener('click', () => {
  availableModelsForForm.forEach(m => enabledModelsForForm.add(m));
  renderModelsChecklist();
});

element('deselect-all-models-btn')?.addEventListener('click', () => {
  const primary = getSelectedModelName();
  enabledModelsForForm.clear();
  if (primary) enabledModelsForForm.add(primary);
  renderModelsChecklist();
});

element('add-custom-model-chip-btn')?.addEventListener('click', () => {
  const name = prompt('请输入自定义模型 ID (例如: claude-3-7-sonnet 或 gemini-2.5-pro):');
  if (!name || !name.trim()) return;
  const clean = name.trim();
  if (!availableModelsForForm.includes(clean)) {
    availableModelsForForm.push(clean);
  }
  enabledModelsForForm.add(clean);
  populateModelSelect(availableModelsForForm, clean);
  element('model-label-input').value = clean;
  renderModelsChecklist();
});

element('model-provider-select')?.addEventListener('change', () => {
  applyPresetToForm(element('model-provider-select').value);
});

element('toggle-key-visibility')?.addEventListener('click', () => {
  const input = element('model-apikey-input');
  if (input) input.type = input.type === 'password' ? 'text' : 'password';
});

element('model-baseurl-input')?.addEventListener('blur', () => {
  const input = element('model-baseurl-input');
  if (!input) return;
  let val = input.value.trim().replace(/\/+$/, '');
  if (val.endsWith('/v')) val += '1';
  input.value = val;
});

element('model-form')?.addEventListener('submit', async event => {
  event.preventDefault();
  const id = element('edit-model-id').value || undefined;
  const provider = element('model-provider-select').value;
  const label = element('model-label-input').value.trim();
  const name = getSelectedModelName();
  const baseURL = element('model-baseurl-input').value.trim();
  const apiKey = element('model-apikey-input').value.trim() || undefined;
  const isDefault = element('model-default-checkbox').checked;

  if (!name) {
    showTestStatus('error', '请先在下拉框选择或输入模型 ID (Model)');
    element('model-name-select').focus();
    return;
  }

  const models = Array.from(enabledModelsForForm);
  if (models.length === 0 && name) {
    models.push(name);
  }

  try {
    const saved = await api('/models', {
      id,
      provider,
      label: label || name,
      name,
      models,
      baseURL,
      apiKey,
      isDefault
    });
    await loadModels();
    selectedModelId = saved.id;
    activeModelName = name;
    localStorage.setItem('cheese.selectedModel', selectedModelId);
    localStorage.setItem('cheese.activeModelName', activeModelName);
    selectModelForEditing(saved.id);
    showTestStatus('success', `✓ 模型配置已保存！已启用 ${models.length} 个模型`);
    renderControls();
  } catch (err) {
    showTestStatus('error', `保存失败: ${err.message}`);
  }
});

element('delete-model-btn')?.addEventListener('click', async () => {
  const id = element('edit-model-id').value;
  if (!id) return;
  if (!confirm('确定要删除此模型配置吗？')) return;
  try {
    await api(`/models/${id}/delete`, {});
    if (selectedModelId === id) {
      selectedModelId = '';
      activeModelName = '';
      localStorage.removeItem('cheese.selectedModel');
      localStorage.removeItem('cheese.activeModelName');
    }
    await loadModels();
    resetModelForm();
    renderControls();
  } catch (err) {
    showTestStatus('error', `删除失败: ${err.message}`);
  }
});

loadModels();
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
