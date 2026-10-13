/**
 * 知识中心控制器 (web/knowledge/controller.js)
 */

import { buildKnowledgeShell } from './views.js';
import { viewCitation } from './citations.js';

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[m]));
}

export class KnowledgeController {
  constructor(mountElement, getWorkspaceId, getAvailableAgents) {
    this.mountElement = mountElement;
    this.getWorkspaceId = getWorkspaceId;
    this.getAvailableAgents = getAvailableAgents || (() => []);

    this.libraries = [];
    this.currentLibraryId = '';
    this.documents = [];
    this.docPage = 0;
    this.docLimit = 50;
    this.sources = [];
    this.discoveries = [];

    this.container = null;
  }

  get workspaceId() {
    return this.getWorkspaceId();
  }

  async init() {
    this.container = buildKnowledgeShell();
    this.mountElement.replaceChildren(this.container);
    this.bindEvents();
    await this.loadLibraries();
  }

  bindEvents() {
    const c = this.container;

    // 知识库切换
    c.querySelector('#kn-lib-select').addEventListener('change', (e) => {
      this.currentLibraryId = e.target.value;
      this.docPage = 0;
      this.loadDocuments();
      this.loadSources();
    });

    // 新建库按钮
    c.querySelector('#kn-create-lib-btn').addEventListener('click', () => {
      this.showCreateLibraryDialog();
    });

    // Tab 切换
    c.querySelectorAll('.kn-tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        c.querySelectorAll('.kn-tab-btn').forEach((b) => b.classList.remove('active'));
        c.querySelectorAll('.kn-tab-pane').forEach((p) => (p.hidden = true));
        btn.classList.add('active');
        const target = c.querySelector(`#kn-tab-${btn.dataset.tab}`);
        if (target) target.hidden = false;

        if (btn.dataset.tab === 'bindings') {
          this.loadBindings();
        } else if (btn.dataset.tab === 'sources') {
          this.loadSources();
          this.loadDiscoveries();
        } else if (btn.dataset.tab === 'documents') {
          this.loadDocuments();
        }
      });
    });

    // 检索测试
    c.querySelector('#kn-search-btn').addEventListener('click', () => this.runSearchTest());
    c.querySelector('#kn-search-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.runSearchTest();
    });
    c.querySelector('#kn-close-search-btn').addEventListener('click', () => {
      c.querySelector('#kn-search-results').hidden = true;
    });

    // 导入文档
    c.querySelector('#kn-import-doc-btn').addEventListener('click', () => {
      this.showImportDocumentDialog();
    });

    // 分页
    c.querySelector('#kn-docs-prev-btn').addEventListener('click', () => {
      if (this.docPage > 0) {
        this.docPage--;
        this.loadDocuments();
      }
    });
    c.querySelector('#kn-docs-next-btn').addEventListener('click', () => {
      if (this.documents.length === this.docLimit) {
        this.docPage++;
        this.loadDocuments();
      }
    });

    // 添加来源
    c.querySelector('#kn-add-source-btn').addEventListener('click', () => {
      this.showAddSourceDialog();
    });

    // 重新发现
    c.querySelector('#kn-refresh-discover-btn').addEventListener('click', () => {
      this.loadDiscoveries();
    });
  }

  // --- API 交互 ---

  async fetchApi(path, options = {}) {
    const wsId = this.workspaceId;
    if (!wsId) throw new Error('未选择工作区');

    const headers = { ...options.headers };
    if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }

    const res = await fetch(`/api/v1/workspaces/${wsId}/knowledge${path}`, {
      ...options,
      headers,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `请求失败 (${res.status})`);
    }

    return res.json();
  }

  async loadLibraries() {
    try {
      this.libraries = await this.fetchApi('/libraries');
      const select = this.container.querySelector('#kn-lib-select');
      select.innerHTML = '';

      if (this.libraries.length === 0) {
        select.innerHTML = '<option value="">(暂无可访问知识库)</option>';
        return;
      }

      this.libraries.forEach((lib) => {
        const opt = document.createElement('option');
        opt.value = lib.id;
        const roleBadge = lib.role === 'basic' ? '[基础]' : lib.role === 'project' ? '[项目]' : '[领域]';
        opt.textContent = `${roleBadge} ${lib.name} (${lib.id})`;
        select.appendChild(opt);
      });

      if (!this.currentLibraryId || !this.libraries.some((l) => l.id === this.currentLibraryId)) {
        this.currentLibraryId = this.libraries[0].id;
      }
      select.value = this.currentLibraryId;

      await Promise.all([this.loadDocuments(), this.loadSources(), this.loadDiscoveries()]);
    } catch (err) {
      console.error('加载知识库列表失败:', err);
    }
  }

  async loadDocuments() {
    const tbody = this.container.querySelector('#kn-docs-tbody');
    tbody.innerHTML = '<tr><td colspan="6" class="table-empty">加载中…</td></tr>';

    try {
      const offset = this.docPage * this.docLimit;
      const docs = await this.fetchApi(
        `/documents?libraryId=${encodeURIComponent(this.currentLibraryId)}&limit=${this.docLimit}&offset=${offset}`
      );
      this.documents = docs;

      this.container.querySelector('#kn-docs-count').textContent = `当前库共显示 ${docs.length} 篇文档`;
      this.container.querySelector('#kn-docs-page-info').textContent = `第 ${this.docPage + 1} 页`;
      this.container.querySelector('#kn-docs-prev-btn').disabled = this.docPage === 0;
      this.container.querySelector('#kn-docs-next-btn').disabled = docs.length < this.docLimit;

      if (docs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="table-empty">当前知识库暂无文档记录</td></tr>';
        return;
      }

      tbody.innerHTML = '';
      docs.forEach((d) => {
        const tr = document.createElement('tr');
        const updatedTime = new Date(d.updatedAt).toLocaleString();
        tr.innerHTML = `
          <td><strong>${escapeHtml(d.sourceKey)}</strong></td>
          <td><code class="hash-tag">${escapeHtml(d.sourceId)}</code></td>
          <td><code>${escapeHtml(d.activeRevisionId || '无')}</code></td>
          <td><span class="status-pill status-pill-${d.status}">${escapeHtml(d.status)}</span></td>
          <td>${escapeHtml(updatedTime)}</td>
          <td class="action-cell">
            <button class="mini-btn btn-revs" type="button">版本</button>
            <button class="mini-btn btn-edit" type="button">编辑</button>
            <button class="mini-btn btn-del danger-text" type="button">移出</button>
          </td>
        `;

        tr.querySelector('.btn-revs').addEventListener('click', () => this.showRevisionsDialog(d));
        tr.querySelector('.btn-edit').addEventListener('click', () => this.showEditDocumentDialog(d));
        tr.querySelector('.btn-del').addEventListener('click', () => this.deleteDocument(d));

        tbody.appendChild(tr);
      });
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="6" class="table-error">加载文档失败: ${escapeHtml(err.message)}</td></tr>`;
    }
  }

  async loadSources() {
    const tbody = this.container.querySelector('#kn-sources-tbody');
    tbody.innerHTML = '<tr><td colspan="6" class="table-empty">加载中…</td></tr>';

    try {
      const sources = await this.fetchApi(
        `/sources?libraryId=${encodeURIComponent(this.currentLibraryId)}`
      );
      this.sources = sources;

      if (sources.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="table-empty">当前知识库暂无来源</td></tr>';
        return;
      }

      tbody.innerHTML = '';
      sources.forEach((s) => {
        const tr = document.createElement('tr');
        const lastSync = s.lastSyncAt ? new Date(s.lastSyncAt).toLocaleString() : '未同步';
        tr.innerHTML = `
          <td><span class="kind-tag">${escapeHtml(s.kind)}</span></td>
          <td><code>${escapeHtml(s.locator)}</code></td>
          <td>
            <input type="checkbox" class="source-enabled-cb" ${s.enabled ? 'checked' : ''} />
          </td>
          <td><span class="sync-status sync-${s.syncStatus}">${escapeHtml(s.syncStatus)}</span></td>
          <td>${escapeHtml(lastSync)}</td>
          <td class="action-cell">
            <button class="mini-btn btn-sync" type="button">立即同步</button>
          </td>
        `;

        const cb = tr.querySelector('.source-enabled-cb');
        cb.addEventListener('change', async () => {
          try {
            await this.fetchApi(`/sources/${s.id}`, {
              method: 'PATCH',
              body: { enabled: cb.checked },
            });
            await this.loadSources();
          } catch (err) {
            alert('切换来源状态失败: ' + err.message);
            cb.checked = !cb.checked;
          }
        });

        tr.querySelector('.btn-sync').addEventListener('click', async (e) => {
          const btn = e.target;
          btn.disabled = true;
          btn.textContent = '同步中…';
          try {
            await this.fetchApi(`/sources/${s.id}/sync`, { method: 'POST', body: {} });
            await this.loadSources();
            await this.loadDocuments();
          } catch (err) {
            alert('同步失败: ' + err.message);
          } finally {
            btn.disabled = false;
            btn.textContent = '立即同步';
          }
        });

        tbody.appendChild(tr);
      });
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="6" class="table-error">加载来源失败: ${escapeHtml(err.message)}</td></tr>`;
    }
  }

  async loadDiscoveries() {
    const list = this.container.querySelector('#kn-discovery-list');
    list.innerHTML = '<div class="table-empty">检测中…</div>';

    try {
      const proposals = await this.fetchApi('/discover', { method: 'POST', body: {} });
      this.discoveries = proposals;

      if (!proposals || proposals.length === 0) {
        list.innerHTML = '<div class="table-empty">未发现新的待启用工程知识来源</div>';
        return;
      }

      list.innerHTML = '';
      proposals.forEach((p) => {
        const item = document.createElement('div');
        item.className = 'discovery-item';
        item.innerHTML = `
          <div class="discovery-item-info">
            <strong>${escapeHtml(p.locator)}</strong>
            <span class="discovery-reason">${escapeHtml(p.reason || '工程目录规范匹配')}</span>
          </div>
          <button class="mini-btn btn-enable-proposal action-tag-btn" type="button">一键启用</button>
        `;

        item.querySelector('.btn-enable-proposal').addEventListener('click', async (e) => {
          const btn = e.target;
          btn.disabled = true;
          try {
            await this.fetchApi('/sources', {
              method: 'POST',
              body: {
                libraryId: `project:${this.workspaceId}`,
                kind: p.kind || 'local',
                locator: p.locator,
                enabled: true,
              },
            });
            await this.loadSources();
            await this.loadDiscoveries();
          } catch (err) {
            alert('启用来源失败: ' + err.message);
            btn.disabled = false;
          }
        });

        list.appendChild(item);
      });
    } catch (err) {
      list.innerHTML = `<div class="table-error">检测发现建议失败: ${escapeHtml(err.message)}</div>`;
    }
  }

  async loadBindings() {
    const container = this.container.querySelector('#kn-bindings-container');
    container.innerHTML = '<div class="table-empty">加载智能体设定中…</div>';

    try {
      const agents = this.getAvailableAgents();
      if (!agents || agents.length === 0) {
        container.innerHTML = '<div class="table-empty">暂无可用 Agent 设定</div>';
        return;
      }

      container.innerHTML = '';
      for (const agent of agents) {
        const card = document.createElement('div');
        card.className = 'binding-card';

        // 当前 Agent 绑定的库
        let boundIds = [];
        try {
          // 当前各库选择
        } catch {}

        const libCheckboxes = this.libraries
          .map((lib) => {
            const isProject = lib.scope === 'project' && lib.workspaceId === this.workspaceId;
            const isBasic = lib.scope === 'public' && lib.role === 'basic';
            const defaultChecked = isProject || isBasic;
            return `
              <label class="binding-lib-checkbox">
                <input type="checkbox" value="${escapeHtml(lib.id)}" ${defaultChecked ? 'checked' : ''} />
                <span>${escapeHtml(lib.name)} (${escapeHtml(lib.id)})</span>
              </label>
            `;
          })
          .join('');

        card.innerHTML = `
          <div class="binding-card-header">
            <span class="binding-agent-avatar">${escapeHtml(agent.avatar || '🧀')}</span>
            <div class="binding-agent-meta">
              <strong>${escapeHtml(agent.name || agent.id)}</strong>
              <span class="agent-id-tag">${escapeHtml(agent.id)}</span>
            </div>
          </div>
          <div class="binding-libs-list">
            ${libCheckboxes}
          </div>
          <div class="binding-card-actions">
            <button class="mini-btn btn-save-binding action-tag-btn" type="button">保存绑定</button>
          </div>
        `;

        card.querySelector('.btn-save-binding').addEventListener('click', async (e) => {
          const btn = e.target;
          btn.disabled = true;
          const checked = Array.from(card.querySelectorAll('input[type="checkbox"]:checked')).map(
            (cb) => cb.value
          );

          try {
            await this.fetchApi(`/bindings/${encodeURIComponent(agent.id)}`, {
              method: 'PUT',
              body: { libraryIds: checked },
            });
            btn.textContent = '已保存 ✓';
            setTimeout(() => {
              btn.textContent = '保存绑定';
              btn.disabled = false;
            }, 1500);
          } catch (err) {
            alert('保存绑定失败: ' + err.message);
            btn.disabled = false;
          }
        });

        container.appendChild(card);
      }
    } catch (err) {
      container.innerHTML = `<div class="table-error">加载绑定失败: ${escapeHtml(err.message)}</div>`;
    }
  }

  // --- 检索测试 ---

  async runSearchTest() {
    const input = this.container.querySelector('#kn-search-input');
    const query = input.value.trim();
    if (!query) return;

    const mode = this.container.querySelector('#kn-search-mode').value;
    const resultsPanel = this.container.querySelector('#kn-search-results');
    const hitsList = this.container.querySelector('#kn-search-hits');

    resultsPanel.hidden = false;
    hitsList.innerHTML = '<div class="loading-spinner">正在执行混合检索与权限过滤…</div>';

    try {
      const res = await this.fetchApi('/search', {
        method: 'POST',
        body: {
          query,
          mode,
          topK: 5,
          libraryIds: [this.currentLibraryId],
          includeGraph: false,
        },
      });

      if (!res.hits || res.hits.length === 0) {
        hitsList.innerHTML = '<div class="table-empty">没有匹配到相关工程知识</div>';
        return;
      }

      hitsList.innerHTML = '';
      res.hits.forEach((h, idx) => {
        const c = h.citation;
        const item = document.createElement('div');
        item.className = 'search-hit-item';
        item.innerHTML = `
          <div class="hit-header">
            <span class="hit-score">#${idx + 1} 得分: ${h.score.toFixed(3)}</span>
            <span class="hit-uri">📄 ${escapeHtml(c.sourceUri)}</span>
            <span class="citation-status-pill status-pill-${c.status}">${escapeHtml(c.status)}</span>
            <button class="mini-btn btn-view-citation action-tag-btn" type="button">查看溯源</button>
          </div>
          <div class="hit-snippet markdown-body">${escapeHtml(h.text)}</div>
        `;

        item.querySelector('.btn-view-citation').addEventListener('click', () => {
          viewCitation(this.workspaceId, c.id);
        });

        hitsList.appendChild(item);
      });
    } catch (err) {
      hitsList.innerHTML = `<div class="table-error">检索出错: ${escapeHtml(err.message)}</div>`;
    }
  }

  // --- 弹窗逻辑 ---

  showCreateLibraryDialog() {
    const root = this.container.querySelector('#kn-dialogs-root');
    root.innerHTML = `
      <dialog id="kn-modal-lib" class="kn-modal">
        <div class="dialog-heading">
          <div class="dialog-title-group">
            <span class="dialog-badge">创建知识库</span>
            <h2>新建工程知识库</h2>
          </div>
          <button class="icon-button btn-close-modal" type="button">✕</button>
        </div>
        <form id="kn-create-lib-form" class="kn-form">
          <div class="form-row">
            <label>知识库名称</label>
            <input id="kn-lib-name-input" class="form-input" required placeholder="例如: 核心业务规则库" />
          </div>
          <div class="form-row">
            <label>描述说明</label>
            <input id="kn-lib-desc-input" class="form-input" placeholder="简要说明此库涵盖的工程领域与规范" />
          </div>
          <div class="form-row">
            <label>知识库作用域</label>
            <select id="kn-lib-scope-select" class="form-select">
              <option value="project">项目专属库 (project - 仅限当前工作区)</option>
              <option value="public">公共知识库 (public - 跨工作区可用)</option>
            </select>
          </div>
          <div class="form-actions">
            <button type="button" class="ghost-btn btn-close-modal">取消</button>
            <button type="submit" class="send-button">确认创建</button>
          </div>
        </form>
      </dialog>
    `;

    const dialog = root.querySelector('#kn-modal-lib');
    dialog.showModal();
    root.querySelectorAll('.btn-close-modal').forEach((b) => b.addEventListener('click', () => dialog.close()));

    root.querySelector('#kn-create-lib-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = root.querySelector('#kn-lib-name-input').value.trim();
      const description = root.querySelector('#kn-lib-desc-input').value.trim();
      const scope = root.querySelector('#kn-lib-scope-select').value;

      try {
        await this.fetchApi('/libraries', {
          method: 'POST',
          body: { name, description, scope },
        });
        dialog.close();
        await this.loadLibraries();
      } catch (err) {
        alert('创建知识库失败: ' + err.message);
      }
    });
  }

  showImportDocumentDialog() {
    const root = this.container.querySelector('#kn-dialogs-root');
    const targetProjectLibId = `project:${this.workspaceId}`;

    root.innerHTML = `
      <dialog id="kn-modal-import" class="kn-modal">
        <div class="dialog-heading">
          <div class="dialog-title-group">
            <span class="dialog-badge">资料导入</span>
            <h2>向项目库导入工程文档</h2>
          </div>
          <button class="icon-button btn-close-modal" type="button">✕</button>
        </div>
        <form id="kn-import-doc-form" class="kn-form">
          <div class="form-row">
            <label>导入模式</label>
            <div class="radio-group">
              <label><input type="radio" name="import-mode" value="content" checked /> 直接输入 Markdown/文本内容</label>
              <label><input type="radio" name="import-mode" value="path" /> 引用已启用的本地相对文件路径</label>
            </div>
          </div>
          <div class="form-row" id="wrap-import-name">
            <label>文档标识 / 名称</label>
            <input id="kn-import-name" class="form-input" placeholder="例如: architecture-decision-001.md" />
          </div>
          <div class="form-row" id="wrap-import-content">
            <label>文档内容 (上限 1 MiB)</label>
            <textarea id="kn-import-content" rows="6" class="form-textarea" placeholder="输入工程文档、架构决策或设计说明…"></textarea>
          </div>
          <div class="form-row" id="wrap-import-path" hidden>
            <label>相对文件路径 (需在已启用来源范围内)</label>
            <input id="kn-import-path" class="form-input" placeholder="例如: docs/spec.md" />
          </div>
          <div class="form-actions">
            <button type="button" class="ghost-btn btn-close-modal">取消</button>
            <button type="submit" class="send-button">导入并发布</button>
          </div>
        </form>
      </dialog>
    `;

    const dialog = root.querySelector('#kn-modal-import');
    dialog.showModal();
    root.querySelectorAll('.btn-close-modal').forEach((b) => b.addEventListener('click', () => dialog.close()));

    const modeRadios = root.querySelectorAll('input[name="import-mode"]');
    modeRadios.forEach((r) => {
      r.addEventListener('change', () => {
        const isPath = r.value === 'path';
        root.querySelector('#wrap-import-content').hidden = isPath;
        root.querySelector('#wrap-import-path').hidden = !isPath;
      });
    });

    root.querySelector('#kn-import-doc-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const isPath = root.querySelector('input[name="import-mode"]:checked').value === 'path';
      const name = root.querySelector('#kn-import-name').value.trim();
      const content = root.querySelector('#kn-import-content').value;
      const path = root.querySelector('#kn-import-path').value.trim();

      const body = {
        libraryId: targetProjectLibId,
        name: name || undefined,
        content: !isPath ? content : undefined,
        path: isPath ? path : undefined,
      };

      try {
        await this.fetchApi('/documents', { method: 'POST', body });
        dialog.close();
        await this.loadDocuments();
      } catch (err) {
        alert('导入文档失败: ' + err.message);
      }
    });
  }

  showEditDocumentDialog(doc) {
    const root = this.container.querySelector('#kn-dialogs-root');
    root.innerHTML = `
      <dialog id="kn-modal-edit" class="kn-modal">
        <div class="dialog-heading">
          <div class="dialog-title-group">
            <span class="dialog-badge">编辑文档版本</span>
            <h2>更新文档内容</h2>
          </div>
          <button class="icon-button btn-close-modal" type="button">✕</button>
        </div>
        <form id="kn-edit-doc-form" class="kn-form">
          <p class="dialog-desc">
            若为本地源码文件，系统将保留原源码文件完好，并在项目知识库中发布受管副本，支持持续追溯。
          </p>
          <div class="form-row">
            <label>新版本内容 (上限 1 MiB)</label>
            <textarea id="kn-edit-content" rows="8" class="form-textarea" placeholder="输入新的文档版本内容…" required></textarea>
          </div>
          <div class="form-actions">
            <button type="button" class="ghost-btn btn-close-modal">取消</button>
            <button type="submit" class="send-button">发布新版本</button>
          </div>
        </form>
      </dialog>
    `;

    const dialog = root.querySelector('#kn-modal-edit');
    dialog.showModal();
    root.querySelectorAll('.btn-close-modal').forEach((b) => b.addEventListener('click', () => dialog.close()));

    root.querySelector('#kn-edit-doc-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const content = root.querySelector('#kn-edit-content').value;

      try {
        const res = await this.fetchApi(`/documents/${doc.id}`, {
          method: 'PATCH',
          body: { content },
        });
        if (res.message) {
          alert(res.message);
        }
        dialog.close();
        await this.loadDocuments();
      } catch (err) {
        alert('更新文档失败: ' + err.message);
      }
    });
  }

  async deleteDocument(doc) {
    if (!confirm(`确定将文档 "${doc.sourceKey}" 移出当前生效索引？\n历史版本将保留，相关片段退出检索。`)) {
      return;
    }

    try {
      await this.fetchApi(`/documents/${doc.id}`, { method: 'DELETE' });
      await this.loadDocuments();
    } catch (err) {
      alert('操作失败: ' + err.message);
    }
  }

  async showRevisionsDialog(doc) {
    const root = this.container.querySelector('#kn-dialogs-root');
    root.innerHTML = `
      <dialog id="kn-modal-revs" class="kn-modal">
        <div class="dialog-heading">
          <div class="dialog-title-group">
            <span class="dialog-badge">版本历史</span>
            <h2>${escapeHtml(doc.sourceKey)} 的版本链</h2>
          </div>
          <button class="icon-button btn-close-modal" type="button">✕</button>
        </div>
        <div class="revisions-list-body">
          <div class="loading-spinner">加载版本列表中…</div>
        </div>
      </dialog>
    `;

    const dialog = root.querySelector('#kn-modal-revs');
    dialog.showModal();
    root.querySelectorAll('.btn-close-modal').forEach((b) => b.addEventListener('click', () => dialog.close()));

    const listBody = root.querySelector('.revisions-list-body');
    try {
      const revs = await this.fetchApi(`/documents/${doc.id}/revisions`);
      if (!revs || revs.length === 0) {
        listBody.innerHTML = '<div class="table-empty">无版本历史记录</div>';
        return;
      }

      listBody.innerHTML = `
        <table class="kn-table">
          <thead>
            <tr>
              <th>版本 ID</th>
              <th>SHA-256 Hash</th>
              <th>Git 提交</th>
              <th>发布时间</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            ${revs
              .map((r) => {
                const isCurrent = r.id === doc.activeRevisionId;
                const statusTag = isCurrent
                  ? '<span class="status-badge-current">● 当前生效</span>'
                  : '<span class="status-badge-historic">历史</span>';
                return `
                <tr>
                  <td><code>${escapeHtml(r.id)}</code></td>
                  <td><code class="hash-tag">${escapeHtml(r.hash.slice(0, 10))}</code></td>
                  <td><code>${escapeHtml(r.commitHash ? r.commitHash.slice(0, 8) : '-')}</code></td>
                  <td>${escapeHtml(new Date(r.createdAt).toLocaleString())}</td>
                  <td>${statusTag}</td>
                </tr>
              `;
              })
              .join('')}
          </tbody>
        </table>
      `;
    } catch (err) {
      listBody.innerHTML = `<div class="table-error">获取版本失败: ${escapeHtml(err.message)}</div>`;
    }
  }

  showAddSourceDialog() {
    const root = this.container.querySelector('#kn-dialogs-root');
    root.innerHTML = `
      <dialog id="kn-modal-source" class="kn-modal">
        <div class="dialog-heading">
          <div class="dialog-title-group">
            <span class="dialog-badge">添加来源</span>
            <h2>接入新的工程知识源</h2>
          </div>
          <button class="icon-button btn-close-modal" type="button">✕</button>
        </div>
        <form id="kn-add-source-form" class="kn-form">
          <div class="form-row">
            <label>目标知识库</label>
            <input class="form-input" value="${escapeHtml(this.currentLibraryId)}" readonly />
          </div>
          <div class="form-row">
            <label>来源类型</label>
            <select id="kn-source-kind" class="form-select">
              <option value="local">本地工作区相对目录或文件 (local)</option>
              <option value="managed">受管文档源 (managed)</option>
            </select>
          </div>
          <div class="form-row">
            <label>路径定位符 (Locator)</label>
            <input id="kn-source-locator" class="form-input" required placeholder="例如: docs 或 src 或 README.md" />
          </div>
          <div class="form-row-checkbox">
            <label class="checkbox-label">
              <input type="checkbox" id="kn-source-enabled" checked />
              <span>添加后立即启用并启动监听同步</span>
            </label>
          </div>
          <div class="form-actions">
            <button type="button" class="ghost-btn btn-close-modal">取消</button>
            <button type="submit" class="send-button">确认添加</button>
          </div>
        </form>
      </dialog>
    `;

    const dialog = root.querySelector('#kn-modal-source');
    dialog.showModal();
    root.querySelectorAll('.btn-close-modal').forEach((b) => b.addEventListener('click', () => dialog.close()));

    root.querySelector('#kn-add-source-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const kind = root.querySelector('#kn-source-kind').value;
      const locator = root.querySelector('#kn-source-locator').value.trim();
      const enabled = root.querySelector('#kn-source-enabled').checked;

      try {
        await this.fetchApi('/sources', {
          method: 'POST',
          body: {
            libraryId: this.currentLibraryId,
            kind,
            locator,
            enabled,
          },
        });
        dialog.close();
        await this.loadSources();
      } catch (err) {
        alert('添加来源失败: ' + err.message);
      }
    });
  }
}
