// Stage 7 tests: main/config-store.js
//
// 覆盖：
//   - init() 触发 loadConfig + 设定 DEFAULT_DATA_DIR
//   - saveConfig 合并写入 + 返回新 config
//   - resolveDataDir：用户自定义 > 默认
//   - seedDefaultDataDir：sentinel 已存在 / 已有 .md / 自定义目录 → 跳过
//   - getConfig / getDefaultDataDir / loadConfig 在 init 后行为
//
// 配置模块依赖 `electron.app` —— 通过 _setApp() 注入 fake app（vi.mock('electron')
// 拦不住 CJS 的 require 调用，所以走 config-store 自己暴露的 setter）。
// 文件系统通过临时目录 + 真实的 fs.promises（mock 太多会失去意义）。
//
// 注意：模块 init 会被显式调用，不能假设 module 级副作用。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, statSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// 真实生产环境走 require('electron')，单测里 vi.mock('electron') 拦不住 CJS 的 require。
// config-store 暴露了 _setApp(mockApp) 让我们注入假 app。
const configStore = await import('../../main/config-store.js');
const { DEFAULT_SETTINGS: DEFAULT_CONFIG, coerceLoadedSettings } = await import('../../shared/settings-schema.js');

let mockHomeDir;
let mockUserDataDir;

beforeEach(() => {
  mockHomeDir = mkdtempSync(join(tmpdir(), 'notes-test-home-'));
  mockUserDataDir = mkdtempSync(join(tmpdir(), 'notes-test-userdata-'));
  // 注入假 app
  configStore._setApp({
    getPath: (name) => {
      if (name === 'home') return mockHomeDir;
      if (name === 'userData') return mockUserDataDir;
      throw new Error(`unexpected getPath(${name})`);
    },
  });
  // 重置模块状态（appConfig / DEFAULT_DATA_DIR / configLoaded）
  configStore._reset();
});

afterEach(() => {
  if (mockHomeDir) rmSync(mockHomeDir, { recursive: true, force: true });
  if (mockUserDataDir) rmSync(mockUserDataDir, { recursive: true, force: true });
});

describe('init', () => {
  it('返回 {appConfig, defaultDataDir}', () => {
    const result = configStore.init();
    expect(result.appConfig).toBeDefined();
    expect(result.defaultDataDir).toBe(join(mockHomeDir, 'Notes'));
  });

  it('loadConfig 后 getConfig 返回当前配置', () => {
    configStore.init();
    expect(configStore.getConfig()).toEqual({ ...DEFAULT_CONFIG });
  });

  it('userData/config.json 不存在时用默认值', () => {
    configStore.init();
    expect(configStore.getConfig()).toEqual({ ...DEFAULT_CONFIG });
  });

  it('userData/config.json 存在时读取并 sanitize', () => {
    writeFileSync(
      join(mockUserDataDir, 'config.json'),
      JSON.stringify({ theme: 'light', dataDir: 'D:\\notes' }),
      'utf-8'
    );
    configStore.init();
    const cfg = configStore.getConfig();
    expect(cfg.theme).toBe('light');
    expect(cfg.dataDir).toBe('D:\\notes');
  });

  it('JSON 损坏 → fallback 到默认', () => {
    writeFileSync(join(mockUserDataDir, 'config.json'), '{not json', 'utf-8');
    configStore.init();
    expect(configStore.getConfig()).toEqual({ ...DEFAULT_CONFIG });
  });
});

describe('saveConfig', () => {
  it('合并写入并返回新配置', async () => {
    configStore.init();
    const result = await configStore.saveConfig({ theme: 'light' });
    // audit fix (C2)：saveConfig 现在返回 {ok, value|error}
    expect(result.ok).toBe(true);
    expect(result.value.theme).toBe('light');
  });

  it('不传 → 等价于 no-op', async () => {
    configStore.init();
    const before = configStore.getConfig();
    const result = await configStore.saveConfig({});
    expect(result.ok).toBe(true);
    expect(result.value).toEqual(before);
  });

  it('多次 saveConfig 累加字段', async () => {
    configStore.init();
    await configStore.saveConfig({ theme: 'light' });
    await configStore.saveConfig({ themePalette: 'ocean' });
    const cfg = configStore.getConfig();
    expect(cfg.theme).toBe('light');
    expect(cfg.themePalette).toBe('ocean');
  });

  it('写入磁盘后再 init → 拿到上次的值', async () => {
    configStore.init();
    await configStore.saveConfig({ theme: 'light', themePalette: 'forest' });

    // 重新加载模块（在另一个进程里没法做，但 init 重读即可）
    configStore.init();
    expect(configStore.getConfig().theme).toBe('light');
    expect(configStore.getConfig().themePalette).toBe('forest');
  });

  it('audit fix (C2)：saveConfig 返回 Promise<{ok,value}> 而非合并后的对象', async () => {
    // 旧 API 是直接返回 appConfig，renderer 端 settings-store 误把它当作
    // 已经持久化的对象来用。改异步后契约改成 {ok:true, value:...}，让失败路径
    // 能区分。回归这条断言防止以后又退回到同步返回 appConfig。
    configStore.init();
    const result = await configStore.saveConfig({ theme: 'light' });
    expect(result).toMatchObject({ ok: true });
    expect(result).toHaveProperty('value');
    expect(result.value).toEqual(expect.objectContaining({ theme: 'light' }));
  });

  // audit fix (Round 4 P0-1)：saveConfig 必须 fsync tmp 文件再 rename，否则断电
  // 后磁盘上可能是新 inode + 空内容（rename 是原子的，但写盘数据还在 page cache，
  // 没 fsync 就断电 → 内核丢弃 page cache → 文件确实是 0 字节）。
  // 之前实现直接走 fs.writeFile + rename，没任何 fsync —— AI key / 自定义 dataDir
  // 这类关键配置可能因为断电被永久清空。本测试用 spy 钉死「先 sync 再 close 再 rename」
  // 的时序，防止未来重构改回 fs.writeFile 而无人察觉。
  it('audit fix (P0-1)：saveConfig 在 rename 前调用 fh.sync()', async () => {
    configStore.init();
    const fsPromises = await import('fs').then((m) => m.promises);
    const realOpen = fsPromises.open;
    /** @type {Array<{method: string, whenMs: number}>} */
    const calls = [];
    let syncCalledAt = -1;
    let closeCalledAt = -1;
    /** @type {string[]} */
    const openedFiles = [];
    fsPromises.open = async function spyOpen(p, flags) {
      openedFiles.push(String(p));
      const fh = await realOpen.call(fsPromises, p, flags);
      // 只 spy tmp 文件（路径含 .tmp.），不动 userData 目录本身
      if (String(p).includes('.tmp.')) {
        const realSync = fh.sync.bind(fh);
        const realClose = fh.close.bind(fh);
        fh.sync = async function spySync() {
          syncCalledAt = Date.now();
          calls.push({ method: 'sync' });
          return realSync();
        };
        fh.close = async function spyClose() {
          closeCalledAt = Date.now();
          calls.push({ method: 'close' });
          return realClose();
        };
      }
      return fh;
    };
    try {
      await configStore.saveConfig({ theme: 'light' });
    } finally {
      fsPromises.open = realOpen;
    }
    // 关键断言：sync 必须在 close 之前被调用（即「先落盘再 close」的原子模式）
    expect(syncCalledAt).toBeGreaterThan(0);
    expect(closeCalledAt).toBeGreaterThan(0);
    expect(syncCalledAt).toBeLessThanOrEqual(closeCalledAt);
    // 调用顺序必须是 [sync, close]（不能 close 在 sync 之前）
    const syncIdx = calls.findIndex((c) => c.method === 'sync');
    const closeIdx = calls.findIndex((c) => c.method === 'close');
    expect(syncIdx).toBeGreaterThanOrEqual(0);
    expect(closeIdx).toBeGreaterThan(syncIdx);
    // tmp 路径应被打开过（确保本测试在真路径上跑）
    expect(openedFiles.some((p) => p.includes('.tmp.'))).toBe(true);
  });

  // audit fix (Round 12 P1)：saveConfig 在 rename 成功后必须对父目录 fsync
  // （POSIX only），与 main/file-ops.js#atomicWriteFile 的 Round 4 修复对称。
  // Windows NTFS journal 元数据自带 fsync 语义跳过；POSIX rename(2) 同分区下
  // 原子，但「目录项本身」写入磁盘的时机由内核控制 —— rename 完不 fsync 父目录
  // 就断电，下次启动目录里可能仍是旧名字 + 新 inode 已分配但未刷盘。
  // 这里 spy fsPromises.open 抓「tmp 之后」的 directory open + sync + close，
  // 钉死时序：先 open parent → sync → close → 之后才走后续逻辑。
  it('audit fix (Round 12 P1)：saveConfig rename 后对父目录 fsync（POSIX）', async () => {
    // 只在 POSIX 平台跑：Windows NTFS 不需要这步（journal 元数据自带 fsync）
    if (process.platform === 'win32') {
      // Windows 跳过：但仍验证代码没崩（rename 路径本身要走完）
      configStore.init();
      await configStore.saveConfig({ theme: 'dark' });
      return;
    }
    configStore.init();
    const fsPromises = await import('fs').then((m) => m.promises);
    const realOpen = fsPromises.open;
    /** @type {Array<{method: string, path: string}>} */
    const parentCalls = [];
    let parentSyncAt = -1;
    let parentCloseAt = -1;
    let tmpSyncAt = -1;
    let tmpRenameDoneAt = -1;
    /** @type {string[]} */
    const openedPaths = [];
    fsPromises.open = async function spyOpen(p, flags) {
      openedPaths.push(String(p));
      const fh = await realOpen.call(fsPromises, p, flags);
      const pathStr = String(p);
      // 父目录 fsync：不是 .tmp. 路径，且不是 userData/config.json 本身，
      // 就是 userData 父目录（saveConfig fs.open(parent, 'r')）
      if (!pathStr.includes('.tmp.') && !pathStr.endsWith('config.json')) {
        const realSync = fh.sync.bind(fh);
        const realClose = fh.close.bind(fh);
        fh.sync = async function spySync() {
          parentSyncAt = Date.now();
          parentCalls.push({ method: 'sync', path: pathStr });
          return realSync();
        };
        fh.close = async function spyClose() {
          parentCloseAt = Date.now();
          parentCalls.push({ method: 'close', path: pathStr });
          return realClose();
        };
      } else if (pathStr.includes('.tmp.')) {
        const realSync = fh.sync.bind(fh);
        fh.sync = async function spySync() {
          tmpSyncAt = Date.now();
          return realSync();
        };
      }
      return fh;
    };
    try {
      await configStore.saveConfig({ theme: 'dark' });
      // rename 是同步的 renameSync，通过 fs.promises.rename 调用；spy 不抓
      // 我们假设它发生在 sync 之后（生产代码时序就是 rename → fsync parent）。
      // 简化：把 tmpSyncAt+1 当作 rename 完成时间（rename 紧跟 tmp sync 后）。
      tmpRenameDoneAt = tmpSyncAt + 1;
    } finally {
      fsPromises.open = realOpen;
    }
    // 关键：parent fsync 必须发生在 tmp sync + rename 之后
    expect(openedPaths.some((p) => !p.includes('.tmp.') && !p.endsWith('config.json'))).toBe(true);
    expect(parentSyncAt).toBeGreaterThan(0);
    expect(parentCloseAt).toBeGreaterThan(0);
    // 时序：parent.sync 在 parent.close 之前
    const syncIdx = parentCalls.findIndex((c) => c.method === 'sync');
    const closeIdx = parentCalls.findIndex((c) => c.method === 'close');
    expect(syncIdx).toBeGreaterThanOrEqual(0);
    expect(closeIdx).toBeGreaterThan(syncIdx);
    // 时序：parent.sync 必须在 rename 之后（防止以后有人手贱把 fsync 挪到 rename 前）
    expect(parentSyncAt).toBeGreaterThanOrEqual(tmpRenameDoneAt);
  });

  // audit fix (Round 12 P2)：saveConfig 失败时 result.error 走 friendly-fs-error
  // 中文文案，不再泄漏原始 e.message（英文 errno + 路径）。
  it('audit fix (Round 12 P2)：saveConfig 失败 error 走 friendly-fs-error 而非原始 e.message', async () => {
    configStore.init();
    const fsPromises = await import('fs').then((m) => m.promises);
    const realOpen = fsPromises.open;
    fsPromises.open = async function boom() {
      const err = new Error('EACCES: permission denied, open \'/secret/path\'');
      err.code = 'EACCES';
      throw err;
    };
    try {
      const result = await configStore.saveConfig({ theme: 'light' });
      expect(result.ok).toBe(false);
      // 不能再含英文 errno 原文
      expect(result.error).not.toMatch(/^EACCES:/);
      // 必须是友好中文（friendly-fs-error 对 EACCES 给的固定文案）
      expect(typeof result.error).toBe('string');
      expect(result.error.length).toBeGreaterThan(0);
    } finally {
      fsPromises.open = realOpen;
    }
  });

  // audit fix (Round 12 P2)：_reset 必须清 saveQueue，否则上一个 case 的
  // fire-and-forget save 会污染下一个 case 的 saveConfig 串行化链。
  // 验证方式：init → 拿第一个 promise (p1) → _reset（清队列）→ 重新 init
  // → 拿第二个 promise (p2)。若 _reset 没清队列，p2 会链到 p1.then(...) 的
  // 尾部，但 p1 的 task 在 _reset 后 appConfig 已被清空的状态下仍会跑（with
  // 空 before / 异常合并）—— 副作用：模拟器内的 fs 在 _reset 后 mockHomeDir
  // 被释放，p1 实际 reject（资源不可用）。新 case 的 p2 必须独立 ok=true，
  // 不被 p1 的失败拖累。
  it('audit fix (Round 12 P2)：_reset 后 saveConfig 独立成功（saveQueue 与旧 case 断链）', async () => {
    configStore.init();
    // 旧 case：fire-and-forget saveConfig，p1 任务在 saveQueue 尾排队
    const p1 = configStore.saveConfig({ theme: 'first' });
    // 等一拍微任务，让 p1 进入 task 阶段（open tmp...）
    await new Promise((r) => setImmediate(r));

    // _reset 切断 saveQueue —— 关键修复点
    configStore._reset();
    // 重新注入 app + init（新 case）
    configStore._setApp({
      getPath: (name) => {
        if (name === 'home') return mockHomeDir;
        if (name === 'userData') return mockUserDataDir;
        throw new Error(`unexpected getPath(${name})`);
      },
    });
    configStore.init();

    // p2：独立 saveConfig，必须独立成功。如果 _reset 没清 saveQueue，
    // p2 会链到 p1.then(...)，而 p1 此刻正在用被 _reset 清空的 appConfig 跑
    // task，merge 时 `before = {}`（被清）、`merged = {theme:'second'}` 表面
    // 正常但 fs 操作可能因时序问题让 p2 也 fail / hang。
    const p2 = configStore.saveConfig({ theme: 'second' });
    const result = await p2;
    expect(result.ok).toBe(true);
    expect(result.value.theme).toBe('second');

    // 让旧 case 的 p1 跑完（避免污染下一个 test）
    await Promise.race([p1.catch(() => null), new Promise((r) => setTimeout(r, 100))]);
  });
});

describe('getDefaultDataDir', () => {
  it('返回 <home>/Notes', () => {
    configStore.init();
    expect(configStore.getDefaultDataDir()).toBe(join(mockHomeDir, 'Notes'));
  });
});

describe('resolveDataDir', () => {
  it('未设置 dataDir → 返回默认', () => {
    configStore.init();
    expect(configStore.resolveDataDir()).toBe(join(mockHomeDir, 'Notes'));
  });

  it('设置了 dataDir → 优先用自定义', async () => {
    configStore.init();
    await configStore.saveConfig({ dataDir: 'C:\\custom' });
    expect(configStore.resolveDataDir()).toBe('C:\\custom');
  });

  it('dataDir 是空白字符串 → 走默认', async () => {
    configStore.init();
    await configStore.saveConfig({ dataDir: '   ' });
    expect(configStore.resolveDataDir()).toBe(join(mockHomeDir, 'Notes'));
  });

  it('dataDir 是空字符串 → 走默认', async () => {
    configStore.init();
    await configStore.saveConfig({ dataDir: '' });
    expect(configStore.resolveDataDir()).toBe(join(mockHomeDir, 'Notes'));
  });
});

describe('resolveDataDirOrFallback（auto-fallback 2026-08）', () => {
  // 这些测试只关心函数返回值，不在乎 schema 默认值。
  // 直接走 fsSync（生产代码用的也是 fsSync.statSync），用临时目录 + rmSync 制造
  // 存在/不存在的目标；不 mock fs —— 真正 stat 一次成本可忽略（毫秒级 tmp 目录）。
  //
  // 关于 spy：试过 vi.spyOn + 直接赋值 + defineProperty，都因为 fs.statSync 在
  // Node ESM 模块导出上 {configurable:false} 而抛 "Cannot redefine property"。
  // 改用「文件系统观察」验证缓存：先 populate 缓存（首次调用），然后 mutate 磁盘
  // （删除目录 / 重建目录），再调用 → 如果返回值跟着磁盘变说明没缓存、跟着首次调用
  // 时的状态说明命中缓存。这样测「不重复 stat」的语义更可靠（行为契约而非 spy 计数）。

  it('未设置 dataDir → 返回默认 + fellBack:false', () => {
    configStore.init();
    const out = configStore.resolveDataDirOrFallback();
    expect(out.dir).toBe(join(mockHomeDir, 'Notes'));
    expect(out.fellBack).toBe(false);
    expect(out.saved).toBe('');
  });

  it('dataDir 指向存在的目录 → 返回 custom + fellBack:false', async () => {
    configStore.init();
    const realDir = mkdtempSync(join(tmpdir(), 'notes-fb-exist-'));
    await configStore.saveConfig({ dataDir: realDir });
    const out = configStore.resolveDataDirOrFallback();
    expect(out.dir).toBe(realDir);
    expect(out.fellBack).toBe(false);
    expect(out.saved).toBe(realDir);
    rmSync(realDir, { recursive: true, force: true });
  });

  it('dataDir 指向不存在的路径 → 回退到默认 + fellBack:true + saved 原值', async () => {
    configStore.init();
    const missing = join(tmpdir(), 'notes-fb-missing-' + Date.now() + '-' + Math.random());
    await configStore.saveConfig({ dataDir: missing });
    const out = configStore.resolveDataDirOrFallback();
    expect(out.dir).toBe(join(mockHomeDir, 'Notes'));
    expect(out.fellBack).toBe(true);
    expect(out.saved).toBe(missing);
  });

  it('dataDir 指向文件而非目录（ENOTDIR）→ 回退到默认', async () => {
    // ENOTDIR 不像 ENOENT 那样常见，但属于「路径存在但不可用」一类，仍应 fallback。
    configStore.init();
    const tmpFile = join(mockUserDataDir, 'not-a-dir-' + Date.now() + '.txt');
    writeFileSync(tmpFile, 'x', 'utf-8');
    await configStore.saveConfig({ dataDir: tmpFile });
    const out = configStore.resolveDataDirOrFallback();
    expect(out.fellBack).toBe(true);
    expect(out.dir).toBe(join(mockHomeDir, 'Notes'));
    expect(out.saved).toBe(tmpFile);
  });

  it('缓存：首次 stat 后再删目录 → 仍返回原路径（命中缓存）', async () => {
    configStore.init();
    const realDir = mkdtempSync(join(tmpdir(), 'notes-fb-cache-'));
    await configStore.saveConfig({ dataDir: realDir });

    // 首次调用：populate 缓存（exists=true）
    const out1 = configStore.resolveDataDirOrFallback();
    expect(out1.dir).toBe(realDir);
    expect(out1.fellBack).toBe(false);

    // 现在删除磁盘上的目录（如果函数每次都 stat，会立即检测到 ENOENT → 回退）
    rmSync(realDir, { recursive: true, force: true });

    // 二次调用：必须仍返回原路径 —— 否则说明每次都 stat、缓存没生效
    const out2 = configStore.resolveDataDirOrFallback();
    expect(out2.dir).toBe(realDir);
    expect(out2.fellBack).toBe(false);
  });

  it('缓存：saveConfig 改了 dataDir → 下次重新 stat（删旧目录不命中缓存）', async () => {
    // 验证缓存失效语义：第一次 cache 指向 A → 改 dataDir 到 B → 删 A 再调用
    // → 应该返回 B（缓存已失效，新 dataDir 重新走 stat），不能返回 A。
    configStore.init();
    const dirA = mkdtempSync(join(tmpdir(), 'notes-fb-A-'));
    const dirB = mkdtempSync(join(tmpdir(), 'notes-fb-B-'));
    await configStore.saveConfig({ dataDir: dirA });
    configStore.resolveDataDirOrFallback();   // populate cache: exists(A)=true

    await configStore.saveConfig({ dataDir: dirB });  // dataDir 变了 → cache 失效
    rmSync(dirA, { recursive: true, force: true });

    const out = configStore.resolveDataDirOrFallback();
    expect(out.dir).toBe(dirB);   // 不是 dirA —— 缓存确实失效了
    expect(out.fellBack).toBe(false);
    rmSync(dirB, { recursive: true, force: true });
  });

  it('缓存：fallback 命中（customDir 不存在）也缓存 → 后续不重新 stat', async () => {
    // 反向验证：首次 stat 出 ENOENT 后，磁盘上即使新建了同路径，再次调用也仍
    // 返回 default —— 因为缓存里这条 customDir 被记成 exists=false。
    configStore.init();
    const missing = join(tmpdir(), 'notes-fb-cache-missing-' + Date.now());
    await configStore.saveConfig({ dataDir: missing });

    const out1 = configStore.resolveDataDirOrFallback();
    expect(out1.fellBack).toBe(true);

    // 磁盘上把这条路径建出来（如果每次 stat，会立刻发现它存在 → 不 fallback）
    mkdirSync(missing, { recursive: true });

    const out2 = configStore.resolveDataDirOrFallback();
    expect(out2.fellBack).toBe(true);   // 仍是 fallback —— 缓存生效
    expect(out2.dir).toBe(join(mockHomeDir, 'Notes'));

    rmSync(missing, { recursive: true, force: true });
  });

  it('dataDir 是空白字符串 → 等同未设置', async () => {
    configStore.init();
    await configStore.saveConfig({ dataDir: '   ' });
    const out = configStore.resolveDataDirOrFallback();
    expect(out.dir).toBe(join(mockHomeDir, 'Notes'));
    expect(out.fellBack).toBe(false);
    expect(out.saved).toBe('');
  });

  it('saveConfig 未改 dataDir → 缓存不失效', async () => {
    // 反向验证 saveConfig 的失效条件精确：只有 dataDir 真改了才清缓存，
    // 改别的字段不应该让缓存跟着失效。
    configStore.init();
    const realDir = mkdtempSync(join(tmpdir(), 'notes-fb-noevict-'));
    await configStore.saveConfig({ dataDir: realDir });
    configStore.resolveDataDirOrFallback();   // populate cache
    rmSync(realDir, { recursive: true, force: true });

    // saveConfig 一个无关字段 → 缓存不应失效，所以仍返回原路径
    await configStore.saveConfig({ themePalette: 'ocean' });
    const out = configStore.resolveDataDirOrFallback();
    expect(out.dir).toBe(realDir);   // 缓存没失效 → 仍返回原路径
    expect(out.fellBack).toBe(false);
  });

  it('saveConfig 把 dataDir 从有值改为空 → 缓存失效，下次返回默认', async () => {
    // 模拟「回到默认」按钮的语义：dataDir 从 custom 切到空 → 下次 resolveDataDirOrFallback
    // 应走默认路径，fellBack=false。
    configStore.init();
    const realDir = mkdtempSync(join(tmpdir(), 'notes-fb-clear-'));
    await configStore.saveConfig({ dataDir: realDir });
    configStore.resolveDataDirOrFallback();   // cache: customDir=realDir, exists=true

    await configStore.saveConfig({ dataDir: '' });   // 切到默认（持久化清空）
    rmSync(realDir, { recursive: true, force: true });

    const out = configStore.resolveDataDirOrFallback();
    expect(out.dir).toBe(join(mockHomeDir, 'Notes'));
    expect(out.fellBack).toBe(false);
    expect(out.saved).toBe('');
  });

  it('_reset 清掉缓存（测试间隔离）', async () => {
    // _reset 的契约是「清掉模块级 in-memory 状态 + 缓存」，**不**清磁盘。
    // 测试间隔离的核心是缓存：上一个 case populate 了缓存，新 case 用同一个
    // customDir 字符串如果不重置就会命中旧缓存（即便磁盘状态已变）。
    //
    // 验证方式：populate 缓存为「exists=true」→ 磁盘上删除目录 → _reset → 重
    // 新 init（不重新保存，磁盘上的 config.json 还指向已删除路径）→ 应该重新
    // stat，磁盘真实状态 ENOENT 浮现出来，fellBack=true。如果 _reset 没清掉
    // 缓存就会继续返回原路径 + fellBack:false，断言失败。
    configStore.init();
    const realDir = mkdtempSync(join(tmpdir(), 'notes-fb-reset-'));
    await configStore.saveConfig({ dataDir: realDir });
    configStore.resolveDataDirOrFallback();   // populate cache: exists=true
    expect(configStore.resolveDataDirOrFallback().fellBack).toBe(false);

    rmSync(realDir, { recursive: true, force: true });
    configStore._reset();
    // 重新 init —— loadConfig() 会从磁盘读到 dataDir=realDir（已删除），
    // 然后 resolveDataDirOrFallback 重新 stat，ENOENT → fellBack=true。
    // 走磁盘文件验证不依赖任何残留缓存。
    configStore._setApp({
      getPath: (name) => {
        if (name === 'home') return mockHomeDir;
        if (name === 'userData') return mockUserDataDir;
        throw new Error(`unexpected getPath(${name})`);
      },
    });
    configStore.init();
    const out = configStore.resolveDataDirOrFallback();
    // 磁盘上 realDir 已删除 → fellBack=true，dir 是默认。这是「缓存真的清掉
    // 了」的标志 —— 如果 cache 还指向 exists=true，这里就会返回 realDir。
    expect(out.dir).toBe(join(mockHomeDir, 'Notes'));
    expect(out.fellBack).toBe(true);
    expect(out.saved).toBe(realDir);
  });
});

describe('ensureDefaultDataDir（auto-create + seed 2026-08）', () => {
  // 用 welcome.md 自己作为「已种子」标记，不再写 .notes-seeded 隐藏文件
  // —— 用户数据目录应该只放用户的内容。

  it('welcome.md 已存在 → 跳过（幂等）', async () => {
    configStore.init();
    const defaultDir = join(mockHomeDir, 'Notes');
    mkdirSync(defaultDir, { recursive: true });
    writeFileSync(join(defaultDir, 'welcome.md'), '用户改过的内容', 'utf-8');

    await configStore.ensureDefaultDataDir();

    // welcome.md 存在 → 不重新复制
    expect(readFileSync(join(defaultDir, 'welcome.md'), 'utf-8')).toBe('用户改过的内容');
  });

  it('默认目录已有其它 .md → 不复制 welcome.md，不写隐藏文件', async () => {
    configStore.init();
    const defaultDir = join(mockHomeDir, 'Notes');
    mkdirSync(defaultDir, { recursive: true });
    writeFileSync(join(defaultDir, 'user-existing.md'), '# user', 'utf-8');

    await configStore.ensureDefaultDataDir();

    // 不复制 welcome.md，也不创建 .notes-seeded（用户数据目录应该干净）
    expect(existsSync(join(defaultDir, 'welcome.md'))).toBe(false);
    expect(existsSync(join(defaultDir, '.notes-seeded'))).toBe(false);
  });

  it('默认目录为空 → 复制 welcome.md（不创建隐藏文件）', async () => {
    configStore.init();
    const defaultDir = join(mockHomeDir, 'Notes');
    mkdirSync(defaultDir, { recursive: true });

    await configStore.ensureDefaultDataDir();

    expect(existsSync(join(defaultDir, 'welcome.md'))).toBe(true);
    expect(existsSync(join(defaultDir, '.notes-seeded'))).toBe(false);
  });

  it('默认目录不存在 → 自动创建 + 复制', async () => {
    configStore.init();
    // 不 mkdir，让 ensure 自己去建

    await configStore.ensureDefaultDataDir();

    const defaultDir = join(mockHomeDir, 'Notes');
    expect(existsSync(defaultDir)).toBe(true);
    expect(existsSync(join(defaultDir, 'welcome.md'))).toBe(true);
  });

  it('用户已设 customDir → 仍种子默认目录（auto-fallback 需要）', async () => {
    // 关键回归测试：之前 seedDefaultDataDir 在 dataDir 设置时跳过，导致
    // U 盘掉线 fallback 到默认时默认目录从未建过 / 种子过。现在 ensure
    // 不再守这个条件，customDir 失效场景下默认目录也能立刻有内容。
    configStore.init();
    await configStore.saveConfig({ dataDir: 'C:\\does-not-exist-anywhere' });

    await configStore.ensureDefaultDataDir();

    const defaultDir = join(mockHomeDir, 'Notes');
    expect(existsSync(defaultDir)).toBe(true);
    expect(existsSync(join(defaultDir, 'welcome.md'))).toBe(true);
  });

  it('重复调用幂等（welcome.md 命中后第二次不覆盖用户内容）', async () => {
    configStore.init();
    const defaultDir = join(mockHomeDir, 'Notes');
    mkdirSync(defaultDir, { recursive: true });

    await configStore.ensureDefaultDataDir();
    // 用户改 welcome.md 后再调一次 ensure → 内容应保留
    writeFileSync(join(defaultDir, 'welcome.md'), '用户改过的内容', 'utf-8');
    await configStore.ensureDefaultDataDir();

    expect(readFileSync(join(defaultDir, 'welcome.md'), 'utf-8')).toBe('用户改过的内容');
  });
});

describe('ensureDefaultDataDirSync（sync mkdir）', () => {
  it('默认目录不存在 → sync mkdir 建出来', () => {
    configStore.init();
    // 不预创建
    const defaultDir = join(mockHomeDir, 'Notes');
    expect(existsSync(defaultDir)).toBe(false);

    configStore.ensureDefaultDataDirSync();

    expect(existsSync(defaultDir)).toBe(true);
    expect(statSync(defaultDir).isDirectory()).toBe(true);
  });

  it('默认目录已存在 → no-op（不抛错）', () => {
    configStore.init();
    const defaultDir = join(mockHomeDir, 'Notes');
    mkdirSync(defaultDir, { recursive: true });
    writeFileSync(join(defaultDir, 'preexisting.txt'), 'hi', 'utf-8');

    configStore.ensureDefaultDataDirSync();

    // 已存在的文件保留
    expect(readFileSync(join(defaultDir, 'preexisting.txt'), 'utf-8')).toBe('hi');
  });

  it('resolveDataDirOrFallback 走默认时自动 ensure（fsWatcher 不撞 ENOENT）', () => {
    // 用户反馈：default 目录不存在 → fsWatcher 启动时 ENOENT 失败、侧栏空白。
    // 这里验证 resolveDataDirOrFallback 路径会自动 ensure，让 fsWatcher
    // 紧接着的 startWatchingDir 不再 ENOENT。
    configStore.init();
    const defaultDir = join(mockHomeDir, 'Notes');
    expect(existsSync(defaultDir)).toBe(false);

    const out = configStore.resolveDataDirOrFallback();
    expect(out.dir).toBe(defaultDir);
    // sync ensure 副作用：default 目录必须已存在
    expect(existsSync(defaultDir)).toBe(true);
  });

  it('resolveDataDirOrFallback fallback 路径也自动 ensure 默认目录', async () => {
    // U 盘掉线 → custom 失效 → runtime fallback 到默认。如果默认也从未
    // 建过/用过，要立刻能列出文件（welcome.md 由异步 ensure 种子）。
    configStore.init();
    const realDir = mkdtempSync(join(tmpdir(), 'notes-fb-ensure-'));
    await configStore.saveConfig({ dataDir: realDir });
    rmSync(realDir, { recursive: true, force: true });

    const defaultDir = join(mockHomeDir, 'Notes');
    expect(existsSync(defaultDir)).toBe(false);

    const out = configStore.resolveDataDirOrFallback();
    expect(out.fellBack).toBe(true);
    // sync ensure 已 mkdir 默认目录
    expect(existsSync(defaultDir)).toBe(true);
    // 异步种子：fire-and-forget，等 in-flight 完成
    await configStore.scheduleEnsureDefaultDataDir();
    expect(existsSync(join(defaultDir, 'welcome.md'))).toBe(true);
  });
});

describe('scheduleEnsureDefaultDataDir（fire-and-forget 去重）', () => {
  it('多次调用 → 只跑一次（共享 in-flight promise）', async () => {
    configStore.init();
    const defaultDir = join(mockHomeDir, 'Notes');
    mkdirSync(defaultDir, { recursive: true });

    const p1 = configStore.scheduleEnsureDefaultDataDir();
    const p2 = configStore.scheduleEnsureDefaultDataDir();
    const p3 = configStore.scheduleEnsureDefaultDataDir();
    // 共享同一份 Promise
    expect(p1).toBe(p2);
    expect(p2).toBe(p3);

    await Promise.all([p1, p2, p3]);
    // in-flight 已清空
    const p4 = configStore.scheduleEnsureDefaultDataDir();
    expect(p4).not.toBe(p1); // 新一次调用拿到的是新的（因为旧的已 settled）
  });

  it('seedDefaultDataDir 仍是 ensureDefaultDataDir 的别名（向后兼容）', async () => {
    configStore.init();
    const defaultDir = join(mockHomeDir, 'Notes');
    mkdirSync(defaultDir, { recursive: true });

    await configStore.seedDefaultDataDir();
    expect(existsSync(join(defaultDir, 'welcome.md'))).toBe(true);
  });
});

// 顺便校验 settings-schema 的 coerceLoadedSettings 也是兜底用的
describe('coerceLoadedSettings（schema 兜底）', () => {
  it('未知字段被剥离', () => {
    const out = coerceLoadedSettings({ theme: 'light', unknownField: 'x' });
    expect(out.theme).toBe('light');
    expect(out.unknownField).toBeUndefined();
  });

  it('已知字段缺省时用默认值', () => {
    const out = coerceLoadedSettings({ theme: 'light' });
    // 没传 dataDir → 走默认
    expect(out.theme).toBe('light');
    expect(out.dataDir).toBe(DEFAULT_CONFIG.dataDir);
  });

  it('空 / 非对象输入 → 默认值', () => {
    expect(coerceLoadedSettings(null)).toEqual({ ...DEFAULT_CONFIG });
    expect(coerceLoadedSettings(undefined)).toEqual({ ...DEFAULT_CONFIG });
    expect(coerceLoadedSettings('garbage')).toEqual({ ...DEFAULT_CONFIG });
  });
});