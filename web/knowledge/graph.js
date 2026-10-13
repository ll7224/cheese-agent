/**
 * 代码结构与局部实体图谱交互视图 (web/knowledge/graph.js)
 * 采用原生 SVG 与确定性环形布局，支持平移、缩放、点击查看证据与一键填入解释草稿。
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

const KIND_COLORS = {
  file: '#2563eb',
  function: '#7c3aed',
  class: '#059669',
  interface: '#d97706',
  type: '#ea580c',
  package: '#4b5563',
  variable: '#0284c7',
};

export class GraphController {
  constructor(container, workspaceId) {
    this.container = container;
    this.workspaceId = workspaceId;
    this.hops = 1;
    this.selectedEntityId = '';
    this.selectedNode = null;
    this.graphData = { generation: 0, nodes: [], edges: [], truncated: false };

    // 视口平移与缩放状态
    this.scale = 1.0;
    this.translateX = 0;
    this.translateY = 0;
    this.isPanning = false;
    this.panStartX = 0;
    this.panStartY = 0;

    this.renderShell();
    this.bindEvents();
    this.loadGraph();
  }

  renderShell() {
    this.container.innerHTML = `
      <div class="graph-wrapper">
        <div class="graph-toolbar">
          <div class="graph-controls-left">
            <input type="text" id="graph-entity-search" class="kn-input graph-search-input" placeholder="输入实体名、路径或留空以总览…" />
            <label class="graph-hops-label">
              <span>跳数:</span>
              <select id="graph-hops-select" class="kn-mini-select">
                <option value="1" selected>1 跳 (上限 60 节点)</option>
                <option value="2">2 跳 (上限 120 节点)</option>
              </select>
            </label>
            <button id="graph-refresh-btn" class="action-tag-btn" type="button">🔄 查询图谱</button>
          </div>
          <div class="graph-controls-right">
            <span id="graph-status-info" class="graph-status-text">加载中…</span>
            <div class="graph-zoom-group">
              <button id="graph-zoom-in" class="icon-button" title="放大">＋</button>
              <button id="graph-zoom-out" class="icon-button" title="缩小">－</button>
              <button id="graph-zoom-reset" class="icon-button" title="重置视图">⟲</button>
            </div>
          </div>
        </div>

        <div id="graph-truncated-banner" class="graph-banner-warning" hidden>
          ⚠ 局部节点超过显示上限，已自动截断。可点击具体节点聚焦缩减范围。
        </div>

        <div class="graph-canvas-container">
          <svg id="graph-svg" class="graph-svg" width="100%" height="600">
            <defs>
              <marker id="arrow" viewBox="0 0 10 10" refX="28" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#64748b" />
              </marker>
              <marker id="arrow-selected" viewBox="0 0 10 10" refX="28" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#3b82f6" />
              </marker>
            </defs>
            <g id="graph-viewport">
              <g id="graph-edges-layer"></g>
              <g id="graph-nodes-layer"></g>
            </g>
          </svg>

          <!-- 右侧代码证据与详情侧边栏 -->
          <div id="graph-detail-sidebar" class="graph-detail-sidebar" hidden>
            <div class="sidebar-header">
              <h3 class="sidebar-title">代码实体证据</h3>
              <button id="graph-close-sidebar" class="icon-button" type="button">✕</button>
            </div>
            <div class="sidebar-body">
              <div class="detail-row">
                <span class="detail-label">名称:</span>
                <span id="node-detail-name" class="detail-value font-mono font-bold"></span>
              </div>
              <div class="detail-row">
                <span class="detail-label">类型:</span>
                <span id="node-detail-kind" class="detail-badge"></span>
              </div>
              <div class="detail-row">
                <span class="detail-label">路径:</span>
                <span id="node-detail-path" class="detail-value font-mono text-sm"></span>
              </div>
              <div class="detail-row">
                <span class="detail-label">行号:</span>
                <span id="node-detail-lines" class="detail-value"></span>
              </div>
              <div class="detail-section">
                <div class="section-title">源码片段证据</div>
                <pre class="snippet-code-box"><code id="node-detail-code"></code></pre>
              </div>
              <div class="sidebar-footer">
                <button id="node-explain-btn" class="send-button w-full" type="button">
                  📝 填入会话草稿解释代码
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  bindEvents() {
    const searchInput = this.container.querySelector('#graph-entity-search');
    const hopsSelect = this.container.querySelector('#graph-hops-select');
    const refreshBtn = this.container.querySelector('#graph-refresh-btn');
    const zoomInBtn = this.container.querySelector('#graph-zoom-in');
    const zoomOutBtn = this.container.querySelector('#graph-zoom-out');
    const zoomResetBtn = this.container.querySelector('#graph-zoom-reset');
    const closeSidebarBtn = this.container.querySelector('#graph-close-sidebar');
    const explainBtn = this.container.querySelector('#node-explain-btn');
    const svg = this.container.querySelector('#graph-svg');

    refreshBtn.addEventListener('click', () => {
      this.selectedEntityId = searchInput.value.trim();
      this.hops = Number(hopsSelect.value) === 2 ? 2 : 1;
      this.loadGraph();
    });

    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        refreshBtn.click();
      }
    });

    hopsSelect.addEventListener('change', () => {
      this.hops = Number(hopsSelect.value) === 2 ? 2 : 1;
      this.loadGraph();
    });

    zoomInBtn.addEventListener('click', () => {
      this.setScale(this.scale * 1.2);
    });

    zoomOutBtn.addEventListener('click', () => {
      this.setScale(this.scale / 1.2);
    });

    zoomResetBtn.addEventListener('click', () => {
      this.scale = 1.0;
      this.translateX = 0;
      this.translateY = 0;
      this.updateViewportTransform();
    });

    closeSidebarBtn.addEventListener('click', () => {
      this.container.querySelector('#graph-detail-sidebar').hidden = true;
      this.selectedNode = null;
      this.highlightSelection();
    });

    explainBtn.addEventListener('click', () => {
      if (!this.selectedNode) return;
      const promptEl = document.getElementById('prompt');
      if (promptEl) {
        promptEl.value = `请解释代码实体 ${this.selectedNode.name} (${this.selectedNode.path}:${this.selectedNode.startLine || 1}-${this.selectedNode.endLine || 1}) 的设计意图、内部逻辑与关联影响：`;
        promptEl.dispatchEvent(new Event('input', { bubbles: true }));
        window.location.hash = '#workbench';
        promptEl.focus();
      }
    });

    // 鼠标拖拽平移与滚轮缩放
    svg.addEventListener('mousedown', (e) => {
      if (e.target.closest('.graph-node')) return;
      this.isPanning = true;
      this.panStartX = e.clientX - this.translateX;
      this.panStartY = e.clientY - this.translateY;
      svg.style.cursor = 'grabbing';
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.isPanning) return;
      this.translateX = e.clientX - this.panStartX;
      this.translateY = e.clientY - this.panStartY;
      this.updateViewportTransform();
    });

    window.addEventListener('mouseup', () => {
      if (this.isPanning) {
        this.isPanning = false;
        svg.style.cursor = 'default';
      }
    });

    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      this.setScale(this.scale * factor);
    });
  }

  setScale(newScale) {
    this.scale = Math.max(0.2, Math.min(3.0, newScale));
    this.updateViewportTransform();
  }

  updateViewportTransform() {
    const viewport = this.container.querySelector('#graph-viewport');
    if (viewport) {
      viewport.setAttribute(
        'transform',
        `translate(${this.translateX}, ${this.translateY}) scale(${this.scale})`
      );
    }
  }

  async loadGraph() {
    const statusInfo = this.container.querySelector('#graph-status-info');
    statusInfo.textContent = '加载图谱中…';

    try {
      const url = `/api/v1/workspaces/${this.workspaceId}/knowledge/graph?entityId=${encodeURIComponent(
        this.selectedEntityId
      )}&hops=${this.hops}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.graphData = await res.json();

      this.renderGraph();
    } catch (err) {
      statusInfo.textContent = `加载失败: ${err.message}`;
    }
  }

  renderGraph() {
    const statusInfo = this.container.querySelector('#graph-status-info');
    const banner = this.container.querySelector('#graph-truncated-banner');
    const nodesLayer = this.container.querySelector('#graph-nodes-layer');
    const edgesLayer = this.container.querySelector('#graph-edges-layer');

    const nodes = this.graphData.nodes || [];
    const edges = this.graphData.edges || [];

    statusInfo.textContent = `共 ${nodes.length} 个节点, ${edges.length} 条关系`;
    banner.hidden = !this.graphData.truncated;

    nodesLayer.innerHTML = '';
    edgesLayer.innerHTML = '';

    if (nodes.length === 0) {
      nodesLayer.innerHTML = `
        <text x="300" y="250" text-anchor="middle" fill="#94a3b8" font-size="16">
          暂无关联代码结构或实体
        </text>
      `;
      return;
    }

    // 计算确定性环形坐标布局
    const positions = this.computeLayout(nodes, edges);

    // 绘制边
    for (const edge of edges) {
      const p1 = positions.get(edge.source);
      const p2 = positions.get(edge.target);
      if (!p1 || !p2) continue;

      const isCandidate = edge.status === 'candidate';
      const edgeGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      edgeGroup.setAttribute('class', 'graph-edge');
      edgeGroup.dataset.edgeId = edge.id;
      edgeGroup.dataset.source = edge.source;
      edgeGroup.dataset.target = edge.target;

      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', p1.x);
      line.setAttribute('y1', p1.y);
      line.setAttribute('x2', p2.x);
      line.setAttribute('y2', p2.y);
      line.setAttribute('stroke', isCandidate ? '#f59e0b' : '#94a3b8');
      line.setAttribute('stroke-width', '1.5');
      if (isCandidate) {
        line.setAttribute('stroke-dasharray', '4,4');
      }
      line.setAttribute('marker-end', 'url(#arrow)');

      const midX = (p1.x + p2.x) / 2;
      const midY = (p1.y + p2.y) / 2;
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', midX);
      text.setAttribute('y', midY - 4);
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('font-size', '10');
      text.setAttribute('fill', isCandidate ? '#d97706' : '#64748b');
      text.textContent = isCandidate ? `${edge.kind} (待验证)` : edge.kind;

      edgeGroup.appendChild(line);
      edgeGroup.appendChild(text);
      edgesLayer.appendChild(edgeGroup);
    }

    // 绘制节点
    for (const node of nodes) {
      const pos = positions.get(node.id);
      if (!pos) continue;

      const color = KIND_COLORS[node.kind] || '#64748b';
      const nodeGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      nodeGroup.setAttribute('class', 'graph-node');
      nodeGroup.setAttribute('transform', `translate(${pos.x}, ${pos.y})`);
      nodeGroup.dataset.nodeId = node.id;
      nodeGroup.style.cursor = 'pointer';

      // 外圈光晕 (选中时高亮)
      const halo = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      halo.setAttribute('r', '26');
      halo.setAttribute('class', 'node-halo');
      halo.setAttribute('fill', 'none');
      halo.setAttribute('stroke', '#3b82f6');
      halo.setAttribute('stroke-width', '3');
      halo.setAttribute('opacity', '0');

      // 主圆
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('r', '20');
      circle.setAttribute('fill', color);
      circle.setAttribute('stroke', '#ffffff');
      circle.setAttribute('stroke-width', '2');

      // 种类缩写标签
      const kindText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      kindText.setAttribute('text-anchor', 'middle');
      kindText.setAttribute('dy', '4');
      kindText.setAttribute('fill', '#ffffff');
      kindText.setAttribute('font-size', '11');
      kindText.setAttribute('font-weight', 'bold');
      kindText.textContent = (node.kind || 'E').slice(0, 2).toUpperCase();

      // 名称标签
      const nameText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      nameText.setAttribute('text-anchor', 'middle');
      nameText.setAttribute('y', '34');
      nameText.setAttribute('fill', 'var(--text, #1e293b)');
      nameText.setAttribute('font-size', '11');
      nameText.setAttribute('font-family', 'monospace');
      const displayName = node.name.length > 18 ? node.name.slice(0, 16) + '…' : node.name;
      nameText.textContent = displayName;

      nodeGroup.appendChild(halo);
      nodeGroup.appendChild(circle);
      nodeGroup.appendChild(kindText);
      nodeGroup.appendChild(nameText);

      nodeGroup.addEventListener('click', (e) => {
        e.stopPropagation();
        this.selectNode(node);
      });

      nodesLayer.appendChild(nodeGroup);
    }
  }

  /**
   * 确定性环形布局计算
   */
  computeLayout(nodes, edges) {
    const positions = new Map();
    const width = 800;
    const height = 600;
    const cx = width / 2;
    const cy = height / 2;

    if (nodes.length === 1) {
      positions.set(nodes[0].id, { x: cx, y: cy });
      return positions;
    }

    // 寻找根节点 (与 selectedEntityId 匹配，或入度最多的节点)
    let rootNode = nodes.find(
      (n) => n.id === this.selectedEntityId || n.name === this.selectedEntityId
    );
    if (!rootNode) {
      rootNode = nodes[0];
    }

    positions.set(rootNode.id, { x: cx, y: cy });

    // 计算 1 跳邻居
    const hop1 = [];
    const hop2 = [];
    const rootId = rootNode.id;

    for (const node of nodes) {
      if (node.id === rootId) continue;
      const isNeighbor = edges.some(
        (e) =>
          (e.source === rootId && e.target === node.id) ||
          (e.target === rootId && e.source === node.id)
      );
      if (isNeighbor) {
        hop1.push(node);
      } else {
        hop2.push(node);
      }
    }

    // 排布 1 跳环 (R = 190)
    const R1 = Math.min(220, Math.max(140, 25 * hop1.length));
    for (let i = 0; i < hop1.length; i++) {
      const angle = (2 * Math.PI * i) / hop1.length - Math.PI / 2;
      positions.set(hop1[i].id, {
        x: cx + R1 * Math.cos(angle),
        y: cy + R1 * Math.sin(angle),
      });
    }

    // 排布 2 跳环 (R = 340)
    const R2 = R1 + 150;
    for (let j = 0; j < hop2.length; j++) {
      const angle = (2 * Math.PI * j) / (hop2.length || 1) - Math.PI / 2;
      positions.set(hop2[j].id, {
        x: cx + R2 * Math.cos(angle),
        y: cy + R2 * Math.sin(angle),
      });
    }

    return positions;
  }

  async selectNode(node) {
    this.selectedNode = node;
    this.highlightSelection();

    const sidebar = this.container.querySelector('#graph-detail-sidebar');
    sidebar.hidden = false;

    this.container.querySelector('#node-detail-name').textContent = node.name;
    const kindBadge = this.container.querySelector('#node-detail-kind');
    kindBadge.textContent = node.kind;
    kindBadge.style.backgroundColor = KIND_COLORS[node.kind] || '#64748b';
    this.container.querySelector('#node-detail-path').textContent = node.path;
    this.container.querySelector(
      '#node-detail-lines'
    ).textContent = `第 ${node.startLine || 1} - ${node.endLine || 1} 行`;

    const codeBox = this.container.querySelector('#node-detail-code');
    codeBox.textContent = '加载代码证据中…';

    try {
      const url = `/api/v1/workspaces/${this.workspaceId}/knowledge/graph/evidence?nodeId=${encodeURIComponent(
        node.id
      )}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        codeBox.textContent = data.snippet || '(未找到代码片段)';
      } else {
        codeBox.textContent = `(加载证据失败: HTTP ${res.status})`;
      }
    } catch (err) {
      codeBox.textContent = `(加载失败: ${err.message})`;
    }
  }

  highlightSelection() {
    const selectedId = this.selectedNode?.id;
    const allHalos = this.container.querySelectorAll('.node-halo');
    const allEdges = this.container.querySelectorAll('.graph-edge line');

    for (const halo of allHalos) {
      const parent = halo.closest('.graph-node');
      if (parent && parent.dataset.nodeId === selectedId) {
        halo.setAttribute('opacity', '1');
      } else {
        halo.setAttribute('opacity', '0');
      }
    }

    for (const line of allEdges) {
      const parent = line.closest('.graph-edge');
      if (
        selectedId &&
        (parent.dataset.source === selectedId || parent.dataset.target === selectedId)
      ) {
        line.setAttribute('stroke', '#3b82f6');
        line.setAttribute('stroke-width', '2.5');
        line.setAttribute('marker-end', 'url(#arrow-selected)');
      } else {
        line.setAttribute('stroke-width', '1.5');
        line.setAttribute('marker-end', 'url(#arrow)');
      }
    }
  }
}
