/**
 * 知识中心视图模版与 DOM 构建 (web/knowledge/views.js)
 * Impeccable Kinpaku (金箔) Design System - Operate Mode
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

// Crisp, consistent SVG icons (16x16, stroke="currentColor", stroke-width="1.5")
const ICONS = {
  document: `<svg class="kn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M3 2.5A1.5 1.5 0 0 1 4.5 1h5l4 4v8.5a1.5 1.5 0 0 1-1.5 1.5h-7.5A1.5 1.5 0 0 1 3 13.5v-11z"/><polyline points="9 1 9 5 13 5"/></svg>`,
  sources: `<svg class="kn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><polygon points="8 1.5 14.5 5 8 8.5 1.5 5 8 1.5"/><polyline points="1.5 8 8 11.5 14.5 8"/><polyline points="1.5 11 8 14.5 14.5 11"/></svg>`,
  agent: `<svg class="kn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="2" y="4" width="12" height="10" rx="2"/><circle cx="5.5" cy="8.5" r="1" fill="currentColor"/><circle cx="10.5" cy="8.5" r="1" fill="currentColor"/><line x1="8" y1="1" x2="8" y2="4"/><line x1="5" y1="12" x2="11" y2="12"/></svg>`,
  graph: `<svg class="kn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="4" cy="4" r="2"/><circle cx="12" cy="4" r="2"/><circle cx="8" cy="12" r="2"/><line x1="5.5" y1="5.5" x2="6.8" y2="10.2"/><line x1="10.5" y1="5.5" x2="9.2" y2="10.2"/></svg>`,
  items: `<svg class="kn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M6 14h4m-3 1.5h2M8 1.5a4.5 4.5 0 0 0-3.5 7.5c.7.7 1.5 1.8 1.5 2.5h4c0-.7.8-1.8 1.5-2.5A4.5 4.5 0 0 0 8 1.5z"/></svg>`,
  search: `<svg class="kn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><line x1="10.5" y1="10.5" x2="14.5" y2="14.5"/></svg>`,
  plus: `<svg class="kn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><line x1="8" y1="3" x2="8" y2="13"/><line x1="3" y1="8" x2="13" y2="8"/></svg>`,
  link: `<svg class="kn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M6.5 9.5a3.5 3.5 0 0 0 5 0l2-2a3.5 3.5 0 0 0-5-5L7.5 3.5"/><path d="M9.5 6.5a3.5 3.5 0 0 0-5 0l-2 2a3.5 3.5 0 0 0 5 5l1-1"/></svg>`,
  trash: `<svg class="kn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><polyline points="2 4 14 4"/><path d="M5 4V2.5A1.5 1.5 0 0 1 6.5 1h3A1.5 1.5 0 0 1 11 2.5V4m2 0v9.5A1.5 1.5 0 0 1 11.5 15h-7A1.5 1.5 0 0 1 3 13.5V4h10z"/></svg>`,
  scan: `<svg class="kn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M1.5 3.5A1.5 1.5 0 0 1 3 2h3.5l2 2H13a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 13 14H3a1.5 1.5 0 0 1-1.5-1.5v-9z"/><polyline points="5.5 8.5 7.5 10.5 10.5 7"/></svg>`,
  sparkle: `<svg class="kn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M8 1v3M8 12v3M1 8h3M12 8h3M3 3l2.2 2.2M10.8 10.8L13 13M3 13l2.2-2.2M10.8 5.2L13 3"/></svg>`,
  refresh: `<svg class="kn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M14 2.5v4h-4"/><path d="M2 13.5v-4h4"/><path d="M13.2 6.5A6 6 0 0 0 3.3 4.5L2 6.5"/><path d="M2.8 9.5a6 6 0 0 0 9.9 2l1.3-2"/></svg>`,
  import: `<svg class="kn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M8 2v9m0 0-3-3m3 3 3-3"/><path d="M2 11v2.5A1.5 1.5 0 0 0 3.5 15h9a1.5 1.5 0 0 0 1.5-1.5V11"/></svg>`,
  close: `<svg class="kn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><line x1="3.5" y1="3.5" x2="12.5" y2="12.5"/><line x1="12.5" y1="3.5" x2="3.5" y2="12.5"/></svg>`,
};

export function buildKnowledgeShell() {
  const container = document.createElement('div');
  container.className = 'knowledge-container';
  container.innerHTML = `
    <!-- Top Bar: Title, Context and Library Selector -->
    <header class="knowledge-header">
      <div class="knowledge-title-group">
        <div class="knowledge-title-row">
          <h1 class="knowledge-main-title">工程知识中心</h1>
          <span class="knowledge-scope-badge" id="kn-scope-badge">当前工作区</span>
        </div>
        <p class="knowledge-desc">管理工作区多维知识库、本地代码与规范同步、智能体绑定与版本追踪。</p>
      </div>

      <div class="knowledge-header-actions">
        <div class="lib-selector-card">
          <label for="kn-lib-select" class="lib-label">当前库</label>
          <div class="kn-select-wrapper">
            <select id="kn-lib-select" class="kn-select" aria-label="选择当前知识库"></select>
          </div>
        </div>
        <div class="header-button-group">
          <button id="kn-manage-workspaces-btn" class="kn-btn kn-btn-secondary" type="button" title="管理此知识库绑定的工作区">
            ${ICONS.link}
            <span>绑定工作区</span>
          </button>
          <button id="kn-delete-lib-btn" class="kn-btn kn-btn-danger" type="button" title="删除当前选中的知识库">
            ${ICONS.trash}
            <span>删除库</span>
          </button>
          <button id="kn-create-lib-btn" class="kn-btn kn-btn-primary" type="button" title="创建新的工程知识库">
            ${ICONS.plus}
            <span>新建知识库</span>
          </button>
        </div>
      </div>
    </header>

    <!-- Search Section -->
    <section class="knowledge-search-bar" aria-label="工程知识混合检索">
      <div class="search-input-group">
        <span class="search-icon-wrap">${ICONS.search}</span>
        <input id="kn-search-input" class="search-input" type="search" placeholder="在当前知识库中检索源码事实、架构决议与经验规则…" autocomplete="off" />
        <kbd class="kn-search-kbd">↵ Enter</kbd>
      </div>
      <div class="search-options">
        <label class="search-mode-label" for="kn-search-mode">
          <span class="mode-label-text">模式</span>
          <select id="kn-search-mode" class="kn-mini-select">
            <option value="fact">事实模式 (仅已生效)</option>
            <option value="experience">经验模式 (含候选经验)</option>
          </select>
        </label>
        <button id="kn-search-btn" class="kn-btn kn-btn-accent" type="button">
          ${ICONS.search}
          <span>检索测试</span>
        </button>
      </div>
    </section>

    <!-- Search Results Panel -->
    <section id="kn-search-results" class="kn-search-results-panel" hidden aria-label="检索结果列表">
      <div class="results-header">
        <div class="results-heading-group">
          <span class="results-title">检索结果</span>
          <span class="results-count-chip" id="kn-search-count-chip">0 条匹配</span>
        </div>
        <button id="kn-close-search-btn" class="kn-btn-icon" type="button" aria-label="关闭检索结果">
          ${ICONS.close}
        </button>
      </div>
      <div id="kn-search-hits" class="results-hits-list"></div>
    </section>

    <!-- Navigation Tabs -->
    <nav class="knowledge-nav-tabs" role="tablist" aria-label="知识中心功能导航">
      <button class="kn-tab-btn active" data-tab="documents" role="tab" aria-selected="true" type="button">
        ${ICONS.document}
        <span>资料列表</span>
      </button>
      <button class="kn-tab-btn" data-tab="sources" role="tab" aria-selected="false" type="button">
        ${ICONS.sources}
        <span>来源清单与同步</span>
      </button>
      <button class="kn-tab-btn" data-tab="bindings" role="tab" aria-selected="false" type="button">
        ${ICONS.agent}
        <span>智能体绑定</span>
      </button>
      <button class="kn-tab-btn" data-tab="graph" role="tab" aria-selected="false" type="button">
        ${ICONS.graph}
        <span>代码图谱</span>
      </button>
      <button class="kn-tab-btn" data-tab="items" role="tab" aria-selected="false" type="button">
        ${ICONS.items}
        <span>沉淀与经验</span>
      </button>
    </nav>

    <!-- Tab Contents -->
    <main class="knowledge-tab-content">
      <!-- 资料列表 Tab -->
      <section id="kn-tab-documents" class="kn-tab-pane active" role="tabpanel">
        <div class="pane-toolbar">
          <div class="toolbar-left">
            <span class="toolbar-stat" id="kn-docs-count">共 0 篇文档</span>
          </div>
          <div class="toolbar-right">
            <button id="kn-scan-docs-toolbar-btn" class="kn-btn kn-btn-secondary" type="button">
              ${ICONS.scan}
              <span>扫描并同步 docs/</span>
            </button>
            <button id="kn-extract-all-docs-btn" class="kn-btn kn-btn-secondary" type="button">
              ${ICONS.sparkle}
              <span>批量提炼知识</span>
            </button>
            <button id="kn-import-doc-btn" class="kn-btn kn-btn-primary" type="button">
              ${ICONS.plus}
              <span>导入文档</span>
            </button>
          </div>
        </div>
        <div class="table-container">
          <table class="kn-table">
            <thead>
              <tr>
                <th style="width: 26%;">文档路径 / 标识</th>
                <th style="width: 14%;">来源 ID</th>
                <th style="width: 14%;">生效版本</th>
                <th style="width: 12%;">状态</th>
                <th style="width: 18%;">更新时间</th>
                <th style="width: 16%; text-align: right;">操作</th>
              </tr>
            </thead>
            <tbody id="kn-docs-tbody">
              <tr><td colspan="6" class="table-empty">加载中…</td></tr>
            </tbody>
          </table>
        </div>
        <div class="kn-pagination">
          <button id="kn-docs-prev-btn" class="kn-btn kn-btn-secondary kn-btn-sm" type="button">上一页</button>
          <span id="kn-docs-page-info" class="page-info">第 1 页</span>
          <button id="kn-docs-next-btn" class="kn-btn kn-btn-secondary kn-btn-sm" type="button">下一页</button>
        </div>
      </section>

      <!-- 来源与同步 Tab -->
      <section id="kn-tab-sources" class="kn-tab-pane" role="tabpanel" hidden>
        <div class="pane-toolbar">
          <div class="toolbar-left">
            <span class="toolbar-stat" id="kn-sources-count">已配置来源</span>
          </div>
          <div class="toolbar-right">
            <button id="kn-import-legacy-btn" class="kn-btn kn-btn-secondary" type="button">
              ${ICONS.import}
              <span>导入旧版知识库</span>
            </button>
            <button id="kn-add-source-btn" class="kn-btn kn-btn-primary" type="button">
              ${ICONS.plus}
              <span>添加来源</span>
            </button>
          </div>
        </div>
        <div class="table-container">
          <table class="kn-table">
            <thead>
              <tr>
                <th style="width: 12%;">来源类型</th>
                <th style="width: 36%;">路径定位符 (Locator)</th>
                <th style="width: 10%;">启用</th>
                <th style="width: 14%;">同步状态</th>
                <th style="width: 16%;">上次同步</th>
                <th style="width: 12%; text-align: right;">操作</th>
              </tr>
            </thead>
            <tbody id="kn-sources-tbody">
              <tr><td colspan="6" class="table-empty">加载中…</td></tr>
            </tbody>
          </table>
        </div>

        <!-- Providers Status Card -->
        <div class="providers-status-section">
          <div class="providers-status-left">
            <span class="providers-label">公共来源提供方</span>
            <div class="providers-badges">
              <span id="kn-status-context7" class="provider-pill">Context7: <span class="kn-badge-pending">检测中…</span></span>
              <span id="kn-status-firecrawl" class="provider-pill">Firecrawl: <span class="kn-badge-pending">检测中…</span></span>
            </div>
          </div>
          <span class="providers-hint">通过 CONTEXT7_API_KEY / FIRECRAWL_API_KEY 环境变量开启</span>
        </div>

        <!-- Auto Discovery Section -->
        <div class="discovery-section">
          <div class="discovery-header">
            <div class="discovery-title-group">
              <span class="discovery-title">自动发现建议</span>
              <p class="discovery-desc">系统检测到当前工作区中存在以下未启用的工程文档目录或文件：</p>
            </div>
            <button id="kn-refresh-discover-btn" class="kn-btn kn-btn-secondary kn-btn-sm" type="button">
              ${ICONS.refresh}
              <span>重新检测</span>
            </button>
          </div>
          <div id="kn-discovery-list" class="discovery-list"></div>
        </div>
      </section>

      <!-- 智能体绑定 Tab -->
      <section id="kn-tab-bindings" class="kn-tab-pane" role="tabpanel" hidden>
        <div class="pane-toolbar">
          <div class="toolbar-left">
            <span class="toolbar-stat">配置各智能体 (Agent) 默认可检索访问的知识库</span>
          </div>
        </div>
        <div id="kn-bindings-container" class="bindings-grid"></div>
      </section>

      <!-- 代码图谱 Tab -->
      <section id="kn-tab-graph" class="kn-tab-pane" role="tabpanel" hidden>
        <div id="kn-graph-root"></div>
      </section>

      <!-- 沉淀与经验 Tab -->
      <section id="kn-tab-items" class="kn-tab-pane" role="tabpanel" hidden>
        <div class="pane-toolbar">
          <div class="toolbar-left">
            <span class="toolbar-stat" id="kn-items-count">共 0 条沉淀</span>
            <div class="filter-wrap">
              <select id="kn-items-filter-status" class="kn-mini-select" aria-label="筛选沉淀状态">
                <option value="">全部状态</option>
                <option value="effective">已生效 (Effective)</option>
                <option value="candidate">候选建议 (Candidate)</option>
                <option value="needs_review">待复核 (Needs Review)</option>
                <option value="invalidated">已失效 (Invalidated)</option>
              </select>
            </div>
          </div>
          <div class="toolbar-right">
            <button id="kn-refresh-items-btn" class="kn-btn kn-btn-secondary" type="button">
              ${ICONS.refresh}
              <span>刷新沉淀</span>
            </button>
          </div>
        </div>
        <div class="table-container">
          <table class="kn-table">
            <thead>
              <tr>
                <th style="width: 100px;">类型</th>
                <th style="width: 100px;">状态</th>
                <th>内容与结论</th>
                <th style="width: 160px;">适用环境</th>
                <th style="width: 100px; text-align: right;">操作</th>
              </tr>
            </thead>
            <tbody id="kn-items-tbody">
              <tr><td colspan="5" class="table-empty">加载中…</td></tr>
            </tbody>
          </table>
        </div>
      </section>
    </main>

    <!-- 弹窗容器 -->
    <div id="kn-dialogs-root"></div>
  `;

  return container;
}
