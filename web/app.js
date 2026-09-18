const element = id => document.getElementById(id);
let workspaceId = '';
let sessionId = location.hash.slice(1);
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
    element('send').disabled = run && ['running', 'queued', 'stopping'].includes(run.status);
    element('connection').textContent = run?.status || '就绪';
    if (run?.error) element('error').textContent = run.error;
  } else {
    element('title').textContent = '有什么值得一起探索？';
    element('messages').replaceChildren();
    element('send').disabled = false;
  }
  element('workspaces').replaceChildren(...workspaces.map(workspace => new Option(workspace.path, workspace.id, false, workspace.id === workspaceId)));
  const sessions = workspaceId ? await api(`/sessions?workspaceId=${workspaceId}`) : [];
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
