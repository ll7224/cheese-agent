const active = status => ['queued', 'running', 'stopping'].includes(status);

function text(message) {
  if (typeof message?.content === 'string') return message.content;
  return (message?.content || []).filter(part => part.type === 'text').map(part => part.text).join('');
}

function runRanges(session) {
  const messages = session.messages || [];
  const userIndexes = messages.flatMap((message, index) =>
    message.role === 'user' && !text(message).startsWith('[系统提醒]') ? [index] : []);
  const ranges = (session.runs || []).map((run, index) => ({
    run,
    start: Number.isInteger(run.messageOffset) ? Math.max(0, run.messageOffset - 1) : (userIndexes[index] ?? messages.length),
  }));
  return ranges.map((range, index) => ({ ...range, end: ranges[index + 1]?.start ?? messages.length }));
}

function outcome(run, messages, events) {
  if (active(run.status)) return null;
  const stopped = [...events].reverse().find(event => event.runId === run.id && !event.childRunId && event.type === 'execution-stopped');
  if (run.status === 'failed' || stopped) return {
    title: '本次任务未完成', tone: 'error',
    message: run.error || stopped?.message || '执行失败，请查看执行日志中的最后一步。',
  };
  if (run.status === 'cancelled') return {
    title: '任务已停止', tone: 'notice',
    message: '已有输出和执行记录已保留，文件修改不会自动撤销。',
  };
  if (run.status === 'interrupted') return {
    title: '任务已中断', tone: 'notice',
    message: run.error || '服务退出前任务尚未完成。请先核实已有修改，再决定是否继续。',
  };
  if (run.status !== 'completed') return null;
  const lastAssistant = [...messages].reverse().find(message => message.role === 'assistant');
  const callsTools = Array.isArray(lastAssistant?.content) && lastAssistant.content.some(part => part.type === 'tool-call');
  if (text(lastAssistant).trim() && !callsTools) return null;
  return {
    title: '运行结束，但没有最终答复', tone: 'notice',
    message: '此次运行没有生成最终答复，不能据此确认任务完成。请查看执行日志中的最后一步，再决定是否继续。',
  };
}

/** Keep each outcome attached to its turn, including after reload or a follow-up. */
export function conversationEntries(session) {
  const messages = session.messages || [];
  const ranges = runRanges(session);
  const entries = [];
  for (let index = 0; index <= messages.length; index++) {
    for (const range of ranges.filter(range => range.end === index)) {
      const notice = outcome(range.run, messages.slice(range.start + 1, range.end), session.events || []);
      if (notice) entries.push({ type: 'outcome', runId: range.run.id, ...notice });
    }
    const message = messages[index];
    if (!message || !['user', 'assistant'].includes(message.role) || !(text(message) || message.reasoning)) continue;
    const range = ranges.find(range => index >= range.start && index < range.end);
    entries.push({ type: 'message', message, runId: range?.run.id });
  }
  return entries;
}

export function currentRunLabel(session, run) {
  if (!run || run.status !== 'completed') return null;
  return conversationEntries(session).some(entry => entry.type === 'outcome' && entry.runId === run.id) ? '未返回结果' : null;
}

export function renderRunOutcome(entry, onShowDetails) {
  const article = document.createElement('article');
  article.className = `message assistant run-outcome run-outcome-${entry.tone}`;
  article.dataset.runId = entry.runId;
  article.setAttribute('role', 'status');
  const title = document.createElement('h2');
  title.textContent = entry.title;
  const message = document.createElement('p');
  message.textContent = entry.message;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ghost-btn';
  button.textContent = '查看执行日志';
  button.addEventListener('click', () => onShowDetails(entry.runId));
  article.append(title, message, button);
  return article;
}
