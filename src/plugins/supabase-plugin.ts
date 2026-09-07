import type { PluginDefinition, PluginApi } from './types.js';

/**
 * 示例业务插件：Supabase 数据库操作插件。
 *
 * 核心演示点：
 * 1. 声明式配置声明：使用 `${SUPABASE_URL}` / `${SUPABASE_KEY}` 自动映射系统环境变量；
 * 2. 优雅降级（Graceful Fallback）：如果环境变量未设置，自动以 Mock 模式运行，保证测试与演示不中断；
 * 3. 动态工具组注入：向 Agent 注入 `list_tables`、`query`、`insert` 等数据操作工具；
 * 4. 资源生命周期释放：通过 destroy 钩子释放资源。
 */
export const supabasePlugin: PluginDefinition = {
  name: 'supabase',
  version: '1.0.0',
  description: '提供 Supabase 数据库操作能力（query / insert / list_tables）',
  config: {
    supabaseUrl: '${SUPABASE_URL}',
    supabaseKey: '${SUPABASE_KEY}',
  },

  /**
   * 插件激活主流程
   */
  activate(api: PluginApi) {
    const config = api.getConfig();
    const url = config.supabaseUrl as string;
    const key = config.supabaseKey as string;

    // 检查配置，如果缺失凭据则提示并降级为本地 Mock 模式
    if (!url || !key) {
      api.log('未配置 SUPABASE_URL / SUPABASE_KEY，使用 Mock 模式');
    }

    // 向宿主系统的 ToolRegistry 注册插件工具
    // （在宿主中实际注册的名字会变为 supabase__list_tables、supabase__query、supabase__insert）
    api.registerTools([
      // 工具 1：查看所有数据表结构
      {
        name: 'list_tables',
        description: '列出数据库中所有表',
        parameters: { type: 'object', properties: {}, required: [] },
        isConcurrencySafe: true,
        isReadOnly: true,
        execute: async () => {
          if (!url) {
            return JSON.stringify({
              tables: ['users', 'posts', 'comments', 'sessions'],
              note: 'Mock 模式 — 配置 SUPABASE_URL 和 SUPABASE_KEY 连接真实数据库',
            });
          }
          return `连接 ${url} 查询表列表...`;
        },
      },
      // 工具 2：条件检索数据
      {
        name: 'query',
        description: '查询指定表的数据，支持 select / where / limit',
        parameters: {
          type: 'object',
          properties: {
            table: { type: 'string', description: '表名' },
            select: { type: 'string', description: '查询字段，默认 *' },
            where: { type: 'string', description: '过滤条件，如 status=active' },
            limit: { type: 'number', description: '返回条数限制，默认 10' },
          },
          required: ['table'],
        },
        isConcurrencySafe: true,
        isReadOnly: true,
        execute: async (input: { table: string; select?: string; where?: string; limit?: number }) => {
          const { table, select = '*', where, limit = 10 } = input;
          if (!url) {
            // Mock 数据集
            const mockData: Record<string, any[]> = {
              users: [
                { id: 1, name: '张三', email: 'zhang@example.com', role: 'admin' },
                { id: 2, name: '李四', email: 'li@example.com', role: 'user' },
                { id: 3, name: '王五', email: 'wang@example.com', role: 'user' },
              ],
              posts: [
                { id: 1, title: 'Agent 开发入门', author_id: 1, status: 'published' },
                { id: 2, title: 'Plugin 架构设计', author_id: 1, status: 'draft' },
              ],
            };
            const rows = mockData[table] || [];
            let filtered = rows;
            if (where) {
              const [field, value] = where.split('=');
              filtered = rows.filter((r) => String(r[field]) === value);
            }
            return JSON.stringify({ table, rows: filtered.slice(0, limit), total: filtered.length });
          }
          return `SELECT ${select} FROM ${table}${where ? ` WHERE ${where}` : ''} LIMIT ${limit}`;
        },
      },
      // 工具 3：插入记录
      {
        name: 'insert',
        description: '向指定表插入一条记录',
        parameters: {
          type: 'object',
          properties: {
            table: { type: 'string', description: '表名' },
            data: { type: 'object', description: '要插入的数据' },
          },
          required: ['table', 'data'],
        },
        isConcurrencySafe: false,
        isReadOnly: false,
        execute: async (input: { table: string; data: Record<string, unknown> }) => {
          const { table, data } = input;
          if (!url) {
            return JSON.stringify({
              success: true,
              table,
              inserted: { id: Math.floor(Math.random() * 1000), ...data },
              note: 'Mock 模式',
            });
          }
          return `INSERT INTO ${table} — ${JSON.stringify(data)}`;
        },
      },
    ]);

    api.log(`已注册 3 个工具（list_tables / query / insert）`);
  },

  /**
   * 插件卸载时的销毁回调
   */
  destroy() {
    console.log('  [plugin:supabase] 连接已释放');
  },
};
