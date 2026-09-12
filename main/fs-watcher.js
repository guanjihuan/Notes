// 目录监听层（Stage 4b.2 抽离 + Stage 8 扩展）
//
// 职责：
//   - fs.watch + readdir 轮询双通道捕获数据目录变化
//   - 把变化推送给 renderer（IPC 'files:changed'，payload 含 relDir / dir）
//   - 窗口最小化 / 隐藏时暂停轮询（fs.watch 保持运行），恢复时补扫一次
//   - Stage 8：支持 rewatch() 把监听目标切换到子目录（Folder Browser）
//
// 设计：
//   - factory 模式：依赖通过参数注入，不引用 mainWindow / configStore 等具名符号
//   - 状态（dirWatcher / dirPollTimer / lastFilesSnapshot / watchedDir / emitDebounceTimer）
//     全部闭包在 factory 返回的实例里，不污染模块全局
//
// 边界：
//   - 不读 mainWindow 具名变量 —— 由 deps.getMainWindow() 提供（避免循环引用）
//   - 不调 configStore —— 由 deps.resolveDataDir() 注入（dir 变化也走这里）
//   - 不重复实现 scanDir —— 由 deps.scanDir() 注入（同一份扫描逻辑）

const fsSync = require('fs');

const DIR_POLL_INTERVAL_MS = 2000;
const EMIT_DEBOUNCE_MS = 300;
// audit fix (Round 7 FS-F8)：debounce maxWait —— 持续事件流（git checkout /
// 大目录解压 / AI 批量写）让 300ms 防抖窗口永远不能 trailing flush，
// fs.watch 通道一次都不 emit。maxWait=1000ms 强制 1s 内必须 emit 一次。
const EMIT_MAX_WAIT_MS = 1000;
const REATTACH_BASE_MS = 5_000;
const REATTACH_MAX_MS = 60_000;
// audit fix (Round 7 FS-F1)：错误闩锁重复抑制窗口。数据目录被删除时
// updateSnapshot 每 2s 失败一次 → renderer 每 2s 弹一次 error toast →
// 屏幕常驻 5 条警告。30s 重发间隔让用户有充裕时间响应，又不至于漏掉
// 真实新错误（同 error 不同 dir 也算新错误，立即重发）。
const ERROR_REPEAT_THROTTLE_MS = 30_000;

/**
 * @typedef {Object} FsWatcherDeps
 * @property {() => (object|null)} getMainWindow - 返回 BrowserWindow 或 null
 * @property {() => (string|null)} resolveDataDir - 当前生效的数据目录
 * @property {(dir: string) => Promise<{ok:boolean, entries?:Array, error?:string}>} scanDir
 *   扫描目录，返回 {ok:true,entries} 或 {ok:false,error}。
 *   Stage 8：必须返回 entries（含文件夹 + 文件），否则非 md 文件变化会漏报。
 * @property {(absDir: string) => string} [toRelDir]
 *   可选：把绝对目录路径转成 dataRoot 下的 POSIX 风格相对路径。
 *   没传则 payload 不带 relDir 字段（旧调用方完全兼容）。
 */

function createFsWatcher(deps) {
  // 解构 + 一次性校验：避免后面每个调用都判 null
  const { getMainWindow, resolveDataDir, scanDir, toRelDir } = deps;
  if (typeof getMainWindow !== 'function') throw new Error('getMainWindow 必须是函数');
  if (typeof resolveDataDir !== 'function') throw new Error('resolveDataDir 必须是函数');
  if (typeof scanDir !== 'function') throw new Error('scanDir 必须是函数');
  const resolveRelDir = typeof toRelDir === 'function' ? toRelDir : null;

  let dirWatcher = null;
  let dirPollTimer = null;
  let lastFilesSnapshot = '';
  /** 当前被监听的目录（供轮询暂停/恢复复用，不必重新传参） */
  let watchedDir = null;
  let emitDebounceTimer = null;
  // audit fix (Round 7 FS-F8)：burst 首事件时间戳。持续事件流在
  // burstStartedAt + EMIT_MAX_WAIT_MS 时强制 flush，避免 trailing-only
  // debounce 在永不静默的流上不发任何事件。
  let burstStartedAt = 0;
  // audit fix (shared-M9)：generation token。startWatchingDir / rewatch 每次
  // 切换目录都自增；updateSnapshot 内 await 结束后比对 token：
  //   - 不匹配 → 这是「上一代目录」的扫描结果，丢弃（既不要写 baseline，
  //     也不要 emitFilesChanged —— 否则基线会被旧目录列表覆盖，新目录的
  //     真实首次扫描结果反而被当成「无变化」忽略，造成侧栏与磁盘状态
  //     不一致的幽灵 bug）
  //   - 匹配 → 当前活跃扫描，正常写 baseline + 推送
  let dirGeneration = 0;
  // audit fix (Round 7 FS-F1)：错误闩锁。lastErrorKey = error+code+relDir 拼接；
  // 同 key 在 ERROR_REPEAT_THROTTLE_MS 内不再重发，新 key 立即重发，扫描恢复
  // （ok=true）时清空。避免「数据目录被删除」类持续错误每 2s 弹一次 toast。
  let lastErrorKey = '';
  let lastErrorAt = 0;
  // audit fix (Round 7 FS-F5)：重连退避计数。OneDrive / 网盘短时不可用时
  // 重连失败指数退避 5s → 10s → 30s → 60s（封顶），避免「目录长时间不存在」
  // 时每 5s 打一行 warn 的忙循环。挂载成功后 nextBackoffMs 重置回基线。
  let nextBackoffMs = REATTACH_BASE_MS;
  // audit fix (Round 7 FS-F7)：轮询重入保护。慢盘（OneDrive / SMB）下
  // scanDir 可能 > 2s，setInterval 触发新调用与上一轮 await 并发争写
  // lastFilesSnapshot → 后完成的可能是先发起的（旧快照覆盖新基线）。
  // pollInFlight 守卫：上一轮未返回时直接跳过本次。
  let pollInFlight = false;

  function isWindowVisible() {
    const win = getMainWindow();
    return !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized();
  }

  /**
   * 条目列表的稳定指纹：folder 用 name；file 用 name + size + mtime。
   * 只在这一个地方定义，两个调用点（updateSnapshot / emitFilesChanged）共用。
   * @param {Array<{name:string,isFolder?:boolean,size?:number,mtimeMs?:number}>} entries
   * @returns {string}
   */
  function entriesSnapshot(entries) {
    return entries.map((e) => {
      if (e.isFolder) return `d:${e.name}`;
      return `f:${e.name}|${e.size}|${e.mtimeMs}`;
    }).join('\n');
  }

  /** 把绝对目录转成 relDir（payload 字段）；内部统一走 resolveRelDir。 */
  function relOf(absDir) {
    if (!resolveRelDir || !absDir) return null;
    try {
      const r = resolveRelDir(absDir);
      return typeof r === 'string' ? r : null;
    } catch {
      return null;
    }
  }

  /**
   * 判断当前是否应该 push 这次错误（基于 lastErrorKey + lastErrorAt 闩锁）。
   * 同 key 在节流窗口内 → 抑制；新 key → 立即放行；恢复 ok → 调用方自动清闩。
   * @param {string} errorKey - "error:code:relDir" 拼接
   * @returns {boolean}
   */
  function shouldReportError(errorKey) {
    const now = Date.now();
    if (errorKey !== lastErrorKey) return true;
    return (now - lastErrorAt) >= ERROR_REPEAT_THROTTLE_MS;
  }

  /** 记录错误已上报（写闩锁）。 */
  function recordError(errorKey) {
    lastErrorKey = errorKey;
    lastErrorAt = Date.now();
  }

  /** 清错误闩锁（扫描恢复 ok 时调用）。 */
  function clearErrorLatch() {
    lastErrorKey = '';
    lastErrorAt = 0;
  }

  /**
   * 安全发送（main-M7：teardown 窗口过程抛 throw → unhandledException）。
   * @param {object} payload
   */
  function safeSend(payload) {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
    try {
      win.webContents.send('files:changed', payload);
    } catch (e) {
      console.warn('[fs-watcher] send failed:', e && e.message);
    }
  }

  async function updateSnapshot(dir, skipInitialEmit = false) {
    // audit fix (shared-M9)：捕获「这一代」的 generation token，await 结束后
    // 与当前 dirGeneration 比对 —— 不一致说明用户在扫描期间又切换了目录，
    // 本次结果属于上一代，必须丢弃（不能写 baseline，也不能 push）。
    const myGen = dirGeneration;
    let result;
    try {
      result = await scanDir(dir);
    } catch (e) {
      // audit fix (Round 7 FS-F16)：scanDir 是注入依赖，契约未约定「绝不
      // reject」。catch 兜住，避免 unhandledRejection 杀进程（--unhandled-
      // rejections=strict 下直接 fatal）。
      console.warn('[fs-watcher] scanDir 抛出:', e && e.message);
      return;
    }
    if (myGen !== dirGeneration) {
      // 切到新目录了：旧扫描结果作废。新目录的扫描正在另一份 updateSnapshot
      // 跑着，让它去写基线 / 推送即可。
      return;
    }
    if (!result.ok) {
      // 扫描失败（audit #3 续）：
      //   以前只是 console.warn + 不更新基线，结果用户看到的是「目录被删了但列表还显示着旧文件」——
      //   误以为数据还在，点了文件得到 FILE_NOT_FOUND 报错。
      //   现在：把错误推给 renderer，让它在保留旧列表的同时显式提示用户
      //   （"数据目录不可访问"），并提供一个「重新选择」的入口。
      //   基线故意不更新 —— 恢复访问后下次轮询自然会有新基线。
      console.warn('[fs-watcher] updateSnapshot 失败:', result.error);
      if (!skipInitialEmit) {
        // audit fix (Round 7 FS-F1)：错误闩锁。DATA_DIR_NOT_FOUND / EACCES
        // 这类每 2s 复发的错误不再每次都 toast。error+code+relDir 拼接作为
        // 闩锁 key；同 key 30s 内只发一次，新 key 立即发，恢复 ok 时清空。
        // audit fix (Round 7 FS-F13)：relDir 用本次扫描的 dir（不是
        // currentRelDir()/watchedDir）—— generation 语义上「本次扫描属于
        // 哪个 dir」应该跟着参数走。
        const relDir = relOf(dir);
        const errorKey = `${result.error || ''}:${result.code || ''}:${relDir || ''}`;
        if (shouldReportError(errorKey)) {
          recordError(errorKey);
          safeSend({
            error: result.error,
            code: result.code,
            dir,
            relDir,
          });
        }
      }
      return;
    }
    // 恢复 ok → 清错误闩锁
    clearErrorLatch();
    const list = result.entries || [];
    const snapshot = entriesSnapshot(list);
    if (snapshot !== lastFilesSnapshot) {
      lastFilesSnapshot = snapshot;
      if (!skipInitialEmit) {
        emitFilesChanged(list, dir);
      }
    }
  }

  /**
   * 向 renderer 推送文件列表。
   *
   * @param {Array=} precomputed - 调用方已经扫描好的列表（updateSnapshot 会传），
   *                               传了就不再重复 scanDir。
   * @param {string=} dir - 列表对应的目录绝对路径；不传则用 watchedDir。
   *
   * 注意：走「自己扫描」分支时必须同步 lastFilesSnapshot 基线。否则 fs.watch 触发的
   * 这次推送不会更新基线，紧随其后的 2 秒轮询会认为列表「又变了」，导致每次外部改动
   * 都发生一次重复扫描 + 重复 IPC 推送。
   *
   * Stage 8：payload 新增 relDir 字段，告诉渲染端「这是哪个目录的变更」，
   * 渲染端比对当前显示目录决定是否重扫。
   *
   * audit fix (Round 7 FS-F11)：payload 同时带 `dir` 字段（绝对路径）与
   * `relDir`（POSIX 相对路径），与 file:scan-dir handler 的返回形状对齐，
   * 方便 renderer 兜底逻辑无需依赖 IPC 调用上下文。
   */
  async function emitFilesChanged(precomputed, dir) {
    const targetDir = dir || watchedDir || resolveDataDir();
    // audit fix (shared-M9)：同样的 generation 防护。emitFilesChanged 自带
    // scanDir 分支时同样有「scan 期间用户切目录 → 旧结果覆盖新基线」的竞态。
    const myGen = dirGeneration;
    let list;
    if (precomputed) {
      list = precomputed;
    } else {
      let result;
      try {
        result = await scanDir(targetDir);
      } catch (e) {
        // audit fix (Round 7 FS-F16)：floating promise 兜底。
        console.warn('[fs-watcher] emitFilesChanged scanDir 抛出:', e && e.message);
        return;
      }
      if (myGen !== dirGeneration) return;
      if (!result.ok) {
        // 推送错误而不是清空列表 —— 临时错误不应让用户失去对已有文件的视图。
        // 渲染端会保留上次的列表，仅显示错误提示。
        // audit fix (Round 7 FS-F12)：与 updateSnapshot 错误分支对齐，
        // payload 同时带 code 字段。
        const relDir = relOf(targetDir);
        const errorKey = `${result.error || ''}:${result.code || ''}:${relDir || ''}`;
        if (shouldReportError(errorKey)) {
          recordError(errorKey);
          safeSend({
            error: result.error,
            code: result.code,
            dir: targetDir,
            relDir,
          });
        }
        return;
      }
      list = result.entries || [];
      // 同步基线，避免轮询把这次改动再报一遍
      lastFilesSnapshot = entriesSnapshot(list);
    }
    if (myGen !== dirGeneration) return;
    // 成功路径同样补 dir 字段（FS-F11）。
    safeSend({ entries: list, dir: targetDir, relDir: relOf(targetDir) });
  }

  function scheduleEmit() {
    const now = Date.now();
    // audit fix (Round 7 FS-F8)：maxWait —— 持续事件流（git checkout /
    // 大目录解压 / AI 批量写）让 300ms 防抖窗口永远 trailing flush 不出。
    // burstStartedAt 记录首事件时间，到 maxWait 时强制立即 emit。
    if (!burstStartedAt) burstStartedAt = now;
    const elapsed = now - burstStartedAt;
    const delay = elapsed >= EMIT_MAX_WAIT_MS ? 0 : EMIT_DEBOUNCE_MS;
    if (emitDebounceTimer) clearTimeout(emitDebounceTimer);
    // audit fix (main-M6)：闭包里捕获触发本次 scheduleEmit 时的 watchedDir，
    // 300ms 后即便用户改了 dataDir（或 Folder Browser 切了子目录），
    // emitFilesChanged 仍按触发时的 dir 推送 + payload.relDir 与之对齐。
    // 否则事件会被「错路由」到新目录的 renderer 视图，造成侧栏幽灵更新。
    const dirAtSchedule = watchedDir;
    const t = setTimeout(() => {
      emitDebounceTimer = null;
      burstStartedAt = 0;
      emitFilesChanged(undefined, dirAtSchedule);
    }, delay);
    // audit fix (main-M8)：unref —— 否则 fs-watcher 还在挂定时器时 Electron
    // 主进程不会自然退出（before-quit 取消 close path 后这 300ms 会再卡一下）。
    if (typeof t.unref === 'function') t.unref();
    emitDebounceTimer = t;
  }

  // audit fix：fs.watch emit error 后退避重连。
  // 用户场景：OneDrive 暂时离线 → 网盘驱动报 EPERM → fs.watch 死掉；
  // 5s 后重连，若目录又可访问就恢复事件推送。退避期间 2s 轮询仍兜底。
  // audit fix (Round 7 FS-F5)：指数退避 5s → 10s → 30s → 60s（封顶），
  // 长期不存在的目录不再每 5s 打一行 warn。成功挂载后 nextBackoffMs 重置。
  let reattachTimer = null;
  function scheduleReattach() {
    if (reattachTimer || !watchedDir) return;
    const delay = nextBackoffMs;
    const t = setTimeout(() => {
      reattachTimer = null;
      if (!watchedDir) return;
      // startWatchingDir 内部 stopWatchingDir 会先关旧句柄，再开新句柄；
      // 即使同名目录也会重新挂 error handler。失败时 startWatchingDir 自己
      // console.warn，仍依赖轮询兜底。
      try {
        startWatchingDir(watchedDir);
        // 挂载成功：重置退避计数，给未来新错误回到基线 5s。
        nextBackoffMs = REATTACH_BASE_MS;
      } catch (e) {
        console.warn(`[fs-watcher] 重连失败（${delay}ms 后再试）:`, e.message);
        // 失败：指数退避，封顶 60s。
        nextBackoffMs = Math.min(nextBackoffMs * 2, REATTACH_MAX_MS);
        scheduleReattach();
      }
    }, delay);
    // audit fix (main-M8)：unref —— 5s 重连定时器若还挂着会拖住进程退出。
    if (typeof t.unref === 'function') t.unref();
    reattachTimer = t;
  }

  function startDirPoll() {
    if (dirPollTimer || !watchedDir) return;
    // audit fix (Round 7 FS-F14)：unref —— 这个 timer 是长期存活的，叠加
    // will-quit 不清 fsWatcher 会在退出路径上拖住主进程。
    dirPollTimer = setInterval(() => {
      // audit fix (Round 7 FS-F7)：重入保护。慢盘（OneDrive / SMB）上
      // scanDir 可能 > 2s，setInterval 触发新一轮与上一轮 await 并发，
      // 争写 lastFilesSnapshot → 后完成的可能是先发起的（旧覆盖新）。
      if (pollInFlight) return;
      pollInFlight = true;
      updateSnapshot(watchedDir)
        .catch((e) => {
          // audit fix (Round 7 FS-F16)：floating promise 兜底。
          console.warn('[fs-watcher] 轮询 updateSnapshot 抛出:', e && e.message);
        })
        .finally(() => {
          pollInFlight = false;
        });
    }, DIR_POLL_INTERVAL_MS);
    if (typeof dirPollTimer.unref === 'function') dirPollTimer.unref();
  }

  function stopDirPoll() {
    if (dirPollTimer) {
      clearInterval(dirPollTimer);
      dirPollTimer = null;
    }
  }

  /**
   * 启动目录监听：
   *   - fs.watch: 立即触发，但 Windows / 云同步盘 / 网络盘可能不发事件
   *   - readdir 轮询: 兜底（每 2 秒）
   *   - 任一通道发现列表变化 → 通过 IPC 'files:changed' 推送新列表给 renderer
   *
   * Stage 8：监听的目录可以是 dataRoot 本身，也可以是其下的子目录（Folder Browser 导航时
   * 通过 rewatch() 切换）。监听目标改变时，fs.watch 句柄会先 close 再在新目录上重新打开。
   */
  function startWatchingDir(dir) {
    stopWatchingDir();
    // audit fix (shared-M9)：新一世代，旧扫描全部作废（见 updateSnapshot
    // / emitFilesChanged 的 myGen 校验）。
    dirGeneration += 1;
    watchedDir = dir;

    // 初始化基线（启动时不把历史文件当作「变化」）
    // 第三个参数 skipInitialEmit = true：仅同步基线，不向 renderer 推送启动时的文件列表
    // （renderer 会通过 ipc 'file:list' / 'file:scan-dir' 自己拉取，避免重复更新）
    updateSnapshot(dir, true);

    try {
      dirWatcher = fsSync.watch(dir, (eventType, filename) => {
        // 不再按扩展名过滤 —— Stage 8 后列表里包含文件夹 + 各种扩展名，
        // 任何变化都可能影响侧栏展示，让轮询做最终判定
        // audit fix (Round 7 FS-F6)：Windows ReadDirectoryChangesW 缓冲区
        // 溢出时 Node 用 filename=null 上报（旧版当成噪声直接 return，
        // 等于在最需要重扫的时刻跳过重扫）。批量操作（git checkout /
        // 解压 / AI 批量写）正好触发这个路径 —— 必须 scheduleEmit 触发重扫。
        if (!filename) {
          scheduleEmit();
          return;
        }
        // Windows 上可能触发多次事件，加 300ms 防抖合并
        scheduleEmit();
      });
      // audit fix：监听底层错误。
      // 之前 fs.watch 句柄没有 .on('error') —— 一旦 watchedDir 在外部被
      // 删除 / 重命名 / 所在盘符消失，fs.watch 会 emit 'error'，没人接，
      // 默认变 unhandledException；poll 循环还在继续扫这个不存在的目录，
      // 每次 updateSnapshot 都返回 ENOENT，但 fs.watch 已经死了，
      // 用户对数据目录的任何后续修改都收不到事件（只能靠 2s 轮询）。
      // 现在挂上 error handler：打日志 + 触发一次重新监听（5s 退避），
      // 让用户重命名 / 重新挂载盘后 fs.watch 自动恢复。
      dirWatcher.on('error', (err) => {
        console.warn('[fs-watcher] fs.watch 报错，重连退避中:', err.message);
        scheduleReattach();
      });
    } catch (e) {
      // audit fix (Round 7 FS-F5)：startWatchingDir 内 fs.watch 同步抛
      // ENOENT/EACCES/EPERM 时，dirWatcher=null，没有 error handler 可挂，
      // scheduleReattach 永远不会再次触发。手动 schedule 一次，下一次轮询
      // 失败 + fs.watch 仍没恢复也会被 scheduleReattach 自循环退避接管。
      console.warn('[fs-watcher] 目录监听启动失败（仅依赖轮询）:', e.message);
      scheduleReattach();
    }

    // 窗口不可见时不必开轮询（会在 show/restore 时恢复）
    if (isWindowVisible()) startDirPoll();
  }

  /**
   * 切换监听目标到另一个子目录（Folder Browser 用）。
   *
   * 与 startWatchingDir 的区别：startWatchingDir 内部先 stopWatchingDir（清基线），所以
   * 即使新旧目录完全相同也会重置基线；rewatch 同名目录直接 no-op，省一次基线重置。
   *
   * @param {string} dir - 新的绝对目录
   */
  function rewatch(dir) {
    if (!dir || typeof dir !== 'string') return;
    if (dir === watchedDir) return;
    startWatchingDir(dir);
  }

  /**
   * 窗口最小化 / 收进托盘时暂停轮询 —— 没人在看文件列表，每 2 秒一次
   * readdir + N 次 stat 是纯浪费（在 OneDrive / 坚果云这类同步盘上尤其贵）。
   *
   * fs.watch 故意保持运行：它是事件驱动的，开着几乎不花钱，隐藏期间的改动仍能捕获。
   */
  function pauseDirPolling() {
    stopDirPoll();
  }

  /** 恢复轮询，并立刻补扫一次，追上隐藏期间 fs.watch 可能漏掉的改动 */
  function resumeDirPolling() {
    if (!watchedDir) return;
    startDirPoll();
    updateSnapshot(watchedDir);
  }

  function stopWatchingDir() {
    // audit fix (Round 7 FS-F9)：自增 dirGeneration，让在飞的
    // updateSnapshot / emitFilesChanged await 返回后 myGen 校验失败、
    // 不会回写刚清空的 baseline。
    dirGeneration += 1;
    if (emitDebounceTimer) {
      clearTimeout(emitDebounceTimer);
      emitDebounceTimer = null;
    }
    burstStartedAt = 0;
    if (reattachTimer) {
      clearTimeout(reattachTimer);
      reattachTimer = null;
    }
    if (dirWatcher) {
      try { dirWatcher.close(); } catch {}
      dirWatcher = null;
    }
    stopDirPoll();
    // audit fix (Round 7 FS-F5)：停止监听也重置退避计数，避免下次启动
    // 接着用上一会话的指数退避值。
    nextBackoffMs = REATTACH_BASE_MS;
    clearErrorLatch();
    pollInFlight = false;
    watchedDir = null;
    lastFilesSnapshot = '';
  }

  return {
    startWatchingDir,
    rewatch,
    pauseDirPolling,
    resumeDirPolling,
    stopWatchingDir,
    /** 测试 / 调试用：当前是否在监听某个目录 */
    get watchedDir() { return watchedDir; },
  };
}

module.exports = {
  createFsWatcher,
  // DIR_POLL_INTERVAL_MS 故意不出 module.exports：只是模块内 setTimeout
  // 的常量（兜底 fs.watch 不稳的场景），无任何外部调用方 —— 出 exports
  // 会让上层误以为「可以调整轮询频率」，徒增 API surface 风险。
};