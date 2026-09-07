/**
 * 用户角色类型定义：
 * - owner (拥有者): 最高权限管理者，拥有所有工具调用权限（包括系统级 Bash 执行）。
 * - collaborator (协作者): 团队开发/普通成员，拥有除高危系统操作（如 Bash）外的大部分工具权限。
 * - guest (访客): 受限临时用户，仅拥有只读检索、计算和信息查询类安全工具权限。
 */
export type Role = 'owner' | 'collaborator' | 'guest';

/**
 * 用户身份上下文结构体
 */
export interface UserIdentity {
  /** 唯一用户 ID */
  id: string;
  /** 用户姓名或账号显示名 */
  name: string;
  /** 分配的安全角色 */
  role: Role;
}

/**
 * 角色与工具访问控制策略表（RBAC 策略映射）：
 *
 * 策略配置说明：
 * - allow: 允许调用的工具列表，或通配符 '*'（代表允许所有工具）。
 * - deny: 显式黑名单列表，其优先级高于 allow（黑名单优先命中策略）。
 */
const TOOL_ACCESS: Record<Role, { allow: string[] | '*'; deny: string[] }> = {
  // 拥有者：无黑名单，允许使用所有已注册工具
  owner: {
    allow: '*',
    deny: [],
  },
  // 协作者：允许大部分工具，但显式禁止直接调用系统级终端执行工具（bash）
  collaborator: {
    allow: '*',
    deny: ['bash'],
  },
  // 访客：仅白名单放行只读探索、本地文件读取、RAG 检索以及无害辅助工具
  guest: {
    allow: [
      'get_weather',
      'calculator',
      'read_file',
      'list_directory',
      'glob',
      'grep',
      'rag_search',
    ],
    deny: [],
  },
};

/**
 * 校验指定角色是否具备调用某工具的权限。
 *
 * 鉴权判定逻辑（黑名单优先机制）：
 * 1. 若工具名出现在该角色的 deny 黑名单中，直接返回 false（拒绝）；
 * 2. 若该角色的 allow 为 '*'（通配符），则允许调用，返回 true；
 * 3. 否则检查该工具名是否包含在 allow 白名单数组中。
 *
 * @param role 用户角色
 * @param toolName 待调用的工具名称
 * @returns 是否允许执行
 */
export function canUseTool(role: Role, toolName: string): boolean {
  const access = TOOL_ACCESS[role];
  // 1. 黑名单优先拦截
  if (access.deny.includes(toolName)) return false;
  // 2. 通配符全部放行
  if (access.allow === '*') return true;
  // 3. 白名单匹配校验
  return access.allow.includes(toolName);
}

/**
 * 批量过滤工具列表，仅返回当前角色有权访问的工具名称集合。
 *
 * 常用于构建当前角色的可用工具集、生成 System Prompt 中的工具声明清单。
 *
 * @param toolNames 待筛选的工具名称数组
 * @param role 用户角色
 * @returns 当前角色允许访问的工具名称数组
 */
export function filterToolsForRole(toolNames: string[], role: Role): string[] {
  return toolNames.filter((name) => canUseTool(role, name));
}

