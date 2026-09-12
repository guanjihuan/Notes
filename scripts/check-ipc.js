#!/usr/bin/env node
// IPC 通道配对审计（取代 preload.js 旧的那 45 行手工注释）
//
// 规则：
//   1. renderer → main（invoke / send）
//      preload.js 中 `ipcRenderer.invoke('foo')` 必须有 main.js 中 `ipcMain.handle('foo', ...)` 配对。
//      `ipcRenderer.send('foo')` 必须有 `ipcMain.on('foo', ...)` 或 `ipcMain.once('foo', ...)` 配对。
//   2. main → renderer（推送）
//      main.js 中 `webContents.send('foo')` 必须有 preload.js 中 `ipcRenderer.on('foo', ...)` 配对。
//      "on" 订阅也可以走 `onXxx` 高阶函数（事件名出现在数组/字符串字面量里）—— 用宽松匹配。
//   3. 动态通道名（如 renderer:save-result:${reqId}）按"前缀"匹配：发起方提供完整字面量，
//      接收方按前缀 ipcMain.on(`renderer:save-result:${...}`) 即可。
//
// 输出：失败时返回非零退出码 + 把缺漏通道写到 stderr。

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PRELOAD = path.join(ROOT, 'preload.js');
const MAIN = path.join(ROOT, 'main.js');
const MAIN_DIR = path.join(ROOT, 'main');

/**
 * 递归收集目录下所有 .js 文件（排除 node_modules / dist 等）。
 * @param {string} dir
 * @returns {string[]}
 */
function walkJs(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === 'dist') continue;
      out.push(...walkJs(p));
    } else if (ent.isFile() && ent.name.endsWith('.js')) {
      out.push(p);
    }
  }
  return out;
}

/**
 * 读文件，返回内容。
 * @param {string} p
 */
function read(p) {
  return fs.readFileSync(p, 'utf8');
}

/**
 * 提取引号字符串字面量（单引号 / 双引号 / 反引号）。
 * @param {string} src
 * @returns {string[]}
 */
function extractStringLiterals(src) {
  /** @type {string[]} */
  const out = [];
  // 单/双引号
  const re1 = /(['"])((?:\\.|(?!\1).)*)\1/g;
  let m;
  while ((m = re1.exec(src))) out.push(m[2]);
  // 模板字符串（无 ${}） — 不展开
  const re2 = /`([^`\\]*(?:\\.[^`\\]*)*)`/g;
  while ((m = re2.exec(src))) {
    // 如果包含 ${...}，整段作为"模板前缀"
    const tpl = m[1];
    if (tpl.includes('${')) {
      // 取 ${ 之前的字面前缀
      const idx = tpl.indexOf('${');
      out.push(tpl.slice(0, idx) + '${...}');
    } else {
      out.push(tpl);
    }
  }
  return out;
}

/**
 * 从文件中抽取 ipcRenderer.{invoke,send,on} 的通道名。
 * @param {string} src
 * @param {RegExp} headRe 形如 /ipcRenderer\.(invoke|send|on)\(\s*(['"`])/g
 * @returns {string[]} 通道字面量
 */
function extractIpcCalls(src, headRe) {
  /** @type {string[]} */
  const out = [];
  for (const m of src.matchAll(headRe)) {
    const quote = m[1];
    const start = m.index + m[0].length;
    const end = src.indexOf(quote, start);
    if (end === -1) continue;
    let literal = src.slice(start, end);
    if (literal.includes('${')) {
      const idx = literal.indexOf('${');
      literal = literal.slice(0, idx) + '${...}';
    }
    out.push(literal);
  }
  return out;
}

/**
 * 给定发送方通道集合 + 接收方"模式"集合（字面量 + 通配前缀），找出漏配的通道。
 * 接收方可以是字面量或 prefix${...}，prefix 部分前缀匹配即可。
 *
 * @param {string[]} sent
 * @param {string[]} received
 * @returns {string[]} 漏配（按 sent 顺序）
 */
/**
 * 收集 `const X = '...' | \`...\`` 形式的字符串字面量赋值（包括带 ${...} 的模板）。
 * 仅在脚本作用域内查找（不在函数体内更精确，但 main.js 顶层都在 module 作用域，问题不大）。
 * @param {string} src
 * @returns {Map<string,string>} varName → 字面量
 */
function collectStringVarAssignments(src) {
  /** @type {Map<string,string>} */
  const map = new Map();
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([`'"])((?:\\.|(?!\2).)*)\2/g;
  let m;
  while ((m = re.exec(src))) {
    const name = m[1];
    let literal = m[3];
    if (literal.includes('${')) {
      const idx = literal.indexOf('${');
      literal = literal.slice(0, idx) + '${...}';
    }
    map.set(name, literal);
  }
  return map;
}

/**
 * 提取 ipcMain.once(VAR, ...) / webContents.send(VAR, ...) 中的字面量（用变量映射）。
 * @param {string} src
 * @param {RegExp} varCallRe
 * @param {Map<string,string>} varMap
 * @returns {string[]}
 */
function extractIpcCallsByVar(src, varCallRe, varMap) {
  /** @type {string[]} */
  const out = [];
  for (const m of src.matchAll(varCallRe)) {
    const varName = m[1];
    const lit = varMap.get(varName);
    if (lit) out.push(lit);
  }
  return out;
}

function diffMissing(sent, received) {
  return sent.filter((s) => {
    if (!s) return false;
    if (received.includes(s)) return false;
    // 动态模板：sent 是字面，received 是前缀${...}？两边都可能是字面或模板
    for (const r of received) {
      if (r === s) return false;
      // 一边是 "foo:${...}" 另一边是 "foo:bar" → 视为配对（只要前缀对得上）
      if (r.endsWith('${...}') && s.startsWith(r.slice(0, -6))) return false;
      if (s.endsWith('${...}') && r.startsWith(s.slice(0, -6))) return false;
    }
    return true;
  });
}

function main() {
  const preloadSrc = read(PRELOAD);
  const mainSrc = read(MAIN);
  // audit fix (Round 8 R-2)：合并 main.js + main/**/*.js。
  // 旧实现只读 main.js，主进程拆出来的子文件（main/ai.js / main/file-ops.js /
  // main/fs-watcher.js / main/config-store.js）里的 ipcMain.handle / webContents.send
  // 完全不在审计图里 —— `files:changed`（main/fs-watcher.js:149）这种动态事件名
  // 容易因重构漏配对。
  const mainSubSrc = walkJs(MAIN_DIR).map(read).join('\n\n');
  const combinedMainSrc = mainSrc + '\n\n' + mainSubSrc;

  // preload.js：ipcRenderer.invoke / send / on
  const invokeRe = /ipcRenderer\.invoke\(\s*([`'"])/g;
  const sendRe = /ipcRenderer\.send\(\s*([`'"])/g;
  const onRe = /ipcRenderer\.on\(\s*([`'"])/g;

  const preloadInvoke = extractIpcCalls(preloadSrc, invokeRe);
  const preloadSend = extractIpcCalls(preloadSrc, sendRe);
  const preloadOn = extractIpcCalls(preloadSrc, onRe);

  // 订阅也可能在 onMenuCommand([...]) 的字符串数组里 — 简单提取那些 ['menu:foo', 'menu:bar'] 数组
  const preloadArrOn = [];
  const arrRe = /\[\s*((?:['"][\w:.-]+['"]\s*,\s*)+['"][\w:.-]+['"])\s*\]/g;
  let am;
  while ((am = arrRe.exec(preloadSrc))) {
    for (const lit of extractStringLiterals(am[1])) {
      if (lit.includes(':') && !lit.includes(' ')) preloadArrOn.push(lit);
    }
  }

  // main.js + main/**/*.js：ipcMain.handle / on / once + webContents.send
  // 同时识别用变量中转的动态通道：先收集 const X = `prefix:${...}` 这种声明，
  // 再把 ipcMain.once(channel, ...) / webContents.send(channel, ...) 里 channel 替换为它的字面量。
  const stringVarLiterals = collectStringVarAssignments(combinedMainSrc);

  const handleRe = /ipcMain\.handle\(\s*([`'"])/g;
  const onMainRe = /ipcMain\.on\(\s*([`'"])/g;
  const onceMainRe = /ipcMain\.once\(\s*([`'"])/g;
  const sendFromMain = extractIpcCalls(combinedMainSrc, handleRe);
  const onMain = extractIpcCalls(combinedMainSrc, onMainRe).concat(extractIpcCalls(combinedMainSrc, onceMainRe));

  // 变量形式：ipcMain.once(channel, ...)  —— channel 来自 stringVarLiterals
  const onMainByVar = extractIpcCallsByVar(combinedMainSrc, /ipcMain\.(?:on|once)\(\s*([A-Za-z_$][\w$]*)\s*,/g, stringVarLiterals);
  const handleByVar = extractIpcCallsByVar(combinedMainSrc, /ipcMain\.handle\(\s*([A-Za-z_$][\w$]*)\s*,/g, stringVarLiterals);
  onMain.push(...onMainByVar);
  sendFromMain.push(...handleByVar);

  // webContents.send(...) 的通道
  const wcSendRe = /webContents\.send\(\s*([`'"])/g;
  const webContentsSend = extractIpcCalls(combinedMainSrc, wcSendRe);
  // 变量形式
  const wcSendByVar = extractIpcCallsByVar(combinedMainSrc, /webContents\.send\(\s*([A-Za-z_$][\w$]*)\s*,/g, stringVarLiterals);
  webContentsSend.push(...wcSendByVar);

  const errors = [];

  // 1. renderer→main invoke 必须配 main.handle
  const missingForInvoke = diffMissing(preloadInvoke, sendFromMain);
  if (missingForInvoke.length) {
    errors.push(`renderer→main invoke 缺 main.handle 配对：\n  ${missingForInvoke.join('\n  ')}`);
  }

  // 2. renderer→main send 必须配 main.on/once
  const missingForSend = diffMissing(preloadSend, onMain);
  if (missingForSend.length) {
    errors.push(`renderer→main send 缺 main.on/once 配对：\n  ${missingForSend.join('\n  ')}`);
  }

  // 3. main→renderer webContents.send 必须配 preload.on (或 onXxx 数组)
  const preloadSubscribed = new Set([...preloadOn, ...preloadArrOn]);
  const missingForWcSend = diffMissing(webContentsSend, [...preloadSubscribed]);
  if (missingForWcSend.length) {
    errors.push(`main→renderer send 缺 preload.on 订阅：\n  ${missingForWcSend.join('\n  ')}`);
  }

  // 4. 列出所有声明的通道，便于人工核对（不算错误）
  const allChannels = new Set([
    ...preloadInvoke,
    ...preloadSend,
    ...preloadOn,
    ...preloadArrOn,
    ...sendFromMain,
    ...onMain,
    ...webContentsSend,
  ]);

  if (errors.length) {
    console.error('[check-ipc] 失败：\n' + errors.map((e) => `  ❌ ${e}`).join('\n\n'));
    process.exit(1);
  }

  console.log(`[check-ipc] 通过 (${allChannels.size} 个通道全部配对)`);
}

main();
