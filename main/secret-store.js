// API Key 等敏感字段的加密存储层（audit P0-1）
// ============================================================================
//
// 背景：原来 aiApiKey 直接以明文写入 userData/config.json。任何能拿到
// userData 目录副本的人 / 备份脚本 / 同步盘历史版本都拿得到明文 Key。
//
// 修复：用 electron.safeStorage（DPAPI / Keychain / libsecret）做对称加密，
// 磁盘仅留包络（enc:v1:<base64 ciphertext>）。运行时内存需要时再解密
// 给 fetch 用 —— 主进程栈上才有明文窗口。
//
// 包络格式：
//   - 'enc:v1:' 前缀 + base64 编码的密文 Buffer
//   - 没有前缀 = 旧版明文（升级前配置），按明文处理（懒迁移见下）
//   - 前缀之后是 v1 版本号：未来升级算法 / 改用非对称 / 换 key 时 bump 到 v2
//
// 降级（isEncryptionAvailable() === false，典型 Linux 无 gnome-keyring/kwallet）：
//   - encrypt 返回明文 + console.warn 一次（每进程）
//   - decrypt 遇到包络但 keyring 不可用 → 返回 ''（AI 配置临时不可用，UI 提示重输）
//
// 迁移（懒迁移，audit P0-1 要求"启动时一次性加密" → 这里更轻量）：
//   - 老配置 plaintext 在 loadConfig 时进内存仍是明文
//   - 任意 settingsStore.update 触发 saveConfig → 写入前自动加密
//   - 不在 loadConfig 里主动写盘：避免「启动 + 配置没改也要做一次 IO」
//   - 透明：上层读 appConfig.aiApiKey 永远拿到明文（loadConfig decrypt 一次，
//     saveConfig 只在写盘路径加密，merged 内存对象保持明文）
//
// 测试注入：_setSafeStorage(mock) 替换底层 safeStorage，_reset() 还原。
// 单测里 vi.mock('electron') 拦不住 CJS require（与 main/config-store.js
// 同模式），用本模块自己的 setter。

'use strict';

const ENVELOPE_PREFIX = 'enc:v1:';
let _warnedUnavailable = false;
let _safeStorageOverride = null;

/**
 * 取当前生效的 safeStorage（生产 = electron.safeStorage，单测 = 注入的 mock）。
 * 模块未在 Electron 内运行时（极少见，e.g. 脚本化测试）返回 null。
 * @returns {object|null}
 */
function getSafeStorage() {
  if (_safeStorageOverride !== null) return _safeStorageOverride;
  try {
    const electron = require('electron');
    return electron && electron.safeStorage ? electron.safeStorage : null;
  } catch {
    return null;
  }
}

/**
 * 系统密钥库是否可用。不可用时（典型 Linux 无 keyring）→ 降级到明文存储。
 * @returns {boolean}
 */
function isAvailable() {
  const ss = getSafeStorage();
  if (!ss || typeof ss.isEncryptionAvailable !== 'function') return false;
  try {
    return !!ss.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/**
 * 「不可用」时一次性 warn。每个进程只 warn 一次，避免设置面板来回点
 * 反复触发；用户看到的也是控制台一次性提示。
 * @param {string} reason
 */
function warnOnceDegraded(reason) {
  if (_warnedUnavailable) return;
  _warnedUnavailable = true;
  console.warn(
    `[secret-store] safeStorage 不可用 (${reason}); API Key 以明文写入 config.json（降级安全）。` +
    'Linux 上安装 gnome-keyring / kwallet 后重启即可恢复加密。'
  );
}

/**
 * 加密一段明文 → 包络字符串（可写盘）。
 * 输入：任意 string（空串、null、undefined 都安全处理）。
 * 输出：
 *   - 空 / null / undefined → ''（不写盘也无所谓；saveConfig 会跳过空 aiApiKey）
 *   - 已是包络（enc:v1:...）→ 原样返回（幂等，防止重复加密变套娃）
 *   - 明文 + safeStorage 可用 → 'enc:v1:' + base64(ciphertext)
 *   - 明文 + safeStorage 不可用 → 原明文 + warn 一次（降级）
 * @param {string|null|undefined} plain
 * @returns {string}
 */
function encrypt(plain) {
  if (plain == null) return '';
  const s = String(plain);
  if (s === '') return '';
  if (s.startsWith(ENVELOPE_PREFIX)) return s;
  const ss = getSafeStorage();
  if (!ss || !isAvailable()) {
    warnOnceDegraded('isEncryptionAvailable() === false');
    return s;
  }
  let buf;
  try {
    buf = ss.encryptString(s);
  } catch (e) {
    warnOnceDegraded(`encryptString 抛错: ${e && e.message ? e.message : 'unknown'}`);
    return s;
  }
  return ENVELOPE_PREFIX + buf.toString('base64');
}

/**
 * 解密包络 → 明文。
 * 输入：任意 string（空 / null / undefined 安全）。
 * 输出：
 *   - 空 / null / undefined → ''
 *   - 没有 enc:v1: 前缀 → 原样返回（旧版明文 passthrough；懒迁移关键）
 *   - 包络 + safeStorage 可用 → 解密后的明文
 *   - 包络 + safeStorage 不可用 → ''（AI 临时不可用，UI 应引导重输）
 *   - 包络 + decryptString 抛错（损坏 / 跨用户 / 改 key 后）→ ''（同不可用）
 * @param {string|null|undefined} stored
 * @returns {string}
 */
function decrypt(stored) {
  if (stored == null) return '';
  const s = String(stored);
  if (s === '') return '';
  if (!s.startsWith(ENVELOPE_PREFIX)) return s;
  const ss = getSafeStorage();
  if (!ss || !isAvailable()) return '';
  try {
    const b64 = s.slice(ENVELOPE_PREFIX.length);
    const buf = Buffer.from(b64, 'base64');
    return ss.decryptString(buf);
  } catch {
    return '';
  }
}

// ---- 测试注入点（生产代码不应调用） ----

/**
 * 替换底层 safeStorage。传 null 还原到 require('electron') 路径。
 * @param {object|null} mock
 */
function _setSafeStorage(mock) {
  _safeStorageOverride = mock;
  // 重置 warn 标志 —— 测试之间不串
  _warnedUnavailable = false;
}

/**
 * 重置模块状态（safeStorage 注入 + warn 标志）回默认。
 * 测试 beforeEach 用。
 */
function _reset() {
  _safeStorageOverride = null;
  _warnedUnavailable = false;
}

module.exports = {
  encrypt,
  decrypt,
  isAvailable,
  ENVELOPE_PREFIX,
  _setSafeStorage,
  _reset,
};
