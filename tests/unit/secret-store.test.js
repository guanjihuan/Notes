// main/secret-store.js —— aiApiKey safeStorage 加密层单测（audit R3 P0-1）
//
// 覆盖：
//   - encrypt / decrypt 的对称与幂等
//   - safeStorage 不可用（典型 Linux 无 keyring）降级 + warn-once
//   - decrypt 遇损坏包络 / keyring 不可用 → 返回 ''（不抛）
//   - 旧版明文 passthrough（懒迁移关键：旧 config.json 仍能解密出 Key）
//   - isAvailable 处理 safeStorage 自身抛错 / 未注册的情况
//
// 注入模式：模块自暴露的 _setSafeStorage(mock)。原因同 main/config-store.js
// —— vi.mock('electron') 拦不住 CJS require。mock 用闭包记录 isEncryptionAvailable
// 状态和调用计数，单测间通过 _reset() 重置。

// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 强制每次 beforeEach 拿一份新模块实例（_reset 也会清 _warnedUnavailable 标志）
const loadModule = async () => {
  // 走 ESM dynamic import；secret-store.js 是 CJS，但 Node 处理 CJS↔ESM 互操作
  // 给一个 .default 包含 module.exports 的默认导出（如果用 require() 则没有）
  // —— secret-store.js 用 module.exports = {...}，ESM 默认 import 拿到的就是
  // module.exports 本身，不需要 .default 访问。
  const mod = await import('../../main/secret-store.js');
  return mod;
};

describe('secret-store：encrypt / decrypt 对称', () => {
  let mod;
  let encryptCalls;
  let decryptCalls;

  beforeEach(async () => {
    mod = await loadModule();
    encryptCalls = [];
    decryptCalls = [];
    // mock safeStorage：明文 ↔ base64('ENC:<plaintext>') 做对称回路
    mod._setSafeStorage({
      isEncryptionAvailable: () => true,
      encryptString: (plain) => {
        encryptCalls.push(plain);
        return Buffer.from(`ENC:${plain}`, 'utf-8');
      },
      decryptString: (buf) => {
        const s = buf.toString('utf-8');
        decryptCalls.push(s);
        if (!s.startsWith('ENC:')) throw new Error('mock: bad envelope');
        return s.slice('ENC:'.length);
      },
    });
  });

  afterEach(() => {
    mod._reset();
  });

  it('encrypt(\'\') → \'\'', () => {
    expect(mod.encrypt('')).toBe('');
  });

  it('encrypt(null) → \'\'', () => {
    expect(mod.encrypt(null)).toBe('');
  });

  it('encrypt(undefined) → \'\'', () => {
    expect(mod.encrypt(undefined)).toBe('');
  });

  it('encrypt(\'sk-test\') → 包络（enc:v1: 前缀 + base64）', () => {
    const out = mod.encrypt('sk-test');
    expect(out.startsWith(mod.ENVELOPE_PREFIX)).toBe(true);
    // base64 decode 应该回到我们 mock 用的 `ENC:sk-test`
    const b64 = out.slice(mod.ENVELOPE_PREFIX.length);
    const decoded = Buffer.from(b64, 'base64').toString('utf-8');
    expect(decoded).toBe('ENC:sk-test');
  });

  it('encrypt → decrypt 往返：明文完整恢复', () => {
    const original = 'sk-中文-emoji-🔑-whitespace \t';
    const enc = mod.encrypt(original);
    expect(enc.startsWith(mod.ENVELOPE_PREFIX)).toBe(true);
    expect(mod.decrypt(enc)).toBe(original);
  });

  it('encrypt 已经是包络的字符串 → 原样返回（幂等，防止套娃）', () => {
    const once = mod.encrypt('sk-x');
    const twice = mod.encrypt(once);
    expect(twice).toBe(once);
    // 验证 mock encryptString 只被调一次
    expect(encryptCalls).toEqual(['sk-x']);
  });

  it('decrypt(\'\') → \'\'', () => {
    expect(mod.decrypt('')).toBe('');
  });

  it('decrypt(null) / decrypt(undefined) → \'\'', () => {
    expect(mod.decrypt(null)).toBe('');
    expect(mod.decrypt(undefined)).toBe('');
  });

  it('decrypt 旧版明文（无前缀）→ 原样返回（懒迁移关键）', () => {
    // 模拟升级前 config.json 里的 plaintext key
    expect(mod.decrypt('sk-old-plaintext')).toBe('sk-old-plaintext');
  });

  it('decrypt 任意不含前缀的字符串 → 原样返回（防御性）', () => {
    expect(mod.decrypt('xxx')).toBe('xxx');
    expect(mod.decrypt('not-an-envelope-but-still-string')).toBe('not-an-envelope-but-still-string');
  });
});

describe('secret-store：safeStorage 不可用降级', () => {
  let warnSpy;
  let mod;

  beforeEach(async () => {
    mod = await loadModule();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    mod._reset();
    warnSpy.mockRestore();
  });

  it('isEncryptionAvailable() === false → encrypt 返回明文 + warn 一次', () => {
    mod._setSafeStorage({
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.from('SHOULD-NOT-BE-USED'),
      decryptString: () => 'SHOULD-NOT-BE-USED',
    });

    expect(mod.encrypt('sk-fallback')).toBe('sk-fallback');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/safeStorage 不可用/);
  });

  it('多次 encrypt 不可用 → 只 warn 一次（不重复打扰用户）', () => {
    mod._setSafeStorage({
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.from('x'),
      decryptString: () => 'x',
    });

    mod.encrypt('a');
    mod.encrypt('b');
    mod.encrypt('c');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('decrypt 遇到包络但 keyring 不可用 → 返回 \'\'（不抛）', () => {
    mod._setSafeStorage({
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.from('x'),
      decryptString: () => 'x',
    });
    // 模拟磁盘上有包络（base64 随便编）
    const fakeEnvelope = mod.ENVELOPE_PREFIX + Buffer.from('whatever', 'utf-8').toString('base64');
    expect(mod.decrypt(fakeEnvelope)).toBe('');
  });

  it('decrypt 遇到损坏包络（decryptString 抛错）→ 返回 \'\'（不抛）', () => {
    mod._setSafeStorage({
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(`ENC:${s}`),
      decryptString: () => {
        throw new Error('bad ciphertext');
      },
    });
    const fakeEnvelope = mod.ENVELOPE_PREFIX + Buffer.from('corrupt', 'utf-8').toString('base64');
    expect(() => mod.decrypt(fakeEnvelope)).not.toThrow();
    expect(mod.decrypt(fakeEnvelope)).toBe('');
  });

  it('isEncryptionAvailable 自身抛错 → isAvailable() 返回 false', () => {
    mod._setSafeStorage({
      isEncryptionAvailable: () => {
        throw new Error('keyring daemon crashed');
      },
      encryptString: () => Buffer.from('x'),
      decryptString: () => 'x',
    });
    expect(mod.isAvailable()).toBe(false);
  });
});

describe('secret-store：safeStorage 完全缺失', () => {
  let warnSpy;
  let mod;

  beforeEach(async () => {
    mod = await loadModule();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    mod._reset();
    warnSpy.mockRestore();
  });

  it('注入 null safeStorage（模拟 require(\'electron\') 无 safeStorage）→ 降级明文', () => {
    mod._setSafeStorage(null);
    // encrypt 走降级路径
    expect(mod.encrypt('sk-x')).toBe('sk-x');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('注入 null safeStorage + decrypt 包络 → 返回 \'\'', () => {
    mod._setSafeStorage(null);
    const fakeEnvelope = mod.ENVELOPE_PREFIX + Buffer.from('x', 'utf-8').toString('base64');
    expect(mod.decrypt(fakeEnvelope)).toBe('');
  });

  it('isAvailable 在无 safeStorage 时 → false', () => {
    mod._setSafeStorage(null);
    expect(mod.isAvailable()).toBe(false);
  });
});

describe('secret-store：_reset 状态隔离', () => {
  let mod;

  beforeEach(async () => {
    mod = await loadModule();
  });

  it('_reset 后 _setSafeStorage 重新注入 + warn 标志清零', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mod._setSafeStorage({
        isEncryptionAvailable: () => false,
        encryptString: () => Buffer.from('x'),
        decryptString: () => 'x',
      });
      mod.encrypt('a');
      mod.encrypt('b');
      expect(warnSpy).toHaveBeenCalledTimes(1);

      mod._reset();
      // 重新注入可用 safeStorage
      mod._setSafeStorage({
        isEncryptionAvailable: () => true,
        encryptString: (s) => Buffer.from(`E:${s}`),
        decryptString: (b) => b.toString('utf-8').slice(2),
      });
      // warn 标志清零，再次不可用时重新 warn
      mod._setSafeStorage({
        isEncryptionAvailable: () => false,
        encryptString: () => Buffer.from('x'),
        decryptString: () => 'x',
      });
      mod.encrypt('c');
      expect(warnSpy).toHaveBeenCalledTimes(2);
    } finally {
      warnSpy.mockRestore();
      mod._reset();
    }
  });
});
