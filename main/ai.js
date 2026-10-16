// 主进程 AI 代理
// ============================================================================
//
// 通过 Node 18+ 内置 fetch 调用 LLM API。两条协议分支：
//   - aiProvider === 'openai'（默认）→ POST {baseURL}/chat/completions
//                                    Authorization: Bearer ...
//   - aiProvider === 'anthropic'      → POST {baseURL}/v1/messages
//                                    x-api-key: ...  +  anthropic-version
//
// 不使用 openai / @anthropic-ai SDK（避免引入依赖；统一在主进程发起，
// 隐藏 apiKey；统一错误结构供 renderer 弹 toast）。
//
// 设计要点：
//   - 每个请求用一个 requestId 追踪；调用方通过 ai:cancel IPC 终止
//   - 配置（provider / baseURL / apiKey / model / systemPrompt）从
//     configStore.getConfig() 现读现用，用户改完设置不需要重启
//   - 错误统一返回 { ok:false, error, message }，error 是稳定的错误码字符串，
//     message 是用户能看的中文
//   - API Key 不写日志；请求/响应调试时只用长度 + 状态码
//
// 协议差异（两个分支各自完整处理；共享的 cancel / 校验 / 响应后处理 抽到 helper）：
//   请求体:
//     OpenAI    : { model, temperature, max_tokens, max_completion_tokens,
//                   messages: [{role, content}], stream:false }
//     Anthropic : { model, max_tokens, system, messages: [{role, content}], ... }
//
//   响应体:
//     OpenAI    : choices[0].message.content  (string)
//                 choices[0].finish_reason === 'length' 截断
//     Anthropic : content[].text              (拼接所有 text 块)
//                 stop_reason === 'max_tokens' 截断
// ============================================================================

'use strict';

const CURRENT_FILE_EDIT_SYSTEM_PROMPT =
  '你是 Markdown 文本助手。输入 JSON 格式含 filename、currentMarkdown、userPrompt。请按 userPrompt 修改 currentMarkdown，然后直接输出 JSON 格式：{"content":"完整 Markdown"}。如果 userPrompt 与文档修改无关，或者是 {"content":"完整 Markdown"} 内容和 currentMarkdown 完全一致，直接简单回复即可，不需要回复 {"content":"完整 Markdown"}。';

const DEFAULT_TIMEOUT_MS = 300_000;
// 内容长度硬上限：防止单次请求几 MB 把 LLM 计费用爆、把事件循环卡住。
// 1.5 MB ≈ 38 万字符 / 10 万行；超过的文档让用户拆分或手动改。
const MAX_CONTENT_BYTES = 1_500_000;
// 提示词硬上限：64 KB ≈ 1.6 万中文字。系统提示词另算（settings 上限 200 KB，
// 拼接后的总输入也由各 API 服务端二次校验）；这里只挡用户 prompt 单字段。
const MAX_PROMPT_BYTES = 64_000;
// 响应体大小上限：防止恶意 / 错误配置的服务器返回几百 MB body 把主进程 OOM。
// 5 MB 对正常 AI 回复（几十 KB 到 1 MB）足够宽松。
const MAX_RESP_BYTES = 5 * 1024 * 1024;
// tryParseJson 输入硬上限：getJsonCandidates 里的 fenced block 正则 +
// indexOf/lastIndexOf/slice 在 5 MB 字符串上仍有可观 CPU 占用，
// 且对对抗性输入（无闭合 ```）会让非贪婪量词扫到尾；提前砍掉尾巴，
// 让 JSON 解析失败直接走 extractRawReply 的回退路径。
const MAX_PARSE_INPUT_BYTES = 2_000_000;

// Anthropic API 当前稳定版本（2023-06-01 之后未再变）
const ANTHROPIC_API_VERSION = '2023-06-01';

// audit fix (CQ-MED-7)：错误码字面值与 renderer 端共享。preload 经 contextBridge
// 把同一份 AI_ERROR 暴露到 window.api.aiErrors，main / renderer 永远引用同一对象，
// 不再靠注释提醒同步。
const { AI_ERROR } = require('../shared/ai-errors.js');
const nodeCrypto = require('node:crypto');
// R3 P0-1：aiApiKey 走 safeStorage 加密后，磁盘上是 enc:v1: 包络；config
// 加载到 appConfig 时已经 decrypt 一次（见 main/config-store.js loadConfig），
// 但这里是直接接 getConfig() 的兜底路径，防御性再 decrypt 一次（passthrough
// 明文，包络也安全），避免未来调用方改动时漏掉解密。
const secretStore = require('./secret-store.js');
const { makeCleanupEpoch } = require('./cleanup-epoch.js');
const ERR_NOT_CONFIGURED = AI_ERROR.NOT_CONFIGURED;
const ERR_TIMEOUT = AI_ERROR.ERR_TIMEOUT;
const ERR_PROVIDER = AI_ERROR.ERR_PROVIDER;
const ERR_FORMAT = AI_ERROR.ERR_FORMAT;
const ERR_CANCELLED = AI_ERROR.ERR_CANCELLED;

const TRUNCATED_MESSAGE = 'AI 修改结果不完整，请缩小文档或简化要求后重试。';

/**
 * 把超长输入砍到上限内（按 UTF-8 字节）。MAX_PARSE_INPUT_BYTES 之外的尾部
 * 在多数 AI 模型回复里没有意义（远早于 JSON 边界）—— 直接截掉既防 ReDoS，
 * 又让正则 / indexOf 不再 O(n²) 退化。
 * @param {string} message
 * @returns {string}
 */
function capForParse(message) {
  const s = String(message || '');
  if (Buffer.byteLength(s, 'utf8') <= MAX_PARSE_INPUT_BYTES) return s;
  // 按字符截可能切到 UTF-8 序列中间；用 Buffer 切字节再转回字符串，
  // 最后若尾部半个 multi-byte 用 toString('utf8') 会被替换成 U+FFFD，
  // 但 JSON.parse 会立即抛 SyntaxError → 由 tryParseJson 的 catch 兜底。
  return Buffer.from(s, 'utf8').subarray(0, MAX_PARSE_INPUT_BYTES).toString('utf8');
}

/**
 * 提取 AI 消息中的 JSON 候选：trimmed 原文 / 三反引号代码块 / 第一个 { 到最后一个 }。
 * @param {string} message
 * @returns {string[]}
 */
function getJsonCandidates(message) {
  const trimmed = capForParse(message).trim();
  const candidates = [trimmed];
  const fencedBlock = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedBlock && fencedBlock[1]) {
    candidates.push(fencedBlock[1].trim());
  }
  const jsonStart = trimmed.indexOf('{');
  const jsonEnd = trimmed.lastIndexOf('}');
  if (jsonStart !== -1 && jsonEnd > jsonStart) {
    candidates.push(trimmed.slice(jsonStart, jsonEnd + 1));
  }
  return [...new Set(candidates)];
}

function tryParseJson(message) {
  for (const candidate of getJsonCandidates(message)) {
    try {
      return JSON.parse(candidate);
    } catch {
      // continue
    }
  }
  return undefined;
}

/**
 * 在 message 中找第一个花括号配对的 JSON 对象，并把对象文本截出来。
 * 简单字符串扫描 —— O(n) 处理嵌套 `{` `}` 和字符串字面量（避免 JSON 内容里的
 * 引号 / 反斜杠把花括号配对误判）。找不到配对返回 null。
 *
 * 与 getJsonCandidates 的 brace-pair 切片不同：这里还要在体内识别字符串里的
 * 转义序列（`\"` / `\\`），因此专写一个实现而非复用 indexOf/lastIndexOf。
 *
 * @param {string} s
 * @returns {string|null}
 */
function extractFirstJsonObject(s) {
  const str = String(s || '');
  const len = str.length;
  let start = -1;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = 0; i < len; i++) {
    const ch = str[i];
    if (inStr) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inStr = false; }
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') {
      if (start < 0) start = i;
      depth++;
      continue;
    }
    if (ch === '}') {
      if (depth === 0) continue;
      depth--;
      if (depth === 0 && start >= 0) return str.slice(start, i + 1);
    }
  }
  return null;
}

function looksLikeEditJson(message) {
  // audit fix：之前的 /"content"\s*:/ 太宽松 —— 用户提示词里只要含 `"content":`
  // 子串就会被当作「AI 改稿的 JSON 截断」，误报 TRUNCATED_MESSAGE。
  // 第二版 `/\{[^{}]*"content"\s*:[^{}]*\}/` 又过紧 —— 当 content 字段后跟随嵌套
  // 对象（例：`{"content":"x","patches":[{"op":"replace"}]}`）时 `[^{}]*` 立刻失配，
  // AI 返回"看似想输出 JSON 但 token 不够截断"的场景下，TRUNCATED 提示被静默吃掉。
  //
  // 现在走 extractFirstJsonObject 取出第一个配对的 JSON 对象文本，再在体内找
  // `"content"` 键（允许值跨多行、允许嵌套、字符串里的 " 不会干扰）。
  // —— 简单纯文本（"please edit {content} now"）也不会命中，因为：
  //   1. 字符串里的花括号不算嵌套对象起点（inStr 分支已处理）；
  //   2. 真正配对的对象才走 key 搜索。
  //
  // 截断的 JSON（花括号未闭合 / 数组未闭合）：extractFirstJsonObject 找不到配对对象，
  // 这里直接返回 false —— normalizeAssistantText 会走 raw 回退把残文本返回给用户。
  // 用户能看到 AI 输出了什么，比直接弹"不完整"更直观。截断信号应当由上游
  // finish_reason=length / stop_reason=max_tokens 在更早的路径触发，不依赖正文配对。
  const obj = extractFirstJsonObject(message);
  if (!obj) return false;
  // 体内 key 检测：用 `"content"` 加 `:` 兜住常见间距（`"content" :` / `"content":`）；
  // 不复用 contains('"content"') 是为了避免匹配键名包含 content 子串的字段
  // （如 `"mycontent":1` —— 但这种情况极少见，多一道正则更稳）。
  return /"content"\s*:/.test(obj);
}

/**
 * 从非 JSON 解析得到的对象里挑 reply/message/text/answer 字段当作纯文本。
 * @param {unknown} parsed
 * @returns {string | null}
 */
function extractRawReply(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  for (const key of ['reply', 'message', 'text', 'answer']) {
    const value = /** @type {Record<string, unknown>} */ (parsed)[key];
    if (typeof value === 'string') return value;
  }
  return null;
}

/**
 * 拼接 baseURL + path，自动处理末尾斜杠。
 * @param {string} base
 * @param {string} path
 * @returns {string}
 */
// P2-6 (audit)：joinUrl / pickOpenAITokenConfig 每次 AI 请求都重复跑
// regex + new URL 解析；同 baseURL / 同 model 在一次会话里反复命中，
// LRU 缓存结果。maxSize 64 覆盖「用户试过的 URL + model」组合，无界增长免疫。
const { createLruCache } = require('./lru-cache.js');
const _joinUrlCache = createLruCache({ maxSize: 64 });
const _tokenConfigCache = createLruCache({ maxSize: 64 });

function joinUrl(base, path) {
  const cacheKey = `${base}|${path}`;
  const hit = _joinUrlCache.get(cacheKey);
  if (hit !== undefined) return hit;
  const joined = _joinUrlUncached(base, path);
  _joinUrlCache.set(cacheKey, joined);
  return joined;
}

function _joinUrlUncached(base, path) {
  // P3-3 fix (audit)：拆分 query / fragment 后再拼。
  // 否则 `https://gw.com?token=abc` 会被拼成 `https://gw.com?token=abc/v1/messages`
  // （query 后被拼了 path，URL 非法）。query / fragment 也可能在错误回显时
  // 包含 api_key 之类敏感 token，所以一并禁止放在 baseURL 里。
  // M2 fix (audit)：剥掉 baseURL 里可能存在的 userinfo（`https://user:pass@host`）。
  // fetch 会把 userinfo 当 Basic Auth 自动发送，把 API Key 当用户名/密码发给中转服务，
  // 敏感凭据直接泄露到第三方；错误回显里也会暴露凭据。
  //
  // M2 follow-up：旧 regex `^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@` 只识别字面 `@`，
  // 对 percent-encoded `user%40evil.com:pass@host` 会放过（`%40` 走 URL 解析后
  // 才被还原成 `@`，fetch 仍按 Basic Auth 发送）。统一走 new URL 解析：URL parser
  // 主动还原 percent-encoding 并暴露 username / password，靠这两个字段判定 /
  // 剥除更稳。query / fragment 仍由外层 split 拿回。
  const s = String(base || '');
  const m = s.match(/^([^?#]*)(\?[^#]*)?(#.*)?$/);
  if (!m) return s;
  let originAndPath = m[1].replace(/\/+$/, '');
  try {
    const parsed = new URL(originAndPath);
    // 任何形式的 userinfo（字面 / percent-encoded / IDN punycode 包装）都会
    // 被 URL parser 还原到 username / password 字段。剥干净再拼回。
    // 注意：直接把 username/password 置空 + toString() 仍会保留空 userinfo 的
    // `https://@host` 形式，所以这里走 host + pathname 重组最稳。
    if (parsed.username || parsed.password) {
      const port = parsed.port ? `:${parsed.port}` : '';
      originAndPath = `${parsed.protocol}//${parsed.hostname}${port}${parsed.pathname}`.replace(/\/+$/, '');
    }
  } catch {
    // URL 解析失败：保留原字符串的 regex 兜底（防御旧路径畸形输入）
    originAndPath = originAndPath.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/, '$1');
  }
  const p = String(path || '').replace(/^\/+/, '');
  return `${originAndPath}/${p}${m[2] || ''}${m[3] || ''}`;
}

/**
 * 过滤错误回显里的敏感 token（OpenAI/Anthropic/proxy 可能在错误信息里
 * echo URL 或 header）。API Key 不该出现在用户能看到的 toast 里。
 * P2-2 fix (audit)；Q3 fix (audit)：补 Google API key / JWT / proxy-authorization。
 * @param {string} detail
 * @returns {string}
 */
function sanitizeDetail(detail) {
  return String(detail || '')
    // OpenAI / 通用 OpenAI 风格 key：sk-xxx / sk-proj-xxx / sk-ant-xxx
    // M3 fix (audit)：阈值 8 → 5，捕获被截断的 key（错误回显常见前缀模式 sk-12ab...）。
    // 5 是保守下限：正常文本里 5 位随机 base64url 不常见
    .replace(/sk-[A-Za-z0-9_-]{5,}/g, '[API_KEY]')
    // Google API key：AIzaSy 开头 + 33 字符。33 是 Google 当前规范
    .replace(/AIzaSy[A-Za-z0-9_-]{20,}/g, '[API_KEY]')
    // JWT：header.payload.signature 三段 base64url；至少各 8 字符避免误伤短词
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[JWT]')
    // M3 fix (audit)：先单独处理 JSON 风格 `"authorization": "Bearer sk-xxx"`——
    // 旧正则 `[^\s,;&}"']+` 遇到 `"` 就停，只盖到 `"Bearer`，剩余 ` sk-xxx"`
    // 直接漏到下一步被文本截断逻辑保留。现在用单独 pattern 一次性吃掉整段带引号的值。
    // audit fix (Phase O-L19)：扩到 `authentication` / `www-authenticate` / `cookie` /
    // `set-cookie` —— 自部署中转 / Azure gateway 偶尔回 `Authentication: Bearer sk-xxx`，
    // LLM 自定义代理常通过 cookie 传 key。原始 key 不会泄露（line 229 的 sk-/AIzaSy
    // 兜底会替成 [API_KEY]），但 header 名这一行会在 detail 文本里残留。
    .replace(/("(?:proxy-authorization|x-api-key|authorization|authentication|www-authenticate|cookie|set-cookie)"\s*:\s*)"[^"]*"/gi, '$1"[REDACTED]"')
    // 任意 header 里出现敏感 token —— 含 proxy-authorization（Q3 audit 新增）
    // 不再排除 `"` 和 `'`：让正则跨过引号吃掉值（与 JSON pattern 互补，命中 form-style）
    .replace(/(proxy-authorization|x-api-key|authorization|authentication|www-authenticate|cookie|set-cookie)\s*[:=]\s*[^\s,;&}]+/gi, '$1=[REDACTED]')
    // URL query 或 form body 里的 key/token
    .replace(/(api[_-]?key|token)\s*=\s*[^\s,;&}]+/gi, '$1=[REDACTED]');
}

/**
 * 把 URL 中可能携带 secret 的部分脱敏再写到日志。
 *   1. 去掉 query 和 fragment（用户 baseURL 不该带 ?api_key=xxx / #fragment，但有人会带）
 *   2. path 段里嵌入的 secret token（OpenAI sk-xxx / Google AIzaSy）也遮罩
 * 保留 scheme + host + path，便于调试"请求打到哪个域名"，但不带任何 secret。
 * Q6 fix (audit)。
 * @param {string} raw
 * @returns {string}
 */
function sanitizeUrl(raw) {
  let s = String(raw || '');
  // M2 follow-up：与 joinUrl 同款 percent-encoded userinfo 防御。
  // 先用 new URL 解析（字面 / 编码 / punycode 都被还原到 username/password），
  // 命中则走 host + pathname 重组。否则 fallback 旧 regex 兜底畸形输入。
  try {
    const parsed = new URL(s);
    if (parsed.username || parsed.password) {
      const port = parsed.port ? `:${parsed.port}` : '';
      s = `${parsed.protocol}//${parsed.hostname}${port}${parsed.pathname}`;
    }
  } catch {
    s = s.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/, '$1');
  }
  return s
    .replace(/[?#].*$/, '')                                       // 去 query / fragment
    .replace(/\/(sk-[A-Za-z0-9_-]{8,})/g, '/[REDACTED]')         // path 段里的 OpenAI key
    .replace(/\/(AIzaSy[A-Za-z0-9_-]{20,})/g, '/[REDACTED]');    // path 段里的 Google key
}

/**
 * 读 response body 到字符串，超过 MAX_RESP_BYTES 立刻中断。
 * P2-3 fix (audit)。
 * @param {Response} res
 * @returns {Promise<{ ok:true, text:string } | { ok:false, message:string }>}
 */
async function readBodyWithLimit(res) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    // 旧版 fetch / mock：fallback 到 .text()，上限由 .text() 自带的内存限制兜底
    try {
      const text = await res.text();
      if (Buffer.byteLength(text, 'utf8') > MAX_RESP_BYTES) {
        return { ok: false, message: 'AI 响应体过大' };
      }
      return { ok: true, text };
    } catch {
      return { ok: false, message: '读取 AI 响应失败' };
    }
  }
  const reader = res.body.getReader();
  /** @type {Buffer[]} */
  const chunks = [];
  let total = 0;
  let readErr = null;
  while (true) {
    let value;
    let done;
    try {
      ({ value, done } = await reader.read());
    } catch (e) {
      readErr = e;
      break;
    }
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESP_BYTES) {
      try { reader.cancel(); } catch { /* ignore */ }
      return { ok: false, message: 'AI 响应体过大（超过 5 MB）' };
    }
    chunks.push(Buffer.from(value));
  }
  if (readErr) {
    // Round 13 fix (M9)：reader.read() 抛错时不 cancel — 流连接资源会被 GC
    // 最终释放，但 fetch 在 abort 时仍可能持有未读数据；显式 cancel 让对端
    // 立即知道我们不再消费，提早关连接。
    try { reader.cancel(); } catch { /* ignore */ }
    return { ok: false, message: '读取 AI 响应失败' };
  }
  return { ok: true, text: Buffer.concat(chunks).toString('utf8') };
}

/**
 * 创建主进程 AI 代理。
 * @param {object} deps
 * @param {() => object} deps.getConfig - 取最新设置（configStore.getConfig）；每次 runEdit 都会调用
 * @param {typeof fetch} [deps.fetchImpl] - 注入 fetch（测试用）
 * @param {(key: string, payload: object) => void} [deps.log] - 日志钩子（不记录 apiKey）
 */
function createAiProxy({ getConfig, fetchImpl, log } = {}) {
  if (typeof getConfig !== 'function') {
    throw new Error('[ai] getConfig 必须是函数');
  }
  const fetchFn = fetchImpl || ((...args) => fetch(...args));
  const logFn = typeof log === 'function' ? log : () => {};

  /** @type {Map<string, AbortController>} */
  const pending = new Map();
  /** requestId → 它的超时定时器。cancel 时一起清，避免 setTimeout 回调空转。 */
  const timers = new Map();
  // audit fix (P1-5)：cancelAll 顺序竞争 epoch 闸。cancelAll 三步非原子
  // （abort → clear → clear），与新 runEdit 同步阶段加 entry 存在竞态窗口。
  // cleanupEpoch.invalidate() 让所有「更早 snapshot」的 in-flight runEdit
  // 自行 bail（isCurrent → false），避免「同 requestId 重试找不到 controller」。
  const cleanupEpoch = makeCleanupEpoch();
  /** audit fix (C4)：请求生命周期登记集合（runEdit 入口 → finally），用于
   *  真正拦截同 requestId 的重复进入 —— 之前的 pending 集合是 postJson 内部填的，
   *  runEdit 同步阶段检查永远是空，已被注释自承为 dead code。 */
  const inFlightRequestIds = new Set();

  function cancel(requestId) {
    const controller = pending.get(requestId);
    const timer = timers.get(requestId);
    if (controller) {
      controller.abort();
      pending.delete(requestId);
    }
    if (timer) {
      clearTimeout(timer);
      timers.delete(requestId);
    }
  }

  function cancelAll() {
    // audit fix (P1-5)：入口先 invalidate，挡掉「cancelAll 期间新 runEdit
    // 同步阶段已加入 entry」竞态。新 runEdit 入口会 snapshot 当前 epoch，
    // await 后 isCurrent → false 时 bail，不污染主流程返回。
    cleanupEpoch.invalidate();
    for (const controller of pending.values()) controller.abort();
    pending.clear();
    // C1 (audit)：与 cancel() 一样同步清理 timeout，避免 setTimeout 回调空转
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    // 第二阶段代码审查 (Phase 2 review #3)：同步清理 inFlightRequestIds。
    // 之前只清 pending / timers —— runEdit 的 finally 也会 clear 自己加进 Set
    // 的 requestId，所以正常路径下 Set 会自然排空。但 cancelAll 在
    // app.on('will-quit') 调用（main.js:889），与 runEdit finally 之间存在
    // 竞态窗口：requestId 仍残留在 Set 里时若有新 AI 请求复用同一 requestId
    // （test harness / HMR / 未来 re-init），cancel(requestId) 会取消错对象。
    // 显式 clear 让 cancelAll 真正幂等且不留残根。
    inFlightRequestIds.clear();
  }

  /**
   * 校验 baseURL 是否为合法 http(s) URL。
   * 防止 javascript: / file: / data: 等伪协议触发 fetch TypeError 后报成"网络错误"误导用户。
   * M1 (audit)：旧版只走 fetch 抛错，错误信息不友好。
   * @param {string} base
   * @returns {{ok:true, value:string} | {ok:false, reason:string}}
   */
  function validateBaseUrl(base) {
    const s = String(base || '').trim();
    if (!s) return { ok: false, reason: 'Base URL 不能为空' };
    if (!/^https?:\/\//i.test(s)) {
      return { ok: false, reason: 'Base URL 必须以 http:// 或 https:// 开头' };
    }
    // P2 fix：hostname 校验 —— 之前只校验前缀，`https:///etc/passwd`（缺少 host）
    // / `https:// host`（带空格）会被放行，然后 fetch 抛「ENOTFOUND / Invalid URL」
    // 但错误信息毫无线索。new URL 直接拒绝这些畸形输入，给出可执行反馈。
    try {
      const parsed = new URL(s);
      if (!parsed.hostname) {
        return { ok: false, reason: 'Base URL 缺少主机名' };
      }
      // 主机名不能包含空白字符或 ASCII 控制字符（防御一些浏览器容忍的奇怪输入）
      // eslint-disable-next-line no-control-regex -- 控制字符范围是刻意检查的非法字符
      if (/[\s\x00-\x1f]/.test(parsed.hostname)) {
        return { ok: false, reason: 'Base URL 主机名包含非法字符' };
      }
    } catch (e) {
      return { ok: false, reason: 'Base URL 不是合法 URL：' + (e && e.message || '') };
    }
    return { ok: true, value: s };
  }

  /**
   * Round 13 fix (M6)：抽「明文 HTTP + 非 loopback + 已配 Key → 拒绝」共用检查。
   * OpenAI / Anthropic 两条分支各复制 30 行同款防御，现在统一走这里。
   * 本地代理（Ollama / LM Studio / vllm）走 http://localhost / 127.0.0.1 / ::1
   * 不需要 Key（apiKey 留空即放过），配置 Key 时必须 HTTPS。
   * @param {string} baseUrl - 已经 validateBaseUrl 通过的 URL
   * @param {string} apiKey - 当前配置的 API Key（空串 = 未配）
   * @returns {null | {ok:false, error:string, message:string}} 通过时返回 null
   */
  function rejectInsecureKeyTransport(baseUrl, apiKey) {
    if (!/^http:\/\//i.test(baseUrl) || !apiKey) return null;
    try {
      const parsed = new URL(baseUrl);
      const host = (parsed.hostname || '').toLowerCase();
      const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
      if (isLoopback) return null;
      console.warn('[ai] 明文 HTTP + 非loopback + 已配 Key，拒绝请求以防泄露:', sanitizeUrl(baseUrl));
      return {
        ok: false,
        error: ERR_NOT_CONFIGURED,
        message: '检测到 Base URL 使用明文 HTTP 且已配置 API Key；请改用 https:// 以避免 Key 在网络传输中被窃取。本地代理（localhost / 127.0.0.1）允许明文。',
      };
    } catch { /* validateBaseUrl 已校验过 URL，这里兜底 */ }
    return null;
  }

  /**
   * 按模型名路由 token 上限 + token 字段。
   * H1 (audit)：65536 远超多数模型上限（gpt-3.5=4096, gpt-4=8192, gpt-4o=16384），
   *             服务端可能直接 400 拒绝或抛 invalid_request_error。
   * H2 (audit)：gpt-5 / o-series 只接受 max_completion_tokens，旧字段会触发
   *             "Unsupported parameter" 错误；老模型反过来——只接受 max_tokens。
   * H5 (audit)：gpt-5 / o-series 不接受自定义 temperature（o1 固定为 1），
   *             发 0.2 会 400 invalid_request_error。
   * @param {string} model
   * @returns {{ capTokens: number, tokenField: 'max_tokens' | 'max_completion_tokens', includeTemperature: boolean }}
   */
  function pickOpenAITokenConfig(model) {
    const key = String(model || '');
    const hit = _tokenConfigCache.get(key);
    if (hit !== undefined) return hit;
    const cfg = _pickOpenAITokenConfigUncached(key);
    _tokenConfigCache.set(key, cfg);
    return cfg;
  }

  function _pickOpenAITokenConfigUncached(model) {
    const m = String(model || '').toLowerCase();
    // gpt-5 / o-series → 必须用 max_completion_tokens；上限通常 ≥ 128k；不传 temperature
    if (/^(gpt-5|o1|o3|o4)/.test(m)) {
      return { capTokens: 32_000, tokenField: 'max_completion_tokens', includeTemperature: false };
    }
    // gpt-4o / 4-turbo → max_tokens，上限 16k
    if (/^gpt-4o/.test(m) || /^gpt-4-turbo/.test(m)) {
      return { capTokens: 16_384, tokenField: 'max_tokens', includeTemperature: true };
    }
    // 普通 gpt-4 → 8k
    if (/^gpt-4/.test(m)) {
      return { capTokens: 8_192, tokenField: 'max_tokens', includeTemperature: true };
    }
    // gpt-3.5 → 4k
    if (/^gpt-3\.5/.test(m)) {
      return { capTokens: 4_096, tokenField: 'max_tokens', includeTemperature: true };
    }
    // 未知模型（包括国产中转、自部署）：保守值 + 老字段，最大限度兼容
    return { capTokens: 4_096, tokenField: 'max_tokens', includeTemperature: true };
  }

  /**
   * Anthropic 模型 max_tokens 上限路由。
   * H1 (audit)：Anthropic 不同模型上限差异很大（旧 haiku 4096 / sonnet-3-5 8192），
   *             65536 会被这些老模型 400 拒绝。
   *
   * audit fix (round-13)：补齐「5 系」与 4.6+ 命名。
   *   之前的正则 `claude-(3-5|3\.5|3-7|sonnet-4|opus-4|4)` 要求 `claude-` 后面
   *   紧跟这些片段，于是 claude-opus-5 / claude-sonnet-5 / claude-fable-5 /
   *   claude-haiku-4-5 全部不命中 → 回退 8192，反而比 claude-opus-4-8（16384）
   *   更低。结果是「越新、输出上限越高的模型，拿到的 max_tokens 越小」：
   *   长笔记改写会在 8k 处被截断 → stop_reason: max_tokens → runEdit 走
   *   TRUNCATED_MESSAGE 分支报「AI 修改结果不完整」。这正是 Phase O-L17
   *   想修掉的那类 bug，只是模型命名又演进了一代。
   *
   * 现行分档（保守取值，远低于官方上限，避免中转/自部署网关拒绝）：
   *   - 5 系 + 4.6/4.7/4.8（官方 max output 128k）→ 32k
   *   - 其余 4 系（含 haiku-4-5）+ 3-5/3-7 → 16k
   *   - claude-3 老家族 → 8k
   *   - 未知模型（国产中转 / 自部署）→ 8k，最大限度兼容
   * @param {string} model
   * @returns {number}
   */
  function pickAnthropicTokenConfig(model) {
    const m = String(model || '').toLowerCase();
    // 5 系（opus-5 / sonnet-5 / fable-5 / mythos-5 / haiku-5）+ 4.6+ → 官方 128k 上限
    // Round 13 fix：旧正则漏了 `claude-haiku-5-*`，会落到下一档的 16k；
    // 同样保留 haiku-5 与其他 5 系在同一档。
    if (/claude-(opus|sonnet|fable|mythos|haiku)-5/.test(m)) return 32_000;
    if (/claude-(opus|sonnet)-4-(6|7|8)/.test(m)) return 32_000;
    // 其余 4 系（sonnet-4-5 / opus-4-5 / haiku-4-5 / claude-4-*）+ 3-5 / 3-7
    if (/claude-(3-5|3\.5|3-7|sonnet-4|opus-4|haiku-4|4)/.test(m)) return 16_384;
    // Round 13 fix (H2)：claude-3 老家族官方 max output = 4096。
    // 旧值 8192 在 opus-3 / sonnet-3 / haiku-3 上会被服务端 400 拒绝，
    // runEdit 走 TRUNCATED_MESSAGE 分支报「AI 修改结果不完整」（实际是
    // 请求参数越界，不是输出被截断）。claude-3-5 / claude-3-7 由上一档命中。
    if (/claude-3/.test(m)) return 4_096;
    return 8_192; // 未知模型回退到 8k —— 之前 4096 经常截断长 diff
  }

  /**
   * 抽象的 HTTP 调用 + 超时 + 取消 + 状态码错误处理。
   * 不解析业务响应（OpenAI / Anthropic 各自的 JSON 结构在调用方处理）。
   *
   * @param {{
   *   requestId: string,
   *   url: string,
   *   headers: Record<string, string>,
   *   body: object,
   *   timeoutMs: number,
   * }} args
   * @returns {Promise<{ ok: true, json: any } | { ok: false, error: string, message: string }>}
   */
  async function postJson({ requestId, url, headers, body, timeoutMs }) {
    const controller = new AbortController();
    pending.set(requestId, controller);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    timers.set(requestId, timer);

    // audit fix：所有 exit 路径必须清理两个 Map，否则长时间使用会泄漏
    // 内存（之前修复 cancelAll 只清理了 Map 没在 postJson 内清理 entry，
    // 现在统一走 helper 确保不遗漏）。
    //
    // 关键：cleanup 只清理「自己的」controller / timer，不能按 requestId 无脑
    // delete。如果 renderer 在我们 await fetchFn 的间隙用同一个 requestId 发起
    // 了新请求（pending.has → cancel → 新 postJson），新请求会重新
    // pending.set(requestId, newController)。随后旧 cleanup 在 microtask 阶段
    // 触发 pending.delete(requestId)，会把新请求的 controller 从 Map 里抹掉，
    // 导致新请求无法单独 cancel。比对 identity 再 delete 即可解决。
    function cleanup() {
      clearTimeout(timer);
      if (pending.get(requestId) === controller) pending.delete(requestId);
      if (timers.get(requestId) === timer) timers.delete(requestId);
    }

    let res;
    try {
      // audit fix (Round 13 / Sec-H3)：redirect: 'manual' 阻止 undici 跟随 3xx
      // 重定向到不同 origin 时复传自定义头。fetch 规范只会在 CORS 非通配头
      // 集合里自动剥 `Authorization`，但 Anthropic 用的是 `x-api-key`（自定义头），
      // 不在脱敏名单里 —— 用户配置的中转 / 第三方网关一旦答 302 到攻击者域，
      // `x-api-key: sk-ant-...` 和当前笔记全文都会被转发出去。
      //
      // 用 manual 后拿到的是 opaqueredirect 类型的 Response，status 0、body 不可读；
      // 我们在下文按 status === 0 / type === 'opaqueredirect' 显式报错给用户。
      // 不支持 redirect 的真 endpoint 不会触发这条分支（2xx/4xx/5xx 都不是 3xx）。
      res = await fetchFn(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: 'manual',
      });
    } catch (e) {
      cleanup();
      if (controller.signal.aborted) {
        if (timedOut) {
          return { ok: false, error: ERR_TIMEOUT, message: 'AI 请求超时，请缩小文档、简化要求或重试' };
        }
        return { ok: false, error: ERR_CANCELLED, message: '已取消 AI 请求' };
      }
      const msg = e instanceof Error ? e.message : String(e);
      if (/abort/i.test(msg)) {
        return { ok: false, error: timedOut ? ERR_TIMEOUT : ERR_CANCELLED, message: timedOut ? 'AI 请求超时，请缩小文档、简化要求或重试' : '已取消 AI 请求' };
      }
      // M1 fix (audit)：网络错误信息里也可能携带 api key（fetch 库 / DNS 错误里偶尔
      // 会回显 URL 或 header），统一走 sanitizeDetail 防止泄露到 toast / 日志
      return { ok: false, error: ERR_PROVIDER, message: `网络错误：${sanitizeDetail(msg)}` };
    }
    // 不再此处 cleanup：fetch 已 resolve 但 body 仍在流式读取，取消窗口内
    // （响应头到达 → body 读完前）cancel 需要 pending 中的 controller 才能 abort。
    // 清理统一收口到下方 try/finally（覆盖所有 early-return / 错误路径）。
    try {
    // audit fix (Round 13 / Sec-H3)：3xx 重定向在 manual 模式下表现为 status=0
    // 且 type='opaqueredirect'。明示用户配置错了 Base URL，不要走"读 body 取错误信息"
    // 分支（那里会卡死读 body 或者报错信息误导成"格式错误"）。
    if (res.status === 0 || res.type === 'opaqueredirect') {
      return {
        ok: false,
        error: ERR_PROVIDER,
        message: 'Base URL 发生了重定向，请直接填写最终地址（出于 API Key 安全考虑，Notes 不会自动跟随重定向）',
      };
    }

    if (!res.ok) {
      const status = res.status;
      let detail = '';
      let errBody = null;
      // P2-3 fix (audit)：用 readBodyWithLimit 限制响应体大小，防止 OOM
      // 审计修复 (Round 11 deep-fix P1-2)：在 readBodyWithLimit 抛 AbortError 时
      // （用户取消）不要静默走到下面 → bodyRead.ok === false 时仍正常报错 OK；
      // 但 reader 自身抛错会冒到 catch。检查 controller.signal.aborted 走「已取消」。
      let bodyRead;
      try {
        bodyRead = await readBodyWithLimit(res);
      } catch (e) {
        if (controller && controller.signal && controller.signal.aborted) {
          return { ok: false, error: ERR_CANCELLED, message: '已取消 AI 请求' };
        }
        throw e;
      }
      if (!bodyRead.ok) {
        // Q6 fix (audit)：url 写入日志前 sanitizeUrl，去掉 query / fragment / path secret
        logFn('ai:http_error', { url: sanitizeUrl(url), status, detail: bodyRead.message });
        return { ok: false, error: ERR_FORMAT, message: bodyRead.message };
      }
      const text = bodyRead.text;
      if (text) {
        // 尝试解析为 JSON 取 error.message；不成功则把原文截断用作 detail
        try {
          const parsed = JSON.parse(text);
          errBody = parsed;
          if (parsed && parsed.error && typeof parsed.error.message === 'string') {
            detail = parsed.error.message;
          }
        } catch {
          // ignore
        }
        if (!detail) detail = text.length > 200 ? `${text.slice(0, 200)}…` : text;
      }
      // P2-2 fix (audit)：过滤 detail 里的 api key / 敏感 token 后再 log + 回显
      detail = sanitizeDetail(detail);
      // Q6 fix (audit)：url 写入日志前 sanitizeUrl，去掉 query / fragment / path secret
      logFn('ai:http_error', { url: sanitizeUrl(url), status, detail });
      if (status === 401 || status === 403) {
        return { ok: false, error: ERR_PROVIDER, message: 'API Key 无效或没有权限' };
      }
      if (status === 404) {
        return { ok: false, error: ERR_PROVIDER, message: 'Base URL 或模型不存在' };
      }
      if (status === 408 || status === 504) {
        return { ok: false, error: ERR_TIMEOUT, message: 'AI 请求超时，请缩小文档、简化要求或重试' };
      }
      if (status === 429) {
        return { ok: false, error: ERR_PROVIDER, message: '请求过于频繁，请稍后重试' };
      }
      if (status === 400 && errBody && errBody.error && errBody.error.type === 'invalid_request_error') {
        // audit fix (Round 8 A-1)：这里过去用的是 `errBody.error.message` 原文，
        // 绕过了上面 line 525 的 sanitizeDetail —— 而 detail 正是同一个字符串
        // 脱敏后的版本。自部署网关（Azure / LiteLLM / 各类中转）在
        // invalid_request_error.message 里 echo 请求头或请求体的情况很常见，
        // 一旦回吐 `Bearer sk-...` 就会原样进 toast。改用已脱敏的 detail。
        return { ok: false, error: ERR_PROVIDER, message: `请求参数错误：${detail || '服务端未提供详情'}` };
      }
      if (status >= 500) {
        // audit fix (M3 regression)：500 也带 sanitized detail，
        // 让上游服务器把真实错误（"invalid token: sk-xxx"）回吐时，
        // 用户能从 toast 看到「凭据有问题」而不是一句空泛的"服务不可用"。
        // detail 已经走过 sanitizeDetail，key 类 token 已经被 [API_KEY] 替换。
        return {
          ok: false,
          error: ERR_PROVIDER,
          message: `AI 服务暂时不可用（HTTP ${status}）${detail ? '：' + detail : ''}`,
        };
      }
      return { ok: false, error: ERR_PROVIDER, message: `AI 请求失败（HTTP ${status}）${detail ? '：' + detail : ''}` };
    }

    /** @type {any} */
    let json;
    try {
      // P2-3 fix (audit)：成功路径也走大小限制（恶意 / 错误配置的服务端可能
      // 对 200 也返回大 body）。用 text + JSON.parse 替代 res.json()。
      const bodyRead = await readBodyWithLimit(res);
      if (!bodyRead.ok) return { ok: false, error: ERR_FORMAT, message: bodyRead.message };
      json = JSON.parse(bodyRead.text);
    } catch (e) {
      // 审计修复 (Round 11 deep-fix P1-2)：用户取消时 readBodyWithLimit 内部
      // reader.cancel() 抛 AbortError，外层 catch 之前把它误判成 "不是合法 JSON"
      // → UI 看到误导的格式错误。先检查 controller.signal.aborted 走「已取消」分支。
      if (controller && controller.signal && controller.signal.aborted) {
        return { ok: false, error: ERR_CANCELLED, message: '已取消 AI 请求' };
      }
      const msg = e instanceof Error ? e.message : String(e);
      if (/abort/i.test(msg)) {
        return { ok: false, error: ERR_CANCELLED, message: '已取消 AI 请求' };
      }
      return { ok: false, error: ERR_FORMAT, message: 'AI 返回的不是合法 JSON' };
    }
    return { ok: true, json };
    } finally {
      cleanup();
    }
  }

  /**
   * 把模型原始文本回复归一化成 { content, responseFormat }：
   *   - 解析成 { content: string } → responseFormat = 'json'（用于文档修改 diff）
   *   - 其它情况 → responseFormat = 'raw'（普通对话回复）
   */
  function normalizeAssistantText(message, originalContent) {
    const parsed = tryParseJson(message);
    if (parsed && typeof parsed === 'object' && typeof parsed.content === 'string') {
      const next = parsed.content;
      if (next === originalContent) {
        return { content: '当前文档无需修改。', responseFormat: 'raw' };
      }
      return { content: next, responseFormat: 'json' };
    }
    // audit fix (shared-M13)：如果 JSON 解析成功但 content 不是字符串（典型
    // 是 [] 数组 / 对象 / null / 数字），不要按「截断」处理 —— 模型是按规矩
    // 返回 JSON 对象的，只是 content 的形状不是我们约定的字符串。把 message
    // 整体当 raw 回退返回给用户，至少他们能看到模型实际输出了什么，而不是
    // 看到一个误导的「输出不完整，请重试」提示。
    if (parsed && typeof parsed === 'object' && 'content' in parsed) {
      return { content: message, responseFormat: 'raw' };
    }
    const rawReply = extractRawReply(parsed);
    if (rawReply) return { content: rawReply, responseFormat: 'raw' };
    if (looksLikeEditJson(message)) {
      return null; // JSON 看起来想返回 {content:...} 但解析失败 —— 截断
    }
    return { content: message, responseFormat: 'raw' };
  }

  /**
   * OpenAI 兼容分支：POST {baseURL}/chat/completions。
   */
  async function runOpenAIEdit({ prompt, content, filename, requestId, timeoutMs }) {
    const config = (typeof getConfig === 'function' ? getConfig() : {}) || {};
    const baseURL = String(config.aiBaseUrl || '').trim();
    // R3 P0-1：解密 aiApiKey 包络。secretStore.decrypt 对明文 / 空 / 损坏都有兜底。
    const apiKey = secretStore.decrypt(config.aiApiKey).trim();
    const model = String(config.aiModel || '').trim();
    const systemPrompt = String(config.aiSystemPrompt || '').trim() || CURRENT_FILE_EDIT_SYSTEM_PROMPT;

    if (!baseURL || !apiKey || !model) {
      return { ok: false, error: ERR_NOT_CONFIGURED, message: '请先在设置中填写 AI 的 Base URL、API Key 和模型名' };
    }
    // M1 (audit)：拒绝 javascript: / data: / file: 等伪协议，避免 fetch TypeError 报成"网络错误"
    const urlCheck = validateBaseUrl(baseURL);
    if (!urlCheck.ok) {
      return { ok: false, error: ERR_NOT_CONFIGURED, message: urlCheck.reason };
    }
    // audit fix (Round 8 A-2) + Round 13 抽 helper：明文 HTTP + 非loopback + 已配置 API Key → 拒绝。
    // 本地代理（Ollama / LM Studio / vllm）走 http://localhost / 127.0.0.1 / ::1
    // 且不需要 Key —— apiKey 留空就过；这里有 apiKey 意味着第三方 API，必须 HTTPS。
    // 静默放行会让 Key 在网线上裸奔到攻击者嗅探点，错误必须显式。
    // localhost/127.0.0.1/::1 仍然放过：本地抓包门槛远高于公网，本地代理是合法场景。
    const insecureReject = rejectInsecureKeyTransport(urlCheck.value, apiKey);
    if (insecureReject) return insecureReject;

    const url = joinUrl(baseURL, 'chat/completions');
    // H1+H2+H5 (audit)：按模型名路由 token 上限，避免 65536 超过多数模型上限被拒；
    // 同时按模型名决定发 max_tokens 还是 max_completion_tokens（gpt-5 / o-series 只接受后者）。
    // o-series / gpt-5 也不接受自定义 temperature（o1 强制为 1，发 0.2 会 400）。
    const { capTokens, tokenField, includeTemperature } = pickOpenAITokenConfig(model);
    /** @type {Record<string, any>} */
    const body = {
      model,
      [tokenField]: capTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: JSON.stringify({ filename, currentMarkdown: content, userPrompt: prompt }),
        },
      ],
      stream: false,
    };
    if (includeTemperature) body.temperature = 0.2;

    logFn('ai:request', { provider: 'openai', url: sanitizeUrl(url), model, filename, promptLen: prompt.length, contentLen: content.length });

    const result = await postJson({ requestId, url, headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    }, body, timeoutMs });
    if (!result.ok) return result;

    const json = result.json;
    const choice = json && Array.isArray(json.choices) ? json.choices[0] : null;
    if (!choice) {
      return { ok: false, error: ERR_FORMAT, message: 'AI 返回了空结果' };
    }
    if (choice.finish_reason === 'length') {
      return { ok: false, error: ERR_FORMAT, message: TRUNCATED_MESSAGE };
    }
    if (choice.finish_reason === 'content_filter') {
      return { ok: false, error: ERR_FORMAT, message: 'AI 返回被服务方过滤，请调整要求后重试' };
    }
    const message = choice.message && typeof choice.message.content === 'string' ? choice.message.content : '';
    if (!message) {
      return { ok: false, error: ERR_FORMAT, message: 'AI 返回了空内容' };
    }

    const normalized = normalizeAssistantText(message, content);
    if (normalized === null) {
      return { ok: false, error: ERR_FORMAT, message: TRUNCATED_MESSAGE };
    }
    return { ok: true, id: requestId, content: normalized.content, responseFormat: normalized.responseFormat };
  }

  /**
   * Anthropic 分支：POST {baseURL}/v1/messages。
   * system 单独字段（不在 messages 里）；messages 只有 user/assistant 两轮对话。
   */
  async function runAnthropicEdit({ prompt, content, filename, requestId, timeoutMs }) {
    const config = (typeof getConfig === 'function' ? getConfig() : {}) || {};
    const baseURL = String(config.aiBaseUrl || '').trim();
    // R3 P0-1：解密 aiApiKey 包络。secretStore.decrypt 对明文 / 空 / 损坏都有兜底。
    const apiKey = secretStore.decrypt(config.aiApiKey).trim();
    const model = String(config.aiModel || '').trim();
    const systemPrompt = String(config.aiSystemPrompt || '').trim() || CURRENT_FILE_EDIT_SYSTEM_PROMPT;

    if (!baseURL || !apiKey || !model) {
      return { ok: false, error: ERR_NOT_CONFIGURED, message: '请先在设置中填写 AI 的 Base URL、API Key 和模型名' };
    }
    // M1 (audit)：同样校验协议前缀，与 OpenAI 分支一致
    const urlCheck = validateBaseUrl(baseURL);
    if (!urlCheck.ok) {
      return { ok: false, error: ERR_NOT_CONFIGURED, message: urlCheck.reason };
    }
    // audit fix (Round 8 A-2) + Round 13 抽 helper：与 OpenAI 分支共用同样防御，
    // 本地代理不需要 Key，留空即可。
    const insecureReject = rejectInsecureKeyTransport(urlCheck.value, apiKey);
    if (insecureReject) return insecureReject;

    const url = joinUrl(baseURL, 'v1/messages');
    // H1 (audit)：Anthropic 各模型 max_tokens 上限不同，超额会 400
    const capTokens = pickAnthropicTokenConfig(model);
    const body = {
      model,
      max_tokens: capTokens,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: JSON.stringify({ filename, currentMarkdown: content, userPrompt: prompt }),
        },
      ],
    };

    logFn('ai:request', { provider: 'anthropic', url: sanitizeUrl(url), model, filename, promptLen: prompt.length, contentLen: content.length });

    const result = await postJson({ requestId, url, headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_API_VERSION,
    }, body, timeoutMs });
    if (!result.ok) return result;

    const json = result.json;
    // 拼接所有 type==='text' 的 content 块；忽略 tool_use / tool_result 等。
    if (!json || !Array.isArray(json.content)) {
      return { ok: false, error: ERR_FORMAT, message: 'AI 返回了空结果' };
    }
    if (json.stop_reason === 'max_tokens') {
      return { ok: false, error: ERR_FORMAT, message: TRUNCATED_MESSAGE };
    }
    /** @type {string} */
    let message = '';
    let hasNonTextBlock = false;
    for (const block of json.content) {
      if (block && block.type === 'text' && typeof block.text === 'string') {
        // Round 13 fix (H7)：Anthropic 不保证 text 块之间有分隔符。
        // [{text:'A.'}, {text:'B begin.'}] 直接拼接得 'A.B begin.'，
        // Markdown 渲染会把 `A.B` 误识为 list / 句点边界。块与块之间补
        // 双换行（Markdown 段落分隔），让多块拼接后渲染保持原意。
        if (message && !message.endsWith('\n')) message += '\n\n';
        message += block.text;
      } else if (block && block.type !== 'text') {
        // audit fix (shared-M11)：tool_use / tool_result / image 等非文本块
        // 当前版本不消费，但若整条 response 只有这些块就给一个明确的中文
        // 提示，而不是误导用户「AI 返回了空内容」（实际是格式我们暂时不支持）。
        hasNonTextBlock = true;
      }
    }
    if (!message) {
      // audit fix (shared-M11)：把「模型只回了 tool_use / image 但没有正文」
      // 与「模型真的没回东西」区分开 —— 后者才报「空内容」。
      if (hasNonTextBlock) {
        return {
          ok: false,
          error: ERR_FORMAT,
          message: 'AI 返回了无法识别的内容（仅含 tool_use / 图像块，无文本回复）',
        };
      }
      return { ok: false, error: ERR_FORMAT, message: 'AI 返回了空内容' };
    }

    const normalized = normalizeAssistantText(message, content);
    if (normalized === null) {
      return { ok: false, error: ERR_FORMAT, message: TRUNCATED_MESSAGE };
    }
    return { ok: true, id: requestId, content: normalized.content, responseFormat: normalized.responseFormat };
  }

  // Round 13 fix (H3)：从共享 AI_ERROR 引用错误码字面值。原先 4 处裸字面量
  // ('INVALID_PROMPT' / 'INVALID_CONTENT' / 'CONTENT_TOO_LARGE' / 'PROMPT_TOO_LARGE')
  // 绕开 AI_ERROR，renderer 端 ai-controller 走通用 toast 而不是本地化提示。
  const ERR_INVALID_PROMPT = AI_ERROR.INVALID_PROMPT;
  const ERR_INVALID_CONTENT = AI_ERROR.INVALID_CONTENT;
  const ERR_CONTENT_TOO_LARGE = AI_ERROR.CONTENT_TOO_LARGE;
  const ERR_PROMPT_TOO_LARGE = AI_ERROR.PROMPT_TOO_LARGE;

  /**
   * 执行一次 AI 修改请求。
   * @param {{ prompt:string, content:string, filename:string, requestId:string }} input
   * @returns {Promise<{ ok:true, id:string, content:string, responseFormat:'json'|'raw' } | { ok:false, error:string, message:string }>}
   */
  async function runEdit({ prompt, content, filename, requestId }) {
    if (typeof prompt !== 'string' || !prompt.trim()) {
      return { ok: false, error: ERR_INVALID_PROMPT, message: '修改要求不能为空' };
    }
    if (typeof content !== 'string') {
      return { ok: false, error: ERR_INVALID_CONTENT, message: '当前文件内容无效' };
    }
    // 字节上限用 UTF-8 编码长度近似（中文/emoji 一个字符多字节，会略高估）
    if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
      return {
        ok: false,
        error: ERR_CONTENT_TOO_LARGE,
        message: `文档过大（超过 ${(MAX_CONTENT_BYTES / 1024 / 1024).toFixed(1)} MB），请拆分后再让 AI 修改`,
      };
    }
    if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) {
      return {
        ok: false,
        error: ERR_PROMPT_TOO_LARGE,
        message: `提示词过长（超过 ${MAX_PROMPT_BYTES / 1024} KB），请简化要求`,
      };
    }
    if (typeof filename !== 'string') {
      filename = '';
    }
    if (typeof requestId !== 'string' || !requestId) {
      // Round 13 fix (M8)：用 crypto.randomUUID 代替 Math.random；后者在
      // 高并发（用户连点）下理论碰撞，会让 cancel 误杀新请求。
      requestId = `ai-${Date.now()}-${nodeCrypto.randomUUID()}`;
    }

    const config = (typeof getConfig === 'function' ? getConfig() : {}) || {};
    const provider = String(config.aiProvider || 'openai').trim().toLowerCase();
    const timeoutMs = DEFAULT_TIMEOUT_MS;

    // audit fix (C4)：原 `if (pending.has(requestId)) cancel(requestId)` 是死代码 —
    // pending 是 postJson 内部填的，postJson 在 runEdit 异步返回之后才执行，
    // runEdit 入口检查 pending 时它一定是空的，双击防护其实由 renderer 端
    // ai-chat-panel 的 _submitting 守门。这里改成真正的 inFlightRequestIds：
    // 进入 runEdit 即登记（早于 postJson），finally 清理，覆盖整个请求生命周期。
    if (inFlightRequestIds.has(requestId)) {
      cancel(requestId);
    }
    inFlightRequestIds.add(requestId);
    // audit fix (P1-5)：拍下 cancelAll epoch 快照。本 runEdit 期间若发生
    // cancelAll（用户点取消、will-quit 触发），await 之后 isCurrent → false
    // → 返 ERR_CANCELLED 不应用任何副作用。snapshot 必须在 inFlightRequestIds
    // 之后但 await 之前 —— 在 inFlightRequestIds.add 之后确保「新请求已
    // 登记」语义在 cancelAll 之前；invalidate 会同时清 Set 的 entry，但本请求
    // 已登记的「我自己负责清除」语义不变（finally 仍会 delete，但 Set 已空，
    // delete 一次 noop）。
    const myEpoch = cleanupEpoch.snapshot();

    // 注：token 上限不再用入参 maxTokens（已被 pick*TokenConfig 按模型路由取代）
    const baseArgs = { prompt, content, filename, requestId, timeoutMs };
    try {
      let result;
      if (provider === 'anthropic') {
        result = await runAnthropicEdit(baseArgs);
      } else if (provider === 'openai') {
        result = await runOpenAIEdit(baseArgs);
      } else {
        // audit fix (2.5)：未知 provider 不再静默按 OpenAI 走 —— 配置错了会让用户困惑。
        // schema enum 已防，但 IPC 直调 / 老 settings 文件可能漏过来，这里明确报错。
        return {
          ok: false,
          error: ERR_NOT_CONFIGURED,
          message: `未知 AI 服务提供方：${provider}（请在设置里选 OpenAI 兼容或 Anthropic 兼容）`,
        };
      }
      // audit fix (P1-5)：await 之后，cancelAll 已 invalidate epoch → 本次
      // 任务期间发生过 cancel，请求结果不再应用（即使 provider 返了 200，
      // 也可能是 cancelAll 触发 abort 之前最后一段响应；语义上「用户已取消」
      // 优先于「网络层成功」）。同时这一步拦截「cancelAll 三步非原子期间
      // 新请求被误 abort 之后」场景 —— 新 runEdit 拿不到 response，但 abort
      // 信号让它提前抛 AbortError；这里统一以 ERR_CANCELLED 兜底。
      if (!cleanupEpoch.isCurrent(myEpoch)) {
        return {
          ok: false,
          error: ERR_CANCELLED,
          message: '请求已被取消',
        };
      }
      return result;
    } finally {
      // audit fix (C4)：无论成功 / 失败 / 抛错都清登记，下次同 requestId
      // 再来能正常进入；防 Set 缓慢增长。
      inFlightRequestIds.delete(requestId);
    }
  }

  return {
    runEdit,
    cancel,
    cancelAll,
  };
}

module.exports = {
  createAiProxy,
  // 共享错误码表 —— preload 经 contextBridge 把同一份 AI_ERROR 暴露到
  // window.api.aiErrors，renderer 直接 window.api?.aiErrors?.AI_ERROR。
  // main/ai.js 内部仍用 ERR_* 命名别名（line 59-63），纯粹是阅读性，无外部
  // 调用方 —— 别名不出 module.exports，避免「两个相同字面值漂移」风险。
  AI_ERROR,
};
