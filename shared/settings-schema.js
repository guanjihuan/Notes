// 设置 schema —— 单一事实源
// ============================================================================
//
// 这是 main / preload / renderer 三处设置定义的唯一权威来源。
// 之前四处漂移（main.js 的 DEFAULT_CONFIG + save-settings 80 行校验链 + renderer
// DEFAULT_SETTINGS + settings-dialog 的选项表）统一收敛到本文件：
//
//   • DEFAULT_SETTINGS       — 各键的默认值
//   • SETTINGS_SCHEMA        — 每键的 type / enum / min / max / custom validator
//   • validateAndSanitize()  — 用 schema 校验+clamp+enumeration
//   • SETTINGS_UI_OPTIONS    — 对话框用的枚举列表（readerFontSize / palette / sort）
//
// 加载方式：
//   • main.js / preload.js（CJS）：const schema = require('../shared/settings-schema.js')
//   • renderer：经 preload contextBridge 过桥（window.api.settingsSchema / coerceLoadedSettings）
//     —— renderer 跑在 Chromium 原生 ESM，不能直接 import CJS（无 CJS 互操作），
//     .cjs / .js 扩展名都不能解决这个问题，文件 *格式* 决定有没有 named export。
//     所以 renderer 拿到的始终是经 preload 包装过的纯数据 / 函数，schema 内部
//     结构不暴露。
//
// 新增/修改设置项流程：
//   1. 在 DEFAULT_SETTINGS 加默认值
//   2. 在 SETTINGS_SCHEMA 加类型/范围/枚举/自定义校验
//   3. 若需要在 UI 显示，在 SETTINGS_UI_OPTIONS 加选项
//   4. 跑 npm run check 验证 — validateAndSanitize 会用 schema 拒绝非法值
// ============================================================================

'use strict';

/**
 * 默认值（单一事实源）。所有键都在这里定义，缺一不可。
 * @type {Readonly<Record<string, *>>}
 */
const DEFAULT_SETTINGS = Object.freeze({
  dataDir: null,           // null = 用主进程默认目录（home/Notes）
  theme: 'dark',           // 'dark' | 'light'
  themePalette: 'default', // 调色板 ID（见 SETTINGS_UI_OPTIONS.palettes）
  alwaysOnTop: false,
  editorMode: 'split',     // 'preview' | 'edit' | 'split' — 默认双栏
  readerFontSize: 17,      // 阅读字号 (px)，范围 12..24
  readerLineHeight: 1.85,  // 阅读行距，范围 1.4..2.2
  fileListSort: 'name',    // 'name' | 'mtime-desc'
  autoSaveDebounceMs: 500, // 自动保存防抖延迟（ms）；0 = 关闭；默认 500ms = 「停打后立刻存」
  splitRatio: 0.5,         // 双栏模式左侧占比 0.2..0.8
  sidebarWidth: null,       // 侧栏拖拽后的宽度（px）；null = 使用 CSS 默认 --w-sidebar
  aiWidth: null,            // AI 中间面板拖拽后的宽度（px）；null = 使用 CSS 默认 --w-ai
  focusMode: false,         // 聚焦模式：隐藏工具栏/侧栏/状态栏；Ctrl+Shift+F 切换
  // AI 修改功能（用户自填 API Key / BaseURL / Model / System Prompt）
  // 详见 main/ai.js。空值时 AI 入口点击会提示去设置。
  aiProvider: 'openai',     // 'openai' | 'anthropic' —— 决定 main/ai.js 走哪条协议
  aiBaseUrl: '',            // baseURL：OpenAI 含 /v1（如 https://api.openai.com/v1）；Anthropic 不含（如 https://api.anthropic.com）
  aiApiKey: '',             // API Key（敏感数据；只在主进程内存里使用，不写日志）
  aiModel: '',              // 模型名；OpenAI 如 gpt-4o-mini；Anthropic 如 claude-opus-5
  aiSystemPrompt: '',       // 自定义系统提示词；空 = 用 main/ai.js 内置中文 prompt
});

/**
 * 每个键的校验规则。
 *   type:    'string' | 'number' | 'boolean' | 'enum' | 'nullable-string' | 'nullable-path'
 *   enum?:   仅 enum 类型：允许的字面量数组
 *   min?:    number / integer / string(长度)
 *   max?:    number / integer / string(长度)
 *   clamp?:  number: 是否 clamp 到 [min,max]
 *   integer?:boolean   number 是否取整
 *   round?:  number: 保留几位小数
 *   choices?:Array<{value, label, hint?}>  UI 选项（仅供 dialog 渲染，不参与校验）
 *
 * 自定义校验（如 dataDir 必须存在）放在 validateAndSanitize() 里集中处理，
 * 因为它需要 fs 调用，不能纯声明式表达。
 *
 * @type {Readonly<Record<string, object>>}
 */
const SETTINGS_SCHEMA = Object.freeze({
  dataDir: {
    type: 'nullable-path',
    description: '数据目录；null = 用默认目录',
  },
  theme: {
    type: 'enum',
    enum: ['dark', 'light'],
    description: 'UI 主题',
  },
  themePalette: {
    type: 'enum',
    enum: ['default', 'ocean', 'forest', 'lavender', 'sunset'],
    description: '调色板',
  },
  alwaysOnTop: {
    type: 'boolean',
    description: '窗口置顶',
  },
  editorMode: {
    type: 'enum',
    enum: ['preview', 'edit', 'split'],
    description: '视图模式',
  },
  readerFontSize: {
    type: 'number',
    min: 12,
    max: 24,
    integer: true,
    clamp: true,
    description: '阅读字号 (px)',
  },
  readerLineHeight: {
    type: 'number',
    min: 1.4,
    max: 2.2,
    // fix(audit 2026-08)：round:1 会把 1.85 静默四舍五入到 1.9。UI 选项列出
    // 的是 [1.5, 1.7, 1.85, 2.0] 两位小数，round:2 才能保留用户的选择。
    round: 2,
    description: '阅读行距',
  },
  fileListSort: {
    type: 'enum',
    enum: ['name', 'mtime-desc'],
    description: '侧栏文件列表排序',
  },
  autoSaveDebounceMs: {
    type: 'number',
    min: 0,
    max: 60000,
    clamp: true,
    integer: true,
    description: '编辑停止后多少毫秒触发自动保存；0 = 关闭',
  },
  splitRatio: {
    type: 'number',
    min: 0.2,
    max: 0.8,
    round: 3,
    clamp: true,
    description: '双栏模式左侧占比',
  },
  sidebarWidth: {
    type: 'nullable-number',
    min: 120,
    max: 480,
    integer: true,
    description: '侧栏宽度 (px)；null = 用 CSS 默认',
  },
  aiWidth: {
    type: 'nullable-number',
    min: 220,
    max: 720,
    integer: true,
    description: 'AI 中间面板宽度 (px)；null = 用 CSS 默认 --w-ai (360)',
  },
  focusMode: {
    type: 'boolean',
    description: '聚焦模式（隐藏工具栏/侧栏/状态栏）',
  },
  aiProvider: {
    type: 'enum',
    enum: ['openai', 'anthropic'],
    description: 'AI 服务提供方：openai = /chat/completions；anthropic = /v1/messages',
  },
  aiBaseUrl: {
    type: 'string',
    // URL 不会超过几 KB，留 4 KB 足够；防止有人塞几 MB 把请求体打爆
    max: 4_096,
    // audit fix (#9 shared)：格式校验。空串放行（用户主动清空 = 关闭 AI）；
    // 非空必须是可解析的 http(s) URL，避免「abc / www.foo.com / file:///xxx」
    // 这类带空格 / 漏 scheme / 协议错误的值被静默接受，最后在主进程 fetch 时
    // 才抛 TypeError，错误信息很难定位到 settings。trim 后用 URL 解析，
    // 协议限定 http: 或 https:（不接 ftp / file / data 等）。
    format: 'url-https',
    description: 'baseURL：OpenAI 含 /v1（如 https://api.openai.com/v1）；Anthropic 不含（如 https://api.anthropic.com）',
  },
  aiApiKey: {
    // 密码字段：renderer 通过 IPC 传给主进程，不在 schema 校验链里打印
    type: 'string',
    // API key 通常 50~200 字符；留 4 KB 上限足够
    max: 4_096,
    description: 'API Key',
  },
  aiModel: {
    type: 'string',
    max: 256,
    description: '模型名',
  },
  aiSystemPrompt: {
    type: 'string',
    // 系统提示词较长是合理的，但单个几十 MB 的 prompt 会拖慢 JSON.stringify
    // 且让 AI 计费爆炸 —— 200 KB 对应约 5 万中文字，足够绝大多数场景
    max: 200_000,
    description: '自定义系统提示词；空 = 用内置默认',
  },
});

/**
 * UI 选项表 —— 仅供对话框渲染使用。
 * key 与 SETTINGS_SCHEMA 的 enum 对齐，但额外带 label / hint。
 * @type {Readonly<Record<string, ReadonlyArray<{value: *, label: string, hint?: string}>>>}
 */
const SETTINGS_UI_OPTIONS = Object.freeze({
  themePalette: Object.freeze([
    { value: 'default', label: '默认' },
    { value: 'ocean', label: '海洋' },
    { value: 'forest', label: '森林' },
    { value: 'lavender', label: '薰衣草' },
    { value: 'sunset', label: '夕阳' },
  ]),
  fileListSort: Object.freeze([
    { value: 'name', label: '按名称', hint: 'A → Z，localeCompare(zh-CN)' },
    { value: 'mtime-desc', label: '按修改时间', hint: '最近修改排在最前' },
  ]),
  // 自动保存不再需要枚举选项：debounce 延迟是连续数值（0..60000 ms），
// 由 toolbar 按钮直接 toggle 0 ↔ 500，UI 也不再有「选几秒」的下拉。
  readerFontSize: Object.freeze([14, 15, 17, 19, 22]),
  readerLineHeight: Object.freeze([1.5, 1.7, 1.85, 2.0]),
  // 两个选项都标"兼容"：突出是「按这个协议实现的兼容 API」而不是特定厂商；
  // 用户可填任意走该协议的 baseURL（中转、自部署、官方 API 都行）。
  aiProvider: Object.freeze([
    { value: 'openai', label: 'OpenAI 兼容', hint: '/chat/completions · 含 DeepSeek / Moonshot / Azure 等' },
    { value: 'anthropic', label: 'Anthropic 兼容', hint: '/v1/messages · Claude 系列 · 含第三方中转' },
  ]),
});

/**
 * 校验 + sanitize 单个键。
 * 返回 { ok:true, value } 或 { ok:false, error }。
 *
 * @param {string} key
 * @param {*} raw
 * @param {object} [opts] - { resolveDir?: async (path) => { ok, error? } }
 *                          注入目录存在性校验（默认走 fs，调用方可传 mock）
 * @returns {Promise<{ok: true, value: *} | {ok: false, error: string}>}
 */
async function validateKey(key, raw, opts = {}) {
  const rule = SETTINGS_SCHEMA[key];
  if (!rule) {
    // 未知键直接拒绝（防止 renderer 误传）
    return { ok: false, error: `未知设置项: ${key}` };
  }

  // nullable 类型：null 一律放行
  if ((rule.type === 'nullable-string' || rule.type === 'nullable-path' || rule.type === 'nullable-number') && raw === null) {
    return { ok: true, value: null };
  }

  // 类型分发
  switch (rule.type) {
    case 'nullable-path': {
      if (typeof raw !== 'string') return { ok: false, error: `${key} 必须是字符串或 null` };
      const trimmed = raw.trim();
      if (!trimmed) return { ok: true, value: null };
      if (opts.resolveDir) {
        const r = await opts.resolveDir(trimmed);
        if (!r.ok) return { ok: false, error: r.error };
      }
      return { ok: true, value: trimmed };
    }
    case 'nullable-string': {
      if (typeof raw !== 'string') return { ok: false, error: `${key} 必须是字符串或 null` };
      if (typeof rule.max === 'number' && raw.length > rule.max) {
        return { ok: false, error: `${key} 过长（超过 ${rule.max} 字符）` };
      }
      return { ok: true, value: raw };
    }
    case 'string': {
      if (typeof raw !== 'string') return { ok: false, error: `${key} 必须是字符串` };
      // P2 fix：trim 首尾空白 —— 用户复制粘贴 AI Key / Model 经常带回车 / 空格，
      // 不 trim 会让 main/ai.js 把它当字面量放进 Authorization header / 请求体，
      // 服务端校验「key 不匹配」但错误信息没有「多打了空格」的提示，用户无从下手。
      // 用户手动改 settings.json 也经常留尾空格。
      const trimmed = raw.trim();
      // rule.max 限定字符串长度 —— 防止几 MB 的值把请求体撑爆 / 拖慢序列化。
      // 用户看到的错误直接说"过长"，避免报"非法 JSON"。
      // （audit fix：之前误写成 opts.max，导致 aiApiKey/aiBaseUrl/aiModel/
      //   aiSystemPrompt 声明的上限从未生效。）
      if (typeof rule.max === 'number' && trimmed.length > rule.max) {
        return { ok: false, error: `${key} 过长（超过 ${rule.max} 字符）` };
      }
      // audit fix (#9 shared)：可选 format 校验。空串放行（清空合法）；
      // 非空按 format 规则走，失败给中文错误。
      if (trimmed && rule.format === 'url-https') {
        let parsed;
        try {
          parsed = new URL(trimmed);
        } catch {
          return { ok: false, error: `${key} 不是合法的 URL（需以 http:// 或 https:// 开头）` };
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return { ok: false, error: `${key} 必须是 http(s) URL（当前协议 ${parsed.protocol}）` };
        }
      }
      return { ok: true, value: trimmed };
    }
    case 'boolean': {
      if (typeof raw !== 'boolean') return { ok: false, error: `${key} 必须是布尔` };
      return { ok: true, value: raw };
    }
    case 'number': {
      // audit C3：拒绝 null / undefined / 空串 / 非数字 —— Number('') === 0 会
      // 让 `readerFontSize: ''` 静默通过 clamp 到 min；这是 bug，不是「合法 0」。
      // 合法输入：实际数字 或 非空数字字符串。
      if (raw === null || raw === undefined) {
        return { ok: false, error: `${key} 必须是数字` };
      }
      if (typeof raw === 'string' && raw.trim() === '') {
        return { ok: false, error: `${key} 必须是数字` };
      }
      const n = Number(raw);
      if (!Number.isFinite(n)) return { ok: false, error: `${key} 必须是数字` };
      let v = n;
      if (rule.clamp && (v < rule.min || v > rule.max)) {
        v = Math.min(Math.max(v, rule.min), rule.max);
      }
      if (rule.integer) v = Math.round(v);
      if (typeof rule.round === 'number') {
        const k = 10 ** rule.round;
        v = Math.round(v * k) / k;
      }
      if (v < rule.min || v > rule.max) {
        return { ok: false, error: `${key} 超出范围 [${rule.min}, ${rule.max}]` };
      }
      return { ok: true, value: v };
    }
    case 'nullable-number': {
      // audit fix (Round 9)：与 'number' 分支对齐显式拒绝 null / undefined /
      // 空串 / 非数字。Number('') === 0 会让 nullable-number 字段把空串静默
      // 转成 0 再 clamp 到 min —— 与上面 'number' 分支同款 bug。null 是
      // 合法值（保留为 null，让 UI 显示「未设置」），但空串 / 非数字必须拒绝。
      //
      // 审计修复 (Round 11 deep-fix P2-3)：undefined 在 nullable 字段应等价于 null。
      // 旧版异步路径拒绝 undefined → 同步 sanitizeSync 路径却把 undefined 当作 null；
      // 手改 config.json 时如果字段被删（JSON.stringify 会序列化成 undefined → 字段缺失，
      // 但 settings-dialog applySetting 走异步路径）会出现 update() reject / load() accept 的不对称。
      // 现在 undefined 走「视为 null」分支。
      if (raw === null || raw === undefined) return { ok: true, value: null };
      if (typeof raw === 'string' && raw.trim() === '') {
        return { ok: false, error: `${key} 必须是数字或 null` };
      }
      const n = Number(raw);
      if (!Number.isFinite(n)) return { ok: false, error: `${key} 必须是数字或 null` };
      let v = n;
      if (rule.integer) v = Math.round(v);
      if (v < rule.min || v > rule.max) {
        return { ok: false, error: `${key} 超出范围 [${rule.min}, ${rule.max}]` };
      }
      return { ok: true, value: v };
    }
    case 'enum': {
      // enum：值在列表内即放行（兼容 string / number 字面量；如 0 也要命中）
      const allowed = rule.enum.some((e) => e === raw) ||
        (typeof raw === 'string' && rule.enum.includes(raw));
      if (!allowed) return { ok: false, error: `${key} 取值非法: ${raw}` };
      return { ok: true, value: raw };
    }
    default:
      return { ok: false, error: `${key} 类型未定义: ${rule.type}` };
  }
}

/**
 * 批量校验 + sanitize。
 * 跳过未在 partial 里出现的键（局部更新）。
 *
 * @param {object} partial
 * @param {object} [opts] - 同 validateKey
 * @returns {Promise<{ok: true, sanitized: object} | {ok: false, error: string}>}
 */
async function validateAndSanitize(partial, opts = {}) {
  if (!partial || typeof partial !== 'object' || Array.isArray(partial)) {
    return { ok: false, error: '请求体必须是对象' };
  }
  /** @type {Record<string, *>} */
  const sanitized = {};
  for (const key of Object.keys(partial)) {
    const r = await validateKey(key, partial[key], opts);
    if (!r.ok) return r;
    sanitized[key] = r.value;
  }
  return { ok: true, sanitized };
}

/**
 * 与默认合并 + 校验完整 settings 对象（启动 / 读取配置文件时用）。
 *
 * 同步校验 —— 故意不 await fs 检查 dataDir 存在性（load 阶段不阻塞）；
 * dataDir 存在性推迟到 settings-store.update 时再走 validateAndSanitize。
 * 但同步可校验的部分（enum / 范围 / 类型）必须现在就做，否则手改的
 * config.json 会把整个 UI 弄坏（audit #8）。
 *
 * @param {*} raw
 * @returns {Record<string, *>}
 */
function coerceLoadedSettings(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_SETTINGS };
  }

  // 旧版 autoSaveIntervalSec (enum: 0/3/10 秒 轮询) → autoSaveDebounceMs (ms 防抖)
  // 语义变了：「每隔 X 秒轮询」变成「停打 X ms 后保存」。所有「开启」档位
  // （旧 3 秒、10 秒）一律映射到新的 500ms 默认值，避免老用户升级后自动保存
  // 突然变得非常激进（1s 内反复触发）或太迟（10s 才一次）。
  if ('autoSaveIntervalSec' in raw) {
    const old = raw.autoSaveIntervalSec;
    if (!('autoSaveDebounceMs' in raw)) {
      const offish = old === 0 || old === '0' || old === false;
      raw.autoSaveDebounceMs = offish ? 0 : 500;
    }
    delete raw.autoSaveIntervalSec;
  }

  /** @type {Record<string, *>} */
  const out = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (!(key in raw)) continue;
    const sanitized = sanitizeSync(key, raw[key]);
    // sanitizeSync 返回 undefined 表示「未知键 / 不可修复」，跳过即可
    if (sanitized !== undefined) out[key] = sanitized;
  }
  // Phase N 修复：保留白名单内的 `_`-前缀元数据键（当前只有 `_hasAiKey`）。
  // 之前只迭代 Object.keys(DEFAULT_SETTINGS) 把未声明的键全 drop —— get-settings
  // 返回的 `_hasAiKey: !!cfg.aiApiKey` 在 coerce 阶段被吃掉，renderer 永远拿不到
  // "已配置 API Key" 信号，"显示已填 key" + reveal 流程全失效。
  //
  // 防御：必须用白名单而不是"所有下划线前缀键都过"。否则攻击者 / 误用方可用
  // `_xxx` 形式把任意字段塞进内存 settings（虽然不会写盘，但能在内存里残留）。
  // 白名单维护成本低（已知元数据键只有少数几个），但放行成本高。
  const METADATA_KEYS = new Set(['_hasAiKey']);
  for (const key of Object.keys(raw)) {
    if (METADATA_KEYS.has(key) && !(key in out)) {
      out[key] = raw[key];
    }
  }
  return out;
}

/**
 * 同步版本的单键 sanitize —— 只做不依赖 IO 的检查。
 * 与 validateKey 共享规则，但把 fs 检查（nullable-path）推迟到 update 阶段。
 *
 * @param {string} key
 * @param {*} raw
 * @returns {*} 合法值；不可修复时返回 undefined（调用方应忽略这个键）
 */
function sanitizeSync(key, raw) {
  const rule = SETTINGS_SCHEMA[key];
  if (!rule) return undefined; // 未知键：丢弃

  // nullable：null 合法
  if ((rule.type === 'nullable-string' || rule.type === 'nullable-path' || rule.type === 'nullable-number') && raw === null) {
    return null;
  }

  switch (rule.type) {
    case 'nullable-path':
    case 'string': {
      if (typeof raw !== 'string') return undefined;
      // audit fix (Round 4 P1-1)：nullable-path 与 validateKey 异步路径对齐——空串归一为 null。
      // 之前 sanitizeSync 直接返回 ''，coerceLoadedSettings 把磁盘上残留的
      // `"dataDir": ""` 保留为 ''，但 validateKey 异步路径会归一为 null，两条路径
      // 语义不同步 → 任何依赖 dataDir === null 判断的代码失配（resolveDataDir
      // 靠 .trim() 兜底不崩但漏检 null 路径）。
      if (rule.type === 'nullable-path' && raw.trim() === '') return null;
      // 同步路径（coerceLoadedSettings / sanitizeSync）也要尊重 max —— 用户
      // 手工改坏 settings.json 时同样不能让几 MB 的字符串进入运行时。
      if (typeof rule.max === 'number' && raw.length > rule.max) return undefined;
      // 审计修复 (Round 11 deep-fix P2-3)：同步路径也 trim，前后空白不再让 URL 校验
      // 失败。async validateKey 早就 trim（Round 8 fix），同步路径遗漏导致
      //   load(): 不 trim 直接 new URL(' https://api.example.com ')
      //   update(): trim 后校验
      // 两次读同一字段返回不同值，UI 看着值变了（实际上是同一字符串的展示差异）。
      // 注意：trim 后可能变空字符串，与 max > 0 但被 trim 成空的 case 区分；
      // 这里把 trim 后空串仍走原 length 检查（空串会让 url-https 校验短路，
      // 但保留 nullable-path 上面已经拦截过的场景）。
      const trimmed = (rule.type === 'string' || rule.type === 'nullable-string' || rule.type === 'path') ? raw.trim() : raw;
      if (typeof rule.max === 'number' && trimmed.length > rule.max) return undefined;
      // fix(audit 2026-08)：同步路径也要校验 format。旧版只 validateKey（async 路径）
      // 校验 format，coerceLoadedSettings 直接放行 → 手改 settings.json 把 aiBaseUrl
      // 写成 "not-a-url" / "ftp://xxx" 也会被加载，渲染端拿到的值是无效 URL，
      // 真正 fetch 时才报 TypeError: fetch failed，错误链很难定位到 settings。
      if (trimmed.length > 0 && rule.format === 'url-https') {
        // 必须前缀严格是 http:// 或 https://，避免 'http:/missing-slash' 这种
        // URL 构造器能解析但实际 fetch 行为不一致的 case。
        if (!/^https?:\/\//i.test(trimmed)) return undefined;
        let parsed;
        try {
          parsed = new URL(trimmed);
        } catch {
          return undefined;
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
      }
      return trimmed;
    }
    case 'nullable-string': {
      if (typeof raw !== 'string') return undefined;
      if (typeof rule.max === 'number' && raw.length > rule.max) return undefined;
      // fix(audit 2026-08)：nullable-string 与 string 一样需要 format 校验，
      // 否则未来 schema 加 nullable-string + format 字段会静默失效。
      if (raw.length > 0 && rule.format === 'url-https') {
        if (!/^https?:\/\//i.test(raw)) return undefined;
        let parsed;
        try {
          parsed = new URL(raw);
        } catch {
          return undefined;
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
      }
      return raw;
    }
    case 'boolean':
      return typeof raw === 'boolean' ? raw : undefined;
    case 'number': {
      // fix(audit 2026-08)：拒绝 Boolean 输入。Number(true) === 1,
      // Number(false) === 0 —— 旧版会让 autoSaveDebounceMs: true 静默变 1ms
      // （激进到每个 keystroke 都存），splitRatio: false 变 0（无预览面板）。
      // 合法输入限定为 number 或非空数字字符串。
      if (raw === null || raw === undefined) return undefined;
      if (typeof raw !== 'number' && typeof raw !== 'string') return undefined;
      if (typeof raw === 'string' && raw.trim() === '') return undefined;
      const n = Number(raw);
      if (!Number.isFinite(n)) return undefined;
      let v = n;
      if (rule.clamp && (v < rule.min || v > rule.max)) {
        v = Math.min(Math.max(v, rule.min), rule.max);
      }
      if (rule.integer) v = Math.round(v);
      if (typeof rule.round === 'number') {
        const k = 10 ** rule.round;
        v = Math.round(v * k) / k;
      }
      // clamp 后还在范围外（例如 raw 是 NaN / Infinity）→ 拒收
      if (v < rule.min || v > rule.max) return undefined;
      return v;
    }
    case 'nullable-number': {
      // audit fix (Round 4 P2-3)：与 number 分支对称——拒绝 Boolean 输入。
      // 原版无 typeof 守卫，Number(true) === 1 隐式通过 isFinite；目前 schema
      // 用 nullable-number 的字段（sidebarWidth / aiWidth）min 检查会拦下 1，
      // 但语义上与 number 不一致，且未来加更宽 min 范围的字段会绕过。复制上方
      // number 分支的 typeof 守卫保持两条路径对称。
      if (raw === null || raw === undefined) return null;
      if (typeof raw !== 'number' && typeof raw !== 'string') return undefined;
      if (typeof raw === 'string' && raw.trim() === '') return undefined;
      const n = Number(raw);
      if (!Number.isFinite(n)) return undefined;
      let v = n;
      if (rule.integer) v = Math.round(v);
      if (v < rule.min || v > rule.max) return undefined;
      return v;
    }
    case 'enum': {
      // 数字 enum 接受 number，字符串 enum 接受 string 字面量
      const ok = rule.enum.some((e) => e === raw)
        || (typeof raw === 'string' && rule.enum.includes(raw));
      return ok ? raw : undefined;
    }
    default:
      return undefined;
  }
}

module.exports = {
  DEFAULT_SETTINGS,
  SETTINGS_SCHEMA,
  SETTINGS_UI_OPTIONS,
  validateKey,
  validateAndSanitize,
  coerceLoadedSettings,
};
