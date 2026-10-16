// file:list 分页缓存（audit R7a P1-20）
//
// 旧版 file:list 一次性返回全部 entries + files，10000 文件 ≈ 1.5-2MB IPC
// payload，结构化克隆 + 渲染端 JSON.parse 都要 30-100ms，首次启动 cold paint
// 明显卡顿。改成「首次 200 + 分页」+ 模块级 cache：scan 一次切片多次返回，
// 避免 loadMore 反复触发全量 scanDir。
//
// 缓存失效：调用方在 file:write / file:create / file:delete / file:rename 成功
// 后调 invalidate()，下一次 file:list / file:list:more 重扫。简化策略：不做
// 精细 dirty entry 合并，整条缓存丢掉。scanDir 1-3s 是「极端大目录（OneDrive
// 1w 文件）」的最坏值，普通 < 100ms，重扫成本可控。
//
// 设计要点：
//   - cache 严格按 dir 区分（Folder Browser 走 file:scan-dir 用 absDir，与根
//     file:list 的 dataRoot 是不同 dir，互不污染）。
//   - 不做 TTL：写操作主动失效是单一来源；fs-watcher 的 emitFilesChanged 不
//     影响 file:list cache（cache 只服务「分页拉取」，fs-watcher 走的是另
//     一条 IPC 通道）。
//   - slice 边界由调用方保证（offset / limit 已经在 main.js file:list handler
//     里做过 safe* 夹紧）；本模块只做"拿/建缓存 → 切片"。

/** @typedef {{ ok:true, dir:string, entries:Array } | { ok:false, error:string, code?:string, message?:string }} ScanResult */

/** 缓存项 */
let _cache = null; // { dir, entries, files, total, at }

/** 强制失效（写操作成功后调用） */
function invalidate() {
  _cache = null;
}

/**
 * 拉或建 file:list 缓存。dir 变化或缓存被显式失效时重扫。
 * @param {string} dir - 绝对路径
 * @param {(dir: string) => Promise<ScanResult>} scanFn - scanDir 注入（测试可换 mock）
 * @returns {Promise<
 *   { dir:string, entries:Array, files:Array, total:number, at:number }
 *   | { error: ScanResult }
 * >}
 */
async function getOrBuild(dir, scanFn) {
  if (_cache && _cache.dir === dir) return _cache;
  const result = await scanFn(dir);
  if (!result.ok) return { error: result };
  const entries = result.entries || [];
  // files = 非文件夹条目（侧栏历史逻辑兼容：state.files 仅含文件）
  const files = entries
    .filter((e) => !e.isFolder)
    .map((e) => ({ name: e.name, path: e.path, size: e.size, mtimeMs: e.mtimeMs, entryType: e.entryType }));
  _cache = { dir, entries, files, total: entries.length, at: Date.now() };
  return _cache;
}

/** 拿一份当前缓存的快照（不改）。test hook：单测断言缓存是否被命中/失效。 */
function peek() {
  return _cache;
}

/** test hook：强制设缓存（不调 scanFn）。 */
function _setForTest(cache) {
  _cache = cache;
}

module.exports = {
  getOrBuild,
  invalidate,
  peek,
  _setForTest,
};
