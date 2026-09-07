/**
 * 命令风险级别定义：
 * - 'safe': 安全命令，通常为只读或无害操作（如 ls, pwd, cat, git status 等）。
 * - 'moderate': 中等风险命令，具有一定的写操作或变更影响（如 rm 普通文件, git push, git reset, kill 进程等），执行时打印告警日志。
 * - 'dangerous': 高危危险命令，可能导致系统崩溃、数据永久丢失、越权提权或外部恶意入侵（如 rm -rf, sudo, mkfs, fork 炸弹, curl | sh 等），默认直接拦截拒绝执行！
 */
export type RiskLevel = 'safe' | 'moderate' | 'dangerous';

/**
 * 命令安全检测与分类判定结果
 */
interface ClassifyResult {
  /** 评估出的风险等级 */
  level: RiskLevel;
  /** 命中危险/中危规则时的原因解释 */
  reason?: string;
}

/**
 * 高危命令匹配规则库（直接拦截，拒绝执行）。
 *
 * 覆盖场景：
 * 1. 强制递归删除关键目录或任意文件（如 rm -rf, rm --force）；
 * 2. Linux/Unix 系统提权操作（sudo / su）；
 * 3. 底层磁盘格式化与设备直写（mkfs, dd of=/dev/）；
 * 4. 经典的 Linux 拒绝服务 Fork 炸弹（:(){ :|:& };:）；
 * 5. 管道下载并执行未知远程脚本（curl | bash, wget | sh）；
 * 6. 危险的 eval 动态执行与直接覆写系统级配置目录（如 /etc/）。
 */
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*-rf\b|.*--force)/, reason: '强制删除文件' },
  { pattern: /\brm\s+-[a-zA-Z]*r/, reason: '递归删除' },
  { pattern: /\bsudo\b/, reason: '提权操作' },
  { pattern: /\bmkfs\b/, reason: '格式化磁盘' },
  { pattern: /\bdd\s+.*of=\/dev\//, reason: '直接写设备' },
  { pattern: /:\(\)\s*\{.*\|.*&\s*\}/, reason: 'Fork bomb' },
  { pattern: /\bcurl\b.*\|\s*(ba)?sh/, reason: '远程脚本执行' },
  { pattern: /\beval\b/, reason: 'eval 动态执行' },
  { pattern: />\s*\/etc\//, reason: '覆写系统配置' },
];

/**
 * 中危命令匹配规则库（放行但记录黄色预警日志）。
 *
 * 覆盖场景：
 * 1. 普通文件删除（rm）；
 * 2. 代码版本控制的远程推送（git push）；
 * 3. 丢弃工作区和历史记录的硬重置（git reset --hard）；
 * 4. 终止系统进程（kill）；
 * 5. 发布公共包（npm publish）。
 */
const MODERATE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\b/, reason: '删除文件' },
  { pattern: /\bgit\s+push\b/, reason: 'Git 推送' },
  { pattern: /\bgit\s+reset\s+--hard\b/, reason: 'Git 硬重置' },
  { pattern: /\bkill\b/, reason: '终止进程' },
  { pattern: /\bnpm\s+publish\b/, reason: '发布 npm 包' },
];

/**
 * 对待执行的 Shell/Bash 命令进行静态语法与敏感模式分析。
 *
 * 评估顺序（短路防御原则）：
 * 1. 优先比对 DANGEROUS 规则，只要命中任意一条立即评为 'dangerous'；
 * 2. 其次比对 MODERATE 规则，命中则评为 'moderate'；
 * 3. 全部未命中则视为 'safe'。
 *
 * @param command 待执行的终端命令字符串
 * @returns 分类判定结果（包含风险等级与拦截理由）
 */
export function classifyBashCommand(command: string): ClassifyResult {
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return { level: 'dangerous', reason };
    }
  }
  for (const { pattern, reason } of MODERATE_PATTERNS) {
    if (pattern.test(command)) {
      return { level: 'moderate', reason };
    }
  }
  return { level: 'safe' };
}

