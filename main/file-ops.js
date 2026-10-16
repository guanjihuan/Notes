// 文件操作 helper（Stage 7 抽出 + Folder Browser 扩展）
//
// 职责：
//   - 暴露 file IPC 所需的可测试纯函数（isWithinDataDir / resolveFileName / scanFiles / scanDir / classifyEntry）
//   - 不包含 ipcMain 注册逻辑（仍留在 main.js，与 config-store 的拆分风格一致）
//
// 边界：
//   - 不引用 mainWindow / ipcMain / shell —— 这些留在 main.js 里就近注册
//   - 不读 configStore —— 由调用方注入数据目录
//   - scanFiles 的 ENOENT 行为：返回错误（不再静默 mkdir）——
//     防止「数据目录被外部删了之后被自动重建掩盖数据丢失」
//     见 audit #3
//
// Folder Browser（2026-08）：
//   - scanDir(absDir) 返回一层所有条目（文件夹 + 文件），含 entryType 分类
//   - 文件分类由 classifyEntry(name) 完成：'folder' | 'editable' | 'binary'
//   - EDITABLE_EXTS（来自 shared/extension-lists.js）是「可打开 + 编辑」
//     的扩展名白名单；markdown (.md/.markdown) 与常见纯文本均在内
//
// 测试：tests/unit/file-ops.test.js（jsdom 环境之外；纯 Node 即可）

const fs = require('fs').promises;
const path = require('path');
// 单一事实源：扩展名白名单（main + preload + renderer 三处共用）
const { EDITABLE_EXTS } = require('../shared/extension-lists.js');
// 单一事实源：errno → 中文提示（main + renderer 共享，preload 过桥）
const { friendlyFsError: sharedFriendlyFsError } = require('../shared/friendly-fs-error.js');
// P2-1：tmp 路径生成走加密安全随机（crypto.randomUUID），不再用 Math.random
const { generateTmpPath } = require('./generate-tmp-path.js');
const { fsyncParentDir } = require('./fsync-parent-dir.js');

/** 单文件大小上限（5 MB），防止超大文件冻结 renderer。 */
const MAX_FILE_SIZE = 5 * 1024 * 1024;

/**
 * atomicWriteFile 产生的 tmp 文件名匹配规则：`<name>.<editableExt>.tmp.<pid>.<ts>.<rand>`。
 * cleanupStaleFileTmpFiles 用它判断哪些 .tmp.* 是自家产物需要清理。
 * 严格要求 pid / ts / rand 三段：pid 与 ts 必须数字，rand 是 generateTmpPath 生成的
 * 36 位带连字符 UUID（见 main/generate-tmp-path.js，`crypto.randomUUID()`，P2-1 升级而来，
 * 旧版是 6 字符小写 base36）。
 *
 * 旧版 `\.tmp\.\d+\.\d+\.[a-z0-9]+$` 太宽 —— 把 `report.tmp.2024.1234567.abcdef` 这种
 * 用户合法文件也匹配上，24h 跨进程阈值后会被静默 unlink。要求 .tmp. 前一段是
 * EDITABLE_EXTS 之一（白名单扩展名）把误伤清零；rand 段允许连字符以匹配 UUID。
 */
const ATOMIC_TMP_RE = new RegExp(
  '\\.(?:' + Array.from(EDITABLE_EXTS).map((e) => e.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('|') +
  ')\\.tmp\\.\\d+\\.\\d+\\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
  'i',
);

/**
 * 检查 fullPath 的占用情况 —— 返回三种状态：
 *   - 'free'       路径不存在，可用
 *   - 'file'       路径已被一个文件占用，需要重命名避让
 *   - 'directory'  路径已被一个目录占用（用户手动 mkdir 出来），也需要避让
 *
 * 审计修复 (Round 11 deep-fix P2-4)：旧版用 fs.access() 只能判断「存在与否」，
 * 不能区分 file vs directory。用户新建笔记取名 `foo.md` 但数据目录里已经有一个
 * 同名目录（手动 mkdir 出来的笔记文件夹），resolveFileName 直接把目录路径当成
 * 可用文件返回；后续 atomicWriteFile 打开目录路径得到 EISDIR，UI 弹「无效参数」
 * 误导信息。改用 fs.stat() 拿 dirent 类型确认。
 */
async function pathOccupancy(fullPath) {
  try {
    const st = await fs.stat(fullPath);
    if (st.isDirectory()) return 'directory';
    if (st.isFile()) return 'file';
    // socket / fifo / device —— 数据目录里不应出现，但既然存在也当占用
    return 'file';
  } catch (e) {
    if (e && e.code === 'ENOENT') return 'free';
    // EACCES / EPERM 等：保守起见当「占用」，让上层走避让分支
    return 'file';
  }
}

/**
 * 给一个文件名分类为 folder / editable / binary。
 * 纯函数：不读文件系统、不感知 path —— 仅看 name 末尾扩展名。
 *
 * 注意：folder 类型由调用方（scanDir）传入时显式标记，
 * 本函数在 entryType === 'folder' 时不会被调用（参见 scanDir 内部）。
 *
 * @param {string} name
 * @returns {'editable'|'binary'}
 */
function classifyEntry(name) {
  if (typeof name !== 'string' || !name) return 'binary';
  const dot = name.lastIndexOf('.');
  // 没有扩展名 → binary
  if (dot < 0) return 'binary';
  const ext = name.slice(dot + 1).toLowerCase();
  // 隐藏文件 / 末尾多余点：扩展名部分为空（".env" 有扩展名 "env"，不是这种）
  if (!ext) return 'binary';
  // dot === 0 的隐藏文件名（如 ".gitignore"）：扩展名部分非空但不在白名单 → binary
  // 注意 ".env" 现在会走 EDITABLE_EXTS.has('env') → 'editable'（修旧版的列表/链接割裂 bug）
  return EDITABLE_EXTS.has(ext) ? 'editable' : 'binary';
}

/**
 * 拒绝 symlink：Notes 用户的工作流是「编辑自己数据目录里的 .md」，
 * 数据目录里出现 symlink 通常来自外部同步盘 / 误操作 / 恶意数据，
 * 写 symlink 会跟随到外部真实文件，绕过 isWithinDataDir 边界。
 * 见 audit #7。
 *
 * @param {string} filePath
 * @returns {Promise<{ok: true, isFile: boolean} | {ok: false, error: string, code?: string}>}
 */
async function assertNotSymlink(filePath) {
  let st;
  try {
    st = await fs.lstat(filePath);
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: true, isFile: false }; // 不存在：留给调用方走 FILE_NOT_FOUND 路径
    return { ok: false, error: e.message, code: e.code };
  }
  if (st.isSymbolicLink()) {
    return { ok: false, error: 'SYMLINK_NOT_ALLOWED', message: '不允许编辑符号链接（防止越权写入）' };
  }
  return { ok: true, isFile: st.isFile() };
}

/**
 * audit fix (M1 main)：递归检查 filePath 与其祖先（直到 stopAt 目录），
 * 任一层级出现 symlink 即拒绝。光检查 target 文件不够 —— 若父目录是 symlink
 * 指向 dataDir 外部，整个 target 的「真实路径」就会跳出 dataDir，绕过
 * isWithinDataDir 的字符串前缀检查。同步盘 / 误操作 / 外部攻击都可能制造
 * 这种中间层 symlink。
 *
 * 策略：从 filePath 父目录开始向上 lstat，到 stopAt（一般是 dataDir）为止，
 * 任一是 symlink 就拒绝。stopAt 本身允许是 symlink？通常不允许，但它的边界
 * 由 assertDataDirSafe 等其它检查负责，这里只覆盖 target 这棵子树。
 *
 * @param {string} filePath - 目标文件路径
 * @param {string} [stopAt] - 终止祖先链的目录（默认不传 = 一路 lstat 到根，
 *   但调用方一般会传 dataDir 来限定范围）
 * @returns {Promise<{ok:true} | {ok:false, error:string, code?:string}>}
 */
async function assertNoSymlinkAncestor(filePath, stopAt) {
  if (!filePath) return { ok: false, error: 'INVALID_PATH', code: 'INVALID_PATH', message: '路径不能为空' };
  const stopResolved = stopAt ? path.resolve(stopAt) : null;
  // audit fix (Phase O fix)：原实现只从 filePath 的**父目录**开始向上 lstat，
  // 漏掉 filePath 自身。若 filePath 本身是 symlink（指向外部目标盘），父目录
  // 通常都是合法的 dataDir 子项，但 filePath 本身跟随 symlink 解析后就跳到
  // dataDir 之外 —— isWithinDataDir 的字符串前缀边界被绕过。
  // 先 lstat filePath 自身：在 stopResolved 子树里也要拒绝自身是 symlink 的场景。
  const resolvedPath = path.resolve(filePath);

  // 边界情形（filePath === stopAt，例如 file:list 以 (dataRoot, dataRoot) 校验
  // 数据根自身）：只查 filePath 自身是否 symlink，不再向上遍历祖先。
  // 旧逻辑在边界相等时跳过自检查、却从 dirname(filePath) 一路 lstat 到根 ——
  // 既漏掉对 dataRoot 自身的检查（审计威胁模型的核心场景），又会把合法的
  // symlinked /home 等祖先误判成 SYMLINK_NOT_ALLOWED，导致根目录列表永久失败。
  const isBoundary = !!stopResolved && resolvedPath === stopResolved;
  if (isBoundary) {
    try {
      const stSelf = await fs.lstat(resolvedPath);
      if (stSelf.isSymbolicLink()) {
        return {
          ok: false,
          error: 'SYMLINK_NOT_ALLOWED',
          code: 'SYMLINK_NOT_ALLOWED',
          message: `路径中包含符号链接，不允许编辑（${resolvedPath}）`,
        };
      }
    } catch (e) {
      // ENOENT：目标本身不存在是允许的（scan-dir 创建场景、新文件）；其它错误上报
      if (e.code !== 'ENOENT') {
        return { ok: false, error: e.message, code: e.code, message: `读取路径状态失败：${e.code || e.message}` };
      }
    }
    return { ok: true };
  }

  if (!stopResolved || resolvedPath !== stopResolved) {
    try {
      const stSelf = await fs.lstat(resolvedPath);
      if (stSelf.isSymbolicLink()) {
        return {
          ok: false,
          error: 'SYMLINK_NOT_ALLOWED',
          code: 'SYMLINK_NOT_ALLOWED',
          message: `路径中包含符号链接，不允许编辑（${resolvedPath}）`,
        };
      }
    } catch (e) {
      // ENOENT：目标本身不存在是允许的（scan-dir 创建场景、新文件）；其它错误上报
      if (e.code !== 'ENOENT') {
        return { ok: false, error: e.message, code: e.code, message: `读取路径状态失败：${e.code || e.message}` };
      }
    }
  }
  let dir = path.dirname(resolvedPath);
  // 已经走到根盘符 / 根目录就停
  const seen = new Set();
  while (dir && !seen.has(dir)) {
    seen.add(dir);
    // 终止祖先链的判定：stopAt 目录已检查过、不再向上 lstat。
    // audit fix (main-M10)：之前三连 OR 里 `dir === stopResolved.toLowerCase?.()`
    // 是死分支 —— dir 来自 path.dirname()，Windows 上是混合大小写，根本不会
    // 全小写化。删掉，只保留 POSIX 严格相等 + Windows 大小写无关两条。
    if (stopResolved && (dir === stopResolved
        || (process.platform === 'win32' && dir.toLowerCase() === stopResolved.toLowerCase()))) {
      break;
    }
    try {
      const st = await fs.lstat(dir);
      if (st.isSymbolicLink()) {
        return {
          ok: false,
          error: 'SYMLINK_NOT_ALLOWED',
          code: 'SYMLINK_NOT_ALLOWED',
          message: `路径中包含符号链接目录，不允许编辑（${dir}）`,
        };
      }
    } catch (e) {
      // 父目录不存在是允许的（target 可能尚未创建）；其它错误上报
      if (e.code !== 'ENOENT') {
        // audit fix (K1-R4)：统一带 code + message 字段，与 assertNotSymlink 对齐。
        return { ok: false, error: e.message, code: e.code, message: `读取目录状态失败：${e.code || e.message}` };
      }
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // 已经到盘符根
    dir = parent;
  }
  return { ok: true };
}

/**
 * 检查目标路径是否在数据目录内（防止越权读写）
 * - Windows 不区分大小写
 * - 字符串前缀比对（path.resolve 后再做）
 * - 未调用 fs.realpath（symlink 不解）；file:write/rename/delete 已先 lstat 拒绝 symlink
 *
 * @param {string} target
 * @param {string} root
 */
function isWithinDataDir(target, root) {
  if (!root || !target) return false;
  const rootResolved = path.resolve(root);
  const targetResolved = path.resolve(target);
  if (process.platform === 'win32') {
    const rootLower = rootResolved.toLowerCase();
    const targetLower = targetResolved.toLowerCase();
    return targetLower.startsWith(rootLower + path.sep)
        || targetLower === rootLower;
  }
  return targetResolved === rootResolved
      || targetResolved.startsWith(rootResolved + path.sep);
}

/**
 * 文件名清洗：拒绝路径分隔符 / `..` / 空字符串 / 控制字符；用户输入的扩展名
 * 原样保留；重名 (2)、(3)...。
 *
 * audit fix (Phase L3-FS 4A/4B)：拒绝 Windows 保留字符（<>:"/\\|?*）和保留设备名
 * (CON / PRN / AUX / NUL / COM1-9 / LPT1-9)。之前 name 里含 `|` 或 `:` 仍能通过
 * resolveFileName，到 fs.rename 才在 Windows 上撞 EPERM/EBUSY，UI 弹出
 * 「没有重命名权限 / 文件被占用」误导性中文。预先拒绝给清晰的中文错误。
 *
 * 用户反馈（2026-08-28）：「新建笔记时直接把后缀放在文件名后面，而不是自动
 * 加上」—— 本函数不再强制补 .md。用户输入 `foo.md` / `foo.txt` / `foo`（无扩展名）
 * 都按字面保留。重名避让时扩展名也原样保留（foo.txt → foo (2).txt）。
 * 重命名场景走 resolveRenameName，行为完全对称。
 *
 * @param {string} raw
 * @param {string} dir - 数据目录绝对路径
 * @returns {Promise<{ok:true, path:string, name:string} | {ok:false, error:string}>}
 */
// Windows 保留设备名（基础名，无扩展名时）。注意是大写比对；用户的实际
// 输入通常是大小写混合，做 toUpperCase 后再校验。带扩展名也照样拒
// （Windows 把 CON.md / con.txt 都视作设备名 —— 这是 NTFS 的硬规则，
// fs.rename 一定撞 EPERM）。
const WIN_RESERVED_DEVICE_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

async function resolveFileName(raw, dir) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, error: '文件名不能为空' };
  }
  const name = raw.trim();
  // 拒绝路径分隔符与 .. 段
  if (/[/\\]/.test(name) || name.includes('..')) {
    return { ok: false, error: '文件名不能包含路径分隔符或 ..' };
  }
  // Windows 保留字符：<>:"/\\|?*（/\\ 已被上面挡一次，这里再列一遍保持语义独立，
  // 让错误信息精确指向 Windows 保留字符而非「路径分隔符」）。
  if (/[<>:"|?*]/.test(name)) {
    return { ok: false, error: '文件名包含 Windows 保留字符（< > : " | ? *）' };
  }
  // 控制字符
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(name)) {
    return { ok: false, error: '文件名包含非法字符' };
  }
  // Windows 保留设备名：取最后一个 . 之前的部分（"CON.md" / "CON" / "CON.txt" 都算）
  const lastDot = name.lastIndexOf('.');
  const baseForReserved = (lastDot > 0 ? name.slice(0, lastDot) : name).toUpperCase();
  if (WIN_RESERVED_DEVICE_NAMES.has(baseForReserved)) {
    return { ok: false, error: `"${baseForReserved}" 是 Windows 保留设备名，不允许作为文件名` };
  }
  // 用户输入的扩展名原样保留 —— 故意不强制 .md（与 resolveRenameName 对齐）。

  let candidate = name;
  let counter = 2;
  for (;;) {
    const fullPath = path.join(dir, candidate);
    // 任何候选路径都必须仍在数据目录内（防止 join 出 ..\）
    if (!isWithinDataDir(fullPath, dir)) {
      return { ok: false, error: '非法路径' };
    }
    const occupancy = await pathOccupancy(fullPath);
    if (occupancy === 'free') {
      return { ok: true, path: fullPath, name: candidate };
    }
    // 'file' / 'directory' 都视为占用 → 走避让分支
    // 重名避让：取最后一个 . 之前的部分加 (N)，扩展名原样保留（与 resolveRenameName 对齐）。
    // foo.md → foo (2).md；bar.txt → bar (2).txt；baz（无扩展名） → baz (2)
    const cutAt = lastDot > 0 ? lastDot : name.length;
    const base = name.slice(0, cutAt);
    const ext = name.slice(cutAt);
    candidate = `${base} (${counter})${ext}`;
    counter += 1;
    if (counter > 1000) return { ok: false, error: '重名次数过多' };
  }
}

/**
 * 重命名专用的文件名清洗。
 *
 * 用户反馈：「重命名不要自动补后缀」—— 重命名场景下用户输入什么就用什么，
 * 包括完全去掉扩展名（foo.md → bar）或换成别的扩展名（foo.md → bar.txt）。
 *
 * 2026-08-28 反馈后，resolveFileName（新建文件）与本函数语义完全对齐：
 * 都不强制补 .md，新建时用户输入什么就用什么（默认 .md 仍由 renderer 的
 * defaultName 带出来）。这样用户想新建一个 .txt 纯文本笔记 / .json 数据笔记
 *     不再需要「先建 .md → 重命名成 .txt」两步。
 *
 * 仍然保留的校验：
 *   - 路径分隔符 / ..
 *   - Windows 保留字符
 *   - Windows 保留设备名（基础名按 . 之前的部分取，"CON.md" 也算）
 *   - 控制字符
 *   - 重名避让（(2)/(3) 后缀保留原始扩展名：foo.md → foo (2).md；
 *     foo.txt → foo (2).txt；无扩展名 foo → foo (2)）
 *
 * @param {string} raw
 * @param {string} dir
 */
async function resolveRenameName(raw, dir) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, error: '文件名不能为空' };
  }
  const name = raw.trim();
  // 拒绝路径分隔符与 .. 段
  if (/[/\\]/.test(name) || name.includes('..')) {
    return { ok: false, error: '文件名不能包含路径分隔符或 ..' };
  }
  if (/[<>:"|?*]/.test(name)) {
    return { ok: false, error: '文件名包含 Windows 保留字符（< > : " | ? *）' };
  }
  // 控制字符
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(name)) {
    return { ok: false, error: '文件名包含非法字符' };
  }
  // Windows 保留设备名：取最后一个 . 之前的部分（"CON.md" / "CON" / "CON.txt" 都算）
  const lastDot = name.lastIndexOf('.');
  const baseForReserved = (lastDot > 0 ? name.slice(0, lastDot) : name).toUpperCase();
  if (WIN_RESERVED_DEVICE_NAMES.has(baseForReserved)) {
    return { ok: false, error: `"${baseForReserved}" 是 Windows 保留设备名，不允许作为文件名` };
  }

  let candidate = name;
  let counter = 2;
  for (;;) {
    const fullPath = path.join(dir, candidate);
    if (!isWithinDataDir(fullPath, dir)) {
      return { ok: false, error: '非法路径' };
    }
    // 审计修复 (Round 11 deep-fix P2-4)：用 pathOccupancy 替代 fs.access，
    // 区分 file vs directory —— 同名目录不能被当作可用文件返回。
    const occupancy = await pathOccupancy(fullPath);
    if (occupancy === 'free') {
      return { ok: true, path: fullPath, name: candidate };
    }
    // 重名避让：取最后一个 . 之前的部分加 (N)，扩展名原样保留。
    // foo.md → foo (2).md；bar.txt → bar (2).txt；baz（无扩展名） → baz (2)
    const cutAt = lastDot > 0 ? lastDot : name.length;
    const base = name.slice(0, cutAt);
    const ext = name.slice(cutAt);
    candidate = `${base} (${counter})${ext}`;
    counter += 1;
    if (counter > 1000) return { ok: false, error: '重名次数过多' };
  }
}

/**
 * 扫描数据目录下的所有 .md / .markdown 文件，按名称排序（locale zh-CN）。
 *
 * 重要变更（audit #3）：目录不存在（ENOENT）时不再自动 mkdir，
 * 直接返回错误让上层决定如何处理（弹对话框 / 切换目录），
 * 避免「数据目录被外部删了之后被静默重建掩盖数据丢失」。
 *
 * @param {string} dir
 * @returns {Promise<{ok:true, files:Array} | {ok:false, error:string, code?:string}>}
 */
async function scanFiles(dir) {
  if (!dir || typeof dir !== 'string') {
    return { ok: false, error: 'invalid dir', code: 'EINVAL' };
  }
  try {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (e) {
      // ENOENT：目录不存在 —— 不再自动重建，让用户看到明确错误
      if (e.code === 'ENOENT') {
        return { ok: false, error: 'DATA_DIR_NOT_FOUND', code: 'ENOENT', message: `数据目录不存在：${dir}` };
      }
      throw e;
    }
    const mdFiles = entries.filter((e) => {
      if (!e.isFile()) return false;
      // Round 13 fix (H6)：与 scanDir 对称过滤符号链接。OneDrive / 网盘
      // 用户在数据目录里放指向外部 secret 文件的 symlink 时，旧版会跟随
      // 读 size / mtime 但 file:read 拒开，UX 不一致且把外部 stat 信息暴露
      // 到 renderer 内存。
      if (e.isSymbolicLink()) return false;
      const lower = e.name.toLowerCase();
      return lower.endsWith('.md') || lower.endsWith('.markdown');
    });

    const files = await Promise.all(mdFiles.map(async (e) => {
      const fullPath = path.join(dir, e.name);
      try {
        const st = await fs.stat(fullPath);
        return {
          name: e.name,
          path: fullPath,
          size: st.size,
          mtimeMs: st.mtimeMs,
        };
      } catch {
        return null;
      }
    }));

    const list = files
      .filter((f) => f !== null)
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    return { ok: true, files: list };
  } catch (e) {
    return { ok: false, error: e.message, code: e.code };
  }
}

/**
 * 简易并发限流器：把 N 个 promise 包成「最多 concurrency 个同时在飞」的执行器。
 * 不引第三方依赖（p-limit / p-queue 等）—— 全文只有 scanDir 一个调用点，
 * 20 行内联比 1 个新 dep 更可控。
 *
 * 行为：
 *   - 入队 → 立即调度，若活跃数 < concurrency 则启动执行
 *   - 任意 fn resolve / reject → 拉下一个
 *   - fn 异常会传给调用方（rethrow），但「下一个」仍会被调度（finally 语义）
 *
 * @param {number} concurrency - 同时在飞的最大任务数（必须 ≥ 1）
 * @returns {(fn: () => Promise<T>) => Promise<T>}
 */
function pLimit(concurrency) {
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    throw new Error('pLimit: concurrency 必须 ≥ 1');
  }
  const queue = [];
  let active = 0;
  const pump = () => {
    while (active < concurrency && queue.length > 0) {
      const job = queue.shift();
      active += 1;
      // resolve / reject 都触发 pump；catch 防止 fn 抛错后 active 永远不归零
      job.fn().then(
        (v) => { active -= 1; job.resolve(v); pump(); },
        (e) => { active -= 1; job.reject(e); pump(); },
      );
    }
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    pump();
  });
}

/** scanDir 单批并发上限（audit R7a P1-17）。
 *
 * 背景：libuv 默认 4 worker threads，scanDir 同时发 N 个 fs.stat 会被 libuv
 * 串行排队 —— SMB / OneDrive 单次 stat 50-200ms 时 10000 文件 → 30-90s。
 * 并发 32 让网络盘上 stat 仍能流水线（多网卡 in-flight），又不至于打满
 * libuv 池 / fd 上限。32 是个保守值：实测 64 在 4 核机器仍 OK，128 在 Windows
 * 上偶发 ETIMEDOUT（WinHTTP max connections per server 默认 6 / process 翻倍
 * 也只有 12），32 是「在所有平台稳定」的最大公约数。
 */
const SCAN_DIR_CONCURRENCY = 32;

/**
 * 扫描一个目录下的所有直接条目（文件夹 + 文件），按类型分类。
 * Folder Browser（2026-08）的核心入口。
 *
 * 行为约定：
 *   - 不递归：只列 absDir 的一层直接子项；想看深层 → 点文件夹进入
 *   - 跳过符号链接文件夹（与 assertNotSymlink 同源策略；
 *     不跟随，避免 symlink 指向 dataDir 外部造成越权）
 *   - 跳过符号链接文件（同样防御）
 *   - 文件 entryType 由 classifyEntry(name) 决定：
 *       'editable' = Markdown 或常见纯文本（白名单内）
 *       'binary'   = 其它扩展名（侧栏仍显示但灰掉、点击弹 toast）
 *   - 文件夹 entryType 固定为 'folder'
 *   - 排序：文件夹在前（按名称），文件在后（按名称）；
 *     让用户先看到目录结构再看到内容，更符合 Explorer/Finder 的直觉
 *
 * 性能（audit R7a P1-17）：fs.stat 用 pLimit(32) 限流，避免 libuv 4 worker
 * 排队把 SMB / OneDrive 30-90s 拖到 1-3s。
 *
 * @param {string} absDir - 数据目录下某一层的绝对路径
 * @returns {Promise<{
 *   ok: true,
 *   dir: string,                          // 回传绝对路径，便于调用方对照
 *   entries: Array<{
 *     name: string,
 *     path: string,                       // 绝对路径
 *     entryType: 'folder'|'editable'|'binary',
 *     isFolder: boolean,
 *     size?: number,
 *     mtimeMs?: number,
 *   }>
 * } | { ok:false, error, code?, message? }>}
 */
async function scanDir(absDir) {
  if (!absDir || typeof absDir !== 'string') {
    return { ok: false, error: 'invalid dir', code: 'EINVAL' };
  }
  let dirents;
  try {
    dirents = await fs.readdir(absDir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') {
      return { ok: false, error: 'DATA_DIR_NOT_FOUND', code: 'ENOENT', message: `目录不存在：${absDir}` };
    }
    // audit fix (Round 12 P2)：非 ENOENT 路径不再把原始 e.message（英文 errno
    // + 绝对路径）透出去。renderer fs-watcher 推过来时直接当成 toast 文案
    // 显示，会泄漏路径 + 看着割裂。走 friendly-fs-error 与 Round 8 EROFS /
    // ENAMETOOLONG 等统一：未知 errno 时拿 e.message 作为 fallback（兜底
    // 业务码），不能让用户看空白 toast。
    return {
      ok: false,
      error: sharedFriendlyFsError(e && e.code, e && e.message) || '扫描目录失败',
      code: e.code,
    };
  }

  // 用 lstat 一次性拿每一项的类型，过滤掉符号链接（防止越权）。
  // 注意 fs.readdir(..., {withFileTypes:true}) 给的 dirent.isSymbolicLink()
  // 在 Windows 上对 junction 也判定为 true —— 这里统一跳，避免跟随。
  const safeDirents = [];
  for (const d of dirents) {
    if (d.isSymbolicLink()) continue;
    safeDirents.push(d);
  }

  // audit fix (R7a P1-17)：fs.stat 走 pLimit(SCAN_DIR_CONCURRENCY) + allSettled。
  // 旧版 Promise.all(N) 在 SMB / OneDrive 上 N 个 stat 串行排队（libuv 4 worker
  // 默认），10000 文件 30-90s；改 32 并发后实测 1-3s。
  // allSettled：单个 stat 抛错（ENOENT 经典 readdir 与 stat 之间被删）不影响
  // 整批，外层 .flatMap 过滤 fulfilled + truthy 即可，与原 .filter(Boolean) 语义
  // 一致（fulfilled=null → drop；rejected → drop；fulfilled=object → keep）。
  const limit = pLimit(SCAN_DIR_CONCURRENCY);
  const tasks = safeDirents.map((d) => limit(async () => {
    const fullPath = path.join(absDir, d.name);
    if (d.isDirectory()) {
      return {
        name: d.name,
        path: fullPath,
        entryType: 'folder',
        isFolder: true,
      };
    }
    if (d.isFile()) {
      try {
        const st = await fs.stat(fullPath);
        return {
          name: d.name,
          path: fullPath,
          entryType: classifyEntry(d.name),
          isFolder: false,
          size: st.size,
          mtimeMs: st.mtimeMs,
        };
      } catch {
        // 文件在 readdir 与 stat 之间被删了 —— 静默跳过
        return null;
      }
    }
    // 其它（socket / fifo / block device 等）—— 不展示
    return null;
  }));
  const settled = await Promise.allSettled(tasks);
  const list = settled.flatMap((r) => (r.status === 'fulfilled' && r.value) ? [r.value] : []);
  // 排序：folder 在前、file 在后，同组内按 zh-CN locale
  list.sort((a, b) => {
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-CN');
  });

  return { ok: true, dir: absDir, entries: list };
}

/**
 * 把数据目录根下的相对路径解析成绝对路径，并做防御性校验。
 *
 * 渲染端传来的 relDir 必须满足：
 *   - 空字符串 → dataRoot（根目录）
 *   - 正斜杠分隔的相对路径（如 'notes/2026'），不含 ..
 *   - 不含绝对路径前缀（Windows 盘符 / POSIX /）
 *
 * 解析后用 isWithinDataDir 二次校验（防止路径穿越 / symlink 跟随）。
 *
 * @param {string} relDir
 * @param {string} dataRoot - 数据目录绝对路径
 * @returns {{ok:true, absDir:string, relDir:string} | {ok:false, error:string, message?:string}}
 */
function resolveDirRelative(relDir, dataRoot) {
  if (typeof relDir !== 'string') {
    return { ok: false, error: 'INVALID_REL_DIR', message: 'relDir 必须是字符串' };
  }
  // 拒绝盘符 / 绝对路径前缀（必须在 strip 前做，否则 '/etc/passwd' 被剥成
  // 'etc/passwd' 反而通过校验）
  if (/^[a-z]:[\\/]/i.test(relDir) || relDir.startsWith('/') || relDir.startsWith('\\')) {
    return { ok: false, error: 'PATH_NOT_ALLOWED', message: '不允许使用绝对路径' };
  }
  const normalized = relDir.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  // 拒绝 .. 段（即使藏在中间）
  if (normalized.split('/').some((seg) => seg === '..' || seg === '.')) {
    return { ok: false, error: 'PATH_NOT_ALLOWED', message: '相对路径不能包含 . 或 ..' };
  }
  const absDir = normalized === '' ? dataRoot : path.join(dataRoot, normalized);
  if (!isWithinDataDir(absDir, dataRoot)) {
    return { ok: false, error: 'PATH_NOT_ALLOWED', message: '路径不在数据目录内' };
  }
  // 重新标准化回 POSIX（与传入保持一致）+ 末尾无 /
  const relOut = normalized;
  return { ok: true, absDir, relDir: relOut };
}

/**
 * 给定 dataRoot 与当前目录的绝对路径，反算 POSIX 风格的相对路径。
 * 渲染端用于比对 fs-watcher 推送的 relDir 字段。
 *
 * Windows case-insensitive：dataRoot 存盘时可能被大小写规范化（NTFS 实际路径
 * 大小写取决于创建时），与 absDir 比对时若不做大小写无关比较，会把同盘同一目录
 * 误判成"不在 dataRoot 下"、返回 '' —— renderer 后续 onFilesChanged 拿到空
 * relDir 会把「旧目录的文件被移除」误判为「当前文件被外部删除」而清空编辑器。
 * 比较走 toLowerCase，结果保留原大小写（POSIX 风格 + 可读性）。
 *
 * @param {string} absDir
 * @param {string} dataRoot
 * @returns {string} POSIX 相对路径，根目录时为 ''
 */
function toRelativeDir(absDir, dataRoot) {
  if (!absDir || !dataRoot) return '';
  const a = absDir.replace(/\\/g, '/').replace(/\/+$/, '');
  const r = dataRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  // Windows 大小写无关比较：dataRoot 与 absDir 指向同一盘同一目录但大小写不同时
  // （NTFS 用户主目录就常见），不能误判成"不在 dataRoot 下"。
  const icmp = process.platform === 'win32'
    ? (x, y) => x.toLowerCase() === y.toLowerCase()
    : (x, y) => x === y;
  if (icmp(a, r)) return '';
  const prefix = r + '/';
  if (icmp(a.slice(0, prefix.length), prefix)) return a.slice(r.length + 1);
  // 不在 dataRoot 下（理论上不该发生）—— 返回空字符串让渲染端走根路径分支
  return '';
}

/**
 * 原子写文件 —— audit fix（C1/C2 file-IO）：
 *   1. 写到 dst.tmp.<pid>.<now>
 *   2. fsync tmp（让内容确实落盘，再 rename 才不会丢）
 *   3. renameWithRetry 覆盖 dst（Windows Defender / 杀毒 / 同步盘
 *      偶尔瞬态持锁，retry-on-busy 比直接放弃稳得多）
 *
 * 失败路径：
 *   - 写入 tmp 失败 → unlink tmp + 抛原始 errno
 *   - rename 失败（retry 后）→ unlink tmp + 抛原始 errno
 *
 * 副作用：成功后磁盘上要么是旧文件（旧文件全程未动），要么是新文件；
 * 永远不会有半截内容被读到。
 *
 * @param {string} dst 目标绝对路径
 * @param {string} content UTF-8 文本
 */
async function atomicWriteFile(dst, content) {
  // P2-1：tmp 路径走加密安全随机。抽 main/generate-tmp-path.js 工厂，
  // 内部用 crypto.randomUUID()（128-bit 加密安全，8-4-4-4-12 hex）替代
  // 旧的 Math.random().toString(36).slice(2, 8) 6 位 base36 后缀。pid +
  // Date.now() 跨进程/跨毫秒去重，UUID 兜住同进程同毫秒并发。路径格式
  // `${dst}.tmp.${pid}.${ts}.${randomId}` 保持不变，fs-watcher 旧逻辑
  // 只匹配 `.tmp.*` 前缀不受影响。
  const tmpPath = generateTmpPath(dst);
  let fh;
  try {
    // R5 P1-13：tmp 文件 mode 0o600 (rw owner only)。多用户 Linux/macOS
    // 上其他用户能读父目录 → 也能读默认 0o644 的 tmp，里面可能含 AI Key
    // 包络 / 用户笔记内容。Windows 不强制 mode（用 ACL），但设了不冲突；
    // 跨平台语义一致。
    fh = await fs.open(tmpPath, 'w', 0o600);
    await fh.writeFile(content, 'utf-8');
    // fsync 关键：没有 fsync，rename 之后断电可能留下「磁盘上 inode 改了
    // 但内容还在 page cache、从未刷盘」的零字节文件。Windows 上 fsync 等价
    // FlushFileBuffers，rename 之前必须强制落盘。
    await fh.sync();
    await fh.close();
    fh = null;
  } catch (e) {
    if (fh) { try { await fh.close(); } catch { /* ignore */ } }
    try { await fs.unlink(tmpPath); } catch { /* tmp 不存在也忽略 */ }
    throw e;
  }

  try {
    await renameWithRetry(tmpPath, dst);
  } catch (e) {
    // rename 失败：清理残余 tmp（不影响下次保存）
    try { await fs.unlink(tmpPath); } catch { /* 文件可能已被 rename 移走 */ }
    throw e;
  }
  // 父目录 fsync（audit Round 4 P0-1）：rename 已在 try/catch 之外，父目录
  // fsync 失败不向上抛 —— 文件已成功 rename 落盘，仅「新名可能不持久化」，
  // 走 main/fsync-parent-dir.js#fsyncParentDir（与 main.js file:rename /
  // file:move / file:copy 同一份语义：win32 skip、open→sync→close、close
  // 失败静默、open/sync 失败返 {ok:false, error}）。
  const fsyncResult = await fsyncParentDir(dst);
  if (!fsyncResult.ok) {
    console.warn('[file-ops] 父目录 fsync 失败（不影响写入成功）:', fsyncResult.error);
  }
}

/**
 * audit fix (C3 file-IO)：rename 重试 EBUSY/EPERM/EACCES。
 * Windows Defender / 杀毒 / 同步盘会在极短时间内持锁目标文件，
 * 单次 rename 失败率约 1-3%。3 次 50/100/200ms backoff 后仍失败才抛。
 * 与 config-store 的同名实现保持一致的 backoff 时序，避免两条路径表现差异。
 * @param {string} src
 * @param {string} dst
 */
async function renameWithRetry(src, dst) {
  const delays = [50, 100, 200];
  for (let i = 0; i <= delays.length; i += 1) {
    try {
      await fs.rename(src, dst);
      return;
    } catch (e) {
      const transient = e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES';
      // 末次重试仍失败 → 直接抛；非瞬态错误也直接抛（不浪费重试）。
      if (!transient || i === delays.length) throw e;
      await new Promise((r) => setTimeout(r, delays[i]));
    }
  }
}

/**
 * audit fix (Folder move/copy)：递归复制一个目录到目标目录。
 * 用于 file:copy 复制整个文件夹（含子目录）的场景。
 *
 * 安全：
 *   - 拒绝跟随符号链接 —— 既跳过 src 树里的 symlink 文件/目录（不 follow 到
 *     dataDir 外部），也拒绝 symlink 目录作为复制目的地（由调用方在入口已校验，
 *     这里再防御一层：递归途中遇到 symlink 直接跳过，绝不 follow）。
 *   - 调用方必须保证 srcAbs / destAbs 都在数据目录内、且 srcAbs 本身不是 symlink。
 *
 * 行为：
 *   - 普通文件 → fs.copyFile
 *   - 普通目录 → mkdir（recursive:false，父已被建好）+ 递归
 *   - 其它（socket / fifo / device / symlink）→ 跳过，不复制
 *
 * @param {string} srcAbs  - 源目录绝对路径（已确认是真实目录）
 * @param {string} destAbs - 目标目录绝对路径（已确认不存在，由调用方 mkdir 好父级）
 * @returns {Promise<void>}
 */
async function recursiveCopy(srcAbs, destAbs) {
  const dirents = await fs.readdir(srcAbs, { withFileTypes: true });
  // 父目录已存在，确保目标目录本体存在（destAbs 是全新的空目录名）
  await fs.mkdir(destAbs, { recursive: false });
  for (const d of dirents) {
    const srcChild = path.join(srcAbs, d.name);
    const destChild = path.join(destAbs, d.name);
    // symlink 一律跳过（lstat 探真实类型，不 follow）
    if (d.isSymbolicLink()) continue;
    if (d.isDirectory()) {
      // 递归前再确认不是 symlink 目录（withFileTypes 的 isDirectory 已排除 symlink，
      // 但防御性 stat 一层更稳）
      try {
        const st = await fs.lstat(srcChild);
        if (st.isSymbolicLink()) continue;
      } catch {
        continue; // 读不到就跳过，不阻断整棵复制
      }
      await recursiveCopy(srcChild, destChild);
    } else if (d.isFile()) {
      await fs.copyFile(srcChild, destChild);
    }
    // 其它类型（FIFO / 设备 / socket）→ 不复制
  }
}

/**
 * 删除数据目录里残留的 `*.tmp.<pid>.<ts>.<rand>` 文件。
 * 由 main.js 在启动时 / 切换数据目录时调用一次。
 *
 * 两层阈值（与 main/config-store.js#cleanupStaleTmpFiles 对齐）：
 *   - 自己 pid + 60s 前 → 必删（防止本进程崩溃留下永久孤儿）
 *   - 非自己 pid + 24h 前 → 必删（清理上一次 Notes 实例崩溃的孤儿）
 *
 * audit fix (Round 16 R2)：atomicWriteFile 自身的 try/catch 已经在失败时
 * unlink tmp，但「本进程崩溃 / 被 kill -9 / 断电」三种场景不会进入清理分支。
 * `scripts/_archive/` 9 个一次性 repro 脚本的历史足以说明崩溃/中断场景不是
 * 理论风险。启动时扫一次数据目录，避免孤儿永久累积。
 *
 * @param {string} dataDir 数据目录绝对路径
 * @returns {Promise<void>}
 */
async function cleanupStaleFileTmpFiles(dataDir) {
  if (!dataDir) return;
  try {
    const files = await fs.readdir(dataDir);
    const myPid = process.pid;
    const now = Date.now();
    const STALE_THRESHOLD_MS = 60_000;
    const CROSS_PID_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;
    for (const f of files) {
      // 只匹配 atomicWriteFile 生成的 `<name>.<ext>.tmp.<pid>.<ts>.<rand>`，
      // rand 为 generateTmpPath 生成的 36 位带连字符 UUID（P2-1 起，非旧版 base36）。
      // audit fix (Tmp-L2)：旧版 `/\.tmp\.\d+\.\d+\.[a-z0-9]+$/i` 太宽，
      // 会把用户自己命名 / 同步盘生成 / 备份工具遗留的 `report.tmp.2024.1234567.abcdef`
      // 这种正常文件当成孤儿静默 unlink。必须要求 .tmp. 前面是 EDITABLE_EXTS
      // 之一（白名单扩展名）。
      // config-store 的 `config.json.tmp.*` 不在此正则范围内，仍由它自家扫（注释指向
      // shared/extension-lists.js#EDITABLE_EXTS，与 fileOps / sidebar 共用扩展名）。
      if (!ATOMIC_TMP_RE.test(f)) continue;
      const full = path.join(dataDir, f);
      try {
        const st = await fs.stat(full);
        const isMine = f.includes(`.${myPid}.`);
        const ageMs = now - st.mtimeMs;
        const shouldRemove = isMine
          ? ageMs > STALE_THRESHOLD_MS
          : ageMs > CROSS_PID_STALE_THRESHOLD_MS;
        if (shouldRemove) {
          await fs.unlink(full);
        }
      } catch { /* 单个文件 stat/unlink 失败不影响整体 */ }
    }
  } catch {
    // readdir 失败（目录不存在等）静默 —— 后续 IPC handler 会处理
  }
}

/**
 * audit fix (Round 4 收尾)：file:write 的 errno 翻译 —— 与 main.js 各 IPC handler
 * （_friendlyCreateError / _friendlyRenameError / _friendlyDeleteError / _friendlyReadError）
 * 共用一份文案。Round 4 之前本函数与 src/app.js#friendlyWriteError、
 * src/file-ops.js#friendlyFsError 三处独立，EROFS / ENAMETOOLONG / ENOTDIR 文案
 * 三处不同，ENOTEMPTY 在 src/file-ops.js 独有 —— 用户看到的提示不一致。
 *
 * 改用 shared/friendly-fs-error.js 单一事实源（preload 同时把它过桥到
 * window.api.friendlyFsError，renderer 两处旧实现也走同一份）。本函数保留壳子
 * 是为了不重写所有调用点的语义（main 内部仍叫 friendlyWriteError 表达
 * 「写盘错误翻译」，renderer 走 window.api.friendlyFsError 表达通用 errno 翻译）。
 *
 * @param {NodeJS.ErrnoException|null|undefined} e
 * @returns {string} 中文提示（永不为空 —— 兜底走「未知错误」）
 */
function friendlyWriteError(e) {
  // 把 e.message 作为 fallback 透传给 sharedFriendlyFsError。
  //   - 已知 errno：shared 模块返回固定中文文案，与 e.message 无关
  //   - 未知 errno / null e / e.code 缺失：shared 模块走 fallback || '未知错误'
  //     → e?.message 有就透传英文 errno + 路径（renderer 拿到的是已经走
  //       friendlyFsError 二次翻译过的中文，不会再让英文 errno 漏到这里）；
  //       没有就回退到「未知错误」（注意：旧版这里固定传「写入文件失败」，
  //       与 renderer 三处的「未知错误」兜底文案不一致，统一为后者）
  return sharedFriendlyFsError(e && e.code, e && e.message);
}

/**
 * 文件夹名避让（重命名时同分支），与 resolveFolderName 完全对称。
 *
 * 文件夹的「合法名」语义比 file 简单：用户输入什么就用什么，没有强制扩展名；
 * Windows 保留字符 / 保留设备名 / 控制字符 / 路径分隔符沿用 file 同一套校验。
 *
 * 重名避让时整段 name 加 (2)(3)...，没有 "基础名 + 扩展名" 的两段切割。
 *
 * @param {string} raw
 * @param {string} parentDir - 父目录绝对路径
 * @returns {Promise<{ok:true, path:string, name:string} | {ok:false, error:string}>}
 */
async function resolveRenameFolderName(raw, parentDir) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, error: '文件夹名不能为空' };
  }
  const name = raw.trim();
  if (/[/\\]/.test(name) || name.includes('..')) {
    return { ok: false, error: '文件夹名不能包含路径分隔符或 ..' };
  }
  if (/[<>:"|?*]/.test(name)) {
    return { ok: false, error: '文件夹名包含 Windows 保留字符（< > : " | ? *）' };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(name)) {
    return { ok: false, error: '文件夹名包含非法字符' };
  }
  if (WIN_RESERVED_DEVICE_NAMES.has(name.toUpperCase())) {
    return { ok: false, error: `"${name}" 是 Windows 保留设备名，不允许作为文件夹名` };
  }

  let candidate = name;
  let counter = 2;
  for (;;) {
    const fullPath = path.join(parentDir, candidate);
    if (!isWithinDataDir(fullPath, parentDir)) {
      return { ok: false, error: '非法路径' };
    }
    const occupancy = await pathOccupancy(fullPath);
    if (occupancy === 'free') {
      return { ok: true, path: fullPath, name: candidate };
    }
    candidate = `${name} (${counter})`;
    counter += 1;
    if (counter > 1000) return { ok: false, error: '重名次数过多' };
  }
}

/**
 * 文件夹名清洗 + 重名避让。
 *
 * 与 file version 的 resolveFileName 完全同源：路径分隔符 / Windows 保留字符 /
 * 保留设备名 / 控制字符 / 非空 一律预先拒绝。
 *
 * 与 file version 的关键差别：
 *   - 不强制补扩展名：用户输入 "projects" / "PROJECTS" / "2026.drafts" 一律原样保留
 *   - 重名避让只加 (2)/(3)...，不分基础名 / 扩展名切割（文件夹名不切）
 *   - 占用检测 pathOccupancy 同样适用：父目录里已有同名 file 也会触发避让
 *
 * 用途：folder:create IPC handler 调它来拿最终路径 + name，主进程据此 mkdir。
 *
 * @param {string} raw
 * @param {string} parentDir - 父目录绝对路径（新建文件夹的落点）
 * @returns {Promise<{ok:true, path:string, name:string} | {ok:false, error:string}>}
 */
async function resolveFolderName(raw, parentDir) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, error: '文件夹名不能为空' };
  }
  const name = raw.trim();
  // 拒绝路径分隔符与 .. 段
  if (/[/\\]/.test(name) || name.includes('..')) {
    return { ok: false, error: '文件夹名不能包含路径分隔符或 ..' };
  }
  // Windows 保留字符
  if (/[<>:"|?*]/.test(name)) {
    return { ok: false, error: '文件夹名包含 Windows 保留字符（< > : " | ? *）' };
  }
  // 控制字符
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(name)) {
    return { ok: false, error: '文件夹名包含非法字符' };
  }
  // Windows 保留设备名：文件夹不带扩展名分支，直接整段判断；带点（DRAFT.2026）也按整段判断
  //（device name 不带点的语义由 NTFS 决定 —— 但 Notes 里不刻意区分，统按整段拒保守）
  if (WIN_RESERVED_DEVICE_NAMES.has(name.toUpperCase())) {
    return { ok: false, error: `"${name}" 是 Windows 保留设备名，不允许作为文件夹名` };
  }

  let candidate = name;
  let counter = 2;
  for (;;) {
    const fullPath = path.join(parentDir, candidate);
    if (!isWithinDataDir(fullPath, parentDir)) {
      return { ok: false, error: '非法路径' };
    }
    const occupancy = await pathOccupancy(fullPath);
    if (occupancy === 'free') {
      return { ok: true, path: fullPath, name: candidate };
    }
    // file / directory 都视为占用
    candidate = `${name} (${counter})`;
    counter += 1;
    if (counter > 1000) return { ok: false, error: '重名次数过多' };
  }
}

module.exports = {
  MAX_FILE_SIZE,
  EDITABLE_EXTS,
  ATOMIC_TMP_RE,
  assertNotSymlink,
  assertNoSymlinkAncestor,
  classifyEntry,
  isWithinDataDir,
  resolveFileName,
  resolveRenameName,
  resolveFolderName,
  resolveRenameFolderName,
  scanFiles,
  scanDir,
  resolveDirRelative,
  toRelativeDir,
  atomicWriteFile,
  renameWithRetry,
  recursiveCopy,
  cleanupStaleFileTmpFiles,
  friendlyWriteError,
};
