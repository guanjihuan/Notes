// Electron 主进程
// 负责窗口管理、文件 IO、IPC 桥接

// 关键：如果系统环境变量 ELECTRON_RUN_AS_NODE=1 被设置，
// electron.exe 会作为普通 Node 运行而非 Electron。
// 这会让 `require('electron')` 返回路径字符串而非 API。
// 这里主动清除它，确保应用始终作为 Electron 运行。
if (process.env.ELECTRON_RUN_AS_NODE) {
  console.log('[main] 检测到 ELECTRON_RUN_AS_NODE=1，已清除（避免被当作 Node）');
  delete process.env.ELECTRON_RUN_AS_NODE;
}

// Windows 控制台编码修复：默认是 GBK(cp936)，导致中文日志乱码。
// 强制切换到 UTF-8，使 console.log 的中文能正确显示。
if (process.platform === 'win32') {
  try {
    process.stdout.setDefaultEncoding('utf8');
    process.stderr.setDefaultEncoding('utf8');
  } catch {
    // 某些环境下 setDefaultEncoding 不可用，忽略
  }
}

// GUI 启动场景下（双击图标 / 启动器退出后），主进程的 stdout/stderr
// 没有真实终端可写，console.log 在 flush 时会触发 EPIPE: broken pipe，
// 进而被 Electron 弹成「A JavaScript error occurred in the main process」。
// 给底层流挂 error 监听，把 EPIPE / ENOTCONN / EBADF 静默吞掉，
// console.log 仍按原样输出，只是不再让异常冒到顶层炸窗。
try {
  for (const stream of [process.stdout, process.stderr]) {
    if (stream && typeof stream.on === 'function') {
      stream.on('error', (err) => {
        if (err && (err.code === 'EPIPE' || err.code === 'ENOTCONN' || err.code === 'EBADF')) {
          return; // 静默忽略：没有终端可写是正常的
        }
        // 其他错误写到 tmp 文件，避免被 Electron 弹成主进程错误框
        try {
          require('fs').appendFileSync(
            require('path').join(require('os').tmpdir(), 'notes-main-stderr.log'),
            `[${new Date().toISOString()}] ${err.stack || err}\n`
          );
        } catch { /* 兜底逻辑本身不应再抛 */ }
      });
    }
  }
} catch {
  // 兜底逻辑本身不应再抛
}

// 把主进程的 console.log / console.warn / console.error 同步写到日志文件，
// 这样即便 stdout 断了（GUI 启动 / 启动器关闭），日志仍可追溯。
// 不影响原有行为：仍会尝试写到 stdout（如果可用）。
//
// audit fix (M5)：之前写 %TEMP%\notes-main.log，多用户系统上 tmp 互相可读，
// 包含路径 / senderId 等的日志会被同机其他用户读到。改用 app.getPath('logs')
// （用户私有）作为首选；app 还没 ready 时退回 userData；都拿不到再退回
// %LOCALAPPDATA%（Windows）或 ~/.local/share（POSIX）。
try {
  const _origLog = console.log;
  const _origWarn = console.warn;
  const _origError = console.error;
  const _path = require('path');
  const _fsSync = require('fs');
  const _resolveLogDir = () => {
    try {
      const { app: _app } = require('electron');
      if (_app && typeof _app.getPath === 'function') {
        // logs 路径可能在 app ready 之前未注册；用 userData 作为兜底
        try {
          const logs = _app.getPath('logs');
          if (logs) return logs;
        } catch {}
        try {
          const ud = _app.getPath('userData');
          if (ud) return ud;
        } catch {}
      }
    } catch {}
    if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
      return process.env.LOCALAPPDATA;
    }
    const home = require('os').homedir();
    if (process.platform === 'darwin') return _path.join(home, 'Library', 'Application Support');
    return _path.join(home, '.local', 'share');
  };
  const _logDir = _resolveLogDir();
  const _logFile = _path.join(_logDir, 'notes-main.log');
  const _writeLog = (level, args) => {
    try {
      // 兜底：目录可能不存在（首次启动 / 权限）→ 同步 mkdirSync recursive
      _fsSync.mkdirSync(_logDir, { recursive: true });
      _fsSync.appendFileSync(
        _logFile,
        `[${new Date().toISOString()}] [${level}] ${args.map((a) => (typeof a === 'string' ? a : require('util').inspect(a))).join(' ')}\n`
      );
    } catch { /* 写日志失败不应影响主流程 */ }
  };
  console.log = (...args) => { _origLog(...args); _writeLog('log', args); };
  console.warn = (...args) => { _origWarn(...args); _writeLog('warn', args); };
  console.error = (...args) => { _origError(...args); _writeLog('error', args); };
} catch {
  // 重写 console 失败不应阻塞启动
}

const electronModule = require('electron');

// 检查 require('electron') 是否返回正确的 API（而非路径字符串）
// 在 Windows 上，如果项目路径包含非 ASCII 字符（如中文），可能会返回路径字符串
if (typeof electronModule === 'string' || !electronModule.app) {
  const errMsg = `
================================================================================
[FATAL] require('electron') 返回了无效值！

问题原因: 项目路径包含非 ASCII 字符（如中文）
  当前路径: ${__dirname}
  返回值: ${typeof electronModule === 'string' ? '字符串 (路径)' : '无效对象'}

解决方法: 将项目移动到 ASCII 路径，例如:
  D:\\Projects\\notes
  C:\\dev\\notes

或者创建一个符号链接（mklink /D，管理员命令提示符）：
  mklink /D C:\\dev\\notes "${__dirname}"

然后在符号链接路径下运行 npm start
================================================================================
`;
  console.error(errMsg);
  try {
    const { app: appApi } = require('electron');
    if (appApi && typeof appApi.whenReady === 'function') {
      appApi.whenReady().then(() => {
        const { BrowserWindow } = require('electron');
        const win = new BrowserWindow({
          width: 600,
          height: 380,
          resizable: false,
          title: 'Notes - 启动错误'
        });
        win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
          <html><body style="font-family:sans-serif;padding:30px;background:#fee;color:#900;">
            <h2>⚠ 启动失败</h2>
            <p><b>问题：</b>项目路径包含非 ASCII 字符（如中文），导致 Electron 无法正确加载 API。</p>
            <p><b>当前路径：</b><br><code>${__dirname}</code></p>
            <p><b>解决方法：</b>将项目移动到 ASCII 路径（如 <code>D:\\Projects\\notes</code>）。</p>
            <p style="margin-top:30px;color:#666;font-size:12px;">详细说明请查看 README。</p>
          </body></html>
        `));
      });
      return;
    }
  } catch {
    // fallthrough
  }
  process.exit(1);
}

const { app, BrowserWindow, ipcMain, dialog, Menu, shell, Tray } = electronModule;
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
// 设置 schema（单一事实源）—— 主进程、preload、renderer 三处共享。
// 新增/修改设置项只需改 shared/settings-schema.js 一处。
const { validateAndSanitize } = require('./shared/settings-schema.js');
// 配置持久化层（Stage 4b.1 抽离）
const configStore = require('./main/config-store');
// 目录监听层（Stage 4b.2 抽离）
// 依赖通过参数注入 —— 不直接引用 mainWindow / configStore / scanFiles
// scanFiles 是函数声明，会被 hoist；这里注册时还未执行定义，但调用时已可用。
const { createFsWatcher } = require('./main/fs-watcher');
// 文件操作 helper（Stage 7 抽出）：可测试的纯函数，IPC 注册仍在 main.js
// 包含 isWithinDataDir / resolveFileName / scanFiles / scanDir / assertNotSymlink / classifyEntry
const fileOps = require('./main/file-ops');
const {
  MAX_FILE_SIZE,
  isWithinDataDir,
  resolveFileName,
  resolveRenameName,
  scanDir,
  assertNotSymlink,
  assertNoSymlinkAncestor,
  resolveDirRelative,
  toRelativeDir,
} = fileOps;
// AI 代理（用 Node 18+ 内置 fetch 调 OpenAI 兼容 API）
const { createAiProxy } = require('./main/ai');
// 启动标记：方便用户在 DevTools / 主进程控制台确认加载了最新代码
// （修改 main.js / main/*.js 后必须完全退出重启，主进程代码只在启动时 require 一次）
console.log('[main] AI proxy loaded — token field routing per model: gpt-5/o-series → max_completion_tokens, others → max_tokens');

// 窗口图标和系统托盘共用同一图标
const APP_ICON_PATH = path.join(__dirname, 'icon.ico');

// 日志路径脱敏 helper：console.error 写 tmp 文件时会带上 filePath（含用户名），
// 多用户系统上 tmp 可被其他用户读，且 ENOENT 也打路径 = 无成本枚举文件名。
// 只保留 basename，定位「哪个文件」已经足够；完整路径不在 tmp 落地。
function _redactPath(p) {
  if (typeof p !== 'string' || !p) return p;
  return path.basename(p);
}

/**
 * 把 file:create 阶段的 errno 翻译成中文，name 用于「创建 X 失败」前缀；
 * 路径只放在 console（已 _redactPath），不让完整路径回到 renderer。
 * 与 file:write 的 renderer friendlyWriteError 一致地走「中文 + errno code」。
 */
function _friendlyCreateError(e, name) {
  const n = name || '文件';
  switch (e && e.code) {
    case 'EACCES':
    case 'EPERM':
      return `没有写入权限，无法创建 ${n}`;
    case 'ENOSPC':
      return '磁盘空间不足，无法创建文件';
    case 'EROFS':
      return '只读文件系统，无法创建文件';
    case 'EISDIR':
      return '该路径是文件夹，无法写入';
    case 'ENOENT':
      return '所在目录不存在，无法创建文件';
    default:
      return `创建 ${n} 失败`;
  }
}

/**
 * audit fix (K1-H1)：file:rename 的 errno 翻译 —— 与 _friendlyCreateError
 * 对称：原路径已过 isWithinDataDir / symlink 守卫，到这层基本只剩 EACCES /
 * EPERM / ENOSPC / EROFS / EEXIST（同名的目录挡住文件 rename 在不同平台错
 * 误码不同）。新名字走 _friendlyCreateError 同款中文提示，不让英文 errno
 * 直接回到 renderer（之前的 e.message 含「EPERM: operation not permitted」
 * + 完整旧路径，调试日志和 UI 都泄露）。
 */
function _friendlyRenameError(e, newName) {
  const n = newName || '文件';
  switch (e && e.code) {
    case 'EACCES':
    case 'EPERM':
      return `没有重命名权限，无法将文件改名为 ${n}`;
    case 'ENOSPC':
      return '磁盘空间不足，无法重命名';
    case 'EROFS':
      return '只读文件系统，无法重命名';
    case 'EEXIST':
    case 'ENOTEMPTY':
      return `已存在同名项，无法重命名为 ${n}`;
    case 'ENOENT':
      return '原文件已被删除，无法重命名';
    case 'EBUSY':
      return '文件被占用，无法重命名';
    default:
      return `重命名 ${n} 失败`;
  }
}

/**
 * audit fix (K1-L2)：file:delete 的 errno 翻译 —— 与上面 _friendly*Error
 * 对称。shell.trashItem 失败的常见 errno：EACCES/EPERM（没权限）、
 * EBUSY（文件被占）、ENOENT（已不存在）、EACCES+Windows 共享冲突。
 */
function _friendlyDeleteError(e) {
  switch (e && e.code) {
    case 'EACCES':
    case 'EPERM':
      return '没有删除权限，请检查文件权限';
    case 'EBUSY':
      return '文件被其他程序占用，无法移到回收站';
    case 'ENOENT':
      return '文件已不存在';
    case 'ENOTDIR':
    case 'EISDIR':
      return '目标路径不是文件';
    default:
      return '无法移到回收站，请手动删除文件';
  }
}

/**
 * audit fix (K1-M2)：file:read 的 errno 翻译。读路径常见 errno：
 * EACCES/EPERM（权限）、EIO（磁盘 I/O）、EISDIR（路径是目录）、
 * ENAMETOOLONG（路径过长）。
 */
function _friendlyReadError(e) {
  switch (e && e.code) {
    case 'EACCES':
    case 'EPERM':
      return '没有读取权限';
    case 'EIO':
      return '磁盘 I/O 错误';
    case 'EISDIR':
      return '该路径是文件夹，无法读取';
    case 'ENAMETOOLONG':
      return '路径过长';
    default:
      return '读取文件失败';
  }
}

/**
 * audit fix (K1-R4)：shell/app:* handler 的 errno 翻译 —— 之前直接返回
 * 英文 e.message（带完整路径）到 renderer，3 个 handler（app:open-path /
 * shell:show-item-in-folder / shell:open-dir）都漏。统一走 _friendlyShellError
 * 翻译成中文，与 _friendlyReadError / _friendlyCreateError 对齐。
 *
 * 这些 handler 多半是 stat 或 shell 操作，常见 errno：
 * EACCES/EPERM（权限）、ENOENT（路径不在）、EIO（磁盘 I/O）、EBUSY（被占）。
 */
function _friendlyShellError(e, fallback) {
  switch (e && e.code) {
    case 'EACCES':
    case 'EPERM':
      return '没有访问权限';
    case 'ENOENT':
      return '路径不存在';
    case 'EIO':
      return '磁盘 I/O 错误';
    case 'EBUSY':
      return '文件被占用';
    case 'ENOTDIR':
      return '目标路径不是目录';
    case 'EISDIR':
      return '目标路径是文件夹';
    case 'ENAMETOOLONG':
      return '路径过长';
    default:
      return fallback || '操作失败';
  }
}

// 抑制 Windows 上常见的 "Unable to move the cache" / "Gpu Cache Creation failed" 警告
app.commandLine.appendSwitch('disable-gpu-cache');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

let mainWindow = null;
let tray = null;
let isQuitting = false;
let currentDataDir = null;
let forceShowTimer = null;
let rendererDirty = false; // 渲染端是否有未保存改动
// 关闭按钮触发的脏检查防重入：用户连点 × 时二次点击若没有 this 守卫会跑
// 两次 confirmDiscardIfDirty（都 await promptRendererSave，让出事件循环），
// 弹出两个原生 dialog，关闭确认也跟着弹两次。镜像 before-quit 的
// quitConfirmInFlight 模式。
let closeConfirmInFlight = false;

// audit fix (Round 17 H2)：fs 操作 30s 超时包裹。SMB / 坚果云 / OneDrive 在
// 网络抖动 / 杀毒持锁 / 用户挂起电脑后重新唤醒时，fs.read / fs.write / fs.stat
// / fs.rename 可能挂死几分钟甚至永久。renderer 这边 `await window.api.xxx()`
// 永远 resolve 不出来，UI 无 loading、无错误提示，用户只能强杀进程。
//
// 设计要点：
//   - 用 Promise.race 而非 AbortController —— Node fs.* 没有内置 abort 语义，
//     注入 abort signal 在不同版本兼容差；race 超时后底层 promise 仍会跑完，
//     但其结果已被丢弃，不会影响调用方。
//   - 超时错误带 code='FS_TIMEOUT'，handler catch 块透传到 renderer；
//     renderer 看到 FS_TIMEOUT 走「磁盘暂时不可用，请稍后重试」友好文案。
//   - 30s 是经验值：原子写 + fsync + rename 在 SMB 上实测 1-3s，30s 给 10x
//     余量；超过这个值基本就是磁盘真的没了，再等也没意义。
//   - timeout Timer 必须 .unref()，否则 fs 操作 hang 时主进程不会自然退出。
const FS_OP_TIMEOUT_MS = 30000;

function withTimeout(promise, ms = FS_OP_TIMEOUT_MS, label = 'fs') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} 操作超过 ${ms}ms 未完成`);
      err.code = 'FS_TIMEOUT';
      reject(err);
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout])
    .finally(() => { clearTimeout(timer); });
}

/**
 * 安全向渲染端发送 IPC。
 *
 * mainWindow 已被销毁时（isDestroyed() true）会直接返回；
 * 但还有一种时序：BrowserWindow 对象还活着、webContents 已被拆毁
 * （例如关窗时 did-finish-load / resize 事件晚到一步），
 * 此时 webContents.send 会同步抛 throw，没有调用方能接住 → unhandledException。
 * main\fs-watcher.js:145 safeSend 用了同款防御；这里共用一份语义。
 *
 * 参数名故意避开 channel：check-ipc.js 的静态扫描按变量名匹配 webContents.send
 * 与 const 字面量，channel 已被 promptRendererSave 的局部 const 占走同名，全局共用
 * 会被错配。改用 eventName 避开冲突。
 */
function safeSendToRenderer(eventName, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send(eventName, payload);
  } catch (e) {
    console.warn(`[main] send ${eventName} 失败:`, e && e.message);
  }
}

// 渲染进程崩溃计数器（防止 reload 死循环）
let renderGoneCount = 0;
const MAX_RENDER_GONE_RELOADS = 3;

// 目录监听实例（Stage 4b.2 抽离到 main/fs-watcher.js）
// 注入依赖：getMainWindow 是闭包（每次访问时读 mainWindow 当前值），
// resolveDataDir 同理。scanDir / toRelDir 都是模块内函数，hoist 后可用。
// Stage 8：注入 scanDir + toRelDir，监听目标是「当前显示目录」而非固定根目录。
const fsWatcher = createFsWatcher({
  getMainWindow: () => mainWindow,
  // 走 currentDataRoot 而不是 resolveDataDir：fsWatcher 的 updateSnapshot 里要
  // 用 dataRoot 重新做相对路径转换，customDir 失效场景下默认目录才是真实 root。
  resolveDataDir: () => currentDataRoot(),
  scanDir,
  toRelDir: (absDir) => toRelativeDir(absDir, currentDataRoot()),
});

// AI 代理实例 —— 每次 runEdit 都现读 configStore.getConfig()，
// 用户改完 BaseURL / API Key / Model 不需要重启。
// P3-2 fix (audit)：注入 log hook 让 ai:request / ai:http_error 在主进程
// 控制台可见（线上排查 AI 失败时只能靠 DevTools network 面板）。
// payload 白名单字段（url/status/detail/model/filename/promptLen/contentLen）
// 已经不含 apiKey / Authorization 头。
const aiProxy = createAiProxy({
  getConfig: () => configStore.getConfig(),
  log: (key, payload) => console.log(`[main][${key}]`, payload),
});

// ============================================
//  启动日志
// ============================================

console.log('[main] Electron 启动中...');
console.log('[main] Platform:', process.platform);
console.log('[main] Electron version:', process.versions.electron);
console.log('[main] Project path:', __dirname);

// audit fix (Round 9)：全局兜底异常日志。之前的代码里 IPC handler / fsWatcher /
// AI 路径的异常基本都 try/catch + console.error，但仍有「外层 promise 链
// 没人 await」「fsWatcher 内部 setTimeout 回调抛」之类的边界场景 —— 没有
// 这里兜底会被 Node 默认行为吞掉（unhandledRejection 在新 Node 上是会
// terminate 进程的，uncaughtException 默认打印 + 退出），连日志都不留。
// 只 log 不 exit（与既有 try/catch 风格一致 —— 主进程挂了 IPC 全断）。
process.on('uncaughtException', (err, origin) => {
  console.error('[main] uncaughtException:', err && (err.stack || err.message || err), 'origin:', origin);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[main] unhandledRejection at:', promise, 'reason:', reason && (reason.stack || reason.message || reason));
});

// ============================================
//  窗口创建
// ============================================

function createWindow() {
  if (forceShowTimer) {
    clearTimeout(forceShowTimer);
    forceShowTimer = null;
  }

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 600,
    minHeight: 420,
    backgroundColor: '#0a0a0c',
    icon: APP_ICON_PATH,
    show: false,
    autoHideMenuBar: true,
    // 自定义窗口：去掉系统标题栏，改由 renderer 顶部工具栏的 -webkit-app-region: drag
    // 接管拖拽，并在工具栏右侧画出自定义最小化/还原/关闭按钮。
    frame: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    }
  });

  mainWindow.loadFile('index.html');

  // 启动时应用持久化的「始终置顶」状态
  if (configStore.getConfig().alwaysOnTop === true) {
    mainWindow.setAlwaysOnTop(true);
  }

  mainWindow.once('ready-to-show', () => {
    console.log('[main] 窗口 ready-to-show，显示窗口');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
    }
    broadcastMaximizeState();
  });

  // 兜底：2 秒后如果还没显示，强制显示
  forceShowTimer = setTimeout(() => {
    forceShowTimer = null;
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      console.warn('[main] ready-to-show 未触发，强制显示窗口');
      mainWindow.show();
    }
  }, 2000);
  // audit fix (Round 9)：timer 句柄 .unref()，防止它单独阻塞进程退出。
  // 没有 .unref 的话，正常退出路径上 forceShowTimer 还没到 2s 触发的窗口里，
  // electron 会等定时器到期才退（虽然窗口已 closed 但 event loop 还被它吊着）。
  // audit fix (Round 9)：窗口重建时也会创建新的 forceShowTimer（createWindow
  // 顶部清掉旧的）。unref 保证不阻塞退出。
  if (forceShowTimer && typeof forceShowTimer.unref === 'function') {
    forceShowTimer.unref();
  }

  // 错误监听
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    console.error('[main] 页面加载失败:', errorCode, errorDescription, validatedURL, 'isMainFrame:', isMainFrame);
    // audit fix (Round 9)：只对主框架错误弹致命 dialog。子框架（iframe）/ 主动
    // abort（errorCode=-3 ERR_ABORTED —— 用户按 Esc / navigate 取消）属正常
    // 路径，弹 dialog 反而扰民。errorCode=-3 是 Chromium 的 ERR_ABORTED。
    if (!isMainFrame || errorCode === -3) return;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    // 主框架加载失败 → renderer 完全没起来，UI 也没法弹 toast。在主进程弹
    // 原生 dialog，让用户知道发生了什么并提供手动退出的按钮。
    try {
      dialog.showMessageBoxSync(mainWindow, {
        type: 'error',
        title: '页面加载失败',
        message: '应用主页面加载失败',
        detail: `${errorDescription} (${validatedURL})\n\n请尝试重启应用或从任务管理器结束进程后重试。`,
        buttons: ['退出', '继续（已加载的页面可能不可用）'],
        defaultId: 0,
        cancelId: 0,
      }) === 1 && console.warn('[main] 用户选择继续，主框架加载失败但继续运行');
    } catch (e) {
      console.error('[main] did-fail-load dialog 弹窗失败:', e);
    }
  });

  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.error('[main] 渲染进程崩溃:', details);
    // 崩溃循环保护：3 次连续崩溃后不再 reload，避免无限循环占满 CPU
    renderGoneCount += 1;
    if (renderGoneCount > MAX_RENDER_GONE_RELOADS) {
      console.error('[main] 渲染进程连续崩溃超过上限，停止自动 reload，请手动重启');
      // audit fix (Round 9)：连续崩溃超上限弹致命 dialog 让用户决定。
      // renderer 已经不可用，没法自己弹 toast，必须在主进程走 dialog。
      if (mainWindow && !mainWindow.isDestroyed()) {
        try {
          dialog.showMessageBoxSync(mainWindow, {
            type: 'error',
            title: '渲染进程连续崩溃',
            message: '应用渲染进程连续崩溃，已停止自动恢复',
            detail: `请尝试重启应用。如果问题持续，请到 GitHub 仓库反馈（控制台有更多细节）。\n\n原因：${details.reason || 'unknown'}`,
            buttons: ['退出', '关闭此提示'],
            defaultId: 0,
            cancelId: 0,
          });
        } catch (e) {
          console.error('[main] render-process-gone dialog 弹窗失败:', e);
        }
      }
      return;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.reload();
    }
  });

  // 崩溃计数器只在「连续崩溃」时累加；reload 成功后再清零，
  // 否则跨多次会话累积 3 次后就再也触发不了自动恢复了。
  mainWindow.webContents.on('did-finish-load', () => {
    renderGoneCount = 0;
    // audit fix (Round 9)：renderer 重新加载（崩溃恢复 / Ctrl+R / 显示引导
    // 重启 renderer）后必须把 rendererDirty 重置为 false —— 否则上次崩溃
    // 之前的状态被「缓存」在主进程，before-quit 会拿这个 stale true 弹「未
    // 保存确认」但用户其实没东西可丢。renderer 重启后 state 是干净的，主
    // 进程需要跟上。
    rendererDirty = false;
    // auto-fallback 2026-08：renderer 就绪后广播一次 data-dir:resolved。
    // 必须在 did-finish-load 里发，不能在 createWindow 末尾 ——
    // 后者调用时 renderer 的 ipcRenderer.on 监听还没装好，事件被丢。
    // fellBack=false 时也发（让 renderer 拿到 defaultDir 用作 UI 文案）；
    // 监听器只在 fellBack=true 时弹引导弹窗，false 时只更新状态。
    broadcastDataDirResolved();
  });

  // 拦截新窗口请求：markdown 里的 `<a target="_blank">` 默认会被 Electron 真的弹一个新窗口。
  // 我们要的是外部链接走 shell.openExternal（preload 已经处理），所以这里一律拒绝。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    console.warn('[main] 拒绝新窗口请求:', url);
    return { action: 'deny' };
  });

  // audit fix (Round 13 / Sec-L)：拒绝所有权限请求。当前 threat model 下没有
  // 任何 feature 需要 media / geolocation / notifications / midi 等权限 —— 一旦
  // 未来 XSS 落地，攻击者若能让 renderer 调 navigator.geolocation / webcam 等，
  // 没有这层兜底会直接拿到原始权限。Electron 默认对每个权限请求都会询问用户，
  // 但「弹窗让用户点」不是真安全 —— 默认 deny + 显式 allow 才能把攻击面关到 0。
  // 设在 webContents 级：每窗口独立；若以后加 BrowserWindow 也要记得复制。
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
  });
  mainWindow.webContents.session.setPermissionCheckHandler(() => false);

  // audit fix (Round 9)：F12 在所有平台都能打开 DevTools。
  // 菜单 accelerator `F12` 在 macOS 可见菜单栏下生效，但 Windows / Linux
  // 上 autoHideMenuBar=true 让菜单隐藏 → accelerator 不再触发，README
  // 承诺「Windows / Linux 也可」变成谎言。webContents.on('before-input-event')
  // 是 Chromium 级的输入事件，不依赖菜单可见性，跨平台一致。
  // 只对 `F12`（不含修饰）生效，编辑器内也让位（CM6 不占 F12 但未来可能）。
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12' && !input.alt && !input.control && !input.meta && !input.shift) {
      event.preventDefault();
      mainWindow.webContents.toggleDevTools();
    }
  });

  // 拦截任何页面内导航：只允许同源 file:// 加载 index.html。
  // 防止恶意 markdown 中的 <meta http-equiv="refresh"> 或 <a href> 把我们带到外部页面。
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = mainWindow.webContents.getURL();
    if (url === allowed) return; // 同 URL 重载
    // 任何外部 URL → 阻止并打开外部浏览器
    event.preventDefault();
    console.warn('[main] 拦截外部导航:', url);
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url).catch((e) => console.error('[main] openExternal 失败:', e));
    }
  });

  // console-message 事件签名：Electron 35+ 派发 5-arg 兼容路径（runtime 不论 listener.length
  // 是 1/2/5 都走同一内部接口），推荐用单参 `(event)` 直接读 WebContentsConsoleMessageEventParams：
  //   event.message    - 消息文本
  //   event.level      - 'verbose' | 'info' | 'warning' | 'error' | 'debug'（字符串，
  //                      不是 Electron 28 时代的 0-3 数字；要相等比较 === 'error'）
  //   event.lineNumber - 源代码行号
  //   event.sourceId   - 源代码 URL
  //   event.frame      - WebFrameMain
  // 走单参路径运行时不会再打印 deprecated 警告（仅多参 `on(..., (a,b) => ...)` 才会触发），
  // 移除 console-message 监听会让 renderer 错误不可见，故保留。
  mainWindow.webContents.on('console-message', (event) => {
    if (event.level === 'error') {
      console.error(`[renderer ${event.sourceId}:${event.lineNumber}]`, event.message);
    }
  });

  // 开发模式下自动打开 DevTools
  if (process.env.NODE_ENV === 'development' || process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // 关闭事件：有托盘时拦截关闭按钮改为隐藏到托盘（不丢数据，无需确认）；
  // 没有托盘时关闭就是退出，有未保存的改动必须先弹确认框。
  mainWindow.on('close', async (e) => {
    // isQuitting 为 true 说明 before-quit 已经做过脏检查了，直接放行
    if (isQuitting) return;
    e.preventDefault();

    // 有托盘时关闭只是隐藏窗口，未保存的内容还在内存里，不该拿弹窗打扰用户；
    // 真正的退出（托盘菜单、Cmd+Q 等）由 before-quit 统一做脏检查
    if (tray) {
      hideWindow();
      return;
    }

    // audit fix (Round 9)：防 close 重入。用户双击 × 时第一次 confirmDiscardIfDirty
    // 还在 await promptRendererSave（让出事件循环），第二次 close 事件进入
    // → 又走 confirmDiscardIfDirty → 两个原生 dialog 同时挂起。镜像
    // before-quit 的 quitConfirmInFlight 模式：第一次进入设标记，二次 click
    // 直接 e.preventDefault 走人。
    if (closeConfirmInFlight) return;
    closeConfirmInFlight = true;
    try {
      // 没有托盘：关闭窗口就是退出，丢改动之前必须确认
      const proceed = await confirmDiscardIfDirty();
      if (!proceed) return;
      isQuitting = true;
      app.quit();
    } finally {
      closeConfirmInFlight = false;
    }
  });

  mainWindow.on('maximize', () => broadcastMaximizeState());
  mainWindow.on('unmaximize', () => broadcastMaximizeState());

  // 窗口最小化 / 收进托盘时暂停 readdir 轮询，重新可见时恢复并补扫一次
  mainWindow.on('minimize', () => fsWatcher.pauseDirPolling());
  mainWindow.on('hide', () => fsWatcher.pauseDirPolling());
  mainWindow.on('restore', () => fsWatcher.resumeDirPolling());
  mainWindow.on('show', () => fsWatcher.resumeDirPolling());

  mainWindow.on('closed', () => {
    console.log('[main] 窗口已关闭');
    // audit fix (Round 9)：清理 forceShowTimer。createWindow 顶部也清，但
    // 异常路径下（窗口被强制销毁没走 createWindow）会泄漏 timer 句柄。
    // 这里 closed 兜底再清一次。forceShowTimer.unref() 之后不会阻塞退出，
    // 但留着没意义（窗口已 null，timer 内回调的 isDestroyed 守卫也会拦下）。
    if (forceShowTimer) {
      clearTimeout(forceShowTimer);
      forceShowTimer = null;
    }
    fsWatcher.stopWatchingDir();
    mainWindow = null;
  });

  console.log('[main] 主窗口创建完成');

  // audit fix (Round 7 FS-F4)：createWindow 是重建路径（macOS activate /
  // showWindow 的 destroyed 分支 / 渲染进程崩溃恢复）的统一入口。窗口重建
  // 后必须重新挂载目录监听，否则整个会话的文件监听彻底死掉，外部改动再也
  // 不会出现在侧栏。startWatchingDir 内部 stopWatchingDir 幂等，无副作用。
  try {
    fsWatcher.startWatchingDir(currentDataRoot());
  } catch (e) {
    console.warn('[main] 重建目录监听失败（仅依赖轮询）:', e && e.message);
  }
}

// ============================================
//  系统托盘
// ============================================

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function hideWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (forceShowTimer) {
    clearTimeout(forceShowTimer);
    forceShowTimer = null;
  }
  mainWindow.hide();
}

function toggleWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
    hideWindow();
  } else {
    showWindow();
  }
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: '显示窗口', click: () => showWindow() },
    { label: '隐藏窗口', click: () => hideWindow() },
    { type: 'separator' },
    {
      label: '始终置顶',
      type: 'checkbox',
      checked: configStore.getConfig().alwaysOnTop === true,
      click: (item) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.setAlwaysOnTop(item.checked);
        }
        // audit fix (C2)：saveConfig 现在返回 Promise（异步写盘 + 串行 queue），
        // fire-and-forget 路径加 .catch 避免写盘失败时 unhandled rejection。
        configStore.saveConfig({ alwaysOnTop: item.checked }).catch((e) => {
          console.error('[main] tray alwaysOnTop 保存失败:', e?.error || e?.message || e);
        });
        // audit fix (H3)：走 safeSendToRenderer —— mainWindow 已被 destroyed
        // 但引用还在的极小窗口里 .send() 同步抛 TypeError，托盘 click 处理器
        // 没 try/catch → unhandledException 主进程侧崩溃。
        safeSendToRenderer('always-on-top:changed', item.checked);
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        // 不在这里置 isQuitting：交给 before-quit 做「未保存改动」确认，
        // 否则托盘退出会跳过脏检查直接丢数据。
        app.quit();
      }
    }
  ]);
}

function createTray() {
  if (tray) return;
  try {
    tray = new Tray(APP_ICON_PATH);
    tray.setToolTip('Notes');
    tray.setContextMenu(buildTrayMenu());
    tray.on('click', () => toggleWindow());
    console.log('[main] 系统托盘已创建');
  } catch (e) {
    console.error('[main] 系统托盘创建失败:', e.message);
    tray = null;
  }
}

function destroyTray() {
  if (!tray) return;
  try {
    tray.destroy();
  } catch (e) {
    console.warn('[main] 销毁托盘失败:', e.message);
  }
  tray = null;
}

// ============================================
//  单实例锁
// ============================================
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  console.log('[main] 已有实例在运行，激活已有窗口后退出本实例');
  isQuitting = true;
  app.quit();
} else {
  app.on('second-instance', () => {
    console.log('[main] 检测到第二个实例启动，激活已有窗口');
    showWindow();
  });
}

// ============================================
//  应用生命周期
// ============================================

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return;

  configStore.init();
  // auto-fallback 2026-08 + auto-create 默认目录：currentDataRoot() 内部走
  // resolveDataDirOrFallback，customDir 失效时回退到默认；返回 DEFAULT_DATA_DIR
  // 时还会 sync mkdir（确保 fsWatcher 启动时不撞 ENOENT）+ 异步种子 README.md
  // （fire-and-forget，下次 fsWatcher 第一次扫描大概率就绪）。
  // 之前用 resolveDataDir() 不做 stat、不 mkdir —— 用户首次启动默认目录还没建、
  // 或 U 盘掉线 fallback 路径下默认目录也从未被用过，都会让 fsWatcher.startWatchingDir
  // 立刻 ENOENT 失败、侧栏空白、用户毫无线索。
  currentDataDir = currentDataRoot();
  // 注意：不要打印完整 config —— aiApiKey 等敏感字段不能进日志。
  // 只打印 "已加载" 这条确认信息；详情在出错时单独打。
  console.log('[main] 已加载配置');
  console.log('[main] 数据目录:', currentDataDir);

  // 等欢迎文档就绪再启动 fsWatcher —— 默认目录刚创建的情况下，先把 README.md
  // 写好再让 fsWatcher 开始监听，避免「fsWatcher 第一次扫描拿到空目录、几秒
  // 后 README.md 突然冒出侧栏」的 UX 撕裂。resolveDataDirOrFallback 内部已
  // fire-and-forget 异步种子一次，这里 await 的是同一份 in-flight promise。
  await configStore.scheduleEnsureDefaultDataDir();

  // audit fix (Round 16 R2)：清理数据目录里残留的 `*.tmp.<pid>.<ts>.<rand>`
  // 孤儿文件。atomicWriteFile 失败路径会 unlink，但「进程被 kill -9 / 断电」
  // 不会走那条路。configStore 自己的 `config.json.tmp.*` 在 configStore.init()
  // 内部已经处理；这里只覆盖 fileOps 这一组。fire-and-forget，不阻塞启动。
  fileOps.cleanupStaleFileTmpFiles(currentDataDir).catch((e) => {
    console.warn('[main] 清理数据目录残留 tmp 失败:', e && e.message);
  });

  console.log('[main] app ready');
  buildMenu();
  createTray();
  createWindow();

  // 启动目录监听器（默认目录已 sync mkdir + README.md 已 async 种子完毕）
  fsWatcher.startWatchingDir(currentDataDir);

  app.on('activate', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      showWindow();
    } else if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}).catch(err => {
  console.error('[main] app ready 失败:', err);
});

// 退出确认是否正在进行，防止用户连点托盘「退出」时叠出多个原生框
let quitConfirmInFlight = false;

// 所有退出路径（托盘退出、Cmd+Q、系统关机请求）都会经过 before-quit。
// isQuitting 只有在这里确认过、或单实例锁失败时才会被置为 true。
app.on('before-quit', async (e) => {
  if (isQuitting) return;

  if (!rendererDirty) {
    isQuitting = true;
    return;
  }

  // 已经弹着一个确认框了，忽略这次退出请求
  if (quitConfirmInFlight) {
    e.preventDefault();
    return;
  }

  e.preventDefault();
  quitConfirmInFlight = true;
  try {
    const proceed = await confirmDiscardIfDirty();
    if (!proceed) return;
    isQuitting = true;
    app.quit();
  } finally {
    quitConfirmInFlight = false;
  }
});

app.on('will-quit', () => {
  // 退出时取消所有在飞的 AI 请求，避免响应被丢弃（付费用 API 也会浪费额度）。
  // audit fix (main-M11)：把同步清理拆出来，把 revealArmedBySender 兜底清理
  // 也挪到这里（armed TTL 兜底 setTimeout 已经 .unref，正常退出流程不会等它，
  // 显式清理避免 reveal Map 在长跑测试 / 频繁 reload 场景下累积 entry）。
  try { aiProxy.cancelAll(); } catch (e) { console.warn('[main] cancelAll 失败:', e && e.message); }
  // audit fix (main-M12a)：revealArmedBySender 在 will-quit 显式清空。
  // 既有 TTL 兜底（armed 5s 后 setTimeout 自动删），但用户开窗口→立刻退的
  // 短路径上 entry 仍占着 Map。shutdown 时主动清掉，调试时也能在 heap
  // snapshot 看到模块级 Map 是干净的。
  try { revealArmedBySender.clear(); } catch (e) { console.warn('[main] revealArmed 清理失败:', e && e.message); }
  // audit fix (Round 7 FS-F15)：will-quit 显式停 fsWatcher。fsWatcher 持有
  // 1 个 FSWatcher 句柄 + 1 个 setInterval + 最多 2 个 setTimeout，长期跑
  // 测试 / 频繁 reload 场景下堆积。closed 路径已经 stopWatchingDir，但
  // macOS `before-quit` 可能跳过 closed 直接 will-quit —— 这里兜底。
  try { fsWatcher.stopWatchingDir(); } catch (e) { console.warn('[main] fsWatcher 清理失败:', e && e.message); }
  destroyTray();
});

app.on('window-all-closed', () => {
  console.log('[main] 所有窗口已关闭');
  if (tray) return;
  if (process.platform !== 'darwin') app.quit();
});

// ============================================
//  IPC: 渲染端脏状态同步 + 触发保存
// ============================================

ipcMain.handle('renderer:set-dirty', (event, isDirty) => {
  // audit fix (L5)：sender 校验。rendererDirty 是退出路径上 confirmDiscardIfDirty
  // 决定「是否弹未保存确认框」的唯一开关。若 XSS 拿到 window.api.setDirty
  // （preload.js 暴露的 contextBridge API，渲染端任意 JS 都能调）就能把
  // rendererDirty 强写为 false → 用户关窗时直接跳过保存确认 → 未保存内容静默
  // 丢失。校验 event.sender 是 mainWindow.webContents、senderFrame 是顶级
  // frame —— 拒掉所有来自子 frame / devtools / 其它 BrowserWindow 的调用。
  if (!event?.sender || !mainWindow || event.sender !== mainWindow.webContents) {
    console.warn('[main] renderer:set-dirty 拒绝：sender 不是主窗口 webContents');
    return false;
  }
  const senderFrame = event.senderFrame;
  if (senderFrame && senderFrame.parent) {
    console.warn('[main] renderer:set-dirty 拒绝：来自子 frame');
    return false;
  }
  // 仅同步标志位，供 confirmDiscardIfDirty 在退出路径上判断「是否弹未保存确认框」。
  // 不在此处刷新托盘菜单 —— dirty 状态与托盘菜单项（始终置顶、显示主窗口）无关。
  rendererDirty = !!isDirty;
  return true;
});

/**
 * 通知渲染端立刻保存当前文件。
 * 通过 webContents.send + 一次性监听 IPC 返回值的方式拿到结果。
 *
 * audit fix (M5 main)：webContents.send 在 webContents 已 destroyed（但
 * mainWindow 还没被回收的极小窗口）会抛 TypeError —— 旧实现没 try/catch，
 * 整个 Promise 永远 hang 在 unhandled 里；confirmDiscardIfDirty 调用方
 * `await promptRendererSave()` 永远等不到 resolve，「关闭窗口」操作死锁。
 * 收紧护栏：send 失败 → 立即解 timer + resolve(false)；webContents 中途
 * destroyed → 同样提前 resolve(false) 不再等 10s。
 *
 * @returns {Promise<boolean>} true 表示保存成功（或没有需要保存的内容）
 */
function promptRendererSave() {
  return new Promise((resolve) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      resolve(false);
      return;
    }
    const reqId = `save-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const channel = `renderer:save-result:${reqId}`;
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      // audit fix (M2)：hardTimer 已被删（见下方），这里不再 clearTimeout(hardTimer)。
      // 旧 hardTimer(10s) 的 callback 是空，只给 settle 一个 handle 来 clear —— 但
      // settle 在 0-10s 之间必然先 fire（renderer 几乎总是 1-3s 内回结果），到 10s 时
      // hardTimer 已 clearTimeout 掉，never fires；10s 后仍未 settle 的极小窗口里，
      // hardTimer fires 是个 no-op（listener 自身由 graceTimer 的 settle(false) 移除，
      // 或被任意 settle(ok) 移除）。删 hardTimer 后语义不变，注释中「进入宽限窗口」
      // 的解释改为「10s 这一刻只是渲染承诺过期，监听器照常保留到 graceTimer」。
      clearTimeout(graceTimer);
      try { ipcMain.removeAllListeners(channel); } catch { /* ignore */ }
      // Phase N M1 fix：早退路径（IPC 收到结果 / 窗口 destroyed / send 失败）清掉
      // graceTimer 与 once('destroyed')，否则 onDestroyed 会留到窗口死亡才被拆、
      // graceTimer 会留到 15s 才被 Node 自然 GC，延迟 process.exit 0.5s ~ 5s
      // （取决于哪条路径先 settle）。granted settled 守卫让它们是 no-op，但 timer/
      // listener 仍占资源。
      try { wc && wc.off('destroyed', onDestroyed); } catch { /* ignore */ }
      resolve(value);
    };

    // audit fix (Main P1 / promptRendererSave grace timer 死代码)：
    // 旧版 hardTimer(10s) + graceTimer(15s) 两个 timeout 都直接调
    // settle(false) —— 因为 hardTimer 先 fire，settled 守卫让 graceTimer
    // 必是 no-op，「宽限期接受晚到的 ok=true 结果」根本没生效，等同于
    // 一段被注释误导的 dead code。
    // 修正：hardTimer fire 时只让出监听器（不再 settle），graceTimer fire
    // 时才 settle(false)。这样 10-15s 之间晚到的 renderer:save-result:{reqId}
    // 仍能走 settle(ok=true)，避免大文件 / 慢盘下「renderer 实际写盘成功
    // 但晚到 10s+」被错判为保存失败 → 用户看到「取消关闭」，实际文件已
    // 保存的诡异状态。
    const HARD_DEADLINE_MS = 10000;
    const GRACE_PERIOD_MS = 15000;
    // audit fix (M2)：硬期限改成「软」语义 —— 没有任何 settle，10s 后 renderer 没
    // 回结果只代表渲染侧可能慢（大文件 / 慢盘），监听器不摘、graceTimer 继续守。
    // 旧版 hardTimer 是空 callback + 只为让 settle 能 clearTimeout 的 dead timer；
    // 删掉后行为完全一致：0-15s 之间晚到的 renderer 结果照样被 settle(ok) 接受，
    // 15s graceTimer 仍未回 → settle(false)。每次 quit attempt 少一个 timer。
    void HARD_DEADLINE_MS; // 仅作注释常量保留（其它模块若想对齐可参考）
    let graceTimer = setTimeout(() => settle(false), GRACE_PERIOD_MS);

    ipcMain.once(channel, (_event, result) => {
      // 宽限期内（10-15s 之间）到达的结果一律接受；hardTimer 之前照常
      // 接受；graceTimer 之后 / 已 settled 直接被 settled 守卫挡掉。
      settle(!!(result && result.ok));
    });

    // webContents 中途被销毁（极少见但可能：before-quit 序列里被 GC）
    const wc = mainWindow.webContents;
    const onDestroyed = () => settle(false);
    if (wc && !wc.isDestroyed()) {
      wc.once('destroyed', onDestroyed);
    }

    try {
      wc.send('renderer:save-request', { reqId });
    } catch (e) {
      console.error('[main] promptRendererSave send 失败:', e.message);
      settle(false);
    }
  });
}

/**
 * 有未保存改动时弹原生三选一确认框（保存 / 丢弃 / 取消）。
 * close（无托盘）和 before-quit 共用，保证任何退出路径都不会静默丢数据。
 * 隐藏到托盘不算退出，不走这里。
 * @returns {Promise<boolean>} true = 可以继续退出；false = 用户取消 / 保存失败
 */
/**
 * confirmDiscardIfDirty 递归上限。防止「用户一直敲字 → 保存后又脏 → 反复弹原生框」
 * 死循环。Phase N-A1 修复用了递归弹框，第 MAX_CONFIRM_RECURSION 次直接返回 false
 * 强制用户取消或丢弃。
 */
const MAX_CONFIRM_RECURSION = 3;

/**
 * confirmDiscardIfDirty 的递归保护版本。depth=0 时不再弹原生框，
 * 直接返回 false（强制用户取消或丢弃），防"用户一直敲字 → 反复提示"的死循环。
 */
async function _confirmDiscardIfDirtyBounded(depth) {
  if (depth <= 0) return false;
  // audit fix (Round 8 M-2)：必须把 depth 透传下去。旧实现调 confirmDiscardIfDirty()
  // 不带参 → 内部又用常量 MAX_CONFIRM_RECURSION - 1 递归 → depth 恒为 2，
  // 「第 3 次强制 return false」的安全网从未生效，理论上可无限递归到栈溢出。
  return await confirmDiscardIfDirty(depth);
}

async function confirmDiscardIfDirty(depth = MAX_CONFIRM_RECURSION) {
  if (!rendererDirty) return true;
  // 旧实现：mainWindow 缺失/被销毁时直接 return true（"允许丢弃"）。
  // 这会让 rendererDirty=true 但窗口在弹框前就被拆掉的极端时序下
  // 默默把未保存改动丢进黑洞 —— close/quit 路径在 call site `if (!proceed) return;`
  // 直接吞掉，等价于「不确认就退出」。
  // 修复：拿不到窗口就拒绝（return false），call site 收到 false 后中止
  // close/quit；用户重启 / 重新打开窗口时仍能拿到 promptRendererSave 流程
  // 继续问「保存 / 丢弃 / 取消」。
  if (!mainWindow || mainWindow.isDestroyed()) return false;

  // 窗口可能已经隐藏到托盘了，先显示出来，否则原生框会挂在看不见的窗口上
  if (!mainWindow.isVisible() || mainWindow.isMinimized()) {
    showWindow();
  }

  const choice = dialog.showMessageBoxSync(mainWindow, {
    type: 'warning',
    buttons: ['保存后退出', '丢弃并退出', '取消'],
    defaultId: 0,
    cancelId: 2,
    title: '未保存的改动',
    message: '当前文件有未保存的改动。\n退出将丢失这些改动。',
    detail: '「保存后退出」会写入磁盘再退出；「丢弃并退出」直接退出；「取消」回到窗口。',
    noLink: true,
  });

  if (choice === 2) return false;

  if (choice === 0) {
    const ok = await promptRendererSave();
    if (!ok) {
      dialog.showMessageBoxSync(mainWindow, {
        type: 'error',
        buttons: ['好'],
        title: '保存失败',
        message: '保存当前文件失败，已取消退出。',
        detail: '请回到窗口检查文件是否可写，或选择「丢弃并退出」。',
        noLink: true,
      });
      return false;
    }
    // audit fix (Phase N-A1)：save 飞行期用户输入的数据丢失路径。
    // 旧实现：promptRendererSave 解析为 ok → confirmDiscardIfDirty 直接 return true
    // → before-quit 看到 isQuitting=true 放行 → app.quit() → 编辑器销毁 →
    // 飞行期用户敲的字（C2）永久丢失（盘上是 C1）。
    //
    // 修复：在保存成功后再 re-check 一次 rendererDirty。rendererDirty 在 save 成功
    // 路径里会被 syncSaveButton() → setDirty(false) 写回 false，但飞行期用户又敲字
    // 会再次翻 true。如果保存后 dirty 重新为 true，说明用户在 save IPC 飞行期
    // 输入了新内容 —— 我们没有这些内容的盘上版本，强制退出等于丢字。
    //
    // 处理：弹"保存后又产生新改动"原生框，用户重新决策（继续保存 / 丢弃 / 取消）。
    // 取消则用户继续编辑；继续保存走递归 → promptRendererSave 二次飞行再被异步
    // 重读 dirty 时可能再次脏——但主进程 IPC 在 await 期间不阻塞（renderer 的
    // editor/view dispatch 同步触发 setDirty IPC 写回 rendererDirty）。最坏
    // 情况用户看到"保存后又有新改动"反复弹——明确告知比静默丢字好得多。
    if (rendererDirty) {
      const retry = dialog.showMessageBoxSync(mainWindow, {
        type: 'warning',
        buttons: ['再次保存', '丢弃并退出', '取消'],
        defaultId: 0,
        cancelId: 2,
        title: '保存后又产生了新改动',
        message: '文件已保存到磁盘，但保存过程中又输入了新内容。',
        detail: '「再次保存」会写入最新的内容再退出；「丢弃并退出」直接退出，丢失保存后的新内容；「取消」回到窗口继续编辑。',
        noLink: true,
      });
      if (retry === 2) return false; // 取消：继续编辑
      if (retry === 1) return true;  // 丢弃：直接退出
      // retry === 0：再次保存。递归调 confirmDiscardIfDirty 重新走完整流程。
      // 限制递归深度 ≤ MAX_CONFIRM_RECURSION 防极端时序死循环（用户一直敲字 →
      // 永远保存后又脏）。depth 沿调用链递减，耗尽后 _confirmDiscardIfDirtyBounded
      // 直接 return false（= 取消退出，回窗口继续编辑），不丢数据。
      return await _confirmDiscardIfDirtyBounded(depth - 1);
    }
  }
  return true;
}

// ============================================
//  IPC: 文件操作（只读）
// ============================================

/**
 * 取当前数据目录路径（IPC handler 统一封装）
 *
 * auto-fallback 2026-08：改走 resolveDataDirOrFallback() —— custom 路径不存在时
 * runtime 回退到默认（saved 字段保留原值，U 盘插回下次启动还能用回去）。
 * 之前直接调 resolveDataDir() 不做 stat，缺失时整个文件 IO 全炸、用户侧栏空白。
 */
function currentDataRoot() {
  return configStore.resolveDataDirOrFallback().dir;
}

/**
 * 启动时广播一次 data-dir:resolved 给 renderer，让 UI 在 fallback 时弹一次
 * 「数据文件夹不可访问」的引导弹窗 / toast。fallBack=false 时不发（无意义噪音）。
 */
function broadcastDataDirResolved() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const info = configStore.resolveDataDirOrFallback();
  safeSendToRenderer('data-dir:resolved', {
    dir: info.dir,
    defaultDir: configStore.getDefaultDataDir(),
    fellBack: info.fellBack,
    saved: info.saved,
  });
}

ipcMain.handle('file:list', async () => {
  const dir = currentDataRoot();
  currentDataDir = dir;
  // audit fix (Main P2 / file:list no validation)：其他 handler（file:scan-dir
  // / file:read / file:write / file:create / file:rename / file:delete）都先
  // 调 assertNoSymlinkAncestor 拒绝祖先链含 symlink 的目标；file:list 是早期
  // 入口，漏了这一步。
  // 威胁面：用户配置 dataDir 指到一个普通目录，但该目录里某个子项（含
  // file:list 直接扫描的根）被替换成 symlink 指向外部（恶意诱导 / 备份恢复
  // 时残留）—— 旧实现 fs.readdir + fs.stat 跟随 symlink，scanDir 把目标当
  // 成普通目录返回，渲染端按内部文件展示，触发 NTLM 偷凭 + 路径穿越。
  const ancestorCheck = await assertNoSymlinkAncestor(dir, dir);
  if (!ancestorCheck.ok) {
    return {
      ok: false,
      files: [],
      entries: [],
      error: ancestorCheck.error,
      code: ancestorCheck.code,
      message: ancestorCheck.message,
    };
  }
  // Folder Browser：根目录也走 scanDir，渲染端用 entryType 分流显示文件夹 / 文件 / binary。
  // 为了兼容老调用方，仍然把 entries 镜像成 files（仅 entryType==='editable'|'binary' 的项）。
  const result = await scanDir(dir);
  if (!result.ok) {
    return {
      ok: false,
      files: [],
      entries: [],
      error: result.error,
      code: result.code,
      message: result.message,
    };
  }
  // files = 非文件夹条目（侧栏历史逻辑兼容：state.files 仅含文件）
  const files = result.entries
    .filter((e) => !e.isFolder)
    .map((e) => ({ name: e.name, path: e.path, size: e.size, mtimeMs: e.mtimeMs, entryType: e.entryType }));
  return {
    ok: true,
    files,
    entries: result.entries,
    dir: result.dir,
    relDir: '',
  };
});

/**
 * file:scan-dir —— Folder Browser 的核心入口（Stage 8）
 *
 * 入参 relDir 是 dataRoot 下的 POSIX 风格相对路径（'notes/2026'）；
 * 空串表示根目录。返回一层所有条目（文件夹 + 文件 + binary）。
 *
 * 渲染端用这个在子目录之间导航；fs-watcher 也通过 {relDir} 字段告诉
 * 渲染端「变更发生在哪一层」，渲染端比对当前目录决定是否重扫。
 */
ipcMain.handle('file:scan-dir', async (_event, relDir) => {
  const dataRoot = currentDataRoot();
  const resolved = resolveDirRelative(typeof relDir === 'string' ? relDir : '', dataRoot);
  if (!resolved.ok) {
    return { ok: false, error: resolved.error, message: resolved.message };
  }
  // audit fix (Phase O-H1)：祖先链 symlink 检查。
  // 之前只 lstat(absDir) 自身，但 dataRoot/links 是 symlink 指向外部时，
  // absDir = dataRoot/links/foo 是合法路径（symlink 在祖先链上），
  // 自身不是 symlink → 通过检查。scanDir 跟随 symlink 读到外部目录文件列表，
  // 渲染后等于无成本枚举外部目标内容。
  // assertNoSymlinkAncestor 从 absDir 一路 lstat 到 dataRoot ，
  // 中间任一层是 symlink 就拒绝 —— 与 file:read/write/rename/delete 对齐。
  const ancestorCheck = await assertNoSymlinkAncestor(resolved.absDir, dataRoot);
  if (!ancestorCheck.ok) {
    return { ok: false, error: ancestorCheck.error, code: ancestorCheck.code, message: ancestorCheck.message };
  }
  const result = await scanDir(resolved.absDir);
  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      code: result.code,
      message: result.message,
      relDir: resolved.relDir,
    };
  }
  return { ok: true, dir: result.dir, relDir: resolved.relDir, entries: result.entries };
});

/**
 * file:watch-dir —— 切换 fs-watcher 的监听目标到指定子目录（Folder Browser 用）。
 *
 * 渲染端进入子目录时调用：
 *   await api.watchDir('notes/2026');
 * 之后 fs-watcher 推送的 files:changed 事件只与该子目录相关（payload.relDir 同步）。
 *
 * 与 startWatchingDir / scanFiles 基线的区别：startWatchingDir 会清基线并按目录类型重新初始化，
 * 这里直接复用工厂内部的 rewatch()，避免「切到同名目录时无谓重置基线」。
 *
 * relDir 必须经过 resolveDirRelative 校验，防止传入绝对路径或 .. 段越权。
 */
ipcMain.handle('file:watch-dir', async (_event, relDir) => {
  const dataRoot = currentDataRoot();
  const resolved = resolveDirRelative(typeof relDir === 'string' ? relDir : '', dataRoot);
  if (!resolved.ok) {
    return { ok: false, error: resolved.error, code: resolved.code, message: resolved.message };
  }
  // audit fix (Phase O-H2)：祖先链 symlink 检查。
  // 之前只 lstat(absDir) 自身。fs.watch(absDir) 会跟随 symlink 解析到外部目标的 inode，
  // watcher 在外部目标盘上持锁并把外部目录变更以 files:changed 推送回 renderer
  // （payload.relDir = 内部相对路径，renderer 误以为是 dataRoot 子目录活动）。
  // assertNoSymlinkAncestor 挡住祖先链含 symlink 的目标。
  const ancestorCheck = await assertNoSymlinkAncestor(resolved.absDir, dataRoot);
  if (!ancestorCheck.ok) {
    return { ok: false, error: ancestorCheck.error, code: ancestorCheck.code, message: ancestorCheck.message };
  }
  try {
    fsWatcher.rewatch(resolved.absDir);
    return { ok: true, dir: resolved.absDir, relDir: resolved.relDir };
  } catch (e) {
    // audit fix (K1-R4)：与其它 handler 对齐 code/message 形状，不再直回 e.message。
    return { ok: false, error: e.code || 'WATCH_FAILED', code: e.code, message: '无法切换监听目录' };
  }
});

ipcMain.handle('file:read', async (_event, filePath) => {
  if (typeof filePath !== 'string' || !filePath) {
    // audit fix (Round 7 IPC-1)：补齐 message 字段。renderer 走
    // `result.message || result.error || '未知错误'` 兜底，没 message 会退到
    // 英文原文 + 文案语言漂移。
    return {
      ok: false,
      error: 'INVALID_PATH',
      code: 'INVALID_PATH',
      message: '路径必须是字符串',
    };
  }
  // 路径必须在当前数据目录下（防御性：防止 renderer 越权访问）
  if (!isWithinDataDir(filePath, currentDataRoot())) {
    return { ok: false, error: 'PATH_NOT_ALLOWED', code: 'PATH_NOT_ALLOWED', message: '路径不在数据目录内' };
  }
  // symlink 防护（audit Q3）：与 file:write/rename/delete 对齐。
  // 之前 fs.stat(filePath) 会跟随 symlink → dataDir 内的 symlink 指向外部文件时，
  // renderer 可以通过 file:read 越权读到外部文件内容。lstat 拒绝 symlink。
  const linkCheck = await assertNotSymlink(filePath);
  if (!linkCheck.ok) {
    return { ok: false, error: linkCheck.error, code: linkCheck.code, message: linkCheck.message };
  }
  if (linkCheck.isFile === false) {
    return { ok: false, error: 'FILE_NOT_FOUND', code: 'FILE_NOT_FOUND', message: '文件已被删除' };
  }
  // audit fix (main-M2)：assertNotSymlink 只看 filePath 自身，而 fs.stat /
  // fs.readFile 会跟随 filePath 祖先链上的 symlink 目录。dataDir/sub 是 symlink
  // 指向外部目录时，readFile 实际读到 dataDir 之外的内容。补一次祖先检查，
  // 与 file:write/rename/delete 的 M1 修复保持对称。
  const ancestorCheck = await assertNoSymlinkAncestor(filePath, currentDataRoot());
  if (!ancestorCheck.ok) {
    return { ok: false, error: ancestorCheck.error, code: ancestorCheck.code, message: ancestorCheck.message };
  }
  try {
    // audit fix (Round 17 H2)：stat / readFile 走 withTimeout —— SMB / OneDrive
    // 挂死时 renderer 不会无 loading 一直等；超时错误带 FS_TIMEOUT 透传到
    // renderer 走「磁盘暂时不可用」文案。
    const st = await withTimeout(fs.stat(filePath), undefined, 'file:read.stat');
    if (!st.isFile()) {
      return { ok: false, error: 'NOT_A_FILE', code: 'NOT_A_FILE', message: '不是普通文件' };
    }
    if (st.size > MAX_FILE_SIZE) {
      return {
        ok: false,
        error: 'FILE_TOO_LARGE',
        code: 'FILE_TOO_LARGE',
        message: `文件过大（${(st.size / 1024 / 1024).toFixed(1)} MB），已超过 ${(MAX_FILE_SIZE / 1024 / 1024).toFixed(0)} MB 上限`
      };
    }
    const content = await withTimeout(fs.readFile(filePath, 'utf-8'), undefined, 'file:read.read');
    // audit fix (Phase L3-FS 2A)：去掉 UTF-8 BOM（Notepad 等 Windows 工具会带
    // 字节序标记存 UTF-8）。BOM 在第一行 heading 之前渲染成零宽字符，会让
    // 文内锚点的 slug 偏移 / 复制粘贴时污染 / DOMPurify 把它当成不可见字符
    // 吞掉前的不一致。原子写会原样写回字节（BOM 是三字节 0xEFBBBF），
    // 这里 strip 后 save 也是无 BOM，写盘时已经清掉。
    let stripped = content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
    // audit fix (Phase L3-FS 1A)：detect binary content misnamed as .md。
    // fs.readFile(..., 'utf-8') 把无效字节替换成 U+FFFD（�）。JPEG/PNG/ZIP 等
    // 二进制文件被外部改名成 .md 时直接命中 EDITABLE_EXTS 走 readFile，
    // 用户编辑保存 → atomicWriteFile 把污染后的 U+FFFD 字符串写回，原二进制
    // 内容永久丢失。简单阈值：前 4 KB 内 U+FFFD 占比 > 1% → 当作二进制拒绝。
    // （正常 UTF-8 文本几乎不会有 U+FFFD；CJK 偶发坏字符也不至于达到 1%。）
    if (stripped.length > 0) {
      const probeLen = Math.min(stripped.length, 4096);
      let replacements = 0;
      for (let i = 0; i < probeLen; i += 1) {
        if (stripped.charCodeAt(i) === 0xFFFD) replacements += 1;
      }
      if (replacements / probeLen > 0.01) {
        return {
          ok: false,
          error: 'NOT_TEXT',
          code: 'NOT_TEXT',
          message: '该文件不是有效的 UTF-8 文本（疑似二进制），无法编辑',
        };
      }
    }
    return { ok: true, content: stripped, mtimeMs: st.mtimeMs, size: st.size };
  } catch (e) {
    if (e.code === 'ENOENT') {
      return { ok: false, error: 'FILE_NOT_FOUND', code: 'ENOENT', message: '文件已被删除' };
    }
    // audit fix (K1-M2)：message 之前直回 e.message（英文 errno + 完整路径），
    // 跟 file:write 的 renderer friendlyWriteError 不一致 —— renderer 一律走
    // 「未知错误」分支。按 errno 翻译。
    console.error('[main] 读取文件失败:', _redactPath(filePath), e.code || e.message);
    return {
      ok: false,
      error: e.code || 'READ_FAILED',
      code: e.code,
      message: _friendlyReadError(e),
    };
  }
});

/**
 * file:write —— 新增 expectedMtimeMs 校验（audit #2）
 *
 * renderer 传入 expectedMtimeMs（state.lastSavedMtimeMs）时，主进程先
 * 读当前磁盘 mtime，不一致则拒绝写入并返回 FILE_CHANGED_EXTERNALLY。
 * 这样可以挡住「外部编辑器刚刚修改 → fs:changed 还没投到 renderer → 用户 Ctrl+S
 * 静默覆盖外部修改」的竞态。
 *
 * 不传 expectedMtimeMs（老调用 / 强写场景）则跳过校验。
 */
ipcMain.handle('file:write', async (_event, filePath, content, expectedMtimeMs = null) => {
  if (typeof filePath !== 'string' || !filePath) {
    // audit fix (Round 7 IPC-3)：补齐 code + message，对齐其它 file:* handler 的
    // 字段集。renderer 一律 `result.code / result.message` 取值，没这两个字段
    // 会兜底走 result.error 英文原文 + 文案漂移。
    return {
      ok: false,
      error: 'INVALID_PATH',
      code: 'INVALID_PATH',
      message: '路径必须是字符串',
    };
  }
  if (typeof content !== 'string') {
    return {
      ok: false,
      error: 'INVALID_CONTENT',
      code: 'INVALID_CONTENT',
      message: '内容必须是字符串',
    };
  }
  // 写入大小限制：与 file:read 对齐（MAX_FILE_SIZE），避免恶意 / bug 写入巨型文件导致下次读不出
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_SIZE) {
    return {
      ok: false,
      error: 'FILE_TOO_LARGE',
      code: 'FILE_TOO_LARGE',
      message: `文件超过 ${MAX_FILE_SIZE} 字节上限`,
    };
  }
  // 路径必须在当前数据目录下（防御性：防止 renderer 越权写入）
  if (!isWithinDataDir(filePath, currentDataRoot())) {
    return { ok: false, error: 'PATH_NOT_ALLOWED', code: 'PATH_NOT_ALLOWED', message: '路径不在数据目录内' };
  }
  // symlink 防护（audit #7）：写入 symlink 会跟随到外部文件，绕过 isWithinDataDir
  const linkCheck = await assertNotSymlink(filePath);
  if (!linkCheck.ok) {
    return { ok: false, error: linkCheck.error, code: linkCheck.code, message: linkCheck.message };
  }
  // audit fix (M1)：symlink 祖先链防护 —— 父目录是 symlink 时，target 的
  // 真实路径会跳出 dataDir。光检查 target 文件不够。
  const ancestorCheck = await assertNoSymlinkAncestor(filePath, currentDataRoot());
  if (!ancestorCheck.ok) {
    return { ok: false, error: ancestorCheck.error, code: ancestorCheck.code, message: ancestorCheck.message };
  }
  if (linkCheck.isFile === false) {
    // audit fix (M2)：assertNotSymlink 不区分「目录」与「不存在」，与 file:rename 对齐：
    // 命中目录 → NOT_A_FILE，让 renderer 给出「该路径是文件夹」的中文提示；命中不存在 → FILE_NOT_FOUND。
    // 否则 fs.writeFile 在目录上会抛 EISDIR 但被 catch 转成通用 WRITE_FAILED，用户只看到 errno。
    let st;
    try {
      st = await fs.stat(filePath);
    } catch {
      st = null;
    }
    if (st && st.isDirectory()) {
      return { ok: false, error: 'NOT_A_FILE', code: 'NOT_A_FILE', message: '该路径是文件夹，不能写入' };
    }
    return { ok: false, error: 'FILE_NOT_FOUND', code: 'FILE_NOT_FOUND', message: '文件已被删除' };
  }
  try {
    // mtime 校验（audit #2）
    if (Number.isFinite(expectedMtimeMs)) {
      // audit fix (Round 17 H2)：stat 走 withTimeout —— 挂死磁盘不挡 IPC 响应。
      const stNow = await withTimeout(fs.stat(filePath), undefined, 'file:write.mtimeCheck');
      // Math.floor 兼容 sub-ms 浮点误差
      if (Math.floor(stNow.mtimeMs) !== Math.floor(expectedMtimeMs)) {
        return {
          ok: false,
          error: 'FILE_CHANGED_EXTERNALLY',
          code: 'FILE_CHANGED_EXTERNALLY',
          mtimeMs: stNow.mtimeMs,
          size: stNow.size,
          message: '文件在外部被修改，请重新加载或选择强制覆盖',
        };
      }
    }
    // audit fix (C1 file-IO)：原子写（tmp + fsync + rename），防止进程在
    // writeFile 中途崩溃导致文件内容半截（用户丢失全部编辑）。
    // audit fix (Round 17 H2)：原子写整体包裹 —— renameWithRetry 的总耗时
    // （fs.open + writeFile + sync + rename + 父目录 sync）在 SMB 上可能
    // 超 30s 时基本就是磁盘掉了。
    await withTimeout(
      fileOps.atomicWriteFile(filePath, content),
      undefined,
      'file:write.atomic',
    );
    const st = await withTimeout(fs.stat(filePath), undefined, 'file:write.stat');
    // audit fix (Round 16 M1)：self-write filter —— 慢盘（SMB / OneDrive）下
    // atomicWriteFile 触发 fs.watch 事件的时刻可能早于本 IPC 响应回到 renderer，
    // renderer 没拿到 mtimeMs 就收 files:changed → 误判外部修改 → 弹 reload
    // 对话框。告诉 fsWatcher 「这个文件接下来 500ms 内的变更是我自己」，让
    // dirWatcher 跳过对应 emit。
    if (fsWatcher && typeof fsWatcher.markExpectedWrite === 'function') {
      try { fsWatcher.markExpectedWrite(filePath, st.mtimeMs); }
      catch (e) { console.warn('[main] markExpectedWrite 失败:', e?.message); }
    }
    return { ok: true, mtimeMs: st.mtimeMs, size: st.size };
  } catch (e) {
    if (e.code === 'ENOENT') {
      return { ok: false, error: 'FILE_NOT_FOUND', code: 'ENOENT', message: '文件已被删除' };
    }
    // P1-7：权限 / 只读 / 磁盘满 / 文件被占用 → 把原始 code 透出，renderer 才能给中文提示
    //
    // audit fix (Phase N Q-fix)：message 字段从 e.message（含英文 errno + 完整
    // 路径，可能泄露）改为 fileOps.friendlyWriteError(e) 翻译成中文，与 _friendlyCreateError
    // / _friendlyRenameError / _friendlyDeleteError / _friendlyReadError 对齐。
    // helper 放在 main/file-ops.js（不是本文件）方便单测 —— main.js 加载 Electron
    // app 实例副作用重，没法在 vitest 里 require。
    console.error('[main] 写入文件失败:', _redactPath(filePath), e.message);
    return {
      ok: false,
      error: e.code || 'WRITE_FAILED',
      code: e.code,
      message: fileOps.friendlyWriteError(e),
    };
  }
});

ipcMain.handle('file:create', async (_event, rawName, opts) => {
  if (typeof rawName !== 'string') {
    return { ok: false, error: 'INVALID_NAME', code: 'INVALID_NAME', message: '文件名必须是字符串' };
  }
  const dataRoot = currentDataRoot();
  if (!dataRoot) return { ok: false, error: 'DATA_DIR_UNAVAILABLE', code: 'DATA_DIR_UNAVAILABLE', message: '数据目录不可用' };

  // Stage 8：file:create 扩展签名以支持子目录。
  // 向后兼容旧调用：(name, initialContentString) —— 旧 IPC 把 initialContent 当字符串。
  // 新调用：(name, { dir?, initialContent? })。
  let targetDir = dataRoot;
  let initialContent = '';
  if (typeof opts === 'string') {
    initialContent = opts;
  } else if (opts && typeof opts === 'object') {
    if (typeof opts.initialContent === 'string') initialContent = opts.initialContent;
    if (typeof opts.dir === 'string' && opts.dir) {
      // dir 必须是 dataRoot 下的绝对路径或根
      if (!isWithinDataDir(opts.dir, dataRoot)) {
        return { ok: false, error: 'PATH_NOT_ALLOWED', code: 'PATH_NOT_ALLOWED', message: '目标目录不在数据目录内' };
      }
      targetDir = opts.dir;
    }
  }

  // audit fix：与 file:write 对齐写入大小上限（**在 mkdir 之前**）。
  // 之前 file:create 漏掉 MAX_FILE_SIZE 检查，导致 initialContent 可塞任意大字符串
  // （粘贴一篇 100MB 小说）→ 下次 file:read 直接返回 FILE_TOO_LARGE，应用被自己
  // 写入的文件锁死、删都删不掉（rename/delete 也可能受影响）。在这里预先拒绝。
  // 放在 mkdir 之前：超大 initialContent 没必要先在磁盘上建空目录再拒绝，浪费 IO。
  if (Buffer.byteLength(initialContent, 'utf8') > MAX_FILE_SIZE) {
    return {
      ok: false,
      error: 'FILE_TOO_LARGE',
      code: 'FILE_TOO_LARGE',
      message: `初始内容超过 ${MAX_FILE_SIZE} 字节上限`,
    };
  }

  // 子目录可能不存在（用户首次进入空子目录并新建文件）→ 自动创建。
  // 这是有意的：用户在 UI 上明确选择了"在该目录下新建"，自动 mkdir 是合理语义。
  //
  // audit fix (Phase O-H3)：祖先链 symlink 检查必须在 mkdir 之前。
  // 之前只 lstat(targetDir) 自己：targetDir 不存在时 ENOENT 跳过；然后
  // mkdir(targetDir, {recursive:true}) 会跟随 symlink 在外部目标盘上真实创建
  // 子目录，副作用先发生；之后 line 1307 的 assertNoSymlinkAncestor(r.path)
  // 才拒绝 atomicWriteFile —— 用户没创建文件但外部目标盘上多了空目录。
  // assertNoSymlinkAncestor 覆盖 targetDir 自身 + 全部祖先，等价且更严格。
  if (targetDir !== dataRoot) {
    const ancestorCheck = await assertNoSymlinkAncestor(targetDir, dataRoot);
    if (!ancestorCheck.ok) {
      return { ok: false, error: ancestorCheck.error, code: ancestorCheck.code, message: ancestorCheck.message };
    }
  }
  try {
    await fs.mkdir(targetDir, { recursive: true });
  } catch (e) {
    // audit fix (K1-H2)：mkdir 失败之前直回 e.message（英文 + 含完整路径），
    // 与上面 atomicWrite 的 _friendlyCreateError 不对称；renderer 一律走
    // 「未知错误」分支。按 errno 翻译：EACCES/EPERM = 没权限，
    // ENOSPC = 磁盘满，EROFS = 只读，ENOENT = 路径里有不存在组件。
    console.error('[main] file:create mkdir 失败:', _redactPath(targetDir), e.code || e.message);
    return {
      ok: false,
      error: e.code || 'MKDIR_FAILED',
      code: e.code,
      message: _friendlyCreateError(e, '所在目录'),
    };
  }

  // audit fix (2026-09-21)：标记是否新建了子目录，用于失败路径下清理空目录。
  // 之前 mkdir 成功后任何下游失败（resolveFileName / isWithinDataDir / symlink
  // 防护 / atomicWriteFile）都会留下 targetDir 这个空子目录 —— 数据目录里
  // 出现不可见的垃圾文件夹，下次扫描会列入文件列表。targetDir === dataRoot
  // 时不需要清理（root 早就在）。
  const didMkdirSubdir = targetDir !== dataRoot;
  // best-effort 清理函数：仅当目录为空时移除（已含文件的不动，避免误删）。
  async function cleanupEmptySubdir() {
    if (!didMkdirSubdir) return;
    try {
      const entries = await fs.readdir(targetDir);
      if (entries.length === 0) {
        await fs.rmdir(targetDir);
      }
    } catch (cleanupErr) {
      // 清理本身失败不抛 —— 让原始错误的响应路径主导。
      console.warn('[main] file:create 清理空子目录失败:', _redactPath(targetDir), cleanupErr.code || cleanupErr.message);
    }
  }

  // 把 mkdir 之后的所有失败路径统一收到一个 catch 里，方便清理逻辑只写一份。
  // 早期错误（resolveFileName / isWithinDataDir / symlink 防护）抛带 _early
  // 标记的结构化对象；atomicWriteFile 抛原始 Error。catch 里按标记分流。
  let resolvedName = null;
  try {
    const r = await resolveFileName(rawName, targetDir);
    // audit fix (Round 7 IPC-2)：补齐 code + message 字段，与其它 file:* handler
    // 对齐。resolveFileName 返回的 r.error 已经是中文明文消息（"文件名不能为空"
    // / "文件名包含 Windows 保留字符" 等），把它同时塞 message 让 renderer 走
    // friendlyFsError(code, message) 时不再兜底到 result.error 字符串。
    if (!r.ok) {
      throw Object.assign(new Error(r.error), { _early: { error: 'INVALID_NAME', code: 'INVALID_NAME', message: r.error } });
    }

    // audit fix (1.1)：与其他 file:* handler 对称地做 isWithinDataDir 防御 + symlink 防护。
    // 理论上是新文件不会有 symlink，但 resolveFileName 已过滤路径分隔符 / '..'，
    // 这层只为了与 read/write/rename/delete 保持对称，且挡住未来可能的边界输入。
    if (!isWithinDataDir(r.path, dataRoot)) {
      throw Object.assign(new Error('路径不在数据目录内'), { _early: { error: 'PATH_NOT_ALLOWED', code: 'PATH_NOT_ALLOWED', message: '路径不在数据目录内' } });
    }
    const linkCheck = await assertNotSymlink(r.path);
    if (!linkCheck.ok) {
      throw Object.assign(new Error(linkCheck.message || 'symlink 防护拒绝'), { _early: linkCheck });
    }

    // audit fix：与 file:read/write/rename/delete 对称做 assertNoSymlinkAncestor。
    // file:create 的 targetDir 上面只 lstat 了自己（如果非根），但 r.path 落在某个
    // 中间是 symlink 的目录下时（如 dataRoot/links/sub/foo.md，其中 links 是
    // 指向外部的 symlink），atomicWriteFile 会跟随 symlink 把文件写到外部，
    // 绕过 isWithinDataDir 的字符串前缀边界。assertNotSymlink 只判 r.path 本身
    // （不存在 → 放过），挡不住中间路径是 symlink 的场景。
    const ancestorCheck = await assertNoSymlinkAncestor(r.path, dataRoot);
    if (!ancestorCheck.ok) {
      throw Object.assign(new Error(ancestorCheck.message || '祖先链 symlink 防护拒绝'), { _early: ancestorCheck });
    }

    // 初始内容默认为 `# 标题\n\n` —— 哪怕空字符串也保证文件可读
    // 2026-08-28 反馈：resolveFileName 不再强制补 .md，所以这里按最后一个 .
    // 剥除任意扩展名（foo.md → foo；foo.txt → foo；无扩展名 → 原样）。
    const baseForTitle = r.name.replace(/\.[^./\\]+$/, '');
    const content = typeof initialContent === 'string' && initialContent.length > 0
      ? initialContent
      : `# ${baseForTitle}\n\n`;
    // audit fix (C2 file-IO)：原子写，与 file:write 对齐。
    // 即便 create 失败也不该留半截文件——磁盘要么没这个文件，要么是完整的。
    // audit fix (Round 17 H2)：包裹 withTimeout —— 与 file:write 同源。
    await withTimeout(
      fileOps.atomicWriteFile(r.path, content),
      undefined,
      'file:create.atomic',
    );
    resolvedName = r.name;
    const st = await withTimeout(fs.stat(r.path), undefined, 'file:create.stat');
    // audit fix (Round 16 M1)：self-write filter —— 与 file:write 同源（见
    // 上方 file:write 的注释）。新建文件的 fs.watch 事件同样会在 IPC 响应
    // 之前到达 renderer，导致侧栏触发不必要的重渲染 / 「文件已存在」误判。
    if (fsWatcher && typeof fsWatcher.markExpectedWrite === 'function') {
      try { fsWatcher.markExpectedWrite(r.path, st.mtimeMs); }
      catch (e) { console.warn('[main] markExpectedWrite 失败:', e?.message); }
    }
    return { ok: true, path: r.path, name: r.name, mtimeMs: st.mtimeMs, size: st.size };
  } catch (e) {
    // 失败路径：先清理可能新建的空子目录，再按错误类型返回响应。
    await cleanupEmptySubdir();
    if (e && e._early) {
      // 早期错误（resolveFileName / isWithinDataDir / symlink 防护）：直接透传结构化字段。
      return { ok: false, error: e._early.error, code: e._early.code, message: e._early.message };
    }
    // atomicWriteFile 错误：按 errno 翻译成中文提示，路径走 _redactPath 防泄露到 tmp 日志。
    console.error('[main] file:create 失败:', _redactPath(targetDir + '/' + rawName), e.code || e.message);
    return {
      ok: false,
      error: e.code || 'CREATE_FAILED',
      code: e.code,
      message: _friendlyCreateError(e, resolvedName || rawName),
    };
  }
});

/**
 * file:rename —— 修复两点（audit #4 + audit #12 + audit #7）：
 *   - 返回 mtimeMs / size 让 renderer 立刻同步侧边栏与状态栏
 *   - Windows 上大小写不敏感比对（path.resolve 保留原大小写）
 *   - symlink 防护：拒绝重命名 symlink
 */
ipcMain.handle('file:rename', async (_event, oldPath, newName) => {
  if (typeof oldPath !== 'string' || typeof newName !== 'string') {
    return { ok: false, error: 'INVALID_ARGS', code: 'INVALID_ARGS', message: '参数类型不合法' };
  }
  const dir = currentDataRoot();
  if (!isWithinDataDir(oldPath, dir)) {
    return { ok: false, error: 'PATH_NOT_ALLOWED', code: 'PATH_NOT_ALLOWED', message: '原路径不在数据目录内' };
  }
  // symlink 防护（audit #7）
  const linkCheck = await assertNotSymlink(oldPath);
  if (!linkCheck.ok) {
    return { ok: false, error: linkCheck.error, code: linkCheck.code, message: linkCheck.message };
  }
  // audit fix (M4 main)：拒绝目录 —— file:rename 契约是「重命名文件」。
  // assertNotSymlink 在 isFile=false 时不区分「目录」与「不存在」，调用方
  // 以前会把目录也当作文件 rename 进去（POSIX 上 fs.rename 真能把目录改名），
  // 与 file:create / file:delete 的 file-only 契约不一致。把目录提前拒掉，
  // 让 Folder Browser 用专门的 folder:rename 路径（见后）。
  if (linkCheck.isFile === false) {
    let st;
    try {
      st = await fs.stat(oldPath);
    } catch {
      st = null;
    }
    if (st && st.isDirectory()) {
      return { ok: false, error: 'NOT_A_FILE', code: 'NOT_A_FILE', message: '该路径是文件夹，请使用文件夹重命名' };
    }
    return { ok: false, error: 'FILE_NOT_FOUND', code: 'FILE_NOT_FOUND', message: '文件已被删除' };
  }
  // audit fix (M1)：原路径父目录链上的 symlink 也要拒 —— 否则 rename 会
  // 跟随到 dataDir 外。
  const oldAncestorCheck = await assertNoSymlinkAncestor(oldPath, dir);
  if (!oldAncestorCheck.ok) {
    return { ok: false, error: oldAncestorCheck.error, code: oldAncestorCheck.code, message: oldAncestorCheck.message };
  }

  // 解析新文件名（重命名专用：不强制 .md 后缀，用户输入什么就用什么 —— 见 [[project-no-auto-md-on-rename-2026-08]]；
  //   仍做路径分隔符 / Windows 保留字符 / 控制字符 / 重名避让校验）。
  const r = await resolveRenameName(newName, dir);
  // audit fix (Round 7 IPC-3)：补齐 message 字段，并保证 code 一定存在。
  // 旧版直接 `code: r.code`，但 resolveRenameName 历史上不返回 code 字段
  // （参见 main/file-ops.js#resolveRenameName：返回 `{ ok:false, error }`），
  // 导致 code=undefined → renderer 兜底走 result.error 文案语言漂移。
  // 这里给所有失败分支兜底 code='INVALID_NAME'（rename 路径专属）。
  if (!r.ok) {
    return {
      ok: false,
      error: 'INVALID_NAME',
      code: 'INVALID_NAME',
      message: r.error,
    };
  }

  // audit 防御性修复：resolveFileName 内部已 access 失败才返回 r.path，
  // 但 resolve 与 rename 之间存在 TOCTOU 窗口（本地攻击者 / 并发进程可能
  // 在 r.path 位置抢先放一个 symlink，fs.rename 在 POSIX 上会跟随 symlink
  // 重命名到外部目标）。在 rename 前再 lstat 一次，命中 symlink 就拒。
  // 若中间有进程在该位置放了普通文件，fs.rename 会自己撞 EEXIST。
  const targetLinkCheck = await assertNotSymlink(r.path);
  if (!targetLinkCheck.ok) {
    return { ok: false, error: targetLinkCheck.error, code: targetLinkCheck.code, message: targetLinkCheck.message };
  }
  // audit fix (M1)：新路径的父目录链同样要无 symlink。
  const newAncestorCheck = await assertNoSymlinkAncestor(r.path, dir);
  if (!newAncestorCheck.ok) {
    return { ok: false, error: newAncestorCheck.error, code: newAncestorCheck.code, message: newAncestorCheck.message };
  }

  // 新路径不能等于原路径（Windows 上大小写不敏感比对，audit #12）
  const oldResolved = path.resolve(oldPath);
  const newResolved = path.resolve(r.path);
  const isSamePath = process.platform === 'win32'
    ? oldResolved.toLowerCase() === newResolved.toLowerCase()
    : oldResolved === newResolved;
  if (isSamePath) {
    // 同名 short-circuit 时拿真实 mtime/size（状态栏需要）。
    // 若 stat 失败（权限 / 瞬时错误），不要用 0 值污染调用方 —— 状态栏会显示
    // 1970-01-01 让用户怀疑数据丢失。直接返回错误，让 UI 不被 0 值污染。
    let st;
    try {
      st = await fs.stat(oldPath);
    } catch (e) {
      return {
        ok: false,
        error: e.code || 'STAT_FAILED',
        code: e.code,
        message: '读取文件状态失败',
      };
    }
    return {
      ok: true,
      path: r.path,
      name: r.name,
      unchanged: true,
      mtimeMs: st.mtimeMs,
      size: st.size,
    };
  }
  try {
    // audit fix (Round 17 H2)：rename 走 withTimeout —— SMB / OneDrive 持锁时
    // rename 可能挂死数分钟；超时透传 FS_TIMEOUT 让 renderer 弹友好提示。
    await withTimeout(fs.rename(oldPath, r.path), undefined, 'file:rename.rename');
    // 重新 stat 拿到新 mtime/size（audit #4：之前漏掉，renderer 状态栏会短暂无日期）
    const st = await withTimeout(fs.stat(r.path), undefined, 'file:rename.stat');
    // audit fix (Round 16 M1)：self-write filter —— rename 触发 fs.watch 两个
    // 事件（oldPath 消失 + r.path 出现）。只要新路径上 500ms 内是 self-write 就
    // 拦住后续 emit，避免 renderer 把「自己刚重命名」当成外部修改触发侧栏闪烁。
    if (fsWatcher && typeof fsWatcher.markExpectedWrite === 'function') {
      try { fsWatcher.markExpectedWrite(r.path, st.mtimeMs); }
      catch (e) { console.warn('[main] markExpectedWrite 失败:', e?.message); }
    }
    return { ok: true, path: r.path, name: r.name, mtimeMs: st.mtimeMs, size: st.size };
  } catch (e) {
    // audit fix (K1-H1)：console 走 _redactPath（之前 e.message 直接打到日志，
    // 含完整旧路径，tmp 日志 / heap snapshot 里泄漏）；message 走 _friendlyRenameError
    // 翻译成中文，不让英文 errno + 完整路径直接回到 renderer。
    console.error('[main] file:rename 失败:', _redactPath(oldPath), '→', _redactPath(r.path), e.code || e.message);
    return {
      ok: false,
      error: e.code || 'RENAME_FAILED',
      code: e.code,
      message: _friendlyRenameError(e, r.name),
    };
  }
});

/**
 * file:delete —— 修复一点（audit #7）：
 *   - symlink 防护：拒绝删除 symlink（避免 trashItem 跟随到外部真实文件）
 *   - Stage 8：支持删除文件夹（Folder Browser）。空判断逻辑：
 *     `assertNotSymlink` 返回 isFile:false 可能是「目录」或「不存在」；
 *     用 stat 二次判定，存在但不是文件 → 当作目录走 trashItem。
 */
ipcMain.handle('file:delete', async (_event, filePath) => {
  if (typeof filePath !== 'string' || !filePath) {
    return { ok: false, error: 'INVALID_PATH', code: 'INVALID_PATH', message: '路径必须是字符串' };
  }
  if (!isWithinDataDir(filePath, currentDataRoot())) {
    return { ok: false, error: 'PATH_NOT_ALLOWED', code: 'PATH_NOT_ALLOWED', message: '路径不在数据目录内' };
  }
  // symlink 防护（audit #7）
  const linkCheck = await assertNotSymlink(filePath);
  if (!linkCheck.ok) {
    return { ok: false, error: linkCheck.error, code: linkCheck.code, message: linkCheck.message };
  }
  // audit fix (M1)：祖先链 symlink 防护 —— 父目录是 symlink 时 trashItem
  // 会跟随到外部真实文件，造成越权删除。
  const ancestorCheck = await assertNoSymlinkAncestor(filePath, currentDataRoot());
  if (!ancestorCheck.ok) {
    return { ok: false, error: ancestorCheck.error, code: ancestorCheck.code, message: ancestorCheck.message };
  }
  // isFile=false 时再 stat 一次区分「目录」与「不存在」；
  // 目录走 trashItem（macOS/Windows 原生支持），ENOENT 报 FILE_NOT_FOUND。
  if (linkCheck.isFile === false) {
    let st;
    try {
      st = await fs.stat(filePath);
    } catch (e) {
      if (e.code === 'ENOENT') {
        return { ok: false, error: 'FILE_NOT_FOUND', code: 'ENOENT', message: '路径已不存在' };
      }
      // audit fix (K1-R4)：与其它 handler 对齐 code/message 形状，不再直回 e.message。
      return { ok: false, error: e.code || 'STAT_FAILED', code: e.code, message: _friendlyShellError(e, '读取状态失败') };
    }
    if (!st.isDirectory()) {
      return { ok: false, error: 'NOT_A_FILE_OR_DIR', code: 'NOT_A_FILE_OR_DIR', message: '该路径既不是文件也不是目录' };
    }
    // 走系统回收站 —— 目录也行；失败兜底 fs.rmdir 删空目录
    try {
      await shell.trashItem(filePath);
      return { ok: true, path: filePath, recycled: true, isFolder: true };
    } catch (e) {
      console.warn('[main] trashItem(目录) 失败，降级到 rmdir:', e.message);
      try {
        await fs.rmdir(filePath);
        return { ok: true, path: filePath, recycled: false, isFolder: true };
      } catch (e2) {
        // 不拼 e2.message（英文 errno + 路径）—— 其它 file:* handler 都用纯中文 message
        return {
          ok: false,
          error: e2.code || 'DELETE_DIR_FAILED',
          code: e2.code,
          message: '删除目录失败（可能非空）',
        };
      }
    }
  }
  // 文件路径：走系统回收站，失败时**不再静默 unlink**。
// 旧版「trashItem 失败 → fallback unlink」在以下场景会让用户永久失去文件：
//   - 回收站被禁用 / 满（Linux + 部分 Windows 配置）
//   - trashItem 因权限 / EBUSY 失败
//   - 文件在外部存储 / 网络盘等 trash 不可达的位置
// 现在：trashItem 失败时直接报错，让 UI 提示用户（而不是悄悄 unlink 把文件抹掉）。
try {
  // audit fix (Round 17 H2)：trashItem 也走 withTimeout —— 网络盘 trash 不可达时
  // Electron 内部可能挂死（直到 trash 处理超时才会 reject）。30s 强制让
  // renderer 拿到结果。
  await withTimeout(shell.trashItem(filePath), undefined, 'file:delete.trash');
  return { ok: true, path: filePath, recycled: true };
} catch (e) {
  // audit fix (K1-L2)：之前 message 拼 e.message（英文 errno + 路径）回到 renderer
  // —— 漏完整路径到 UI。其他 file:* handler 都用纯中文 message，这里对齐。
  // 按 errno 翻译：EACCES/EPERM = 没权限、EBUSY = 文件被占、ENOENT = 已不在。
  console.warn('[main] shell.trashItem 失败，不降级 unlink:', _redactPath(filePath), e.code || e.message);
  return {
    ok: false,
    error: 'TRASH_FAILED',
    code: e.code || 'TRASH_FAILED',
    message: _friendlyDeleteError(e),
  };
}
});

// ============================================
//  IPC: 应用信息
// ============================================

ipcMain.handle('app:get-data-dir', () => currentDataRoot());
ipcMain.handle('app:get-default-data-dir', () => configStore.getDefaultDataDir());
ipcMain.handle('app:get-version', () => app.getVersion());

ipcMain.handle('app:open-data-dir', async () => {
  let dir;
  try {
    dir = path.resolve(currentDataRoot());
    const st = await fs.stat(dir);
    if (!st.isDirectory()) {
      return { ok: false, error: 'NOT_A_DIRECTORY', code: 'NOT_A_DIRECTORY', message: '数据路径不是一个目录' };
    }
  } catch (e) {
    // audit fix (K1-M1)：补齐 ok / code / message 字段，与其它 handler 形状一致；
    // message 不再拼 e.message（英文 errno + 路径）。
    console.warn('[main] app:open-data-dir stat 失败:', _redactPath(dir), e.code || e.message);
    return {
      ok: false,
      error: e.code || 'STAT_FAILED',
      code: e.code,
      message: '无法访问数据目录',
    };
  }
  try {
    // audit fix (K1-M5)：shell.openPath 返回 Promise，未 await 时空字符串 = 失败
    // 会被静默吞掉，调用方以为「打开成功」实际啥都没发生。await 后检查空串。
    const failure = await shell.openPath(dir);
    if (failure) {
      // shell.openPath 失败时返回错误消息字符串（不是抛错）
      console.warn('[main] shell.openPath 返回失败:', failure);
      return {
        ok: false,
        error: 'OPEN_FAILED',
        code: 'OPEN_FAILED',
        message: `无法打开数据目录：${failure}`,
      };
    }
    return { ok: true, path: dir };
  } catch (e) {
    console.warn('[main] shell.openPath 抛错:', _redactPath(dir), e.message);
    return {
      ok: false,
      error: e.code || 'OPEN_FAILED',
      code: e.code,
      message: '无法打开数据目录',
    };
  }
});

// 仅打开路径，不修改持久化设置（用于设置对话框的"打开"预览按钮）
//
// 安全：renderer 不能传任意路径触发 shell.openPath（即使只是打开文件管理器，
// 也是无谓的权限暴露）。这里强制 target 必须是当前数据目录（settings-dialog.js
// 也只拿 _configDir 来调用）。路径比对走 path.resolve + 大小写规整化
// （Windows 不区分大小写、POSIX 区分），避免通过 '..' / 大小写绕过。
ipcMain.handle('app:open-path', async (_event, target) => {
  if (typeof target !== 'string' || !target) {
    // audit fix (Round 8 IPC-5)：补齐 message 字段，与 file:read / file:write /
    // shell:open-dir 等 handler 对齐。renderer 走 `result.message || result.error
    // || '未知错误'` 兜底，没 message 会拿到英文业务码。
    return {
      ok: false,
      error: 'INVALID_PATH',
      code: 'INVALID_PATH',
      message: '路径必须是字符串',
    };
  }
  // path 已在文件顶部 require，这里不再重复（避免阅读时被遮蔽误以为是局部变量）
  // 走 currentDataRoot 而不是 resolveDataDir：customDir 失效时回退到默认，
  // 让预览按钮跟用户实际在用的目录一致（与 fallback 语义对齐）。
  const dataDir = currentDataRoot();
  const resolvedTarget = path.resolve(target);
  const resolvedData = path.resolve(dataDir);
  const samePath = process.platform === 'win32'
    ? resolvedTarget.toLowerCase() === resolvedData.toLowerCase()
    : resolvedTarget === resolvedData;
  if (!samePath) {
    return { ok: false, error: 'PATH_NOT_ALLOWED', code: 'PATH_NOT_ALLOWED', message: '仅允许打开当前数据目录' };
  }
  try {
    const st = await fs.stat(resolvedTarget);
    if (!st.isDirectory()) {
      // audit fix (K1-R4)：error 改用 NOT_A_DIRECTORY 业务码（与 shell:open-dir 对齐），
      // 之前用中文 '不是一个目录' 与全文件英文 error 风格不一致。
      return { ok: false, error: 'NOT_A_DIRECTORY', code: 'NOT_A_DIRECTORY', message: '不是一个目录' };
    }
    await shell.openPath(resolvedTarget);
    return { ok: true, path: resolvedTarget };
  } catch (e) {
    // audit fix (K1-R4)：走 _friendlyShellError 翻译 errno，不再直回 e.message。
    return { ok: false, error: e.code || 'OPEN_FAILED', code: e.code, message: _friendlyShellError(e, '无法打开数据目录') };
  }
});

ipcMain.handle('app:choose-data-dir', async () => {
  // audit fix (H5)：补 isDestroyed() —— !mainWindow 只能挡 null/undefined，
  // 异步窗口销毁的窗口期（mainWindow 引用还在但 isDestroyed===true）会进
  // showOpenDialog 抛错。X 紧接菜单点「选择数据目录」的场景能复现。
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择数据文件夹',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: '选择此文件夹',
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

/**
 * app:reset-data-dir —— 「回到默认」按钮的 IPC（auto-fallback 2026-08）：
 *   1) saveConfig({ dataDir: '' }) 把 custom 持久化值清空，下次启动也走默认
 *   2) 重启 fsWatcher（监听目标从缺失的旧路径切到默认）
 *   3) 刷新托盘菜单（托盘「打开数据文件夹」缓存了旧路径）
 *   4) 返回 { dir, defaultDir } 让 renderer 弹 toast
 *
 * 与 runtime fallback 的区别：runtime fallback 只在内存里走默认，config.json 里
 * 的 dataDir 不动 —— U 盘插回下次启动还能用回去；这里走 saveConfig 是「永久放弃
 * custom 路径」的语义。auto-fallback 已尽量减少用户误触发，这里只对应用户主动点
 * 「回到默认」按钮的明确指令。
 */
ipcMain.handle('app:reset-data-dir', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { ok: false, error: 'NO_WINDOW' };
  }
  try {
    const saveResult = await configStore.saveConfig({ dataDir: '' });
    if (!saveResult.ok) {
      return { ok: false, error: saveResult.error || '配置保存失败' };
    }
    // 走 currentDataRoot 而不是 resolveDataDir —— 内部会 sync mkdir（默认目录可能
    // 从未被用过）+ 异步种子 README.md，让 fsWatcher 启动时不撞 ENOENT、侧栏里
    // 立刻有欢迎文档可见。
    const newDir = currentDataRoot();
    currentDataDir = newDir;
    // 等欢迎文档就绪再重启 fsWatcher，避免「fsWatcher 启动时拿到空目录、
    // 几秒后 README.md 突然冒出侧栏」的 UX 撕裂。
    await configStore.scheduleEnsureDefaultDataDir();
    // 重启目录监听：旧监听在缺失的 custom 路径上，新监听切到默认
    try {
      fsWatcher.startWatchingDir(newDir);
    } catch (e) {
      console.warn('[main] 重启目录监听失败（仅依赖轮询）:', e && e.message);
    }
    if (tray) {
      tray.setContextMenu(buildTrayMenu());
    }
    return {
      ok: true,
      dir: newDir,
      defaultDir: configStore.getDefaultDataDir(),
    };
  } catch (e) {
    console.error('[main] app:reset-data-dir 失败:', e && (e.message || e));
    return { ok: false, error: e?.message || '未知错误' };
  }
});

// ============================================
//  IPC: shell.openExternal（链接点击跳转默认浏览器）
// ============================================
ipcMain.handle('shell:open-external', async (_event, url) => {
  // audit fix (Round 7 IPC-10)：改成 `{ ok, code, message }` envelope，与全文件
  // 其它 IPC handler 对齐。renderer 端 `if (!ok)` 无法区分「URL 不合法」/「shell
  // 调用失败」/「系统级错误」，统一走 envelope 让 toast 文案可针对原因。
  if (typeof url !== 'string' || !url) {
    return {
      ok: false,
      error: 'INVALID_URL',
      code: 'INVALID_URL',
      message: '链接必须是字符串',
    };
  }
  // 防御性：只允许 http(s) 和 mailto，避免被利用打开 file:// / 其他协议
  if (!/^(https?:\/\/|mailto:)/i.test(url)) {
    console.warn('[main] 拒绝打开非 http(s)/mailto URL:', url);
    return {
      ok: false,
      error: 'INVALID_URL',
      code: 'INVALID_URL',
      message: '只允许 http(s) / mailto 链接',
    };
  }
  // 进一步校验：scheme 后必须有合法主机部分。
  // 之前只校验前缀，会放过畸形 URL（如 'http:///etc/passwd' / 'http://\x00/foo' /
  // 'http:// host' 带空格）。new URL 在解析失败时抛错，刚好兜底。
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'mailto:') {
      console.warn('[main] 拒绝打开：协议不匹配', parsed.protocol, url);
      return {
        ok: false,
        error: 'INVALID_URL',
        code: 'INVALID_URL',
        message: '协议不被允许',
      };
    }
    // mailto 不要求 hostname；http/https 必须有非空 hostname
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && !parsed.hostname) {
      console.warn('[main] 拒绝打开：缺少 hostname', url);
      return {
        ok: false,
        error: 'INVALID_URL',
        code: 'INVALID_URL',
        message: '链接缺少主机名',
      };
    }
  } catch (e) {
    console.warn('[main] 拒绝打开：URL 解析失败', url, e.message);
    return {
      ok: false,
      error: 'INVALID_URL',
      code: 'INVALID_URL',
      message: '链接格式不合法',
    };
  }
  try {
    // 必须 await：openExternal 返回 Promise，不接住的话失败会变成
    // unhandledRejection，而渲染端还以为打开成功了
    await shell.openExternal(url);
    return { ok: true };
  } catch (e) {
    console.error('[main] openExternal 失败:', e.message);
    return {
      ok: false,
      error: e.code || 'OPEN_FAILED',
      code: e.code || 'OPEN_FAILED',
      message: '无法打开链接',
    };
  }
});

/**
 * 在系统文件管理器中显示文件（macOS = Reveal，Win/Linux = 选中文件）。
 *
 * 旧版走 `app:open-path` 但那个 IPC 要求 path 必须是目录，
 * 传文件会被拒绝（"不是一个目录"）。这里单独走 shell.showItemInFolder，
 * 是 Electron 提供的"显示文件"标准入口。
 */
ipcMain.handle('shell:show-item-in-folder', async (_event, fullPath) => {
  if (typeof fullPath !== 'string' || !fullPath) {
    // audit fix (Round 8 IPC-6)：补齐 message 字段，与 shell:open-dir / file:read
    // 等 handler 对齐。renderer friendlyFsError 兜底走 result.message，没 message
    // 会退到英文业务码。
    return {
      ok: false,
      error: 'INVALID_PATH',
      code: 'INVALID_PATH',
      message: '路径必须是字符串',
    };
  }
  // isWithinDataDir 需要数据目录作为第二参；不传则内部 root 为 undefined → 永远 false → 误拒
  if (!isWithinDataDir(fullPath, currentDataRoot())) {
    return { ok: false, error: 'PATH_NOT_ALLOWED', code: 'PATH_NOT_ALLOWED', message: '路径不在数据目录内' };
  }
  try {
    // audit fix (Main P1 / shell:show-item-in-folder symlink check)：
    // 之前 isWithinDataDir 只检「路径字面值是否在数据目录下」—— 但路径若
    // 是数据目录里的符号链接（symlink）且指向外部，shell.showItemInFolder
    // 实际会在文件管理器里打开 symlink 真实目标。攻击向量：
    //   - 攻击者诱导用户把外部恶意目录 / 网络共享（`\\evil\share`）做成
    //     数据目录里的 symlink；
    //   - 渲染端走 fs.stat（跟随 symlink）拿到合法 st.isFile()=true 通过；
    //   - shell.showItemInFolder 在 Windows 上解析为 SMB UNC，系统静默做
    //     NTLM 认证（与 Sec-H2 同一族风险，CVE-2023-23397 的笔记版本）。
    // 修复：realpath 拿到「symlink 真实指向」，再次 isWithinDataDir 校验。
    // 真实路径不在数据目录 → 拒（错误码 SYMLINK_OUTSIDE，与 file:write
    // 路径的 SYMLINK_NOT_ALLOWED 对齐但语义更准确）。
    const real = await fs.promises.realpath(fullPath);
    if (!isWithinDataDir(real, currentDataRoot())) {
      return {
        ok: false,
        error: 'SYMLINK_OUTSIDE',
        code: 'SYMLINK_OUTSIDE',
        message: '符号链接指向数据目录外',
      };
    }
    const st = await fs.stat(fullPath);
    if (!st.isFile()) {
      return { ok: false, error: 'NOT_A_FILE', code: 'NOT_A_FILE', message: '不是一个文件' };
    }
    shell.showItemInFolder(fullPath);
    return { ok: true };
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: false, error: 'FILE_NOT_FOUND', code: 'FILE_NOT_FOUND', message: '文件不存在' };
    // audit fix (K1-R4)：走 _friendlyShellError 翻译 errno，不再直回 e.message。
    return { ok: false, error: e.code || 'STAT_FAILED', code: e.code, message: _friendlyShellError(e, '无法在文件夹中显示') };
  }
});

/**
 * 在系统文件管理器中打开数据目录下的任意目录（子目录 / 数据根）。
 *
 * 与 `shell:show-item-in-folder` 的差别：showItemInFolder 只接受文件路径
 * （"在文件夹中显示并选中文件"语义），无法用来打开一个目录供用户浏览。
 * 状态栏左侧的路径 chip 在「没打开文件」时会显示当前浏览目录，此时点击应该
 * 真的打开那个目录（Win/Linux = 资源管理器进目录；macOS = Finder 进目录），
 * 而不是静默无副作用。
 *
 * 安全：与 `shell:show-item-in-folder` 对称 —— 强制 isWithinDataDir 边界检查，
 * 不让 renderer 通过这条 IPC 打开任意系统目录。
 */
ipcMain.handle('shell:open-dir', async (_event, dirPath) => {
  if (typeof dirPath !== 'string' || !dirPath) {
    // audit fix (Round 7 IPC-4)：补齐 code + message 字段，与其它 shell:* handler
    // 对齐。renderer 走 friendlyFsError(code, message) 没 message 兜底到英文。
    return {
      ok: false,
      error: 'INVALID_PATH',
      code: 'INVALID_PATH',
      message: '路径必须是字符串',
    };
  }
  const resolved = path.resolve(dirPath);
  if (!isWithinDataDir(resolved, currentDataRoot())) {
    // audit fix (Round 7 IPC-4 风格补齐)：与 file:read/write 等对齐 error + code + message。
    // renderer 走 friendlyFsError(code, message) 没 code 字段会落到 error 字符串，
    // 文案与其它通道不一致。
    return { ok: false, error: 'PATH_NOT_ALLOWED', code: 'PATH_NOT_ALLOWED', message: '路径不在数据目录内' };
  }
  try {
    // audit fix：用 lstat 拒绝 symlink 目录（与 file:scan-dir 对齐）。
    // fs.stat 跟随 symlink —— resolved 若指向外部目录，stat 仍能拿到目标目录
    // 信息，导致下面的 shell.openPath 跑出数据目录边界。lstat + isSymbolicLink
    // 检查与 file:scan-dir 一致。
    const lst = await fs.lstat(resolved);
    if (lst.isSymbolicLink()) {
      return { ok: false, error: 'SYMLINK_NOT_ALLOWED', code: 'SYMLINK_NOT_ALLOWED', message: '不允许在符号链接目录上执行此操作' };
    }
    if (!lst.isDirectory()) {
      // audit fix (Round 7 IPC-9)：补齐 message 字段，与 line 1705/1717/1720 对齐。
      // renderer 走 `friendlyFsError(code, message || error || '未知错误')` 时
      // 缺 message 兜底到 result.error 业务码字符串 'NOT_A_DIRECTORY'，用户看到
      // 的是代码不是中文。
      return {
        ok: false,
        error: 'NOT_A_DIRECTORY',
        code: 'NOT_A_DIRECTORY',
        message: '路径不是文件夹',
      };
    }
    const failure = await shell.openPath(resolved);
    if (failure) {
      // shell.openPath 失败时返回错误消息字符串（不是抛错），参考 app:open-path
      return { ok: false, error: 'OPEN_FAILED', code: 'OPEN_FAILED', message: failure };
    }
    return { ok: true };
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: false, error: 'DIR_NOT_FOUND', code: 'DIR_NOT_FOUND', message: '目录不存在' };
    // audit fix (K1-R4)：走 _friendlyShellError 翻译 errno，不再直回 e.message。
    return { ok: false, error: e.code || 'OPEN_FAILED', code: e.code, message: _friendlyShellError(e, '无法打开目录') };
  }
});

// ============================================
//  IPC: 窗口控制
// ============================================

ipcMain.handle('window:set-always-on-top', (_event, enabled) => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (typeof enabled !== 'boolean') {
    console.warn('[main] setAlwaysOnTop 收到非布尔值:', enabled);
    return false;
  }
  try {
    mainWindow.setAlwaysOnTop(enabled);
    return true;
  } catch (e) {
    console.error('[main] setAlwaysOnTop 失败:', e.message);
    return false;
  }
});

ipcMain.handle('window:minimize', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  // audit fix (K1-L4)：try/catch 兜底 —— minimize() 在窗口被销毁过程中可能抛
  // "Object has been destroyed"，与 setAlwaysOnTop 的 L4 修复对齐。
  try {
    mainWindow.minimize();
    return true;
  } catch (e) {
    console.warn('[main] window:minimize 失败:', e.message);
    return false;
  }
});

ipcMain.handle('window:toggle-maximize', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  try {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
    return mainWindow.isMaximized();
  } catch (e) {
    console.warn('[main] window:toggle-maximize 失败:', e.message);
    return false;
  }
});

ipcMain.handle('window:close', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  try {
    mainWindow.close();
    return true;
  } catch (e) {
    console.warn('[main] window:close 失败:', e.message);
    return false;
  }
});

function broadcastMaximizeState() {
  safeSendToRenderer('window:maximize-state', mainWindow?.isMaximized?.() ?? false);
}

// ============================================
//  IPC: AI 修改
// ============================================

/**
 * 渲染端发来修改请求：调 OpenAI 兼容 API，返回 { id, content, responseFormat }。
 * 错误统一返回 { ok:false, error, message } 供 renderer 弹 toast。
 */
ipcMain.handle('ai:edit', async (_event, payload) => {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'INVALID_PAYLOAD', message: '请求体无效' };
  }
  const { prompt, content, filename, requestId } = payload;
  return aiProxy.runEdit({ prompt, content, filename, requestId });
});

/**
 * 渲染端发来取消请求：找到对应 requestId 的 AbortController 并触发 abort。
 * 找不到（请求已完成 / 超时）静默忽略。
 */
ipcMain.on('ai:cancel', (_event, requestId) => {
  if (typeof requestId === 'string' && requestId) {
    aiProxy.cancel(requestId);
  }
});

// ============================================
//  IPC: 应用设置（持久化）
// ============================================

ipcMain.handle('app:get-settings', () => {
  const cfg = configStore.getConfig() || {};
  const { aiApiKey, ...rest } = cfg;
  // P1-1 fix (audit)：过滤 aiApiKey 真值，只露布尔标记。renderer 任何位置
  // 通过 window.api.getSettings() 都拿不到完整 Key —— 必须显式调
  // app:reveal-ai-key 才能拿真值（settings 对话框回显用）。
  return { ...rest, aiApiKey: '', _hasAiKey: !!aiApiKey };
});

/**
 * Q7/Q9 fix (audit)：「显示 API Key」必须先 arm 再 reveal：
 *
 *   1. settings-dialog 在用户主动点击「显示 Key」时先调 app:arm-reveal-ai-key
 *      —— 主进程记录一个 5 秒 armed 窗口（per-sender，按 webContents.id 区分）。
 *   2. 然后调 app:reveal-ai-key —— 主进程检查 armed 窗口仍在有效期内。
 *   3. reveal 后立即 disarm。
 *
 * DevTools / 第三方 hook / 任何意外注入的 JS 不会先经过「用户点按钮」事件，
 * 自然不会调 arm。一旦 arm 流程跑过，主进程日志记下 time + senderId，方便
 * 事后审计。这条链路**不能**完全防御已被攻陷的 renderer（renderer 拿到的
 * IPC 桥跟合法代码一样），但能在「合法流程之外」显著抬高成本（attacker 必须
 * 也调 arm 才能拿 key，会留下可追溯的日志条目）。
 *
 * 不入 renderer 常驻缓存；调用方应在用完后立即从 DOM 清掉。
 */
const REVEAL_ARMED_TTL_MS = 5_000;
/** @type {Map<number, number>} webContents.id → 截止时间戳 */
const revealArmedBySender = new Map();

ipcMain.handle('app:arm-reveal-ai-key', (event) => {
  const senderId = event.sender && event.sender.id;
  if (typeof senderId !== 'number') {
    return { ok: false, error: 'INVALID_SENDER' };
  }
  const until = Date.now() + REVEAL_ARMED_TTL_MS;
  revealArmedBySender.set(senderId, until);
  // L4 fix (audit)：去掉 ISO 时间戳（精确到 ms 让 arm 时刻成为可关联的 fingerprint），
  // 改用 ttlMs 表明窗口长度即可。
  console.log('[reveal-ai-key] armed by sender', senderId, 'ttlMs=', REVEAL_ARMED_TTL_MS);
  // 兜底：armed 窗口过期自动清理（防止 reveal 永远不来，Map 一直占位）
  setTimeout(() => {
    const cur = revealArmedBySender.get(senderId);
    if (cur === until) revealArmedBySender.delete(senderId);
  }, REVEAL_ARMED_TTL_MS + 100).unref?.();
  return { ok: true, ttlMs: REVEAL_ARMED_TTL_MS };
});

ipcMain.handle('app:reveal-ai-key', (event) => {
  const senderId = event.sender && event.sender.id;
  const until = (typeof senderId === 'number') ? revealArmedBySender.get(senderId) : undefined;
  // 任意一条命中即拒绝：没 arm / arm 已过期 / sender 不匹配
  if (typeof until !== 'number' || until <= Date.now()) {
    if (typeof senderId === 'number') revealArmedBySender.delete(senderId);
    // 不打印 apiKey 内容；只记"拒绝了一次 reveal 尝试"，方便事后追查
    console.warn('[reveal-ai-key] rejected: no valid arm window for sender', senderId);
    return { ok: false, error: 'NOT_AUTHORIZED' };
  }
  // 一次性：reveal 后立即 disarm，避免同一窗口被重放
  revealArmedBySender.delete(senderId);
  const cfg = configStore.getConfig() || {};
  // 显式记一条"成功 reveal"日志（含 key 长度而非真值，便于事后核对"有没有人偷 key"）
  // L4 fix (audit)：单行结构、sender + length，去掉任何 key 相关指纹；
  // 配 arm 日志一起能看出 arm→reveal 时序关系。
  const keyStr = String(cfg.aiApiKey || '');
  console.log('[reveal-ai-key] revealed by sender', senderId, 'length=', keyStr.length);
  return { ok: true, aiApiKey: keyStr };
});

/**
 * 返回 config.json 的真实路径 + 所在目录。
 * 设置对话框用：让用户看到 API Key / 设置到底存在了哪个文件，
 * 并能一键打开所在目录自行核对/备份。
 *
 * audit fix (M4)：路径在 tmp 日志 / 屏幕共享 / 截图里出现会暴露 Windows 用户名
 * （`C:\Users\<name>\AppData\...`）。设置面板只需要「哪个文件 / 哪个目录」足够
 * 用户理解位置，把 basename / dir basename 返回即可，完整路径仅在「打开所在
 * 目录」按钮内部使用（不再经过 IPC）。
 */
ipcMain.handle('app:get-config-path', () => {
  const filePath = configStore.getConfigPath();
  return {
    name: path.basename(filePath),
    dirName: path.basename(path.dirname(filePath)),
  };
});

/**
 * 打开 config.json 所在目录（设置对话框 AI 段的 [打开文件夹] 按钮）。
 *
 * audit fix (Round 9 CFG-1)：这个按钮之前完全是死的，两处同时坏掉 ——
 *   1) M4 把 `app:get-config-path` 的返回从 `{path, dir}` 改成 `{name, dirName}`
 *      做隐私脱敏，但 settings-dialog 仍读 `cfg.path` / `cfg.dir` → 都是
 *      undefined → `initial._configPath` 永不赋值 → hint 里的路径 + 按钮
 *      整段模板不渲染（文案还断在「存储于 config.json」和「。每次请求」之间）。
 *   2) 即便按钮渲染出来，它调的 `app:open-path` 强制 target === 当前数据目录，
 *      传 config 目录会被 PATH_NOT_ALLOWED 拒掉（那个 handler 的注释说
 *      「settings-dialog 也只拿 _configDir 来调用」，但 _configDir 是 userData
 *      目录、不是数据目录 —— 注释与事实不符）。
 *
 * 这里用「不接参数」的专用 handler 同时满足两个既有约束：完整路径不过 IPC
 * （隐私），renderer 也无法传任意路径（安全）。形状与 app:open-data-dir 对齐。
 */
ipcMain.handle('app:open-config-dir', async () => {
  let dir;
  try {
    dir = path.dirname(configStore.getConfigPath());
    const st = await fs.stat(dir);
    if (!st.isDirectory()) {
      return { ok: false, error: 'NOT_A_DIRECTORY', code: 'NOT_A_DIRECTORY', message: '配置路径不是一个目录' };
    }
  } catch (e) {
    console.warn('[main] app:open-config-dir stat 失败:', _redactPath(dir), e.code || e.message);
    return { ok: false, error: e.code || 'STAT_FAILED', code: e.code, message: '无法访问配置目录' };
  }
  try {
    const failure = await shell.openPath(dir);
    if (failure) {
      console.warn('[main] shell.openPath 返回失败:', failure);
      return { ok: false, error: 'OPEN_FAILED', code: 'OPEN_FAILED', message: `无法打开配置目录：${failure}` };
    }
    // 不回传 dir —— 完整路径带 Windows 用户名，与 app:get-config-path 的脱敏一致。
    return { ok: true };
  } catch (e) {
    console.warn('[main] shell.openPath 抛错:', _redactPath(dir), e.message);
    return { ok: false, error: e.code || 'OPEN_FAILED', code: e.code, message: _friendlyShellError(e, '无法打开配置目录') };
  }
});

/**
 * 保存设置。
 * 返回结构化结果 { ok:true, settings } / { ok:false, error }，而不是抛错 ——
 * ipcMain.handle 抛出的错误会被 Electron 包装成
 * "Error invoking remote method 'app:save-settings': Error: 目录不存在"，
 * 渲染端直接把这串东西塞进 toast 很难看。
 */
ipcMain.handle('app:save-settings', async (event, partial) => {
  if (!partial || typeof partial !== 'object') return { ok: true, settings: configStore.getConfig() };

  // 目录存在性校验（schema 里用 opts.resolveDir 注入，因为要异步 fs.lstat + access）
  // audit fix (Security-L4)：旧版用 fs.stat 会跟随 symlink —— 用户 / 同步盘 /
  // 配置注入可以塞一个 symlink 指到任意目录，本会话内该 symlink 目标就成了 active
  // dataDir，违反「dataDir 不得是 symlink」的不变量（resolveDataDirOrFallback 是
  // 用 lstat 拒的；本入口是同一不变量，必须对齐）。改用 fs.lstat 后 isSymbolicLink
  // 即拒。
  const resolveDir = async (p) => {
    try {
      const st = await fs.lstat(p);
      if (st.isSymbolicLink()) return { ok: false, error: '不允许将符号链接作为数据目录' };
      if (!st.isDirectory()) return { ok: false, error: '路径不是一个目录' };
      await fs.access(p, fsSync.constants.R_OK);
      return { ok: true };
    } catch (e) {
      if (e.code === 'ENOENT') return { ok: false, error: '目录不存在' };
      if (e.code === 'EACCES' || e.code === 'EPERM') return { ok: false, error: '没有访问权限' };
      return { ok: false, error: e.message || '无法访问该目录' };
    }
  };

  const result = await validateAndSanitize(partial, { resolveDir });
  if (!result.ok) return { ok: false, error: result.error };
  const sanitized = result.sanitized;

  // audit fix (main-M4)：先 saveConfig 再 apply 窗口 / 托盘副作用。旧实现先
  // setAlwaysOnTop / 重建 tray menu，saveConfig 失败时 UI 已变更、磁盘还是
  // 旧值，重启后置顶状态被撤回 + 用户以为配置损坏。修复后语义：「磁盘先
  // 落定，UI 再跟上」—— saveConfig 失败直接返回 {ok:false}，副作用一段都
  // 不跑。
  // audit fix (Round 8 M-1)：必须在 saveConfig 之前快照旧值。saveConfig 成功时
  // 会把 appConfig 就地换成 merged（config-store.js:188），之后再读
  // configStore.getConfig().alwaysOnTop 拿到的已经是新值 → 与 sanitized 恒等 →
  // `!==` 恒为 false → setAlwaysOnTop / 托盘菜单刷新一次都不跑。表现：用户勾选
  // 「始终置顶」后磁盘和 UI 都变了，但窗口实际没置顶、托盘勾选状态也不同步，
  // 要重启（createWindow 重新 apply）才生效。
  const prevAlwaysOnTop = configStore.getConfig().alwaysOnTop;
  const saveResult = await configStore.saveConfig(sanitized);
  if (!saveResult.ok) {
    return { ok: false, error: saveResult.error || '配置保存失败' };
  }
  const next = saveResult.value;

  // alwaysOnTop 变更需要同步到窗口 + tray（schema 不应耦合 Electron API，所以副作用留在 main.js）
  if ('alwaysOnTop' in sanitized && prevAlwaysOnTop !== sanitized.alwaysOnTop) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setAlwaysOnTop(sanitized.alwaysOnTop);
    }
    if (tray) {
      tray.setContextMenu(buildTrayMenu());
    }
  }

  // dataDir 变更后重新启动目录监听 + 刷新托盘菜单（托盘「打开数据文件夹」缓存了旧路径）
  if ('dataDir' in sanitized) {
    // 走 currentDataRoot 而不是 resolveDataDir：customDir 失效时 fallback 到默认
    // 并 sync mkdir，确保 fsWatcher 启动时不撞 ENOENT。
    const newDirRaw = currentDataRoot();
    await configStore.scheduleEnsureDefaultDataDir();
    // audit fix：直接比较字符串会因为尾斜杠 / 大小写 / `..` 残留而误判。
    // 用 path.resolve 归一化后再比；Windows 上大小写不敏感。
    const newResolved = path.resolve(newDirRaw);
    // audit fix (M3)：currentDataDir === null 兜底 —— 当前总是非 null（whenReady
    // 已先 set），但 app:save-settings 的早期触发 / future splash 路径可能命中。
    // TypeError: path.resolve(null) 会把整个 settings 保存流程打挂。
    const curResolved = path.resolve(currentDataDir || newDirRaw);
    const same = process.platform === 'win32'
      ? newResolved.toLowerCase() === curResolved.toLowerCase()
      : newResolved === curResolved;
    if (!same) {
      currentDataDir = newDirRaw;
      // audit fix (H4)：与 app:reset-data-dir 同款 try/catch —— startWatchingDir
      // 同步路径可能 ENOENT / EACCES（旧目录已被删 / 权限收紧），失败也不应该
      // 让 IPC 抛回 renderer（磁盘已 saveConfig 成功）。失败只丢 watcher，配置
      // 与数据目录写入照常生效；下次启动会自然拉起。
      try { fsWatcher.startWatchingDir(newDirRaw); }
      catch (e) { console.warn('[main] restart fsWatcher 失败:', e?.message || e); }
      if (tray) {
        tray.setContextMenu(buildTrayMenu());
      }
    }
  }

  // Phase N 安全修复：save-settings 之前直接 echo `next`，里面含 aiApiKey 明文。
  // renderer settingsStore.update 会拿这个 settings 调 coerceLoadedSettings
  // 覆盖 _settings —— 把真值灌进内存。后续 getSettings / getAll / IPC echo 都
  // 走同一份内存，AI Key 明文在内存里能待到下次 restart。
  // 与 get-settings 同款 redaction：剥掉 aiApiKey 真值、用 aiApiKey='' 占位、
  // 用 _hasAiKey 标记"是否配置过 Key"。renderer settings-store 已在 update 路径
  // 把 aiApiKey='' 落进 _settings 与 cachePartial，"清空 Key" 的写入也无副作用
  // 走空字符串 diff。
  const { aiApiKey: realKey, ...rest } = next;
  return { ok: true, settings: { ...rest, aiApiKey: '', _hasAiKey: !!realKey } };
});

// ============================================
//  应用菜单
// ============================================

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),
    {
      label: '视图',
      submenu: [
        {
          label: '切换主题',
          accelerator: 'CmdOrCtrl+Shift+T',
          // audit fix (H3)：应用菜单 click 走 safeSendToRenderer —— 关闭中窗口
          // 的 webContents.send 同款 TypeError 风险。
          click: () => safeSendToRenderer('menu:toggle-theme')
        },
        { type: 'separator' },
        {
          label: '设置...',
          accelerator: 'CmdOrCtrl+,',
          click: () => safeSendToRenderer('menu:settings')
        },
        { type: 'separator' },
        {
          label: '开发者工具',
          accelerator: 'F12',
          click: () => mainWindow?.webContents.toggleDevTools()
        },
        { role: 'reload', label: '重新加载' }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}