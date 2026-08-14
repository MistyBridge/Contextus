// server 侧 git 只读工具（复用核心层 git 封装，不新增业务逻辑）
import { git } from "../../src/git.js";

/**
 * 世界线 tip 指纹——与核心层 twin.ts 会话内缓存失效依据一致：
 * 任何提交 / 分支 / drop 都会改变 refs/context 的 for-each-ref 输出。
 * 指纹变化 = 树数据失效，server 据此广播 tree-changed。
 */
export function tipsFingerprint(cwd: string): string {
  return git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/context"], cwd);
}
