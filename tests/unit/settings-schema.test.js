// Stage 7 tests: shared/settings-schema.js
//
// 覆盖：
//   - DEFAULT_SETTINGS：导出 + 含必要字段
//   - coerceLoadedSettings：未知字段剥除 / 已知字段合并默认值
//   - validateKey：enum / boolean / number clamp / nullable-path
//   - validateAndSanitize：批量校验，遇到非法字段提前失败
//
// shared/ 是 CommonJS，直接 require 即可（不像 main/ 需要 _setApp 注入）。

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(__dirname, '../../shared/settings-schema.js');

const schema = require('../../shared/settings-schema.js');
const {
  DEFAULT_SETTINGS,
  coerceLoadedSettings,
  validateKey,
  validateAndSanitize,
  SETTINGS_SCHEMA,
} = schema;

describe('DEFAULT_SETTINGS', () => {
  it('导出且包含核心字段', () => {
    expect(DEFAULT_SETTINGS).toBeDefined();
    expect(DEFAULT_SETTINGS.theme).toBeDefined();
    expect(DEFAULT_SETTINGS.themePalette).toBeDefined();
    expect(DEFAULT_SETTINGS.dataDir).toBeDefined();
    expect(DEFAULT_SETTINGS.alwaysOnTop).toBe(false);
  });

  it('AI 默认值：provider = openai；baseUrl / apiKey / model / systemPrompt 空串', () => {
    expect(DEFAULT_SETTINGS.aiProvider).toBe('openai');
    expect(DEFAULT_SETTINGS.aiBaseUrl).toBe('');
    expect(DEFAULT_SETTINGS.aiApiKey).toBe('');
    expect(DEFAULT_SETTINGS.aiModel).toBe('');
    expect(DEFAULT_SETTINGS.aiSystemPrompt).toBe('');
  });
});

describe('coerceLoadedSettings', () => {
  it('非对象 → 默认值', () => {
    expect(coerceLoadedSettings(null)).toEqual({ ...DEFAULT_SETTINGS });
    expect(coerceLoadedSettings('str')).toEqual({ ...DEFAULT_SETTINGS });
  });

  it('已知字段被 raw 覆盖', () => {
    const out = coerceLoadedSettings({ theme: 'light', readerFontSize: 19 });
    expect(out.theme).toBe('light');
    expect(out.readerFontSize).toBe(19);
  });

  it('未知字段被剥除', () => {
    const out = coerceLoadedSettings({ theme: 'light', bogus: 'x' });
    expect(out.theme).toBe('light');
    expect(out).not.toHaveProperty('bogus');
  });

  it('缺省字段用默认值', () => {
    const out = coerceLoadedSettings({ theme: 'light' });
    expect(out.theme).toBe('light');
    expect(out.themePalette).toBe(DEFAULT_SETTINGS.themePalette);
  });

  it('旧 autoSaveIntervalSec (0) → 迁移到 autoSaveDebounceMs (0)', () => {
    // 旧版 0 = 关闭；新版 0 = 关闭 —— 直接 1:1 映射
    const out = coerceLoadedSettings({ autoSaveIntervalSec: 0 });
    expect(out.autoSaveDebounceMs).toBe(0);
    expect(out).not.toHaveProperty('autoSaveIntervalSec');
  });

  it('旧 autoSaveIntervalSec (3 / 10) → 迁移到 autoSaveDebounceMs (500)', () => {
    // 旧版「开启」档（3 秒、10 秒轮询）→ 新版「500ms 防抖」
    // 语义从「每隔 X 秒轮询」变成「停打 X ms 后保存」；统一映射到 500ms 默认值。
    expect(coerceLoadedSettings({ autoSaveIntervalSec: 3 }).autoSaveDebounceMs).toBe(500);
    expect(coerceLoadedSettings({ autoSaveIntervalSec: 10 }).autoSaveDebounceMs).toBe(500);
  });

  it('autoSaveDebounceMs 越界 → clamp 到边界', () => {
    // 验证 number 类型规则生效：超界值被 clamp，不被丢弃
    expect(coerceLoadedSettings({ autoSaveDebounceMs: 99999 }).autoSaveDebounceMs).toBe(60000);
    expect(coerceLoadedSettings({ autoSaveDebounceMs: -100 }).autoSaveDebounceMs).toBe(0);
  });

  it('string 字段超长 → 丢弃回默认（同步路径用 rule.max）', () => {
    // 同步路径（coerceLoadedSettings / sanitizeSync）一直用 rule.max；本次 audit
    // 修复的是 async validateKey 误写 opts.max 的问题。两条路径必须保持一致。
    const out = coerceLoadedSettings({ aiModel: 'a'.repeat(10_000) });
    expect(out.aiModel).toBe(DEFAULT_SETTINGS.aiModel);
  });

  it('Phase N 修复：下划线前缀的元数据键（如 _hasAiKey）保留', () => {
    // 主进程 get-settings / save-settings 都会注入 _hasAiKey 作为「是否配置过 API Key」
    // 的只读元数据标记。旧实现只迭代 Object.keys(DEFAULT_SETTINGS)，未知键全 drop，
    // 导致 renderer settingsStore.load() 后拿不到 _hasAiKey，「显示已填 Key」+ reveal
    // 流程全失效。下划线前缀约定为「只读元数据、不写盘」，coerce 阶段需保留。
    const out = coerceLoadedSettings({ theme: 'dark', _hasAiKey: true });
    expect(out.theme).toBe('dark');
    expect(out._hasAiKey).toBe(true);
  });

  it('非下划线前缀的未知键仍被剥除（确保下划线特判不会过度放行）', () => {
    // 防御：下划线特判只放行 _ 前缀，普通 unknown 字段仍走原剥离路径，
    // 不让攻击者用 _privateName 这种「看上去像元数据」的字段把脏数据灌进内存。
    const out = coerceLoadedSettings({ theme: 'dark', _privateNote: 'secret', bogus: 42 });
    expect(out).not.toHaveProperty('_privateNote');
    expect(out).not.toHaveProperty('bogus');
  });

  // fix(audit 2026-08)：同步路径（sanitizeSync / coerceLoadedSettings）之前
  // 不校验 format 字段，导致手改 settings.json 写 aiBaseUrl: "ftp://x" /
  // "not-a-url" 会被静默接受，渲染端拿到无效 URL，真正 fetch 时才报 TypeError
  // 错误链很难定位到 settings。
  it('aiBaseUrl 非法 URL（同步路径） → 丢弃回默认空串', () => {
    expect(coerceLoadedSettings({ aiBaseUrl: 'ftp://x.y' }).aiBaseUrl).toBe('');
    expect(coerceLoadedSettings({ aiBaseUrl: 'not-a-url' }).aiBaseUrl).toBe('');
    expect(coerceLoadedSettings({ aiBaseUrl: 'javascript:alert(1)' }).aiBaseUrl).toBe('');
    // http:/missing-slash.com —— URL 构造器能解析但 fetch 行为不一致，必须拒绝
    expect(coerceLoadedSettings({ aiBaseUrl: 'http:/missing-slash.com' }).aiBaseUrl).toBe('');
  });

  it('aiBaseUrl 合法 http(s) URL（同步路径） → 保留', () => {
    expect(coerceLoadedSettings({ aiBaseUrl: 'https://api.openai.com/v1' }).aiBaseUrl).toBe(
      'https://api.openai.com/v1',
    );
    expect(coerceLoadedSettings({ aiBaseUrl: 'http://10.0.0.1:11434/v1' }).aiBaseUrl).toBe(
      'http://10.0.0.1:11434/v1',
    );
  });

  // fix(audit 2026-08)：Boolean 输入不应被 Number() 强转。
  // Number(true) === 1、Number(false) === 0，旧版会让 autoSaveDebounceMs: true
  // 静默变 1ms（激进到每个 keystroke 都存），splitRatio: false 变 0（无预览）。
  it('number 字段 Boolean 输入 → 丢弃回默认', () => {
    expect(coerceLoadedSettings({ autoSaveDebounceMs: true }).autoSaveDebounceMs)
      .toBe(DEFAULT_SETTINGS.autoSaveDebounceMs);
    expect(coerceLoadedSettings({ splitRatio: false }).splitRatio)
      .toBe(DEFAULT_SETTINGS.splitRatio);
    expect(coerceLoadedSettings({ readerFontSize: true }).readerFontSize)
      .toBe(DEFAULT_SETTINGS.readerFontSize);
  });

  // fix(audit 2026-08)：round:1 会把 1.85 静默四舍五入到 1.9。UI 选项列出
  // 的是 [1.5, 1.7, 1.85, 2.0] 两位小数，round:2 才能保留用户的选择。
  it('readerLineHeight 1.85 不会被四舍五入到 1.9', () => {
    expect(coerceLoadedSettings({ readerLineHeight: 1.85 }).readerLineHeight).toBe(1.85);
    expect(coerceLoadedSettings({ readerLineHeight: 1.7 }).readerLineHeight).toBe(1.7);
    expect(coerceLoadedSettings({ readerLineHeight: 2.0 }).readerLineHeight).toBe(2.0);
  });
});

describe('validateKey', () => {
  it('enum 合法值 → ok', async () => {
    const r = await validateKey('theme', 'light');
    expect(r.ok).toBe(true);
    expect(r.value).toBe('light');
  });

  it('enum 非法值 → 报错', async () => {
    const r = await validateKey('theme', 'rainbow');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/theme 取值非法/);
  });

  it('boolean 非法类型 → 报错', async () => {
    const r = await validateKey('alwaysOnTop', 'yes');
    expect(r.ok).toBe(false);
  });

  it('number clamp 越界 → clamp 到边界', async () => {
    const tooBig = await validateKey('readerFontSize', 99);
    expect(tooBig.ok).toBe(true);
    expect(tooBig.value).toBe(SETTINGS_SCHEMA.readerFontSize.max);

    const tooSmall = await validateKey('readerFontSize', 1);
    expect(tooSmall.ok).toBe(true);
    expect(tooSmall.value).toBe(SETTINGS_SCHEMA.readerFontSize.min);
  });

  it('number 非数字 → 报错', async () => {
    const r = await validateKey('readerFontSize', 'big');
    expect(r.ok).toBe(false);
  });

  it('nullable-path 空字符串 → null', async () => {
    const r = await validateKey('dataDir', '   ');
    expect(r.ok).toBe(true);
    expect(r.value).toBe(null);
  });

  // audit fix (Round 9)：nullable-number 与 number 分支对称拒绝空串。
  // 旧版 `case 'nullable-number'` 直接 `Number(raw)` → Number('') === 0 →
  // clamp 到 min，sidebarWidth='' 会被静默改成 200（默认 min）。
  it('nullable-number 空字符串 → 报错（不是 0）', async () => {
    const r = await validateKey('sidebarWidth', '');
    expect(r.ok).toBe(false);
  });

  it('nullable-number 全空白字符串 → 报错', async () => {
    const r = await validateKey('sidebarWidth', '   ');
    expect(r.ok).toBe(false);
  });

  it('nullable-number null → null（合法）', async () => {
    const r = await validateKey('sidebarWidth', null);
    expect(r.ok).toBe(true);
    expect(r.value).toBe(null);
  });

  it('nullable-number undefined → 视为 null（与同步路径一致）', async () => {
    // 审计修复 (Round 11 deep-fix P2-3)：nullable 字段的 undefined 与 null 同义。
    // 旧版 async 路径把 undefined 当作错误（与同步 sanitizeSync 行为不一致），
    // 导致 load() 接受 + update() 拒绝同一字段。
    const r = await validateKey('sidebarWidth', undefined);
    expect(r.ok).toBe(true);
    expect(r.value).toBeNull();
  });

  it('nullable-path 非字符串 → 报错', async () => {
    const r = await validateKey('dataDir', 123);
    expect(r.ok).toBe(false);
  });

  it('未知字段 → 报错', async () => {
    const r = await validateKey('unknown', 'anything');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/未知设置项/);
  });

  it('autoSaveDebounceMs 合法值 0 / 500 / 60000', async () => {
    expect((await validateKey('autoSaveDebounceMs', 0)).ok).toBe(true);
    expect((await validateKey('autoSaveDebounceMs', 500)).ok).toBe(true);
    expect((await validateKey('autoSaveDebounceMs', 60000)).ok).toBe(true);
  });

  it('autoSaveDebounceMs 越界 → clamp', async () => {
    // -1 → 0；99999 → 60000（clamp 行为）
    expect((await validateKey('autoSaveDebounceMs', -1)).value).toBe(0);
    expect((await validateKey('autoSaveDebounceMs', 99999)).value).toBe(60000);
  });

  it('autoSaveDebounceMs 非数字 → 报错', async () => {
    const r = await validateKey('autoSaveDebounceMs', 'soon');
    expect(r.ok).toBe(false);
  });

  it('aiProvider openai / anthropic → ok', async () => {
    expect((await validateKey('aiProvider', 'openai')).value).toBe('openai');
    expect((await validateKey('aiProvider', 'anthropic')).value).toBe('anthropic');
  });

  it('aiProvider 非法值 → 报错', async () => {
    const r = await validateKey('aiProvider', 'gemini');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/aiProvider 取值非法/);
  });

  it('string 字段超过 rule.max → 报错', async () => {
    // audit fix：之前误用 opts.max，导致 aiApiKey/aiBaseUrl/aiModel/aiSystemPrompt
    // 声明的字符上限从未生效。这里锁定 rule.max 路径。
    expect((await validateKey('aiModel', 'a'.repeat(257))).ok).toBe(false);
    expect((await validateKey('aiBaseUrl', 'a'.repeat(4097))).ok).toBe(false);
    expect((await validateKey('aiApiKey', 'k'.repeat(4097))).ok).toBe(false);
    expect((await validateKey('aiSystemPrompt', 'x'.repeat(200_001))).ok).toBe(false);
  });

  it('string 字段在 rule.max 范围内 → ok', async () => {
    expect((await validateKey('aiModel', 'a'.repeat(256))).ok).toBe(true);
    // aiBaseUrl 现在带 url-https 格式校验 —— 用合法 URL 串代替 'a'.repeat，
    // 否则 URL 校验会拒绝非 URL 字符。最大长度限制的覆盖由上面的「超长」
    // 测试用例保证。12 字符 scheme/host + 4084 字符 path = 4096 总长。
    expect((await validateKey('aiBaseUrl', 'https://a.aa/' + 'a'.repeat(4083))).ok).toBe(true);
    expect((await validateKey('aiApiKey', 'k'.repeat(4096))).ok).toBe(true);
    expect((await validateKey('aiSystemPrompt', 'x'.repeat(200_000))).ok).toBe(true);
  });

  it('string 字段超长错误信息含上限值', async () => {
    const r = await validateKey('aiModel', 'a'.repeat(257));
    expect(r.error).toMatch(/超过 256 字符/);
  });
});

describe('validateAndSanitize', () => {
  it('合法 batch → 返回 sanitized 对象', async () => {
    const r = await validateAndSanitize({ theme: 'light', readerFontSize: 18 });
    expect(r.ok).toBe(true);
    expect(r.sanitized.theme).toBe('light');
    expect(r.sanitized.readerFontSize).toBe(18);
  });

  it('任一字段非法 → 整个失败', async () => {
    const r = await validateAndSanitize({ theme: 'light', readerFontSize: 'huge' });
    expect(r.ok).toBe(false);
  });

  it('非对象 → 报错', async () => {
    expect((await validateAndSanitize(null)).ok).toBe(false);
    expect((await validateAndSanitize('str')).ok).toBe(false);
    expect((await validateAndSanitize([])).ok).toBe(false);
  });

  it('空对象 → 空 sanitized', async () => {
    const r = await validateAndSanitize({});
    expect(r.ok).toBe(true);
    expect(r.sanitized).toEqual({});
  });
});

// ------------------------------------------------------------------
// AI 字段的「空串是合法值」契约
//
// settings-dialog.js:303-326「清空 AI 配置」按钮依赖此契约：按钮设
// aiKeyInput.value = ''，保存时 diff 检测 '' !== initial.aiApiKey → patch 含
// aiApiKey: ''，走 settingsStore.update → settings-schema 校验 → 写盘。
// 若未来 schema 把 '' 改成 null / undefined 或拒绝空串，清空按钮会无声失效。
// ------------------------------------------------------------------
describe('AI 字段空串是合法值（清空按钮依赖此契约）', () => {
  it('aiApiKey: "" → 接受且保留为空串', async () => {
    const r = await validateAndSanitize({ aiApiKey: '' });
    expect(r.ok).toBe(true);
    expect(r.sanitized.aiApiKey).toBe('');
  });

  it('aiBaseUrl / aiModel / aiSystemPrompt 同时清空 → 全部接受', async () => {
    const r = await validateAndSanitize({
      aiApiKey: '',
      aiBaseUrl: '',
      aiModel: '',
      aiSystemPrompt: '',
    });
    expect(r.ok).toBe(true);
    expect(r.sanitized.aiApiKey).toBe('');
    expect(r.sanitized.aiBaseUrl).toBe('');
    expect(r.sanitized.aiModel).toBe('');
    expect(r.sanitized.aiSystemPrompt).toBe('');
  });

  it('aiApiKey: 任意非空串 → 接受且原样保留', async () => {
    const r = await validateAndSanitize({ aiApiKey: 'sk-abc-123' });
    expect(r.ok).toBe(true);
    expect(r.sanitized.aiApiKey).toBe('sk-abc-123');
  });
});

// ------------------------------------------------------------------
// nullable-string 类型支持
//
// audit fix：validateKey / sanitizeSync 的 switch 之前没有 nullable-string
// case，遇到该类型的字符串值会落到 default → 「类型未定义」错误。
// 当前 schema 没有 nullable-string 字段（aiApiKey 等用 string + 主进程判空），
// 这里用代码存在性测试锁定修复，避免未来回归。
// ------------------------------------------------------------------
describe('nullable-string 类型支持（audit fix）', () => {
  const source = readFileSync(SCHEMA_PATH, 'utf8');

  it('validateKey 的 switch 含 nullable-string case', () => {
    // 提取 validateKey 函数体的 switch 段，断言其中含 case 'nullable-string'
    const match = source.match(/async function validateKey[\s\S]*?^}/m);
    expect(match, 'validateKey 函数必须存在').toBeTruthy();
    expect(match[0]).toMatch(/case\s+['"]nullable-string['"]\s*:/);
  });

  it('sanitizeSync 的 switch 含 nullable-string case', () => {
    // sanitizeSync 没有 async/function 关键字前缀 —— 直接匹配函数签名
    const match = source.match(/function sanitizeSync[\s\S]*?^}/m);
    expect(match, 'sanitizeSync 函数必须存在').toBeTruthy();
    expect(match[0]).toMatch(/case\s+['"]nullable-string['"]\s*:/);
  });

  it('nullable-string 校验含 max 长度检查（与 string 一致）', () => {
    const validateMatch = source.match(/async function validateKey[\s\S]*?^}/m);
    expect(validateMatch).toBeTruthy();
    // nullable-string case 内必须包含 rule.max 长度检查
    const nullableCase = validateMatch[0].match(/case\s+['"]nullable-string['"]\s*:[\s\S]*?(?=\n\s+case\s|\n\s+default|\n\s+\})/);
    expect(nullableCase, 'validateKey 必须有 nullable-string case 体').toBeTruthy();
    expect(nullableCase[0]).toMatch(/rule\.max/);
  });
});

// ------------------------------------------------------------------
// Round 4 P1-1：nullable-path 同步路径空串归一为 null
//
// 之前 sanitizeSync 直接返回 ''，与 validateKey 异步路径归一为 null 不同步。
// coerceLoadedSettings 把磁盘上残留的 "dataDir": "" 保留为 ''，但 validateKey
// 会归一为 null → 任何依赖 dataDir === null 判断的代码失配。
// ------------------------------------------------------------------
describe('nullable-path 同步路径空串归一为 null（Round 4 P1-1）', () => {
  it('coerceLoadedSettings 把 dataDir: "" 归一为 null', () => {
    const result = coerceLoadedSettings({ ...DEFAULT_SETTINGS, dataDir: '' });
    expect(result.dataDir).toBe(null);
  });

  it('coerceLoadedSettings 把 dataDir: "  "（纯空白）归一为 null', () => {
    const result = coerceLoadedSettings({ ...DEFAULT_SETTINGS, dataDir: '   ' });
    expect(result.dataDir).toBe(null);
  });

  it('coerceLoadedSettings 把 dataDir: "/some/path" 原样保留', () => {
    const result = coerceLoadedSettings({ ...DEFAULT_SETTINGS, dataDir: '/some/path' });
    expect(result.dataDir).toBe('/some/path');
  });

  it('dataDir: null 仍是 null（不破坏既有契约）', () => {
    const result = coerceLoadedSettings({ ...DEFAULT_SETTINGS, dataDir: null });
    expect(result.dataDir).toBe(null);
  });
});

// ------------------------------------------------------------------
// Round 4 P2-3：nullable-number typeof 守卫对称
//
// 原版无 typeof 守卫，Number(true) === 1 隐式通过 isFinite。
// 当前 schema 用 nullable-number 的字段（sidebarWidth / aiWidth）min 检查
// 会拦下 1，但语义与 number 不一致 —— 加 typeof 守卫保持两条路径对称。
// ------------------------------------------------------------------
describe('nullable-number typeof 守卫对称（Round 4 P2-3）', () => {
  it('sidebarWidth: true → 拒绝（typeof 不匹配）', () => {
    const r = coerceLoadedSettings({ ...DEFAULT_SETTINGS, sidebarWidth: true });
    // sidebarWidth 不在 coerce 结果里（或保留 default），绝不能是 1
    expect(r.sidebarWidth).not.toBe(1);
  });

  it('sidebarWidth: false → 拒绝', () => {
    const r = coerceLoadedSettings({ ...DEFAULT_SETTINGS, sidebarWidth: false });
    expect(r.sidebarWidth).not.toBe(0);
  });

  it('sidebarWidth: 250 → 接受', () => {
    const r = coerceLoadedSettings({ ...DEFAULT_SETTINGS, sidebarWidth: 250 });
    expect(r.sidebarWidth).toBe(250);
  });

  it('sidebarWidth: "300" → 接受（字符串数字合法）', () => {
    const r = coerceLoadedSettings({ ...DEFAULT_SETTINGS, sidebarWidth: '300' });
    expect(r.sidebarWidth).toBe(300);
  });

  it('sidebarWidth: null → 仍是 null', () => {
    const r = coerceLoadedSettings({ ...DEFAULT_SETTINGS, sidebarWidth: null });
    expect(r.sidebarWidth).toBe(null);
  });
});

describe('SETTINGS_UI_OPTIONS.aiProvider[*].defaults (audit T-4)', () => {
  // T-4 把原本散在 src/settings-dialog.js 顶部的 AI_DEFAULTS（baseURL + model
  // 占位符）迁到这里与 label / hint 同源。settings-dialog 通过
  // getAiProviderDefaults(value) 查表，schema 是唯一事实源。
  //
  // 这里保护：
  //   1. 两个 provider 都必须有 defaults 字段（不能让 placeholder 退化成空串）
  //   2. defaults 必须含 baseUrl + model 两个 string 字段
  //   3. 默认 baseUrl 必须与 provider 的协议约定一致 —— OpenAI 含 /v1，
  //      Anthropic 不含；否则用户在空白字段看到错误提示就会按 placeholder 填错。
  const { SETTINGS_UI_OPTIONS } = schema;
  const providers = SETTINGS_UI_OPTIONS.aiProvider;

  it('OpenAI 兼容项的 defaults 含 /v1 + model', () => {
    const p = providers.find((x) => x.value === 'openai');
    expect(p?.defaults, 'openai 项必须有 defaults 字段').toBeDefined();
    expect(typeof p.defaults.baseUrl).toBe('string');
    expect(typeof p.defaults.model).toBe('string');
    expect(p.defaults.baseUrl.endsWith('/v1'), 'OpenAI 兼容默认 baseURL 必须以 /v1 结尾').toBe(true);
  });

  it('Anthropic 兼容项的 defaults 不含 /v1', () => {
    const p = providers.find((x) => x.value === 'anthropic');
    expect(p?.defaults).toBeDefined();
    expect(p.defaults.baseUrl.endsWith('/v1'), 'Anthropic 默认 baseURL 不能含 /v1 后缀').toBe(false);
    expect(p.defaults.baseUrl.length).toBeGreaterThan(0);
    expect(p.defaults.model.length).toBeGreaterThan(0);
  });

  it('所有 aiProvider 项都覆盖 defaults（新增 provider 时强制填齐）', () => {
    for (const p of providers) {
      expect(p.defaults, `${p.value} 缺 defaults`).toBeDefined();
      expect(typeof p.defaults.baseUrl, `${p.value}.defaults.baseUrl 不是 string`).toBe('string');
      expect(typeof p.defaults.model, `${p.value}.defaults.model 不是 string`).toBe('string');
    }
  });

  it('defaults 字段被 Object.freeze 保护（防运行时突变）', () => {
    const p = providers.find((x) => x.value === 'openai');
    // Object.freeze 在严格模式写入会抛错；非严格模式静默失败（settings-dialog 是
    // ESM 在 module top-level 加载时是 strict，但 try/catch 包住更稳）。
    expect(() => { p.defaults.baseUrl = 'http://evil'; }).toThrow();
    expect(p.defaults.baseUrl).toBe('https://api.openai.com/v1');
  });
});

// 2026-10 加：fileListSort 排序下拉的 schema 契约 —— enum 与 UI 选项表必须同源，
// renderer 从两端派生（FILE_LIST_SORT_VALUES / FILE_LIST_SORT_OPTIONS）。
// 任一端漏更新 → 排序下拉菜单少一项或多出非法值。
describe('fileListSort 排序下拉契约（2026-10 dropdown 改造）', () => {
  const schema = require('../../shared/settings-schema.js');
  const { SETTINGS_UI_OPTIONS, SETTINGS_SCHEMA } = schema;
  const sortSpec = SETTINGS_SCHEMA.fileListSort;
  const uiOptions = SETTINGS_UI_OPTIONS.fileListSort;

  it('SETTINGS_SCHEMA.fileListSort.enum 与 SETTINGS_UI_OPTIONS.fileListSort[*].value 完全一致', () => {
    const enumValues = sortSpec.enum;
    const uiValues = uiOptions.map((o) => o.value);
    // 用 toEqual 而非 toBe —— 顺序也得一致（dropdown 顺序由 enum 决定）
    expect(uiValues).toEqual(enumValues);
  });

  it('每项 UI 选项都含 value + label + hint 三个字段', () => {
    uiOptions.forEach((opt) => {
      expect(typeof opt.value).toBe('string');
      expect(typeof opt.label).toBe('string');
      expect(typeof opt.hint).toBe('string');
      expect(opt.label.length).toBeGreaterThan(0);
      expect(opt.hint.length).toBeGreaterThan(0);
    });
  });

  it('enum 至少 2 项 —— dropdown 设计要求比并排按钮更多选项', () => {
    // 设计动机：原并排 2 按钮在 220px 侧栏下「修改时间」会被截断；改下拉后
    // 至少要有「按名称 A→Z」「按修改时间 新→旧」两项作为基础集合。
    expect(sortSpec.enum.length).toBeGreaterThanOrEqual(2);
  });

  it('DEFAULT_SETTINGS.fileListSort === schema.enum[0] === UI options[0].value（保证 fallback / 旧值不会静默被 coerce）', () => {
    // 三处必须相等：
    //   1) DEFAULT_SETTINGS.fileListSort —— 新装用户的初始值
    //   2) schema.enum[0] —— validateAndSanitize 接受的默认值会回到这个
    //   3) SETTINGS_UI_OPTIONS.fileListSort[0].value —— 下拉默认选中项
    // 谁漏改谁静默失效：例如把 DEFAULT 改成 'mtime-desc' 但 enum/uiOptions 不动，
    // validateAndSanitize 会把它强制降回 'name'，用户看 UI 永远停在 name。
    expect(DEFAULT_SETTINGS.fileListSort).toBe(sortSpec.enum[0]);
    expect(DEFAULT_SETTINGS.fileListSort).toBe(SETTINGS_UI_OPTIONS.fileListSort[0].value);
  });
});
