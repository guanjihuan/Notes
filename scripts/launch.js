// Notes 启动包装
//
// 主要职责：
//   1. 处理 Windows 控制台编码（cp936 → utf-8）让中文日志不乱码
//   2. 在 Windows 上以管理员权限运行时切换工作目录到项目根
//      （某些路径如 `C:\Windows\System32` 在普通权限下无法读取 electron 二进制）
//   3. 避免被 ELECTRON_RUN_AS_NODE 影响（main.js 也会清除，这里是双保险）
//
// 与 Todo List 的 launch.js 逻辑完全一致 —— 它经过实际使用验证。

const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

// 防止 ELECTRON_RUN_AS_NODE=1 让我们作为普通 Node 运行
if (process.env.ELECTRON_RUN_AS_NODE) {
  console.log('[launch] 清除 ELECTRON_RUN_AS_NODE 环境变量');
  delete process.env.ELECTRON_RUN_AS_NODE;
}

// Windows 控制台 UTF-8
if (process.platform === 'win32') {
  try {
    process.stdout.setDefaultEncoding('utf8');
    process.stderr.setDefaultEncoding('utf8');
  } catch {
    // 某些嵌入式环境下不可用，忽略
  }

  // 把当前终端的代码页切换到 UTF-8。
  // 否则即使我们输出 UTF-8 字节，cmd.exe 默认 cp936 会按 GBK 解析成乱码。
  // chcp 65001 = UTF-8 code page
  try {
    require('child_process').execSync('chcp 65001 > nul', {
      stdio: 'ignore',
      shell: true,
    });
  } catch {
    // chcp 在某些嵌入式终端不可用，忽略
  }
}

// 解析 electron 可执行文件路径
function resolveElectronBinary() {
  try {
    // 优先使用 require('electron') 暴露的二进制路径（dev 模式）
    const electronPath = require('electron');
    if (typeof electronPath === 'string' && fs.existsSync(electronPath)) {
      return electronPath;
    }
  } catch {
    // fallthrough
  }
  // 兜底：尝试常见路径
  const candidates = [
    path.join(__dirname, '..', 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron'),
    path.join(__dirname, '..', 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error('未找到 electron 可执行文件，请先运行 npm install');
}

const electronPath = resolveElectronBinary();
const projectRoot = path.resolve(__dirname, '..');
console.log('[launch] Electron:', electronPath);
console.log('[launch] 项目根目录:', projectRoot);

// 在 Windows 上以管理员权限运行时，当前工作目录可能是 System32
// electron 二进制所在目录可能存在空格或权限问题，统一切换到项目根
if (process.cwd() !== projectRoot) {
  try {
    process.chdir(projectRoot);
  } catch (e) {
    // 切换失败只发警告，不要静默吞掉 —— spawn 仍会用 cwd: projectRoot，
    // 所以这里失败通常不影响 electron 启动，但日志里有必要让用户看到。
    console.warn(`[launch] 切换工作目录到 ${projectRoot} 失败：${e.message}`);
  }
}

// 传递所有参数给 electron
const args = [projectRoot, ...process.argv.slice(2)];

console.log('[launch] 启动参数:', args.join(' '));

const child = spawn(electronPath, args, {
  stdio: 'inherit',
  cwd: projectRoot,
  env: {
    ...process.env,
    // 确保不会被子进程继承为 Node 模式
    ELECTRON_RUN_AS_NODE: undefined,
  },
  windowsHide: false,
});

child.on('error', (err) => {
  console.error('[launch] 启动失败:', err.message);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.log(`[launch] Electron 被信号终止: ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 0);
});

// 透传 Ctrl+C
process.on('SIGINT', () => {
  child.kill('SIGINT');
});
process.on('SIGTERM', () => {
  child.kill('SIGTERM');
});
