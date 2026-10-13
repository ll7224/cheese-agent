/**
 * 资料与引用面板模块 (web/knowledge/citations.js)
 * 纯文本展示引用原文、1-based 行号、版本状态与当前版本入口。
 */

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[m]));
}

let activeCitationDialog = null;

function ensureCitationDialog() {
  if (activeCitationDialog) return activeCitationDialog;
  let dialog = document.getElementById('citation-dialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'citation-dialog';
    dialog.className = 'citation-dialog';
    dialog.setAttribute('aria-labelledby', 'citation-dialog-title');
    dialog.innerHTML = `
      <div class="citation-modal-content">
        <div class="dialog-heading">
          <div class="dialog-title-group">
            <span class="dialog-badge">资料引用溯源</span>
            <h2 id="citation-dialog-title">引用内容溯源与有效性</h2>
          </div>
          <button class="icon-button" type="button" id="close-citation-dialog" aria-label="关闭引用弹窗">✕</button>
        </div>
        <div id="citation-modal-body" class="citation-modal-body">
          <div class="loading-spinner">正在加载引用详情…</div>
        </div>
      </div>
    `;
    document.body.appendChild(dialog);
    dialog.querySelector('#close-citation-dialog').addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close();
    });
  }
  activeCitationDialog = dialog;
  return dialog;
}

/**
 * 弹出展示引用溯源详情
 */
export async function viewCitation(workspaceId, citationId) {
  const dialog = ensureCitationDialog();
  const body = dialog.querySelector('#citation-modal-body');
  body.innerHTML = '<div class="loading-spinner">正在拉取引用原文及版本状态…</div>';
  dialog.showModal();

  try {
    const res = await fetch(`/api/v1/workspaces/${workspaceId}/knowledge/citations/${citationId}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `请求失败 (${res.status})`);
    }
    const data = await res.json();
    renderCitationDetail(body, data, workspaceId);
  } catch (err) {
    body.innerHTML = `
      <div class="citation-error-card">
        <span class="error-icon">⚠️</span>
        <div class="error-msg">读取引用失败: ${escapeHtml(err.message)}</div>
      </div>
    `;
  }
}

function renderCitationDetail(container, data, workspaceId) {
  const { citation, content, currentRevisionId, current } = data;
  const span = citation.span || {};
  const statusClass = citation.status === 'effective'
    ? 'status-pill-effective'
    : (citation.status === 'invalidated' ? 'status-pill-invalidated' : 'status-pill-candidate');
  const statusLabel = citation.status === 'effective'
    ? '已生效'
    : (citation.status === 'invalidated' ? '已失效 (已由新条目或版本替代)' : '候选 (待验证)');
  const currentBadge = current
    ? '<span class="status-badge-current">● 当前生效版本</span>'
    : `<span class="status-badge-historic">⚠️ 历史版本 (当前生效: ${escapeHtml(currentRevisionId || '无')})</span>`;

  // 纯文本按行拆分并增加 1-based 行号，标记高亮行范围
  const lines = (content || '').split('\n');
  const startLine = span.startLine || 1;
  const endLine = span.endLine || lines.length;

  const linesHtml = lines
    .map((lineText, idx) => {
      const lineNum = idx + 1;
      const isHighlighted = lineNum >= startLine && lineNum <= endLine;
      const highlightClass = isHighlighted ? 'citation-line-highlight' : '';
      return `<div class="citation-code-line ${highlightClass}">` +
        `<span class="line-number" aria-hidden="true">${lineNum}</span>` +
        `<span class="line-code">${escapeHtml(lineText) || ' '}</span>` +
      `</div>`;
    })
    .join('');

  container.innerHTML = `
    <div class="citation-meta-card">
      <div class="citation-meta-row">
        <span class="citation-uri" title="${escapeHtml(citation.sourceUri)}">📄 ${escapeHtml(citation.sourceUri)}</span>
        <div class="citation-tags">
          <span class="citation-status-pill ${statusClass}">${statusLabel}</span>
          <span class="citation-kind-pill">${escapeHtml(citation.evidenceKind || 'document')}</span>
          ${currentBadge}
        </div>
      </div>
      <div class="citation-meta-details">
        <span>行号跨度: <strong>${startLine} ~ ${endLine}</strong></span>
        <span>字符偏移: <strong>${span.startOffset ?? '-'} ~ ${span.endOffset ?? '-'}</strong></span>
        <span>版本 Hash: <code class="hash-tag">${escapeHtml((citation.hash || '').slice(0, 10))}</code></span>
        ${citation.commit ? `<span>Git 提交: <code>${escapeHtml(citation.commit.slice(0, 8))}</code></span>` : ''}
        <span>知识库: <code>${escapeHtml(citation.libraryId || 'default')}</code></span>
      </div>
    </div>

    <div class="citation-source-viewer">
      <div class="viewer-header">
        <span>不可变版本原文 (${lines.length} 行)</span>
        <span class="span-hint">高亮区域为检索匹配片段 (第 ${startLine} - ${endLine} 行)</span>
      </div>
      <div class="citation-code-wrapper">
        <pre class="citation-code-pre">${linesHtml}</pre>
      </div>
    </div>
  `;
}

/**
 * 在消息底部渲染引用徽章列表
 */
export function renderMessageCitations(container, citations, workspaceId) {
  if (!citations || citations.length === 0) return;
  const wrapper = document.createElement('div');
  wrapper.className = 'message-citations-wrapper';

  const heading = document.createElement('div');
  heading.className = 'message-citations-heading';
  heading.innerHTML = `
    <span class="citation-heading-icon">📚</span>
    <span>知识溯源 (${citations.length} 处引用)</span>
  `;
  wrapper.appendChild(heading);

  const list = document.createElement('div');
  list.className = 'message-citations-list';

  citations.forEach((c, idx) => {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = `citation-pill ${c.status === 'candidate' ? 'pill-candidate' : 'pill-effective'}`;
    pill.title = `点击查看引用原文: ${c.sourceUri}`;
    pill.innerHTML = `
      <span class="pill-index">[${idx + 1}]</span>
      <span class="pill-uri">${escapeHtml(c.sourceUri || '未知来源')}</span>
      ${c.status === 'candidate' ? '<span class="pill-tag">候选</span>' : ''}
    `;
    pill.addEventListener('click', () => {
      viewCitation(workspaceId, c.citationId);
    });
    list.appendChild(pill);
  });

  wrapper.appendChild(list);
  container.appendChild(wrapper);
}
