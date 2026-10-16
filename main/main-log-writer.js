// P2-10 / P2-12（audit）：主进程日志异步缓冲写出。
//
// 旧实现（main.js 顶部 console 重写层）：每行 mkdirSync + appendFileSync ——
// 同步 IO 直接阻塞 main 事件循环。AI 流式 / fsWatcher 高频日志期间，
// 每次 console.* 都是一次磁盘往返；顶层同步 fs 也拖慢启动路径。
//
// 新设计：write(line) 只进内存缓冲并调度一次 flush 定时器（默认 250ms，
// .unref() 不拖进程退出）；flush 把整段缓冲拼成一次 mkdir(recursive) +
// appendFile 异步写出。崩溃窗口 = 最多 flushMs 毫秒的日志丢失 ——
// 对诊断日志可接受（崩溃路径另有 stderr 兜底）。
//
// 失败语义与旧版一致：写盘失败静默丢弃（不应影响主流程）。
// 缓冲上限 maxBuffered 行，超出丢最老，防 AI 刷屏撑爆内存。

'use strict';

/**
 * @param {object} opts
 * @param {string} opts.logDir
 * @param {string} opts.logFile
 * @param {{ mkdir: Function, appendFile: Function }} [opts.fsImpl] 默认 require('fs').promises
 * @param {number} [opts.flushMs=250]
 * @param {number} [opts.maxBuffered=1000]
 * @param {Function} [opts.setTimeoutImpl]
 * @param {Function} [opts.clearTimeoutImpl]
 */
function createMainLogWriter({
  logDir,
  logFile,
  fsImpl,
  flushMs = 250,
  maxBuffered = 1000,
  setTimeoutImpl,
  clearTimeoutImpl,
}) {
  const fs = fsImpl || require('fs').promises;
  const _setTimeout = setTimeoutImpl || setTimeout;
  const _clearTimeout = clearTimeoutImpl || clearTimeout;

  /** @type {string[]} */
  let buffer = [];
  /** @type {Promise<void>|null} mkdir 只做一次，缓存 promise */
  let mkdirPromise = null;
  /** @type {Promise<void>|null} in-flight flush，dispose/重复 flush 复用 */
  let flushing = null;
  let timer = null;

  function ensureDir() {
    if (!mkdirPromise) {
      mkdirPromise = fs.mkdir(logDir, { recursive: true }).catch(() => {
        // mkdir 失败：下次 flush 重试（不缓存失败的 promise）
        mkdirPromise = null;
        throw new Error('mkdir failed');
      });
    }
    return mkdirPromise;
  }

  async function flush() {
    if (flushing) return flushing;
    if (buffer.length === 0) return;
    const lines = buffer;
    buffer = [];
    flushing = (async () => {
      try {
        await ensureDir();
        await fs.appendFile(logFile, lines.join(''));
      } catch {
        // 写日志失败静默丢弃 —— 与旧同步实现「catch 忽略」语义一致
      } finally {
        flushing = null;
      }
    })();
    return flushing;
  }

  function scheduleFlush() {
    if (timer) return;
    timer = _setTimeout(() => {
      timer = null;
      flush();
    }, flushMs);
    // 日志定时器不应单独吊住进程退出
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  return {
    write(line) {
      buffer.push(line);
      if (buffer.length > maxBuffered) {
        buffer.splice(0, buffer.length - maxBuffered);
      }
      scheduleFlush();
    },
    flush,
    dispose() {
      if (timer) {
        _clearTimeout(timer);
        timer = null;
      }
    },
  };
}

module.exports = { createMainLogWriter };
