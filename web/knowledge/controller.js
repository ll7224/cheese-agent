/**
 * 知识中心控制器 (web/knowledge/controller.js)
 */

import { buildKnowledgeShell } from './views.js';
import { viewCitation } from './citations.js';
import { GraphController } from './graph.js';

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
        } else if (btn.dataset.tab === 'graph') {
          this.loadGraph();
        } else if (btn.dataset.tab === 'items') {
          this.loadItems();
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

    // 导入旧版知识库
    const importLegacyBtn = c.querySelector('#kn-import-legacy-btn');
    if (importLegacyBtn) {
      importLegacyBtn.addEventListener('click', async () => {
        const pathInput = prompt('请输入旧版 SQLite 知识库路径（留空则默认读取 .cheese-knowledge/knowledge.db）：', '');
        if (pathInput === null) return;
        importLegacyBtn.disabled = true;
        importLegacyBtn.textContent = '导入中…';
        try {
          const res = await this.fetchApi('/legacy/import', {
            method: 'POST',
            body: pathInput.trim() ? { legacyDbPath: pathInput.trim() } : {},
          });
          alert(`旧版知识库导入完成！\n已导入文档: ${res.importedDocuments} 篇\n已导入切片: ${res.importedChunks} 个\n目标库: ${res.legacyLibraryId}`);
          await this.loadLibraries();
          await this.loadSources();
          await this.loadDocuments();
        } catch (err) {
          alert('导入旧版知识库失败: ' + err.message);
        } finally {
          importLegacyBtn.disabled = false;
          importLegacyBtn.textContent = '📥 导入旧版知识库';
        }
      });
    }

    // 扫描并同步 docs/
    const scanDocsBtn = c.querySelector('#kn-scan-docs-toolbar-btn');
    if (scanDocsBtn) {
      scanDocsBtn.addEventListener('click', async () => {
        scanDocsBtn.disabled = true;
        scanDocsBtn.textContent = '正在扫描并同步 docs…';
        try {
          await this.fetchApi('/sources', {
            method: 'POST',
            body: {
              libraryId: this.currentLibraryId,
              kind: 'local',
              locator: 'docs',
              enabled: true,
            },
          });
          await this.loadSources();
          await this.loadDiscoveries();
          await this.loadDocuments();
          alert('docs/ 目录扫描与同步完成！文档与版本切片已就绪。');
        } catch (err) {
          alert('扫描并同步 docs 失败: ' + err.message);
        } finally {
          scanDocsBtn.disabled = false;
          scanDocsBtn.textContent = '📁 扫描并同步 docs/';
        }
      });
    }

    // 批量提炼知识
    const extractAllDocsBtn = c.querySelector('#kn-extract-all-docs-btn');
    if (extractAllDocsBtn) {
      extractAllDocsBtn.addEventListener('click', () => {
        this.showBatchExtractDialog();
      });
    }

    // 沉淀与经验
    const filterStatus = c.querySelector('#kn-items-filter-status');
    if (filterStatus) {
      filterStatus.addEventListener('change', () => this.loadItems());
    }
    const refreshItemsBtn = c.querySelector('#kn-refresh-items-btn');
    if (refreshItemsBtn) {
      refreshItemsBtn.addEventListener('click', () => this.loadItems());
    }
  }

  // --- API 交互 ---

  async fetchApi(path, options = {}) {
    const wsId = this.workspaceId;
    if (!wsId) throw new Error('未选择工作区');

    const method = (options.method || 'GET').toUpperCase();
    const headers = { ...options.headers };
    let body = options.body;

    if (['POST', 'PUT', 'PATCH'].includes(method)) {
      headers['Content-Type'] = 'application/json';
      if (body === undefined || body === null) {
        body = '{}';
      } else if (typeof body === 'object' && !(body instanceof FormData)) {
        body = JSON.stringify(body);
      }
    }

    const res = await fetch(`/api/v1/workspaces/${wsId}/knowledge${path}`, {
      ...options,
      method,
      headers,
      body,
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
        tbody.innerHTML = `
          <tr>
            <td colspan="6" class="table-empty">
              <div style="padding: 16px 0; text-align: center;">
                <p style="margin: 0 0 6px 0; font-weight: 500;">当前知识库暂无已索引文档记录</p>
                <p style="font-size: 12px; color: var(--text-muted); margin: 0 0 12px 0;">系统支持一键扫描工程 docs/ 目录并自动建立知识切片索引与提炼。</p>
                <button id="kn-quick-sync-docs-btn" class="action-tag-btn" type="button">📁 一键扫描并同步 docs 目录</button>
              </div>
            </td>
          </tr>
        `;
        const syncDocsBtn = tbody.querySelector('#kn-quick-sync-docs-btn');
        if (syncDocsBtn) {
          syncDocsBtn.addEventListener('click', async () => {
            syncDocsBtn.disabled = true;
            syncDocsBtn.textContent = '正在扫描并同步 docs…';
            try {
              await this.fetchApi('/sources', {
                method: 'POST',
                body: {
                  libraryId: this.currentLibraryId,
                  kind: 'local',
                  locator: 'docs',
                  enabled: true,
                },
              });
              await this.loadSources();
              await this.loadDiscoveries();
              await this.loadDocuments();
            } catch (err) {
              alert('同步 docs 目录失败: ' + err.message);
              syncDocsBtn.disabled = false;
              syncDocsBtn.textContent = '📁 一键扫描并同步 docs 目录';
            }
          });
        }
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
            <button class="mini-btn btn-extract action-tag-btn" type="button" title="从文档提炼知识">提炼</button>
            <button class="mini-btn btn-revs" type="button">版本</button>
            <button class="mini-btn btn-edit" type="button">编辑</button>
            <button class="mini-btn btn-del danger-text" type="button">移出</button>
          </td>
        `;

        tr.querySelector('.btn-extract').addEventListener('click', () => this.showExtractDialog(d));
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

    this.loadProviderStatus();

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
            await this.loadDocuments();
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

  loadGraph() {
    const root = this.container.querySelector('#kn-graph-root');
    if (!root) return;
    if (!this.graphController) {
      this.graphController = new GraphController(root, this.workspaceId);
    } else {
      this.graphController.loadGraph();
    }
  }

  // --- 通用弹窗安全管理 ---

  openModal(html, setupFn) {
    const root = this.container.querySelector('#kn-dialogs-root');
    root.innerHTML = html;
    const dialog = root.querySelector('dialog');
    if (!dialog) return;

    let isClosed = false;
    const closeModal = () => {
      if (isClosed) return;
      isClosed = true;
      try {
        if (dialog.open) dialog.close();
      } catch {}
      root.innerHTML = '';
    };

    dialog.addEventListener('close', () => {
      closeModal();
    });

    root.querySelectorAll('.btn-close-modal').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.preventDefault();
        closeModal();
      });
    });

    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) {
        closeModal();
      }
    });

    dialog.showModal();
    if (setupFn) {
      setupFn(dialog, closeModal);
    }
  }

  // --- 弹窗逻辑 ---

  showCreateLibraryDialog() {
    const html = `
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

    this.openModal(html, (dialog, closeModal) => {
      dialog.querySelector('#kn-create-lib-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = dialog.querySelector('#kn-lib-name-input').value.trim();
        const description = dialog.querySelector('#kn-lib-desc-input').value.trim();
        const scope = dialog.querySelector('#kn-lib-scope-select').value;

        try {
          const created = await this.fetchApi('/libraries', {
            method: 'POST',
            body: { name, description, scope },
          });
          closeModal();
          if (created && created.id) {
            this.currentLibraryId = created.id;
          }
          await this.loadLibraries();
          alert(`知识库「${created.name}」创建成功！已切换为当前工作知识库。`);
        } catch (err) {
          alert('创建知识库失败: ' + err.message);
        }
      });
    });
  }

  showImportDocumentDialog() {
    const targetProjectLibId = `project:${this.workspaceId}`;
    const html = `
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

    this.openModal(html, (dialog, closeModal) => {
      const modeRadios = dialog.querySelectorAll('input[name="import-mode"]');
      modeRadios.forEach((r) => {
        r.addEventListener('change', () => {
          const isPath = r.value === 'path';
          dialog.querySelector('#wrap-import-content').hidden = isPath;
          dialog.querySelector('#wrap-import-path').hidden = !isPath;
        });
      });

      dialog.querySelector('#kn-import-doc-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const isPath = dialog.querySelector('input[name="import-mode"]:checked').value === 'path';
        const name = dialog.querySelector('#kn-import-name').value.trim();
        const content = dialog.querySelector('#kn-import-content').value;
        const path = dialog.querySelector('#kn-import-path').value.trim();

        const body = {
          libraryId: targetProjectLibId,
          name: name || undefined,
          content: !isPath ? content : undefined,
          path: isPath ? path : undefined,
        };

        try {
          await this.fetchApi('/documents', { method: 'POST', body });
          closeModal();
          await this.loadDocuments();
        } catch (err) {
          alert('导入文档失败: ' + err.message);
        }
      });
    });
  }

  showEditDocumentDialog(doc) {
    const html = `
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

    this.openModal(html, (dialog, closeModal) => {
      dialog.querySelector('#kn-edit-doc-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const content = dialog.querySelector('#kn-edit-content').value;

        try {
          const res = await this.fetchApi(`/documents/${doc.id}`, {
            method: 'PATCH',
            body: { content },
          });
          if (res.message) {
            alert(res.message);
          }
          closeModal();
          await this.loadDocuments();
        } catch (err) {
          alert('更新文档失败: ' + err.message);
        }
      });
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
    const html = `
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

    this.openModal(html, async (dialog, closeModal) => {
      const listBody = dialog.querySelector('.revisions-list-body');
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
    });
  }

  async loadProviderStatus() {
    try {
      const status = await this.fetchApi('/providers');
      const c7 = this.container.querySelector('#kn-status-context7');
      const fc = this.container.querySelector('#kn-status-firecrawl');
      if (c7) {
        c7.innerHTML = `Context7: <span class="${status.context7 ? 'sync-ready' : 'sync-error'}">${status.context7 ? '✓ 可用' : '未配置'}</span>`;
      }
      if (fc) {
        fc.innerHTML = `Firecrawl: <span class="${status.firecrawl ? 'sync-ready' : 'sync-error'}">${status.firecrawl ? '✓ 可用' : '未配置'}</span>`;
      }
    } catch {
      // 忽略检查异常
    }
  }

  showAddSourceDialog() {
    const html = `
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
              <option value="context7">Context7 公共文档 (context7)</option>
              <option value="firecrawl">Firecrawl 网页爬取 (firecrawl)</option>
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

    this.openModal(html, (dialog, closeModal) => {
      dialog.querySelector('#kn-add-source-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const kind = dialog.querySelector('#kn-source-kind').value;
        const locator = dialog.querySelector('#kn-source-locator').value.trim();
        const enabled = dialog.querySelector('#kn-source-enabled').checked;

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
          closeModal();
          await this.loadSources();
        } catch (err) {
          alert('添加来源失败: ' + err.message);
        }
      });
    });
  }

  async loadItems() {
    const tbody = this.container.querySelector('#kn-items-tbody');
    const countEl = this.container.querySelector('#kn-items-count');
    const filterSelect = this.container.querySelector('#kn-items-filter-status');
    if (!tbody) return;

    tbody.innerHTML = '<tr><td colspan="5" class="table-empty">加载沉淀条目中…</td></tr>';

    try {
      const status = filterSelect ? filterSelect.value : '';
      const query = status ? `?status=${encodeURIComponent(status)}` : '';
      const items = await this.fetchApi(`/items${query}`);

      if (countEl) countEl.textContent = `共 ${items.length} 条沉淀`;

      if (items.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="table-empty">暂无沉淀条目</td></tr>';
        return;
      }

      tbody.innerHTML = '';
      items.forEach((item) => {
        const tr = document.createElement('tr');
        const kindBadge = `<span class="evidence-kind-tag kind-${item.kind}">${escapeHtml(item.kind)}</span>`;
        const statusBadge = `<span class="citation-status-pill status-pill-${item.status}">${escapeHtml(item.status)}</span>`;

        tr.innerHTML = `
          <td>${kindBadge}</td>
          <td>${statusBadge}</td>
          <td>
            <div class="item-text">${escapeHtml(item.text)}</div>
            ${item.supersedes ? `<div class="item-supersedes" style="font-size: 11px; color: var(--text-muted, #888); margin-top: 4px;">替代旧条目: <code>${escapeHtml(item.supersedes)}</code></div>` : ''}
          </td>
          <td><code>${escapeHtml(item.applicability || '-')}</code></td>
          <td>
            <button class="mini-btn btn-correct-item action-tag-btn" type="button">纠错</button>
          </td>
        `;

        tr.querySelector('.btn-correct-item').addEventListener('click', () => {
          this.showCorrectItemDialog(item);
        });

        tbody.appendChild(tr);
      });
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="5" class="table-error">加载失败: ${escapeHtml(err.message)}</td></tr>`;
    }
  }

  showCorrectItemDialog(item) {
    const html = `
      <dialog id="kn-modal-correct" class="kn-modal">
        <div class="dialog-heading">
          <div class="dialog-title-group">
            <span class="dialog-badge">知识纠错</span>
            <h2>纠正沉淀条目</h2>
          </div>
          <button class="icon-button btn-close-modal" type="button">✕</button>
        </div>
        <form id="kn-correct-item-form" class="kn-form">
          <div class="form-row">
            <label>原条目内容</label>
            <div class="form-readonly-text" style="padding: 8px 12px; background: var(--bg-hover, rgba(0,0,0,0.05)); border-radius: 4px; font-size: 13px;">${escapeHtml(item.text)}</div>
          </div>
          <div class="form-row">
            <label>纠正后的新结论 / 文本</label>
            <textarea id="kn-correct-text" rows="4" class="form-textarea" required placeholder="输入纠正后的准确规则、决策或结论…"></textarea>
          </div>
          <div class="form-actions">
            <button type="button" class="ghost-btn btn-close-modal">取消</button>
            <button type="submit" class="send-button">确认纠错</button>
          </div>
        </form>
      </dialog>
    `;

    this.openModal(html, (dialog, closeModal) => {
      dialog.querySelector('#kn-correct-item-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const replacement = dialog.querySelector('#kn-correct-text').value.trim();
        if (!replacement) return;

        try {
          await this.fetchApi(`/items/${item.id}/correct`, {
            method: 'POST',
            body: { replacement },
          });
          closeModal();
          await this.loadItems();
        } catch (err) {
          alert('纠错失败: ' + err.message);
        }
      });
    });
  }

  async showExtractDialog(doc) {
    const html = `
      <dialog id="kn-modal-extract-review" class="kn-modal kn-modal-wide">
        <div class="dialog-heading">
          <div class="dialog-title-group">
            <span class="dialog-badge">知识提炼与沉淀</span>
            <h2>提炼文档知识: ${escapeHtml(doc.sourceKey)}</h2>
          </div>
          <button class="icon-button btn-close-modal" type="button">✕</button>
        </div>
        <div class="extract-review-banner">
          <span>💡 默认设为待验证候选（candidate），防止过时文档污染事实检索；勾选并确认后入库。</span>
          <div class="extract-batch-actions">
            <button type="button" class="mini-text-btn btn-select-all">全选</button>
            <button type="button" class="mini-text-btn btn-deselect-all">反选</button>
          </div>
        </div>
        <div class="extract-body-container">
          <div class="loading-spinner">正在分析文档结构并提炼核心决议、规范与经验…</div>
        </div>
        <div class="form-actions" style="margin-top: 16px;">
          <button type="button" class="ghost-btn btn-close-modal">取消</button>
          <button type="button" id="kn-btn-commit-extract" class="send-button" disabled>确认入库 (0 条)</button>
        </div>
      </dialog>
    `;

    this.openModal(html, async (dialog, closeModal) => {
      const bodyContainer = dialog.querySelector('.extract-body-container');
      const commitBtn = dialog.querySelector('#kn-btn-commit-extract');
      const selectAllBtn = dialog.querySelector('.btn-select-all');
      const deselectAllBtn = dialog.querySelector('.btn-deselect-all');

      try {
        const drafts = await this.fetchApi(`/documents/${doc.id}/extract/preview`, {
          method: 'POST',
          body: {},
        });

        if (!drafts || drafts.length === 0) {
          bodyContainer.innerHTML = '<div class="table-empty">未在此文档中提炼出明确的架构决议、约束或最佳实践条目。</div>';
          return;
        }

        bodyContainer.innerHTML = `
          <div class="extract-items-list" id="kn-extract-cards-list"></div>
        `;
        const cardsList = bodyContainer.querySelector('#kn-extract-cards-list');

        drafts.forEach((draft, idx) => {
          const card = document.createElement('div');
          card.className = 'extract-item-card';
          card.dataset.index = idx;

          const entityBadges = (draft.matchedEntityNames || [])
            .map((name) => `<span class="entity-badge">🏷️ ${escapeHtml(name)}</span>`)
            .join('');

          card.innerHTML = `
            <input type="checkbox" class="extract-item-cb" checked />
            <div class="extract-item-main">
              <div class="extract-item-controls">
                <select class="kn-mini-select draft-kind">
                  <option value="decision" ${draft.kind === 'decision' ? 'selected' : ''}>架构决策 (decision)</option>
                  <option value="observation" ${draft.kind === 'observation' ? 'selected' : ''}>规则约束 (observation)</option>
                  <option value="experience" ${draft.kind === 'experience' ? 'selected' : ''}>候选建议 (experience)</option>
                </select>
                <select class="kn-mini-select draft-status">
                  <option value="candidate" ${draft.status === 'candidate' ? 'selected' : ''}>候选待验证 (candidate)</option>
                  <option value="effective" ${draft.status === 'effective' ? 'selected' : ''}>正式生效 (effective)</option>
                </select>
                <span class="extract-line-tag">行 ${draft.startLine}</span>
              </div>
              <textarea class="extract-item-textarea draft-text" rows="2">${escapeHtml(draft.text)}</textarea>
              <div class="extract-item-meta">
                <div class="extract-snippet"><strong>原文:</strong> <code>${escapeHtml(draft.sourceSnippet || '')}</code></div>
                ${entityBadges ? `<div class="extract-entities"><strong>关联代码实体:</strong> ${entityBadges}</div>` : ''}
              </div>
            </div>
          `;
          cardsList.appendChild(card);
        });

        const updateCommitBtn = () => {
          const checkedCount = cardsList.querySelectorAll('.extract-item-cb:checked').length;
          commitBtn.textContent = `确认入库 (${checkedCount} 条)`;
          commitBtn.disabled = checkedCount === 0;
        };

        cardsList.querySelectorAll('.extract-item-cb').forEach((cb) => {
          cb.addEventListener('change', updateCommitBtn);
        });

        selectAllBtn.addEventListener('click', () => {
          cardsList.querySelectorAll('.extract-item-cb').forEach((cb) => (cb.checked = true));
          updateCommitBtn();
        });

        deselectAllBtn.addEventListener('click', () => {
          cardsList.querySelectorAll('.extract-item-cb').forEach((cb) => (cb.checked = !cb.checked));
          updateCommitBtn();
        });

        updateCommitBtn();

        commitBtn.addEventListener('click', async () => {
          const selectedDrafts = [];
          const cardEls = cardsList.querySelectorAll('.extract-item-card');
          cardEls.forEach((card) => {
            const cb = card.querySelector('.extract-item-cb');
            if (!cb.checked) return;
            const idx = parseInt(card.dataset.index, 10);
            const orig = drafts[idx];
            const kind = card.querySelector('.draft-kind').value;
            const status = card.querySelector('.draft-status').value;
            const text = card.querySelector('.draft-text').value.trim();
            if (!text) return;
            selectedDrafts.push({
              ...orig,
              kind,
              status,
              text,
            });
          });

          if (selectedDrafts.length === 0) return;

          commitBtn.disabled = true;
          commitBtn.textContent = '入库中…';
          try {
            const res = await this.fetchApi(`/documents/${doc.id}/extract/commit`, {
              method: 'POST',
              body: { items: selectedDrafts },
            });
            closeModal();
            alert(`提炼完成！成功沉淀 ${res.length} 条工程知识。`);
            await this.loadItems();
            await this.loadDocuments();
          } catch (err) {
            alert('提炼知识入库失败: ' + err.message);
            commitBtn.disabled = false;
            updateCommitBtn();
          }
        });
      } catch (err) {
        bodyContainer.innerHTML = `<div class="table-error">提炼预览失败: ${escapeHtml(err.message)}</div>`;
      }
    });
  }

  async showBatchExtractDialog() {
    const html = `
      <dialog id="kn-modal-extract-review" class="kn-modal kn-modal-wide">
        <div class="dialog-heading">
          <div class="dialog-title-group">
            <span class="dialog-badge">批量知识提炼</span>
            <h2>工作区文档批量提炼与沉淀</h2>
          </div>
          <button class="icon-button btn-close-modal" type="button">✕</button>
        </div>
        <div class="extract-review-banner">
          <span>💡 扫描工作区工程文档并提炼规则，确认后批量持久化并关联代码图谱。</span>
          <div class="extract-batch-actions">
            <button type="button" class="mini-text-btn btn-select-all">全选</button>
            <button type="button" class="mini-text-btn btn-deselect-all">反选</button>
          </div>
        </div>
        <div class="extract-body-container">
          <div class="loading-spinner">正在扫描工作区所有技术文档…</div>
        </div>
        <div class="form-actions" style="margin-top: 16px;">
          <button type="button" class="ghost-btn btn-close-modal">取消</button>
          <button type="button" id="kn-btn-commit-batch-extract" class="send-button" disabled>确认批量入库 (0 条)</button>
        </div>
      </dialog>
    `;

    this.openModal(html, async (dialog, closeModal) => {
      const bodyContainer = dialog.querySelector('.extract-body-container');
      const commitBtn = dialog.querySelector('#kn-btn-commit-batch-extract');
      const selectAllBtn = dialog.querySelector('.btn-select-all');
      const deselectAllBtn = dialog.querySelector('.btn-deselect-all');

      try {
        const results = await this.fetchApi('/extract-docs/preview', {
          method: 'POST',
          body: { libraryId: this.currentLibraryId || undefined },
        });

        const totalItems = (results || []).reduce((sum, r) => sum + (r.items ? r.items.length : 0), 0);

        if (!results || results.length === 0 || totalItems === 0) {
          bodyContainer.innerHTML = '<div class="table-empty">当前知识库文档中未检测到符合条件的知识条目。</div>';
          return;
        }

        bodyContainer.innerHTML = `
          <div class="extract-items-list" id="kn-extract-batch-list"></div>
        `;
        const batchList = bodyContainer.querySelector('#kn-extract-batch-list');

        results.forEach((docRes) => {
          if (!docRes.items || docRes.items.length === 0) return;

          const groupHeader = document.createElement('div');
          groupHeader.className = 'draft-group-header';
          groupHeader.innerHTML = `📄 <strong>${escapeHtml(docRes.sourceKey)}</strong> <span style="font-size: 11px; color: var(--text-muted); font-weight: normal;">(${docRes.items.length} 条)</span>`;
          batchList.appendChild(groupHeader);

          docRes.items.forEach((draft, idx) => {
            const card = document.createElement('div');
            card.className = 'extract-item-card';
            card.dataset.docId = docRes.documentId;
            card.dataset.index = idx;

            const entityBadges = (draft.matchedEntityNames || [])
              .map((name) => `<span class="entity-badge">🏷️ ${escapeHtml(name)}</span>`)
              .join('');

            card.innerHTML = `
              <input type="checkbox" class="extract-item-cb" checked />
              <div class="extract-item-main">
                <div class="extract-item-controls">
                  <select class="kn-mini-select draft-kind">
                    <option value="decision" ${draft.kind === 'decision' ? 'selected' : ''}>架构决策 (decision)</option>
                    <option value="observation" ${draft.kind === 'observation' ? 'selected' : ''}>规则约束 (observation)</option>
                    <option value="experience" ${draft.kind === 'experience' ? 'selected' : ''}>候选建议 (experience)</option>
                  </select>
                  <select class="kn-mini-select draft-status">
                    <option value="candidate" ${draft.status === 'candidate' ? 'selected' : ''}>候选待验证 (candidate)</option>
                    <option value="effective" ${draft.status === 'effective' ? 'selected' : ''}>正式生效 (effective)</option>
                  </select>
                  <span class="extract-line-tag">行 ${draft.startLine}</span>
                </div>
                <textarea class="extract-item-textarea draft-text" rows="2">${escapeHtml(draft.text)}</textarea>
                <div class="extract-item-meta">
                  <div class="extract-snippet"><strong>原文:</strong> <code>${escapeHtml(draft.sourceSnippet || '')}</code></div>
                  ${entityBadges ? `<div class="extract-entities"><strong>关联代码实体:</strong> ${entityBadges}</div>` : ''}
                </div>
              </div>
            `;
            batchList.appendChild(card);
          });
        });

        const updateCommitBtn = () => {
          const checkedCount = batchList.querySelectorAll('.extract-item-cb:checked').length;
          commitBtn.textContent = `确认批量入库 (${checkedCount} 条)`;
          commitBtn.disabled = checkedCount === 0;
        };

        batchList.querySelectorAll('.extract-item-cb').forEach((cb) => {
          cb.addEventListener('change', updateCommitBtn);
        });

        selectAllBtn.addEventListener('click', () => {
          batchList.querySelectorAll('.extract-item-cb').forEach((cb) => (cb.checked = true));
          updateCommitBtn();
        });

        deselectAllBtn.addEventListener('click', () => {
          batchList.querySelectorAll('.extract-item-cb').forEach((cb) => (cb.checked = !cb.checked));
          updateCommitBtn();
        });

        updateCommitBtn();

        commitBtn.addEventListener('click', async () => {
          const docMap = new Map();
          const cardEls = batchList.querySelectorAll('.extract-item-card');
          cardEls.forEach((card) => {
            const cb = card.querySelector('.extract-item-cb');
            if (!cb.checked) return;
            const docId = card.dataset.docId;
            const idx = parseInt(card.dataset.index, 10);
            const docRes = results.find((r) => r.documentId === docId);
            if (!docRes) return;
            const orig = docRes.items[idx];
            const kind = card.querySelector('.draft-kind').value;
            const status = card.querySelector('.draft-status').value;
            const text = card.querySelector('.draft-text').value.trim();
            if (!text) return;
            if (!docMap.has(docId)) {
              docMap.set(docId, []);
            }
            docMap.get(docId).push({
              ...orig,
              kind,
              status,
              text,
            });
          });

          if (docMap.size === 0) return;

          commitBtn.disabled = true;
          commitBtn.textContent = '批量入库中…';
          let totalCommitted = 0;
          try {
            for (const [docId, items] of docMap.entries()) {
              const committed = await this.fetchApi(`/documents/${docId}/extract/commit`, {
                method: 'POST',
                body: { items },
              });
              totalCommitted += committed.length;
            }
            closeModal();
            alert(`批量提炼完成！成功沉淀 ${totalCommitted} 条工程知识。`);
            await this.loadItems();
            await this.loadDocuments();
          } catch (err) {
            alert('批量入库过程中发生错误: ' + err.message);
            commitBtn.disabled = false;
            updateCommitBtn();
          }
        });
      } catch (err) {
        bodyContainer.innerHTML = `<div class="table-error">批量提炼扫描失败: ${escapeHtml(err.message)}</div>`;
      }
    });
  }
}
