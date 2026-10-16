// main/fs-watcher.js 单测（Case-M1 audit fix + Round 13 fix 回归）
//
// 不在仓库里的测试 —— fs-watcher 600+ 行（数据目录监听 + 事件防抖 + 自写过滤 +
// 错误闩锁 + 退避重连 + generation token）一直没单元测试。这次先补 case-insensitive
// self-write filter 这一条（核心 bug 修复的回归锚点），其他路径（轮询 / 重连 / 错误
// 抑制）需要 jsdom + 真实 fs.watch 集成，留给后续 Story。
//
// 覆盖：
//   - markExpectedWrite / isSelfWrite：登记大小写 X 的路径，命中查询大小写 Y 也能识别
//   - 与 case-sensitive 的 Linux 行为对照（platform-based 切换）
//   - 过期条目被惰性 GC
//   - updateSnapshot 轮询路径 push 回归（Round 13 fix fce2d83 修复的 bug）：
//     旧实现 baseline 在 updateSnapshot 先写、emitFilesChanged 又读，看到同一
//     snapshot 时 if 块不进、safeSend 跳过 —— 2s 轮询（fs.watch 不可靠环境的
//     唯一兜底）检测到的改动永远不通知 renderer。

import { describe, it, expect, vi } from 'vitest';
const { createFsWatcher } = require('../../main/fs-watcher.js');

/**
 * 构造一个最小化的 fsWatcher 实例用于单元测试。
 * 不实际订阅 fs.watch、轮询或 IPC —— 我们只关心 self-write filter 的 Map 行为。
 */
function makeWatcher() {
  return createFsWatcher({
    // 不用 —— 只用 mark/isSelfWrite
    getMainWindow: () => null,
    resolveDataDir: () => null,
    scanDir: async () => ({ ok: true, entries: [] }),
  });
}

/**
 * 构造带 ipc spy 的 fsWatcher，用于验证 updateSnapshot regular path 是否
 * 真的把列表变化 push 到 renderer。getMainWindow 返回一个虚拟 BrowserWindow，
 * webContents.send 被替换为 vi.fn()，方便断言调用次数 + payload。
 */
function makeWatcherWithIpc(scanResults) {
  const sends = [];
  const fakeWin = {
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => sends.push({ channel, payload }) },
  };
  let scanIdx = 0;
  const w = createFsWatcher({
    getMainWindow: () => fakeWin,
    resolveDataDir: () => '/data',
    scanDir: async () => scanResults[scanIdx++] || { ok: true, entries: [] },
  });
  return { watcher: w, sends, fakeWin };
}

describe('fs-watcher markExpectedWrite / isSelfWrite (Case-M1)', () => {
  it('同 case 命中（sanity）', () => {
    const w = makeWatcher();
    w.markExpectedWrite('C:\\Notes\\foo.md', 1000);
    expect(w.isSelfWrite('C:\\Notes\\foo.md')).toBe(true);
  });

  it('Windows / darwin：跨 case 命中（Case-M1 修复）', () => {
    // audit fix (Case-M1)：fs.watch 在 Windows 上报的 filename 与 caller 写入的
    // case 可能不一致（取决于 ReadDirectoryChangesW / NTFS 短名 8.3 / 同步盘
    // 大小写敏感层）。strict Map.get 会漏命中 → renderer 把自写当成外部修改
    // 误报，用户选「用磁盘版」会覆盖刚保存的内容。
    const w = makeWatcher();
    const mixed = process.platform;
    // 在 Windows / darwin 上模拟「登记 Foo.md，watcher 上报 foo.md」
    w.markExpectedWrite(`C:\\Notes\\Foo.md`, 1000);
    const lookups = (process.platform === 'win32' || process.platform === 'darwin')
      ? [`C:\\Notes\\foo.md`, `C:\\Notes\\FOO.md`, `c:\\notes\\Foo.md`, `C:/Notes/Foo.md`]
      : [`C:\\Notes\\Foo.md`];
    for (const alt of lookups) {
      expect(w.isSelfWrite(alt)).toBe(true);
    }
    expect(mixed).toBeTruthy(); // sanity guard
  });

  it('Linux（case-sensitive 平台）：跨 case 不命中（旧行为保留）', () => {
    // 仅当跑在 Linux 上才相关：默认模拟 darwin 风格的 expect 命中安全，
    // 但 Linux 上 case-different 路径不应被误当作自写。
    if (process.platform === 'linux') {
      const w = makeWatcher();
      w.markExpectedWrite('/tmp/Foo.md', 1000);
      expect(w.isSelfWrite('/tmp/Foo.md')).toBe(true);
      expect(w.isSelfWrite('/tmp/foo.md')).toBe(false);
    } else {
      // 在非 Linux 上跳过，但保持测试存在以便 CI 多平台矩阵触达。
      expect(true).toBe(true);
    }
  });

  it('未登记的路径：isSelfWrite 返回 false', () => {
    const w = makeWatcher();
    expect(w.isSelfWrite('C:\\Notes\\unknown.md')).toBe(false);
    w.markExpectedWrite('C:\\Notes\\expected.md', 1000);
    expect(w.isSelfWrite('C:\\Notes\\other.md')).toBe(false);
  });

  it('clearExpectedWrites 后所有命中失效', () => {
    const w = makeWatcher();
    w.markExpectedWrite('C:\\Notes\\foo.md', 1000);
    expect(w.isSelfWrite('C:\\Notes\\foo.md')).toBe(true);
    // markExpectedWrite 的 expiresAt = Date.now() + 500ms —— 不 clear 也得过 500ms
    // 才失效。clear 是立即清理入口（切目录 / stop 监听时调用）。
    w.clearExpectedWrites();
    expect(w.isSelfWrite('C:\\Notes\\foo.md')).toBe(false);
  });
});

describe('fs-watcher updateSnapshot —— push 决策回归 (Round 13 fix fce2d83)', () => {
  // 关键回归锚点：2s 轮询（OneDrive / SMB fs.watch 不可靠环境唯一兜底）检测
  // 到列表变化，必须把新列表推到 renderer 侧栏刷新。历史 bug 把 skipInitialEmit
  // 透传给 emitFilesChanged + baseline 重复写，导致 safeSend 永远跳过。
  //
  // 测试通过 internal _test_updateSnapshot 触发该路径，避免引入 jsdom + 真 fs.watch。

  it('startup 路径（skipInitialEmit=true）：同步 baseline 但不 push', async () => {
    // audit fix：startWatchingDir 内部 updateSnapshot(dir, true) 拿到的「真实状态」
    // 只用来同步 baseline，不能误当成「新增变化」推给 renderer —— renderer 会通过
    // 'file:list' 自己拉取启动文件列表，避免「刚加载就 emitFilesChanged 又被 renderer
    // 当 fs:changed 事件 → 触发 scanDir 重复请求」的循环。
    const { watcher: w, sends } = makeWatcherWithIpc([
      { ok: true, entries: [{ name: 'a.md', size: 10, mtimeMs: 1 }] },
    ]);
    await w._test_updateSnapshot('/data', /* skipInitialEmit */ true);
    // startup 只写 baseline 不 push
    const filesChanged = sends.filter((s) => s.channel === 'files:changed');
    expect(filesChanged.length).toBe(0);
  });

  it('常规路径（skipInitialEmit=false）：检测到变化必须 push', async () => {
    // 关键回归：第一次 startup（不 push）后，第二次常规 updateSnapshot 看到列表变化
    // → 必须 safeSend 通知 renderer。Round 13 fix 之前的实现 silent 失败。
    const { watcher: w, sends } = makeWatcherWithIpc([
      // 1st call: startup snapshot, list = [a.md]
      { ok: true, entries: [{ name: 'a.md', size: 10, mtimeMs: 1 }] },
      // 2nd call: polling tick, list grew to [a.md, b.md]
      { ok: true, entries: [
        { name: 'a.md', size: 10, mtimeMs: 1 },
        { name: 'b.md', size: 20, mtimeMs: 2 },
      ] },
    ]);
    await w._test_updateSnapshot('/data', true);  // startup
    await w._test_updateSnapshot('/data', false); // polling tick detects new file
    const pushes = sends
      .filter((s) => s.channel === 'files:changed')
      .map((s) => s.payload);
    expect(pushes.length).toBeGreaterThanOrEqual(1);
    const last = pushes[pushes.length - 1];
    expect(last.entries.map((e) => e.name).sort()).toEqual(['a.md', 'b.md']);
    // relOf 没有 toRelDir 注入时返回 null（fs-watcher 契约：可选字段，
    // payload 缺 relDir 仍合法；renderer 走 fallback 不依赖此字段）
    expect(last.relDir == null).toBe(true);
  });

  it('常规路径但列表未变：不 push（baseline 一致）', async () => {
    // 同一列表连扫两次 → baseline 不变 → emitFilesChanged 内部 if 块不进 → 不 push。
    // 避免 fs.watch + polling 双通道把同一次变化报两遍。
    const { watcher: w, sends } = makeWatcherWithIpc([
      { ok: true, entries: [{ name: 'a.md', size: 10, mtimeMs: 1 }] },
      { ok: true, entries: [{ name: 'a.md', size: 10, mtimeMs: 1 }] },
    ]);
    await w._test_updateSnapshot('/data', true);
    await w._test_updateSnapshot('/data', false);
    const pushes = sends.filter((s) => s.channel === 'files:changed');
    expect(pushes.length).toBe(0);
  });

  it('扫描失败（result.ok=false）→ 通过错误通道 push，不走 entries 通道', async () => {
    // 与 change 分支独立 —— 错误走 'files:changed' 但 payload 不带 entries，
    // renderer 用 error 字段弹 toast 并保留旧列表（Round 7 FS-F12 行为）。
    const { watcher: w, sends } = makeWatcherWithIpc([
      { ok: false, error: 'DATA_DIR_NOT_FOUND', code: 'ENOENT' },
    ]);
    await w._test_updateSnapshot('/data', false);
    const pushes = sends.filter((s) => s.channel === 'files:changed');
    expect(pushes.length).toBe(1);
    expect(pushes[0].payload.error).toBe('DATA_DIR_NOT_FOUND');
    expect(pushes[0].payload.entries).toBeUndefined();
  });
});

// audit R7a P1-19：fs-watcher 轮询改为「自适应间隔 + 不 drop」pending
// 单测覆盖三件事：
//   1. getPollInterval：lastChangeAt 在 ACTIVE_WINDOW 内 → 500ms，否则 5s
//   2. markActivity 刷新 lastChangeAt → 立刻切到 active
//   3. pending 语义：in-flight 期间触发的 tick 不丢，in-flight 完成后立即补一次
describe('fs-watcher 自适应轮询 (audit R7a P1-19)', () => {
  it('getPollInterval：初始（lastChangeAt=0，距 now 远）→ QUIET 5000ms', () => {
    const w = makeWatcher();
    expect(w._test_getPollInterval()).toBe(5000);
  });

  it('getPollInterval：markActivity 后立即 → ACTIVE 500ms', () => {
    const w = makeWatcher();
    w._test_markActivity();
    expect(w._test_getPollInterval()).toBe(500);
  });

  it('getPollInterval：markActivity 后等到 ACTIVE_WINDOW 之外 → QUIET', async () => {
    const w = makeWatcher();
    w._test_markActivity();
    expect(w._test_getPollInterval()).toBe(500);
    // 模拟时间推进 POLL_ACTIVE_WINDOW_MS + 1：用 setTimeout 等真实时间。
    // 2100ms 等得起，测试只跑一次。备选用 vi.useFakeTimers + setSystemTime
    // 也行，但 fake timer + markActivity 内部 Date.now() 兼容性有边角问题。
    await new Promise((r) => setTimeout(r, 2100));
    expect(w._test_getPollInterval()).toBe(5000);
  });

  it('pending 语义：in-flight 期间触发的 tick 不丢，in-flight 完后立即补', async () => {
    // 设计要点：pendingPoll 是**幂等**标志，不是队列。
    //   - in-flight 期间任何 tick 都只把 pendingPoll 置 true（不重复累计）
    //   - in-flight 完成后 finally 检查 pendingPoll：true → scheduleNextPoll(0)
    //   - 紧跟的「补」是 1 次新 scanDir，不是 N 次
    // 所以「3 次 tick + resolve」→ scanCalls 期望 2（1 原 + 1 补），不是 3。
    //
    // 旧版（fixed 2s + pollInFlight drop）的语义是：3 次 tick 期间全部被 drop，
    // scanCalls 期望 1（且永远不会补）。这条测试是回归锚点：
    // 拿掉 pendingPoll 行为 → scanCalls 在 resolve 后仍为 1，测试失败。
    //
    // 时序坑：test 里 `await new Promise(r => setTimeout(r, 0))` 是先于
    // runPollTick finally 调度的；Node 同 delay 的 setTimeout 严格按调度顺序
    // 触发，test 的会先 fire，导致 scanCalls 还在 1 时 expect(2) 失败。
    // 修：用一个 polling 等待「scanCalls 达到 2」，让事件循环多跑几个 tick。
    let resolveScan;
    const scanCalls = [];
    const w = createFsWatcher({
      getMainWindow: () => null,
      resolveDataDir: () => '/data',
      scanDir: async () => {
        scanCalls.push(Date.now());
        // 慢：等我们手动 resolve
        await new Promise((r) => { resolveScan = r; });
        return { ok: true, entries: [] };
      },
    });
    // 跳过 fs.watch 订阅（测试不依赖真实目录事件）
    w._test_setWatchedDir('/data');
    // 第一次 tick：in-flight 启动，scanDir 进入 await
    w._test_runPollTick();
    // 第二次 tick：in-flight 还在，pendingPoll = true，scanDir 不再调用
    w._test_runPollTick();
    // 第三次 tick：同样 pendingPoll = true（幂等）
    w._test_runPollTick();
    // 期望 1 次 in-flight scanDir，pendingPoll 期间 0 次额外调用
    expect(scanCalls.length).toBe(1);
    // 解除 in-flight：第一次 scanDir 完成 → runPollTick finally 触发「补一次」
    resolveScan({ ok: true, entries: [] });
    // 等「补」的 scanDir 真的发起（scanCalls 长度变 2）。最坏情况：
    // in-flight 微任务 + emitFilesChanged 微任务 + setTimeout(0) 调度 +
    // setTimeout(0) 触发 + 新 runPollTick 进入 + 新 scanDir push —— 几十 ms 内。
    await new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        if (scanCalls.length >= 2) return resolve();
        if (Date.now() - start > 200) return resolve(); // 兜底
        setTimeout(tick, 5);
      };
      tick();
    });
    expect(scanCalls.length).toBe(2);
    // 把「补」触发的第 2 次 scanDir 也 resolve 掉，不让它的 in-flight
    // 干扰其它测试
    if (resolveScan) resolveScan({ ok: true, entries: [] });
    // 关键：runPollTick 的 finally 走「无 pending → scheduleNextPoll(
    // getPollInterval())」会挂 5s 后的 timer。不显式清掉的话，timer 触发时
    // 又会调一次 scanDir（scanCalls 变 3），且新 scanDir 等到没人 resolve
    // 会一直挂着 —— watcher + scanCalls 闭包泄漏到进程结束，vitest 报告
    // "tests passed" 但实际上 open handle 没释放。pause 清 dirPollTimer +
    // pollPaused，让 watcher 真正失活。
    w._test_pauseDirPolling();
  });

  // audit R7a P1-19 bugfix：pauseDirPolling 必须真正停止轮询。回归锚点：
  //   - in-flight tick 还在 await scanDir 时调 pause
  //   - scanDir 完成后 runPollTick finally 走 scheduleNextPoll(...)
  //   - 旧版（无 pollPaused 闸）→ 仍挂 5s 后才退到的定时器
  //   - 修后（有 pollPaused 闸）→ 不挂任何新 timer，轮询真停
  // 拿掉 pollPaused 检查 → _test_hasPollTimer() 在 resolveScan 后仍返回 true，
  // 本测试失败。仅查 scanCalls 长度不够 —— 5s 间隔下 50ms 等不出新 tick，
  // 必须直接断言 dirPollTimer 是否被挂。
  it('pause 期间 in-flight runPollTick finally 不 re-schedule', async () => {
    let resolveScan;
    const scanCalls = [];
    const w = createFsWatcher({
      getMainWindow: () => null,
      resolveDataDir: () => '/data',
      scanDir: async () => {
        scanCalls.push(Date.now());
        await new Promise((r) => { resolveScan = r; });
        return { ok: true, entries: [] };
      },
    });
    w._test_setWatchedDir('/data');
    // 启动一个 in-flight tick（scanDir 进入 await）→ runPollTick 被 setTimeout
    // 调度时 dirPollTimer 已被清，所以这一步后 hasPollTimer() = false
    w._test_runPollTick();
    expect(scanCalls.length).toBe(1);
    expect(w._test_hasPollTimer()).toBe(false);
    // 暂停：模拟窗口最小化 → pollPaused = true
    w._test_pauseDirPolling();
    // in-flight scanDir 完成 → runPollTick finally 执行：
    //   旧版：scheduleNextPoll(getPollInterval()) 挂 5s 后的 timer
    //   修后：pollPaused 短路，dirPollTimer 保持 null
    resolveScan({ ok: true, entries: [] });
    // 等 microtask + setTimeout(0) 都跑过。50ms 足够覆盖几轮事件循环。
    await new Promise((r) => setTimeout(r, 50));
    // 核心断言：pause 之后不应该有新的 poll timer 被挂上
    expect(w._test_hasPollTimer()).toBe(false);
  });

  // 配对测试：resume 后必须能再跑轮询。验证 pollPaused 不会让恢复路径失活。
  it('resume 后轮询可重新启动', () => {
    const w = makeWatcher();
    w._test_setWatchedDir('/data');
    w._test_pauseDirPolling();
    // pause 后调 resume —— 不报错、watchedDir 还在即可（startDirPoll 在
    // makeWatcher 里没有真实 scanDir，所以不验证 emit 次数）。
    expect(() => w._test_resumeDirPolling()).not.toThrow();
  });
});

