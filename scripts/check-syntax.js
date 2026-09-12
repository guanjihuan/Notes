#!/usr/bin/env node
// 语法体检：对 main / preload / scripts / src 全部 JS 文件跑 `node --check`。
// 比 ESLint 严格度低，但能捕获**最基础的**语法错误（漏括号、错引号等）
// 在文件压根还没被 linted 之前的快速反馈。

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/** @type {string[]} */
const targets = [
  'main.js',
  'preload.js',
  'scripts/launch.js',
  // src/ 下用 ESM import/export，node --check 会按 ESM 解析（package.json 无 "type" 字段 → CJS），
  // 因此 src/**/*.js 必须以 .mjs 单独跑。
];

const esmTargets = [
  'src',
];

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    // audit fix (Q3.7)：跳过 symlink 文件 + 目录。
    // 之前只用 isFile()/isDirectory() 判定，fs.readdirSync withFileTypes 不会跟随 symlink，
    // 但 isSymbolicLink() 会同步报告出来 —— 显式跳过避免后续 stat 跟着 symlink 跑到
    // 项目外文件。实际风险低（项目里没有 symlink），但保留防御。
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walk(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
}

/** @type {string[]} */
const allCjs = targets.map((p) => path.join(ROOT, p)).filter(fs.existsSync);

/** @type {string[]} */
const allEsm = [];
for (const dir of esmTargets) {
  const abs = path.join(ROOT, dir);
  if (fs.existsSync(abs)) walk(abs, allEsm);
}

let failed = false;

for (const file of allCjs) {
  try {
    // audit fix (Q3.7)：改用 execFileSync 不带 shell。
    // 之前用 ``execSync(`node --check "${file}"`, { stdio: 'pipe' })`` 把路径拼进
    // shell 字符串 —— 文件名里出现 `; rm -rf ~ #` 就会被 cmd.exe / sh 解释执行。
    // 项目内的文件名目前可信，但这是审计工具自身表面的隐患，留着没意义。
    execFileSync('node', ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    failed = true;
    console.error(`[check-syntax] CJS 失败: ${path.relative(ROOT, file)}`);
    if (err.stderr) console.error(err.stderr.toString());
  }
}

for (const file of allEsm) {
  try {
    // audit fix (Q3.7)：同样改用 execFileSync。
    // ESM 走 stdin 重定向：用 { input: fs.readFileSync(file) } 把文件内容喂给子进程
    // stdin，避开 shell 重定向 / 文件名展开。
    const source = fs.readFileSync(file);
    execFileSync('node', ['--check', '--input-type=module'], { stdio: ['pipe', 'pipe', 'pipe'], input: source });
  } catch (err) {
    failed = true;
    console.error(`[check-syntax] ESM 失败: ${path.relative(ROOT, file)}`);
    if (err.stderr) console.error(err.stderr.toString());
  }
}

if (failed) {
  console.error('[check-syntax] 失败');
  process.exit(1);
}
console.log(`[check-syntax] 通过 (${allCjs.length} CJS + ${allEsm.length} ESM)`);
