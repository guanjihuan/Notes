// 配置持久化层（Stage 4b.1 抽离）
//
// 职责：
//   - 加载 / 保存用户配置（userData/config.json）
//   - 解析「实际生效」的数据目录（用户自定义 vs 默认 ~/Notes）
//   - 首次启动把 data/README.md 种子化到默认数据目录
//
// 设计：
//   - 本模块自给自足：不读 mainWindow / tray / IPC 等任何 main.js 状态。
//   - 暴露单一对象 { load, save, get, resolveDataDir, seedDefault, getDefaultDataDir }
//   - main.js 调一次 load() 拿到当前配置后，可随时通过 save() / get() 操作。
//   - schema 校验 / 默认值仍由 shared/settings-schema.js 提供（单一事实源）。

const electron = require('electron');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const os = require('os');

// rename 重试 backoff 阶梯（ms）—— Windows Defender / 杀毒 / 同步盘
// 会在极短时间内持锁目标文件，单次 rename 失败率约 1-3%。3 次 backoff
// 后仍失败才抛错（见 renameWithRetry）。
const RENAME_BACKOFF_MS = [50, 100, 200];
const {
  DEFAULT_SETTINGS: DEFAULT_CONFIG,
  coerceLoadedSettings,
} = require('../shared/settings-schema.js');
// audit fix (Round 12 P2)：saveConfig 失败时的 e.message 直接走 friendly-fs-error，
// 与 main/file-ops.js#friendlyWriteError 走同一份文案。避免用户看到
// 「EACCES: permission denied, open '/Users/.../config.json'」英文 errno + 路径。
const { friendlyFsError } = require('../shared/friendly-fs-error.js');

// 测试注入点：默认走真实 electron.app，单测可以换成 mock app。
// 下划线前缀表示「仅测试用」—— 生产代码不应调用。
let _app = electron && electron.app;

function getConfigPath() {
  return path.join(_app.getPath('userData'), 'config.json');
}

/**
 * 默认数据目录：用户主目录下的 Notes 子目录
 * 跨平台统一（不像 Todo List 那样在 Windows 上探测 D: 盘）—— 这是阅读器，单用户跨平台直接可用。
 */
function getDefaultDataDir() {
  try {
    const home = _app.getPath('home');
    return path.join(home, 'Notes');
  } catch {
    return path.join(os.homedir(), 'Notes');
  }
}

let appConfig = {};
let DEFAULT_DATA_DIR = null;
let configLoaded = false;

function loadConfig() {
  const cfgPath = getConfigPath();
  let raw;
  try {
    raw = fsSync.readFileSync(cfgPath, 'utf-8');
  } catch (e) {
    // ENOENT 是「首次启动」，静默回退默认值是合理的；
    // 其他错误（权限 / 磁盘坏道）也走默认值，但要在控制台留痕，方便用户反馈。
    if (e.code !== 'ENOENT') {
      console.warn('[config-store] 配置读取失败，使用默认值:', e.code || e.message);
    }
    appConfig = { ...DEFAULT_CONFIG };
    cleanupStaleTmpFiles();
    configLoaded = true;
    return appConfig;
  }

  try {
    const parsed = JSON.parse(raw);
    appConfig = coerceLoadedSettings(parsed);
  } catch (e) {
    // 关键修复：之前 `} catch { ... }` 把 JSON 解析错误也吞了 —— 一旦 config.json
    // 半截 / 格式错（断电、强杀进程、磁盘故障），用户的 aiApiKey / 自定义 dataDir
    // 会无声丢失；下一次 saveConfig() 又会把默认值覆盖回去，损坏永久化。
    // 现在把损坏的配置文件改名备份（config.json.broken-<ts>），再走默认值。
    // 用户在设置里重新填值后会写回新的 config.json，备份留在旁边方便排查。
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${cfgPath}.broken-${ts}`;
    try {
      fsSync.renameSync(cfgPath, backupPath);
      console.warn(`[config-store] config.json 解析失败 (${e.message})，已备份到 ${backupPath}，使用默认值`);
    } catch (renameErr) {
      console.warn(`[config-store] config.json 解析失败且备份失败 (${renameErr.message})，使用默认值`);
    }
    appConfig = { ...DEFAULT_CONFIG };
  }
  // audit fix (4.4)：清理上次异常退出留下的 config.json.tmp.* 残留。
  // 正常路径下 saveConfig 会在 rename 成功后留下 0 个 tmp，rename 失败路径会立刻 unlink；
  // 但断电 / kill -9 会跳过 unlink，长期积累成百上千个 tmp。
  // 启动时扫一遍目录、删除自己的残留（不动当前 pid / 当前时间戳的，避免误删正在写的）。
  cleanupStaleTmpFiles();
  configLoaded = true;
  return appConfig;
}

/**
 * 删除数据目录里残留的 config.json.tmp.* 文件。
 * 两层阈值：
 *   - 自己 pid + 60s 前 → 必删（防止本进程崩溃留下永久孤儿）
 *   - 非自己 pid + 24h 前 → 必删（清理上一次 Notes 实例崩溃的孤儿，
 *     24h 长到不会误删正在运行的其它 Notes 实例）
 *
 * audit fix (Round 16 R2)：旧版只覆盖「自己 pid + 60s」一层。Notes
 * 进程被 kill / 断电时，tmp 文件用的是当时进程的 pid；下次启动时本进程
 * pid 不同，60s 阈值永远不命中，孤儿永久残留。`scripts/_archive/` 下
 * 9 个一次性 repro 脚本的历史足以说明这种崩溃/中断场景不是理论风险。
 */
function cleanupStaleTmpFiles() {
  try {
    const dir = path.dirname(getConfigPath());
    const files = fsSync.readdirSync(dir);
    const myPid = process.pid;
    const now = Date.now();
    const STALE_THRESHOLD_MS = 60_000;            // 自己 pid：60s
    const CROSS_PID_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 跨 pid：24h
    for (const f of files) {
      if (!/^config\.json\.tmp\./.test(f)) continue;
      const full = path.join(dir, f);
      try {
        const st = fsSync.statSync(full);
        const isMine = f.includes(`.${myPid}.`);
        const ageMs = now - st.mtimeMs;
        const shouldRemove = isMine
          ? ageMs > STALE_THRESHOLD_MS
          : ageMs > CROSS_PID_STALE_THRESHOLD_MS;
        if (shouldRemove) {
          fsSync.unlinkSync(full);
        }
      } catch { /* 单个文件 stat/unlink 失败不影响整体 */ }
    }
  } catch {
    // readdir 失败（目录不存在等）静默 —— 配置读不到已 try/catch 兜过
  }
}

/**
 * 保存（部分）配置到磁盘。失败仅 console.error，不抛 —— 调用方继续用内存里的值。
 * 返回合并后的当前配置。
 *
 * 写盘用「tmp + rename」原子模式（audit #5）：
 *   - 先写到 config.json.tmp，再 fs.renameSync 覆盖 config.json
 *   - 进程在写入中途崩溃时磁盘上要么是旧文件，要么是新文件，绝不会半截 JSON
 *   - Windows 上 renameSync 在目标已存在时会成功（POSIX 语义），覆盖是原子的
 *   - Linux 上 rename 也是原子的（同分区）
 * 这样 config.json 永远可解析 —— 启动时再坏也只会回到默认（loadConfig 已 try/catch），
 * 不会让整个 app 因为 settings 损坏而拒绝启动。
 */
/**
 * audit fix (Phase 3 C2)：异步 + 串行 promise queue + 失败回滚。
 *
 * 旧实现三个问题：
 *  1. writeFileSync/renameSync 在主进程事件循环里同步阻塞 —— 拖 AI 面板分割条
 *     这类高频触发会卡 UI（settings-store 在 200ms 防抖后多次调用，每次都阻塞
 *     几 ms~几十 ms；慢盘 / OneDrive 同步冲突会更糟）。
 *  2. 多调用并发时，appConfig = {...appConfig, ...next} 在内存里已经合并，
 *     但只有最后一次 writeFile 落盘；如果中间某次失败，前一次的合并内容丢失
 *     但 appConfig 还显示「成功」（next 返回合并后的状态）。
 *  3. catch 只 unlink tmp，appConfig 不回滚 —— 调用方以为保存成功，磁盘实际
 *     是旧值。
 *
 * 新实现：
 *  - 每次 saveConfig 排队到 saveQueue 的链尾，前一次写完才执行下一次
 *  - 用 fs.promises.writeFile + rename 异步 IO，不再阻塞事件循环
 *  - rename 重试 EBUSY/EPERM 3 次（50/100/200ms backoff）—— Windows Defender
 *    短暂持锁常见，retry-on-busy 比直接放弃更稳
 *  - 写入失败：appConfig 回滚到 pre-merge 快照，调用方拿到 { ok:false, error }
 */
let saveQueue = Promise.resolve();
function saveConfig(next) {
  // audit fix (H1)：merged 不能在 enqueue 时计算，否则两个并发调用
  // 都基于同一份 appConfig 合并，第二个任务写盘时会覆盖第一个任务的改动
  // （典型场景：用户同时点 alwaysOnTop + 切 dataDir —— alwaysOnTop 被静默丢）。
  // 改成在 task 内部取最新 appConfig 合并；同时 before 也在 task 内取，
  // 保证回滚到「本次任务开始前一刻」的状态，而不是「所有任务开始前一刻」。
  const task = async () => {
    const before = { ...appConfig };
    const merged = { ...appConfig, ...next };
    // auto-fallback 2026-08：dataDir 改了 → 让 resolveDataDirOrFallback 下次重新 stat。
    // 之前没有缓存，没有这个 hook；现在 saveConfig 走完同步更新 appConfig，
    // 旧缓存条目还指向改前的路径 → 必须在此清掉。
    if ('dataDir' in next && before.dataDir !== next.dataDir) {
      _invalidateResolveCache();
    }
    const cfgPath = getConfigPath();
    // audit fix (Round 16 P0)：追加 6 位 base36 随机后缀。pid + Date.now() 只保证
    // 跨进程 / 跨毫秒唯一，同进程同毫秒并发（典型场景：saveQueue 中 p1 与后续 task
    // 在 await 后进入 fs.open）会算出相同 tmpPath，后到的 rename 因源文件已被消费
    // 而失败（ENOENT），上层捕获后返回 {ok:false}。random 后缀 ~36^6 ≈ 21 亿组合，
    // 同毫秒冲突概率可忽略。main/file-ops.js#atomicWriteFile 也做了对称修复。
    const tmpPath = `${cfgPath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    let fh = null;
    try {
      await fs.mkdir(path.dirname(cfgPath), { recursive: true });
      // audit fix (Round 4 P0-1)：改走 fs.open + writeFile + sync + close —— fs.writeFile
      // 内部只把数据送进 page cache，没保证落盘就 close。rename 之后再断电，磁盘上
      // 可能是新名字 + 零字节 / 半截 JSON（之前 C2 修过「不写半截 JSON」靠的是 rename
      // 原子性，但 fsync 缺失让断电后实际文件可能不是新文件）。AI key / 自定义 dataDir
      // 这类关键配置丢失 = 用户感知不到为什么 settings 全没了。先 fsync 再 rename 才能
      // 保证断电后磁盘上要么是旧 config.json（rename 前断电），要么是完整新文件。
      fh = await fs.open(tmpPath, 'w');
      await fh.writeFile(JSON.stringify(merged, null, 2), 'utf-8');
      await fh.sync();
      await fh.close();
      fh = null;
      await renameWithRetry(tmpPath, cfgPath);
      // audit fix (Round 12 P1)：parent dir fsync (POSIX only)。
      // main/file-ops.js#atomicWriteFile 已在 Round 4 加了这段对称保护，
      // saveConfig 漏修。POSIX rename(2) 同分区下原子，但「目录项本身」的
      // 落盘时机由内核控制 —— rename 完直接断电，下次启动目录里可能仍是旧
      // 名字 + 新 inode 已分配但未刷盘 → 用户保存的 AI Key / 自定义 dataDir
      // 在断电窗口后「看起来没保存」。Windows NTFS journal 元数据已带 fsync
      // 语义，跳过；macOS / Linux 走 open('r')+sync+close 兜底。
      // 注意：fsync 失败 ≠ 数据丢失（rename 已生效），只 warn 不抛错。
      if (process.platform !== 'win32') {
        try {
          const dirFh = await fs.open(path.dirname(cfgPath), 'r');
          try {
            await dirFh.sync();
          } finally {
            await dirFh.close();
          }
        } catch (fsyncErr) {
          console.warn('[config-store] parent dir fsync failed (non-fatal):', fsyncErr && fsyncErr.message);
        }
      }
      // 写盘成功 → 同步到 in-memory cache
      appConfig = merged;
      return { ok: true, value: merged };
    } catch (e) {
      if (fh) { try { await fh.close(); } catch { /* ignore */ } }
      console.error('[config-store] 配置保存失败:', e.message);
      // audit fix (C2)：回滚 appConfig 到 merge 前状态，避免 UI 看到「已保存」
      // 但磁盘实际是旧值（renderer 端 settingsStore.optimisticUpdate 已经把 UI
      // 改成新值，需要靠下一次 save 失败时回滚避免误以为成功）。
      appConfig = before;
      // 清理残余 tmp（不影响下次保存）
      try { await fs.unlink(tmpPath); } catch { /* 文件可能已被 rename 移走 */ }
      return { ok: false, error: friendlyFsError(e && e.code, e && e.message) || '配置保存失败' };
    }
  };
  saveQueue = saveQueue.then(task, task);
  return saveQueue;
}

/**
 * audit fix (C2)：rename 重试 EBUSY/EPERM —— Windows Defender / 杀毒 / 同步盘
 * 会在极短时间内持锁目标文件，单次 rename 失败率约 1-3%。3 次
 * RENAME_BACKOFF_MS 阶梯 backoff 后仍失败才抛错。
 * @param {string} src
 * @param {string} dst
 */
async function renameWithRetry(src, dst) {
  const delays = RENAME_BACKOFF_MS;
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
 * 获取实际生效的数据目录路径（用户自定义优先，否则默认 ~/Notes）
 *
 * 纯字符串返回，不做磁盘存在性检查 —— schema 校验 / 写入前的便宜判断用这个。
 * 真正运行时（如 fsWatcher 启动 / scanDir 之前）请用 `resolveDataDirOrFallback()`，
 * 那个会 stat 路径、缺失时自动回退到默认。
 */
function resolveDataDir() {
  const custom = appConfig.dataDir;
  if (custom && typeof custom === 'string' && custom.trim()) {
    return custom;
  }
  return DEFAULT_DATA_DIR;
}

/**
 * 解析数据目录，路径不存在时自动回退到默认（runtime-only，不修改 appConfig.dataDir）。
 *
 * 设计动机（auto-fallback 2026-08）：
 *   旧版 `resolveDataDir()` 只做字符串返回 —— 当 `appConfig.dataDir` 指向的目录
 *   被外部删除 / 移动 / 离线（OneDrive / U 盘 / 网盘常见）时，fsWatcher 静默死亡、
 *   scanDir 返回 ENOENT、侧栏空白，用户唯一恢复路径是手动「切换数据文件夹」再选。
 *   这里加一层 stat 存在性检查：缺失 → runtime 回退到默认（saved 字段记录原值，
 *   持久化的 appConfig.dataDir 不动 —— 用户插回 U 盘下次启动还能用回去）。
 *
 * 缓存：
 *   同步 statSync 在每个 IPC handler 里都跑会很贵（file:list / file:read 等高频调用
 *   都会走 currentDataRoot()）。这里按 customDir 字符串做键的同步缓存：
 *     - 同一 customDir 连续调用 → 只 stat 一次
 *     - saveConfig 改了 dataDir → 缓存清掉，下次再 stat
 *   stat 失败后再次调用也命中缓存（避免 stat 一个不存在的路径反复失败）。
 *
 * 错误处理：
 *   - ENOENT / ENOTDIR → 视为不存在，回退到默认
 *   - 其他 errno（EACCES / EBUSY / EPERM / EIO）→ 视为存在（可能是瞬时 ——
 *     U 盘读权限慢 / Windows Defender 持锁等），让上层 scanDir 自然失败
 *     而不是「看似可用但其实打开就崩」
 *
 * @returns {{ dir: string, fellBack: boolean, saved: string }}
 *   dir：实际可用的目录（默认或 custom）
 *   fellBack：true 表示 custom 路径不可用、临时回退到默认
 *   saved：appConfig.dataDir 的当前持久化值（trim 后）；empty 表示从未设置
 */
let _resolveCache = null; // { customDir: string, exists: boolean }
/**
 * 同步确保默认数据目录存在。默认目录可能是用户首次启动还没建出来、
 * 也可能是 customDir 失效 fallback 时默认目录也从未被用过 —— 任何要返回
 * DEFAULT_DATA_DIR 的路径都必须先确保它存在，否则 fsWatcher.startWatchingDir
 * 会立刻 ENOENT 失败、scanDir 也读不出文件。
 *
 * 同步而不是异步：resolveDataDirOrFallback 是 sync 接口（被 IPC handler /
 * fsWatcher 启动路径同步调用），下面 fsWatcher 紧接着就拿这个 dir 去
 * fs.watch —— 异步 mkdir 会有竞态。mkdir recursive 已幂等，目录存在 no-op。
 */
function ensureDefaultDataDirSync() {
  if (!DEFAULT_DATA_DIR) return;
  try {
    fsSync.mkdirSync(DEFAULT_DATA_DIR, { recursive: true });
  } catch (e) {
    console.warn(`[config-store] 创建默认数据目录失败（${DEFAULT_DATA_DIR}）:`, e.message);
  }
}

function resolveDataDirOrFallback() {
  const custom = (typeof appConfig.dataDir === 'string') ? appConfig.dataDir.trim() : '';
  if (!custom) {
    ensureDefaultDataDirSync();
    scheduleEnsureDefaultDataDir();
    return { dir: DEFAULT_DATA_DIR, fellBack: false, saved: '' };
  }
  // 命中缓存：相同 customDir 不重复 stat
  if (_resolveCache && _resolveCache.customDir === custom) {
    if (_resolveCache.exists) {
      return { dir: custom, fellBack: false, saved: custom };
    }
    ensureDefaultDataDirSync();
    scheduleEnsureDefaultDataDir();
    return { dir: DEFAULT_DATA_DIR, fellBack: true, saved: custom };
  }
  // 重新 stat
  let exists = true;
  try {
    // audit fix (H1 / symlink elevation)：用 lstat 而非 stat —— stat 会 follow
    // 符号链接，让一个被外部指向敏感目录的 symlink 当作「合法数据目录」通过
    // 校验，随后 file:read/write/fsWatcher 都会跑在外部目录上，用户完全无感。
    // 这里先 lstat，再显式拒绝 symlink；普通目录 / 文件路径走原逻辑。
    const st = fsSync.lstatSync(custom);
    if (st.isSymbolicLink()) {
      exists = false;
    } else if (!st.isDirectory()) {
      // dataDir 字段意外指向了一个文件路径（用户在设置对话框里手填、或
      // config.json 被改坏），仍应 fallback，否则上层 scanDir / watchDir
      // 立刻 ENOTDIR 报上来，体验割裂。
      exists = false;
    }
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') {
      exists = false;
    } else {
      // EACCES / EBUSY / EPERM / EIO 等：当作存在，让上层自然处理错误
      // （fallback 反而会掩盖真实问题，比如 U 盘权限错误需要用户介入）
      exists = true;
    }
  }
  _resolveCache = { customDir: custom, exists };
  if (exists) {
    return { dir: custom, fellBack: false, saved: custom };
  }
  console.warn(`[config-store] 数据目录不可访问（${custom}），临时回退到默认 ${DEFAULT_DATA_DIR}`);
  ensureDefaultDataDirSync();
  scheduleEnsureDefaultDataDir();
  return { dir: DEFAULT_DATA_DIR, fellBack: true, saved: custom };
}

/**
 * 清掉 resolveDataDirOrFallback 的缓存。
 *
 * 内部仅由 saveConfig 在 dataDir 字段变化时调用 —— 让 schema 校验后改值不会让旧
 * 缓存继续返回错误结果。外部无需直接调用（reset IPC 自己会改 dataDir 走 saveConfig）。
 */
function _invalidateResolveCache() {
  _resolveCache = null;
}

function getConfig() {
  if (!configLoaded) {
    // 防御：调用方忘了 load() —— 隐式初始化一次
    loadConfig();
  }
  return appConfig;
}

/**
 * 首次启动把 data/README.md 种子化到默认数据目录。
 *
 * 触发条件（任一为真则跳过）：
 *   - 默认目录里已有 README.md（已种子过）→ 直接 return
 *   - 默认目录里有其它 .md 文件（用户笔记）→ 不覆盖
 *
 * 用 README.md 自己作为「已种子」的隐式标记，不再写 .notes-seeded 隐藏文件
 * —— 用户数据目录应该只放用户的内容。
 *
 * 不再守卫「用户没设 dataDir」：auto-fallback 路径下用户设了 dataDir 但路径失效，
 * 也会 runtime 回退到默认目录 —— 这时默认目录可能是空的，要种子化 README
 * 让用户立刻看到内容（而不是打开一个空侧栏）。
 *
 * 失败仅 console.warn，不弹窗；用户用「打开数据文件夹」按钮可以自己补救。
 */

/**
 * 种子文件清单 —— 顺序就是侧栏显示顺序（README 是首页）。
 * 新增 onboarding 文档时只在这里加一行 + 在 data/ 下放对应源文件，无需改 IPC / 主流程。
 */
const ONBOARDING_SEED_FILES = [
  'README.md',
];

async function ensureDefaultDataDir() {
  if (!DEFAULT_DATA_DIR) return;
  const targetDir = DEFAULT_DATA_DIR;
  const sentinelDst = path.join(targetDir, 'README.md');

  try {
    // 先确保目录存在（mkdir recursive 不存在就建、存在 no-op）。
    // ensureDefaultDataDirSync 已经在 resolveDataDirOrFallback 同步路径里调过
    // 一次，这里再调一次是 idempotent 的——但 async 路径是 fire-and-forget，
    // 可能在 sync 路径之前跑（scheduleEnsureDefaultDataDir 从 IPC handler 进）
    // 或之后（启动 bootstrap），所以这里再保险一次。
    await fs.mkdir(targetDir, { recursive: true });

    // README.md 已存在 → 已经种子过（或用户改过），跳过整个 onboarding 集合
    try {
      await fs.stat(sentinelDst);
      return;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }

    // 已有其它 .md → 用户笔记，不种子化也不打扰用户
    const dirEntries = await fs.readdir(targetDir).catch((err) => {
      if (err.code === 'ENOENT') return [];
      throw err;
    });
    if (dirEntries.some((n) => n.toLowerCase().endsWith('.md'))) {
      return;
    }

    // 种子化整套 onboarding 文件。每个文件独立 copyFile —— 中途某一份失败
    // 不影响其他（部分种子优于全失败，符合"让用户立刻看到内容"的目标）。
    const seeded = [];
    for (const fileName of ONBOARDING_SEED_FILES) {
      try {
        const src = path.join(__dirname, '..', 'data', fileName);
        const dst = path.join(targetDir, fileName);
        await fs.copyFile(src, dst);
        seeded.push(fileName);
      } catch (fileErr) {
        // 单文件失败（最常见：data/ 里漏放新文件源）仅 warn，不中断剩余文件
        console.warn(`[config-store] 种子 ${fileName} 失败:`, fileErr.message);
      }
    }
    if (seeded.length > 0) {
      console.log(`[config-store] 已种子 onboarding 到默认数据目录（${seeded.length} 个）:`, targetDir);
    }
  } catch (e) {
    console.warn('[config-store] onboarding 种子失败:', e.message);
  }
}

/**
 * 首次启动种子别名 —— 保留旧 API 名字（main.js 调用方），内部委托给 ensureDefaultDataDir。
 * 新代码优先用 ensureDefaultDataDir；旧名仅作 bootstrap 时的语义入口。
 */
async function seedDefaultDataDir() {
  return ensureDefaultDataDir();
}

/**
 * fire-and-forget 异步种子 —— resolveDataDirOrFallback 内每次返回 DEFAULT_DATA_DIR
 * 都会调它，确保在 IPC handler 同步返回之后异步把 README.md 种子进去。
 *
 * 用 _ensureInFlight Promise 去重：同一时间多次触发只跑一次（fsWatcher 启动后
 * 第一次 IPC scanDir 触发 fallback + renderer 启动后的 resetDataDir + 启动自身
 * 三条路径都会调用，全部共享同一份 in-flight promise）。
 */
let _ensureInFlight = null;
function scheduleEnsureDefaultDataDir() {
  if (_ensureInFlight) return _ensureInFlight;
  _ensureInFlight = ensureDefaultDataDir().finally(() => {
    _ensureInFlight = null;
  });
  return _ensureInFlight;
}

/**
 * 一站式初始化：loadConfig + 设定 DEFAULT_DATA_DIR。
 * 必须在 app ready 之后调（getDefaultDataDir 用到 app.getPath）。
 */
function init() {
  appConfig = loadConfig();
  DEFAULT_DATA_DIR = getDefaultDataDir();
  return { appConfig, defaultDataDir: DEFAULT_DATA_DIR };
}

/**
 * 测试辅助：把模块级状态重置回初始值（appConfig={}, DEFAULT_DATA_DIR=null, configLoaded=false）。
 *
 * 下划线前缀表示「仅测试用」—— 生产代码不应调用。单测之间需要干净的隔离。
 */
function _reset() {
  appConfig = {};
  DEFAULT_DATA_DIR = null;
  configLoaded = false;
  // auto-fallback 2026-08：测试间清理缓存，避免上一个 case 残留 customDir
  // 命中率污染下一个 case 的首次 stat。
  _resolveCache = null;
  // ensureDefaultDataDir 的 in-flight 也要清，避免上一个 case 的种子任务
  // 在新 case 期间仍在跑（race）。
  _ensureInFlight = null;
  // audit fix (Round 12 P2)：saveQueue 也要清。前一个 case 的 saveConfig
  // 若没 await 就 _reset，新 case 的 saveConfig 会链到旧 case 的尾后 →
  // 跨 case 串扰（renderer 端 / 用户态不会触发，但单测 _reset 后再 save
  // 必须从干净 queue 开始）。
  saveQueue = Promise.resolve();
}

/**
 * 测试辅助：注入 fake electron.app。单测里 vi.mock('electron') 拦不住 CJS 的 require，
 * 所以提供 setter 让测试换掉内部 app 引用。
 */
function _setApp(mockApp) {
  _app = mockApp;
}

module.exports = {
  init,
  loadConfig,
  saveConfig,
  getConfig,
  getConfigPath,
  getDefaultDataDir,
  resolveDataDir,
  resolveDataDirOrFallback,
  ensureDefaultDataDir,
  ensureDefaultDataDirSync,
  scheduleEnsureDefaultDataDir,
  seedDefaultDataDir,
  _reset,
  _setApp,
};
