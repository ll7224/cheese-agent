/**
 * 知识中心视图模版与 DOM 构建 (web/knowledge/views.js)
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

export function buildKnowledgeShell() {
  const container = document.createElement('div');
  container.className = 'knowledge-container';
  container.innerHTML = `
    <div class="knowledge-header">
      <div class="knowledge-title-group">
        <div class="knowledge-badge-row">
          <span class="knowledge-core-badge">ENGINEERING KNOWLEDGE</span>
          <span class="knowledge-scope-badge" id="kn-scope-badge">当前工作区</span>
        </div>
        <h1 class="knowledge-main-title">工程知识中心</h1>
        <p class="knowledge-desc">管理工作区多维知识库、本地来源同步、智能体绑定与版本追踪。</p>
      </div>
      <div class="knowledge-header-actions">
        <div class="lib-selector-wrap">
          <label for="kn-lib-select" class="lib-label">当前知识库:</label>
          <select id="kn-lib-select" class="kn-select"></select>
        </div>
        <button id="kn-create-lib-btn" class="action-tag-btn" type="button">＋ 新建知识库</button>
      </div>
    </div>

    <div class="knowledge-search-bar">
      <div class="search-input-group">
        <span class="search-icon">🔍</span>
        <input id="kn-search-input" class="search-input" placeholder="在当前知识库中搜索源码事实、规范与经验…" />
      </div>
      <div class="search-options">
        <label class="search-mode-label">
          <span>模式:</span>
          <select id="kn-search-mode" class="kn-mini-select">
            <option value="fact">事实模式 (仅已生效)</option>
            <option value="experience">经验模式 (含候选经验)</option>
          </select>
        </label>
        <button id="kn-search-btn" class="send-button kn-search-button" type="button">检索测试</button>
      </div>
    </div>

    <div id="kn-search-results" class="kn-search-results-panel" hidden>
      <div class="results-header">
        <span class="results-title">检索结果</span>
        <button id="kn-close-search-btn" class="icon-button" type="button">✕</button>
      </div>
      <div id="kn-search-hits" class="results-hits-list"></div>
    </div>

    <div class="knowledge-nav-tabs">
      <button class="kn-tab-btn active" data-tab="documents" type="button">📄 资料列表</button>
      <button class="kn-tab-btn" data-tab="sources" type="button">🌐 来源清单与同步</button>
      <button class="kn-tab-btn" data-tab="bindings" type="button">🤖 智能体绑定</button>
      <button class="kn-tab-btn" data-tab="graph" type="button">🕸 代码图谱</button>
      <button class="kn-tab-btn" data-tab="items" type="button">💡 沉淀与经验</button>
    </div>

    <div class="knowledge-tab-content">
      <!-- 资料列表 Tab -->
      <section id="kn-tab-documents" class="kn-tab-pane active">
        <div class="pane-toolbar">
          <div class="toolbar-left">
            <span class="toolbar-stat" id="kn-docs-count">共 0 篇文档</span>
          </div>
          <div class="toolbar-right">
            <button id="kn-import-doc-btn" class="action-tag-btn" type="button">＋ 导入文档</button>
          </div>
        </div>
        <div class="table-container">
          <table class="kn-table">
            <thead>
              <tr>
                <th>文档路径 / 标识</th>
                <th>来源 ID</th>
                <th>生效版本</th>
                <th>状态</th>
                <th>更新时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody id="kn-docs-tbody">
              <tr><td colspan="6" class="table-empty">加载中…</td></tr>
            </tbody>
          </table>
        </div>
        <div class="kn-pagination">
          <button id="kn-docs-prev-btn" class="mini-text-btn" type="button">上一页</button>
          <span id="kn-docs-page-info" class="page-info">第 1 页</span>
          <button id="kn-docs-next-btn" class="mini-text-btn" type="button">下一页</button>
        </div>
      </section>

      <!-- 来源与同步 Tab -->
      <section id="kn-tab-sources" class="kn-tab-pane" hidden>
        <div class="pane-toolbar">
          <div class="toolbar-left">
            <span class="toolbar-stat" id="kn-sources-count">已配置来源</span>
          </div>
          <div class="toolbar-right">
            <button id="kn-add-source-btn" class="action-tag-btn" type="button">＋ 添加来源</button>
          </div>
        </div>
        <div class="table-container">
          <table class="kn-table">
            <thead>
              <tr>
                <th>来源类型</th>
                <th>路径定位符 (Locator)</th>
                <th>是否启用</th>
                <th>同步状态</th>
                <th>上次同步</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody id="kn-sources-tbody">
              <tr><td colspan="6" class="table-empty">加载中…</td></tr>
            </tbody>
          </table>
        </div>

        <div class="discovery-section">
          <div class="discovery-header">
            <span class="discovery-title">🔍 自动发现建议</span>
            <button id="kn-refresh-discover-btn" class="mini-text-btn" type="button">重新检测</button>
          </div>
          <p class="discovery-desc">系统检测到当前工作区中存在以下未启用的工程文档目录或文件：</p>
          <div id="kn-discovery-list" class="discovery-list"></div>
        </div>
      </section>

      <!-- 智能体绑定 Tab -->
      <section id="kn-tab-bindings" class="kn-tab-pane" hidden>
        <div class="pane-toolbar">
          <span class="toolbar-stat">配置各智能体 (Agent) 默认可检索访问的知识库</span>
        </div>
        <div id="kn-bindings-container" class="bindings-grid"></div>
      </section>

      <!-- 代码图谱 Tab -->
      <section id="kn-tab-graph" class="kn-tab-pane" hidden>
        <div id="kn-graph-root"></div>
      </section>

      <!-- 沉淀与经验 Tab -->
      <section id="kn-tab-items" class="kn-tab-pane" hidden>
        <div class="pane-toolbar">
          <div class="toolbar-left">
            <span class="toolbar-stat" id="kn-items-count">共 0 条沉淀</span>
            <select id="kn-items-filter-status" class="kn-mini-select">
              <option value="">全部状态</option>
              <option value="effective">已生效 (Effective)</option>
              <option value="candidate">候选建议 (Candidate)</option>
              <option value="needs_review">待复核 (Needs Review)</option>
              <option value="invalidated">已失效 (Invalidated)</option>
            </select>
          </div>
          <div class="toolbar-right">
            <button id="kn-refresh-items-btn" class="action-tag-btn" type="button">🔄 刷新沉淀</button>
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
                <th style="width: 120px;">操作</th>
              </tr>
            </thead>
            <tbody id="kn-items-tbody">
              <tr><td colspan="5" class="table-empty">加载中…</td></tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>

    <!-- 弹窗容器 -->
    <div id="kn-dialogs-root"></div>
  `;

  return container;
}
