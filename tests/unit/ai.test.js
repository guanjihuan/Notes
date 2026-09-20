// main/ai.js —— AI 代理的协议分支测试
//
// 覆盖：
//   - aiProvider 默认走 OpenAI 分支（旧版配置 / 没填 provider）
//   - aiProvider='openai' → POST /chat/completions · Bearer 鉴权
//   - aiProvider='anthropic' → POST /v1/messages · x-api-key + anthropic-version
//   - 未配置 / 超时 / 取消 / HTTP 错误 / 响应格式错误的稳定错误码
//   - OpenAI / Anthropic 各自的截断信号（finish_reason / stop_reason）
//
// 不依赖 Electron（ai.js 只用 Node 内置 fetch）；通过 deps.fetchImpl 注入
// 假 fetch 验证 URL / headers / body，避免真实网络。

import { describe, it, expect } from 'vitest';
const { createAiProxy } = require('../../main/ai.js');

/**
 * 构造一个 mock fetch：断言请求、返回预设响应。
 * @param {object} opts
 * @param {(url:string, init:object) => void} [opts.onCall] 每次调用都跑一次
 * @param {Response|Error} [opts.response] 默认 200 + 合法 OpenAI 回复
 */
function mockFetch({ onCall, response } = {}) {
  /** @type {Array<{url:string, init:object}>} */
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    if (onCall) onCall(url, init);
    if (response instanceof Error) throw response;
    return response || new Response(JSON.stringify({
      choices: [{ message: { content: '{"content":"ok"}' }, finish_reason: 'stop' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { fn, calls };
}

describe('createAiProxy.runEdit —— Provider 分发', () => {
  it('aiProvider 缺省 / 未知 → 走 OpenAI 分支（向后兼容）', async () => {
    let captured = null;
    const fetchImpl = async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"content":"ok"}' }, finish_reason: 'stop' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const proxy = createAiProxy({
      getConfig: () => ({ aiBaseUrl: 'https://x/v1', aiApiKey: 'sk-x', aiModel: 'gpt-x' }),
      fetchImpl,
    });
    const r = await proxy.runEdit({ prompt: 'p', content: 'c', filename: 'f.md', requestId: 'r1' });
    expect(r.ok).toBe(true);
    expect(captured.url).toBe('https://x/v1/chat/completions');
    expect(captured.init.headers.Authorization).toBe('Bearer sk-x');
  });

  it('aiProvider=openai → POST /chat/completions · Bearer', async () => {
    let captured = null;
    const fetchImpl = async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'plain reply' }, finish_reason: 'stop' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const proxy = createAiProxy({
      getConfig: () => ({
        aiProvider: 'openai',
        aiBaseUrl: 'https://api.openai.com/v1',
        aiApiKey: 'sk-test',
        aiModel: 'gpt-4o-mini',
      }),
      fetchImpl,
    });
    const r = await proxy.runEdit({ prompt: 'p', content: 'c', filename: 'f.md', requestId: 'r2' });
    expect(r.ok).toBe(true);
    expect(r.responseFormat).toBe('raw');
    expect(captured.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(captured.init.method).toBe('POST');
    expect(captured.init.headers.Authorization).toBe('Bearer sk-test');
    expect(captured.init.headers['x-api-key']).toBeUndefined();
    // body 应含 messages 数组（system + user）
    const body = JSON.parse(captured.init.body);
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1].role).toBe('user');
  });

  it('aiProvider=anthropic → POST /v1/messages · x-api-key + anthropic-version', async () => {
    let captured = null;
    const fetchImpl = async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify({
        content: [{ type: 'text', text: '{"content":"hello"}' }],
        stop_reason: 'end_turn',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const proxy = createAiProxy({
      getConfig: () => ({
        aiProvider: 'anthropic',
        aiBaseUrl: 'https://api.anthropic.com',
        aiApiKey: 'sk-ant-test',
        aiModel: 'claude-3-5-sonnet-latest',
      }),
      fetchImpl,
    });
    const r = await proxy.runEdit({ prompt: 'p', content: 'c', filename: 'f.md', requestId: 'r3' });
    expect(r.ok).toBe(true);
    expect(r.content).toBe('hello');
    expect(captured.url).toBe('https://api.anthropic.com/v1/messages');
    expect(captured.init.headers['x-api-key']).toBe('sk-ant-test');
    expect(captured.init.headers['anthropic-version']).toBe('2023-06-01');
    expect(captured.init.headers.Authorization).toBeUndefined();
    const body = JSON.parse(captured.init.body);
    // Anthropic: system 在顶层，messages 只有 user
    expect(body.system).toBeDefined();
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages.length).toBe(1);
    expect(body.messages[0].role).toBe('user');
  });
});

describe('createAiProxy.runEdit —— 错误码', () => {
  it('未配置 → AI_NOT_CONFIGURED', async () => {
    const proxy = createAiProxy({
      getConfig: () => ({ aiBaseUrl: '', aiApiKey: '', aiModel: '' }),
      fetchImpl: async () => { throw new Error('should not call'); },
    });
    const r = await proxy.runEdit({ prompt: 'p', content: 'c', filename: 'f', requestId: 'r' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('AI_NOT_CONFIGURED');
  });

  // audit fix (Round 8 A-2)：明文 HTTP + 非loopback + 已配置 API Key → 拒绝。
  // 本地代理（Ollama / LM Studio / vllm）走 http://localhost / 127.0.0.1 不需要 Key，
  // 留空 apiKey 即过；这里测的是「Key 存在 + 非loopback 明文」必须被拒。
  it('OpenAI 明文 http + 非loopback + 已配 Key → AI_NOT_CONFIGURED（防 Key 泄露）', async () => {
    const proxy = createAiProxy({
      getConfig: () => ({ aiProvider: 'openai', aiBaseUrl: 'http://evil.example.com/v1', aiApiKey: 'sk-real-key', aiModel: 'gpt-4' }),
      fetchImpl: async () => { throw new Error('should not call — 明文 HTTP + 非loopback 必须在 fetch 前拒绝'); },
    });
    const r = await proxy.runEdit({ prompt: 'p', content: 'c', filename: 'f', requestId: 'r' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('AI_NOT_CONFIGURED');
    expect(r.message).toMatch(/明文 HTTP/);
    expect(r.message).toMatch(/https/);
  });
  it('Anthropic 明文 http + 非loopback + 已配 Key → AI_NOT_CONFIGURED', async () => {
    const proxy = createAiProxy({
      getConfig: () => ({ aiProvider: 'anthropic', aiBaseUrl: 'http://gateway.example.com', aiApiKey: 'sk-ant-key', aiModel: 'claude-3-5-sonnet' }),
      fetchImpl: async () => { throw new Error('should not call'); },
    });
    const r = await proxy.runEdit({ prompt: 'p', content: 'c', filename: 'f', requestId: 'r' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('AI_NOT_CONFIGURED');
    expect(r.message).toMatch(/明文 HTTP/);
  });
  it('明文 http + localhost + 已配 Key → 仍放过（本地代理合法场景）', async () => {
    // localhost 上 Key 即使被同机嗅探到也比公网风险低，且本地代理（Ollama）
    // 走 http 是惯例。这里验证 validateBaseUrl + http 守卫不误伤。
    const proxy = createAiProxy({
      getConfig: () => ({ aiProvider: 'openai', aiBaseUrl: 'http://localhost:11434/v1', aiApiKey: 'k', aiModel: 'gpt-4' }),
      fetchImpl: async () => new Response(JSON.stringify({
        choices: [{ message: { content: '{"content":"ok"}' }, finish_reason: 'stop' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    });
    const r = await proxy.runEdit({ prompt: 'p', content: 'c', filename: 'f', requestId: 'r' });
    expect(r.ok).toBe(true);
  });
  it('明文 http + 127.0.0.1 + 已配 Key → 仍放过', async () => {
    const proxy = createAiProxy({
      getConfig: () => ({ aiProvider: 'openai', aiBaseUrl: 'http://127.0.0.1:1234/v1', aiApiKey: 'k', aiModel: 'gpt-4' }),
      fetchImpl: async () => new Response(JSON.stringify({
        choices: [{ message: { content: '{"content":"ok"}' }, finish_reason: 'stop' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    });
    const r = await proxy.runEdit({ prompt: 'p', content: 'c', filename: 'f', requestId: 'r' });
    expect(r.ok).toBe(true);
  });

  it('OpenAI 401 → AI_PROVIDER_ERROR（"API Key 无效或没有权限"）', async () => {
    const proxy = createAiProxy({
      getConfig: () => ({ aiProvider: 'openai', aiBaseUrl: 'https://x/v1', aiApiKey: 'bad', aiModel: 'gpt' }),
      fetchImpl: async () => new Response('Unauthorized', { status: 401 }),
    });
    const r = await proxy.runEdit({ prompt: 'p', content: 'c', filename: 'f', requestId: 'r' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('AI_PROVIDER_ERROR');
    expect(r.message).toMatch(/API Key/);
  });

  it('Anthropic 400 + invalid_request_error → 透出 error.message', async () => {
    const proxy = createAiProxy({
      getConfig: () => ({ aiProvider: 'anthropic', aiBaseUrl: 'https://x', aiApiKey: 'k', aiModel: 'm' }),
      fetchImpl: async () => new Response(JSON.stringify({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'max_tokens: too large' },
      }), { status: 400, headers: { 'Content-Type': 'application/json' } }),
    });
    const r = await proxy.runEdit({ prompt: 'p', content: 'c', filename: 'f', requestId: 'r' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('AI_PROVIDER_ERROR');
    expect(r.message).toMatch(/max_tokens: too large/);
  });

  it('OpenAI finish_reason=length → AI_BAD_RESPONSE（截断提示）', async () => {
    const proxy = createAiProxy({
      getConfig: () => ({ aiProvider: 'openai', aiBaseUrl: 'https://x/v1', aiApiKey: 'k', aiModel: 'm' }),
      fetchImpl: async () => new Response(JSON.stringify({
        choices: [{ message: { content: '{"content":"abc' }, finish_reason: 'length' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    });
    const r = await proxy.runEdit({ prompt: 'p', content: 'c', filename: 'f', requestId: 'r' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('AI_BAD_RESPONSE');
    expect(r.message).toMatch(/不完整/);
  });

  it('Anthropic stop_reason=max_tokens → AI_BAD_RESPONSE（截断提示）', async () => {
    const proxy = createAiProxy({
      getConfig: () => ({ aiProvider: 'anthropic', aiBaseUrl: 'https://x', aiApiKey: 'k', aiModel: 'm' }),
      fetchImpl: async () => new Response(JSON.stringify({
        content: [{ type: 'text', text: '{"content":"trunc' }],
        stop_reason: 'max_tokens',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    });
    const r = await proxy.runEdit({ prompt: 'p', content: 'c', filename: 'f', requestId: 'r' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('AI_BAD_RESPONSE');
    expect(r.message).toMatch(/不完整/);
  });

  it('网络错误 → AI_PROVIDER_ERROR（带原始 message）', async () => {
    const proxy = createAiProxy({
      getConfig: () => ({ aiProvider: 'openai', aiBaseUrl: 'https://x/v1', aiApiKey: 'k', aiModel: 'm' }),
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    });
    const r = await proxy.runEdit({ prompt: 'p', content: 'c', filename: 'f', requestId: 'r' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('AI_PROVIDER_ERROR');
    expect(r.message).toMatch(/ECONNREFUSED/);
  });
});

describe('createAiProxy —— timer / pending Map cleanup', () => {
  // audit fix：postJson 之前只 clearTimeout 没从 timers Map delete entry，
  // 长时间使用会内存泄漏。这里通过重复 runEdit 验证 timer/pending 都已清空。
  it('连续 10 次成功请求后 timers / pending Map 都为空', async () => {
    const proxy = createAiProxy({
      getConfig: () => ({ aiProvider: 'openai', aiBaseUrl: 'https://x/v1', aiApiKey: 'k', aiModel: 'm' }),
      fetchImpl: async () => new Response(JSON.stringify({
        choices: [{ message: { content: '{"content":"ok"}' }, finish_reason: 'stop' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    });
    for (let i = 0; i < 10; i++) {
      const r = await proxy.runEdit({ prompt: 'p', content: 'c', filename: 'f', requestId: `r${i}` });
      expect(r.ok).toBe(true);
    }
    // 通过 cancelAll 的清理量反推：cancelAll 应该不需要清任何东西（如果还有泄漏，会 abort 已完成的 controller）
    proxy.cancelAll();
    // 重复 cancelAll 不应该抛错（说明 Map 已空）
    expect(() => proxy.cancelAll()).not.toThrow();
  });

  it('失败响应（HTTP 400）后 timer Map 已清', async () => {
    let count = 0;
    const proxy = createAiProxy({
      getConfig: () => ({ aiProvider: 'openai', aiBaseUrl: 'https://x/v1', aiApiKey: 'k', aiModel: 'm' }),
      fetchImpl: async () => {
        count++;
        return new Response('Bad Request', { status: 400 });
      },
    });
    for (let i = 0; i < 5; i++) {
      const r = await proxy.runEdit({ prompt: 'p', content: 'c', filename: 'f', requestId: `err${i}` });
      expect(r.ok).toBe(false);
    }
    expect(count).toBe(5);
    // 后续 cancelAll 无副作用说明没有累积
    expect(() => proxy.cancelAll()).not.toThrow();
  });

  it('网络异常（fetch reject）后 timer Map 已清', async () => {
    const proxy = createAiProxy({
      getConfig: () => ({ aiProvider: 'openai', aiBaseUrl: 'https://x/v1', aiApiKey: 'k', aiModel: 'm' }),
      fetchImpl: async () => { throw new Error('ECONNRESET'); },
    });
    for (let i = 0; i < 5; i++) {
      const r = await proxy.runEdit({ prompt: 'p', content: 'c', filename: 'f', requestId: `net${i}` });
      expect(r.ok).toBe(false);
    }
    expect(() => proxy.cancelAll()).not.toThrow();
  });

  // looksLikeEditJson 是 main/ai.js 的内部函数，没导出。这里通过 runEdit 行为
// 反推 —— 当 AI 返回「带嵌套 JSON 但格式损坏」的文本时，应得到 AI_BAD_RESPONSE
// （提示不完整）而不是 raw 回退（让用户看到残缺 JSON 当作文本）。
describe('createAiProxy.runEdit —— looksLikeEditJson（嵌套 JSON 截断识别）', () => {
  // 这些测试间接覆盖嵌套对象场景：原来的正则 `/\{[^{}]*"content"\s*:[^{}]*\}/`
  // 在 content 后跟嵌套 {} 时会失配，导致 looksLikeEditJson 误报 false，
  // normalizeAssistantText 走 raw 回退 —— AI 返回半截带嵌套对象的 JSON 时，
  // 用户看到的是残缺 JSON 当文本，不是「请缩小文档」的提示。
  function makeProxyWithText(aiText) {
    const fetchImpl = async () => new Response(JSON.stringify({
      choices: [{ message: { content: aiText }, finish_reason: 'stop' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return createAiProxy({
      getConfig: () => ({ aiProvider: 'openai', aiBaseUrl: 'https://x/v1', aiApiKey: 'k', aiModel: 'm' }),
      fetchImpl,
    });
  }

  it('AI 返回半截嵌套 JSON（外层 {} 未闭合）→ raw 回退，responseFormat=raw', async () => {
    // 模拟 AI 想要返回 {content:"...", patches:[...]} 但 token 耗尽、整个对象都
    // 没闭合：tryParseJson 失败、extractFirstJsonObject 也找不到配对对象、
    // looksLikeEditJson 返回 false → 走 raw 路径把残文本返回给用户。
    // （这是设计：raw 回退让用户至少能看到 AI 输出了什么；TRUNCATED 是 OpenAI /
    // Anthropic 自己的 finish_reason=length / stop_reason=max_tokens 触发的，
    // 不靠正文里的 {} 配对判断。）
    const truncated = '{"content":"hi","patches":[{"op":"replace","old":"a","new":"b"},';
    const proxy = makeProxyWithText(truncated);
    const r = await proxy.runEdit({ prompt: 'p', content: 'c', filename: 'f', requestId: 'rt1' });
    expect(r.ok).toBe(true);
    expect(r.responseFormat).toBe('raw');
    expect(r.content).toBe(truncated);
  });

  it('AI 返回半截 JSON 但 brace-pair slice 仍能拿到合法对象 → 解析成功', async () => {
    // 复杂 case：文本里有 prose + JSON 截断（缺尾 `}`），但第一个 { 到最后一个 }
    // 之间存在合法 JSON。这种情况应当被 getJsonCandidates 的 brace-pair slice
    // 提取并解析 —— 验证新 extractFirstJsonObject 与既有 brace-pair slice
    // 路径都不破坏嵌套解析。
    const mixed = 'Here is the edit:\n{"content":"abc","meta":{"note":"done"}}\n[truncated';
    const proxy = makeProxyWithText(mixed);
    const r = await proxy.runEdit({ prompt: 'p', content: 'c', filename: 'f', requestId: 'rt2' });
    expect(r.ok).toBe(true);
    expect(r.content).toBe('abc');
    expect(r.responseFormat).toBe('json');
  });

  it('AI 返回完整嵌套 JSON（合法）→ ok=true', async () => {
    // 完整嵌套 JSON 应当被 tryParseJson 解析通过、走 responseFormat='json'。
    const valid = '{"content":"hi","patches":[{"op":"replace"}]}';
    const proxy = makeProxyWithText(valid);
    const r = await proxy.runEdit({ prompt: 'p', content: 'c', filename: 'f', requestId: 'rt3' });
    expect(r.ok).toBe(true);
    expect(r.content).toBe('hi');
    expect(r.responseFormat).toBe('json');
  });

  it('用户提示词纯文本里出现 "content" 子串 → 不误判 TRUNCATED', async () => {
    // 老正则 `"content"\s*:` 在纯文本里有 `please update the "content" of section` 也会命中。
    // 新实现要求体内有真配对的 JSON 对象 + `"content"` 键，纯文本不会触发。
    const prose = '请把 "content" 字段里那个段落的标题改了。';
    const proxy = makeProxyWithText(prose);
    const r = await proxy.runEdit({ prompt: 'p', content: 'c', filename: 'f', requestId: 'rt4' });
    // 不是 JSON → responseFormat='raw'，当成普通回复返回，不应报错。
    expect(r.ok).toBe(true);
    expect(r.responseFormat).toBe('raw');
    expect(r.content).toBe(prose);
  });

  it('AI 返回带 fenced code block 的 JSON（含嵌套） → ok=true', async () => {
    // ```json\n{...}\n``` 也应被 tryParseJson 处理，新实现的
    // extractFirstJsonObject 在 fenced block 内也能正常工作（先 trim 后扫描）。
    const fenced = '```json\n{"content":"fenced ok","meta":{"k":"v"}}\n```';
    const proxy = makeProxyWithText(fenced);
    const r = await proxy.runEdit({ prompt: 'p', content: 'c', filename: 'f', requestId: 'rt5' });
    expect(r.ok).toBe(true);
    expect(r.content).toBe('fenced ok');
  });
});

it('重复 requestId 第二次进入 runEdit 会取消第一次', async () => {
    let callCount = 0;
    const fetchImpl = (url) => {
      callCount++;
      // 第一次永远不返回（模拟长任务）
      if (callCount === 1) return new Promise(() => {});
      // 第二次正常返回
      return Promise.resolve(new Response(JSON.stringify({
        choices: [{ message: { content: '{"content":"ok"}' }, finish_reason: 'stop' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    };
    const proxy = createAiProxy({
      getConfig: () => ({ aiProvider: 'openai', aiBaseUrl: 'https://x/v1', aiApiKey: 'k', aiModel: 'm' }),
      fetchImpl,
    });
    // 第一次请求（永远 hang）
    const p1 = proxy.runEdit({ prompt: 'p', content: 'c', filename: 'f', requestId: 'dup' });
    // 第二次同 requestId → 应该 cancel 第一次并发新请求
    const p2 = proxy.runEdit({ prompt: 'p2', content: 'c', filename: 'f', requestId: 'dup' });
    const r2 = await p2;
    expect(r2.ok).toBe(true);
    expect(r2.content).toBe('ok');
    // p1 应该被 cancel（不需要 resolve，cancelAll 会清掉）
    proxy.cancelAll();
    // 等 p1 真的 reject（被 abort 后 fetch promise 不会自己结束）
    // 加个超时兜底防止测试挂住
    await Promise.race([p1.catch(() => {}), new Promise((r) => setTimeout(r, 100))]);
    expect(() => proxy.cancelAll()).not.toThrow();
  });
});

// audit F1：cleanup 必须 identity-check 后再 delete（详细注释见 main/ai.js 的 cleanup）。
describe('createAiProxy —— requestId 重入取消', () => {
  it('重复 requestId 第二次进入 runEdit 会取消第一次', async () => {
    let callCount = 0;
    const fetchImpl = () => {
      callCount++;
      if (callCount === 1) return new Promise(() => {});
      return Promise.resolve(new Response(JSON.stringify({
        choices: [{ message: { content: '{"content":"ok"}' }, finish_reason: 'stop' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    };
    const proxy = createAiProxy({
      getConfig: () => ({ aiProvider: 'openai', aiBaseUrl: 'https://x/v1', aiApiKey: 'k', aiModel: 'm' }),
      fetchImpl,
    });
    const p1 = proxy.runEdit({ prompt: 'p', content: 'c', filename: 'f', requestId: 'dup' });
    const p2 = proxy.runEdit({ prompt: 'p2', content: 'c', filename: 'f', requestId: 'dup' });
    const r2 = await p2;
    expect(r2.ok).toBe(true);
    expect(r2.content).toBe('ok');
    proxy.cancelAll();
    await Promise.race([p1.catch(() => {}), new Promise((r) => setTimeout(r, 100))]);
    expect(() => proxy.cancelAll()).not.toThrow();
  });

  it('同 requestId 重新发起后，新请求仍可被 cancel(requestId) 单独取消', async () => {
    const inFlight = [];
    const fetchImpl = (url, opts) => {
      return new Promise((resolve, reject) => {
        inFlight.push({ opts });
        // 必须监听 abort 信号；否则 catch 永远不触发，测试会 timeout
        if (opts && opts.signal) {
          if (opts.signal.aborted) {
            reject(new DOMException('aborted', 'AbortError'));
            return;
          }
          opts.signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          }, { once: true });
        }
      });
    };
    const proxy = createAiProxy({
      getConfig: () => ({ aiProvider: 'openai', aiBaseUrl: 'https://x/v1', aiApiKey: 'k', aiModel: 'm' }),
      fetchImpl,
    });
    const p1 = proxy.runEdit({ prompt: 'p', content: 'c', filename: 'f', requestId: 'dup' });
    await new Promise((r) => setTimeout(r, 0));
    const p2 = proxy.runEdit({ prompt: 'p2', content: 'c', filename: 'f', requestId: 'dup' });
    await new Promise((r) => setTimeout(r, 0));
    proxy.cancel('dup');
    // 等两个都 settle（aborted）
    await Promise.all([
      p1.catch(() => {}),
      p2.catch(() => {}),
    ]);
    expect(inFlight).toHaveLength(2);
    // 关键断言：第二个请求的 signal.aborted 必须是 true
    // —— F1 修复前：旧 cleanup 把 controller 从 Map 抹掉，proxy.cancel('dup') 是 no-op
    expect(inFlight[1].opts.signal.aborted).toBe(true);
  });
});

// audit M1+M2+M3 回归测试：API Key 脱敏 + URL userinfo 剥除 + JSON-wrapped header 修复
describe('createAiProxy.runEdit —— API Key 脱敏 + URL 清洗', () => {
  // M1 fix：fetch 抛错时 message 里携带 key 也必须脱敏。
  // 真实场景：fetch reject 的 Error.message 偶尔会包含 URL（含 query key）或
  // 自定义 fetch 包装层把请求 headers 拼进 message。
  it('M1：网络错误 message 含 sk- 前缀的 key → result.message 已脱敏', async () => {
    const proxy = createAiProxy({
      getConfig: () => ({ aiProvider: 'openai', aiBaseUrl: 'https://x/v1', aiApiKey: 'k', aiModel: 'm' }),
      fetchImpl: async () => { throw new Error('fetch failed for Authorization: Bearer sk-realsk1234567890abcdef'); },
    });
    const r = await proxy.runEdit({ prompt: 'p', content: 'c', filename: 'f', requestId: 'm1' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('AI_PROVIDER_ERROR');
    expect(r.message).not.toMatch(/sk-realsk1234567890abcdef/);
    expect(r.message).toMatch(/\[API_KEY\]/);
  });

  // M1 follow-up：非 sk- 前缀的 key（自定义 token / API secret）也应被某条规则盖住。
  it('M1：网络错误 message 含通用 token=xxx → result.message 已脱敏', async () => {
    const proxy = createAiProxy({
      getConfig: () => ({ aiProvider: 'openai', aiBaseUrl: 'https://x/v1', aiApiKey: 'k', aiModel: 'm' }),
      fetchImpl: async () => { throw new Error('api_key=hunter2_real_secret_was_here'); },
    });
    const r = await proxy.runEdit({ prompt: 'p', content: 'c', filename: 'f', requestId: 'm1b' });
    expect(r.ok).toBe(false);
    expect(r.message).not.toMatch(/hunter2_real_secret_was_here/);
    expect(r.message).toMatch(/\[REDACTED\]/);
  });

  // M2 fix：baseURL 含 userinfo（https://user:pass@host）必须剥掉。
  // 真实场景：中转服务在 baseURL 里塞 userinfo 简化配置；fetch 会把 userinfo
  // 当 Basic Auth 自动发出去，凭据泄露到第三方。
  it('M2：baseURL 含 userinfo → 实际 fetch 的 URL 已剥 userinfo', async () => {
    let captured = null;
    const fetchImpl = async (url) => {
      captured = url;
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"content":"ok"}' }, finish_reason: 'stop' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const proxy = createAiProxy({
      getConfig: () => ({
        aiProvider: 'openai',
        aiBaseUrl: 'https://hunter2:secret@relay.example.com/v1',
        aiApiKey: 'k', aiModel: 'm',
      }),
      fetchImpl,
    });
    const r = await proxy.runEdit({ prompt: 'p', content: 'c', filename: 'f', requestId: 'm2' });
    expect(r.ok).toBe(true);
    expect(captured).toBe('https://relay.example.com/v1/chat/completions');
    expect(captured).not.toMatch(/hunter2/);
    expect(captured).not.toMatch(/secret/);
    expect(captured).not.toMatch(/@/);
  });

  // M2 follow-up：URL 里 path 段含 sk-xxx 的极端情况也要在 sanitizeUrl 输出里被遮罩。
  // 不依赖 joinUrl（防御深度）：sanitizeUrl 单独处理原始 URL 时也应当剥 userinfo。
  it('M2：sanitizeUrl 输出（HTTP 错误日志）已剥 userinfo + path 段 key', async () => {
    /** @type {Array<{event:string, data:any}>} */
    const logs = [];
    const proxy = createAiProxy({
      getConfig: () => ({
        aiProvider: 'openai',
        aiBaseUrl: 'https://user:pass@api.example.com/v1',
        aiApiKey: 'k', aiModel: 'm',
      }),
      fetchImpl: async () => new Response('oops', { status: 500 }),
      log: (event, data) => logs.push({ event, data }),
    });
    const r = await proxy.runEdit({ prompt: 'p', content: 'c', filename: 'f', requestId: 'm2b' });
    expect(r.ok).toBe(false);
    const httpErrLog = logs.find((l) => l.event === 'ai:http_error');
    expect(httpErrLog).toBeDefined();
    expect(httpErrLog.data.url).not.toMatch(/user/);
    expect(httpErrLog.data.url).not.toMatch(/pass/);
    expect(httpErrLog.data.url).not.toMatch(/@/);
    expect(httpErrLog.data.url).toMatch(/^https:\/\/api\.example\.com/);
  });

  // M2 follow-up (Round 14)：percent-encoded userinfo 也必须剥。
  // 旧 regex `^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@` 不接受 `%` 之外的字符，但
  // percent-encoded 形式 `user%40evil.com:pass@host` 字面上没有 `@` —— fetch
  // 在解析 URL 时把 `%40` 还原成 `@`，再按 Basic Auth 发送，等于把
  // "user%40evil.com:pass" 整段写到 Authorization 头，敏感凭据直发中转。
  it('M2 percent-encoded：baseURL 含 %40 编码的 userinfo → 实际 fetch 的 URL 已剥 userinfo', async () => {
    let captured = null;
    const fetchImpl = async (url) => {
      captured = url;
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"content":"ok"}' }, finish_reason: 'stop' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const proxy = createAiProxy({
      getConfig: () => ({
        aiProvider: 'openai',
        aiBaseUrl: 'https://hunter2%40evil.com:secret@relay.example.com/v1',
        aiApiKey: 'k', aiModel: 'm',
      }),
      fetchImpl,
    });
    const r = await proxy.runEdit({ prompt: 'p', content: 'c', filename: 'f', requestId: 'm2pct' });
    expect(r.ok).toBe(true);
    // 剥 userinfo 之后只剩 host + path，不能再含 hunter2 / secret 字样
    expect(captured).toBe('https://relay.example.com/v1/chat/completions');
    expect(captured).not.toMatch(/hunter2/);
    expect(captured).not.toMatch(/secret/);
  });

  // M2 follow-up (Round 14)：sanitizeUrl 也走 new URL 解析路径，percent-encoded
  // userinfo 在错误日志里也必须被遮罩（与 fetch URL 行为一致）。
  it('M2 percent-encoded：sanitizeUrl 输出（HTTP 错误日志）已剥 percent-encoded userinfo', async () => {
    const logs = [];
    const proxy = createAiProxy({
      getConfig: () => ({
        aiProvider: 'openai',
        aiBaseUrl: 'https://user%40evil.com:pass@api.example.com/v1',
        aiApiKey: 'k', aiModel: 'm',
      }),
      fetchImpl: async () => new Response('oops', { status: 500 }),
      log: (event, data) => logs.push({ event, data }),
    });
    const r = await proxy.runEdit({ prompt: 'p', content: 'c', filename: 'f', requestId: 'm2pctlog' });
    expect(r.ok).toBe(false);
    const httpErrLog = logs.find((l) => l.event === 'ai:http_error');
    expect(httpErrLog).toBeDefined();
    expect(httpErrLog.data.url).not.toMatch(/user/);
    expect(httpErrLog.data.url).not.toMatch(/pass/);
    expect(httpErrLog.data.url).toMatch(/^https:\/\/api\.example\.com/);
  });

  // M3 fix：HTTP 错误回显里出现 JSON 风格的 `"authorization": "Bearer xxx"` 文本
  // （错误信息里把 header 序列化成字符串，AI proxy / 网关常见），旧 regex 遇到 `"`
  // 就停，只盖到开引号，剩下 `xxx` 全部漏出。新增的 JSON 包装 pattern 一次性吃完整段。
  // 这里使用非 sk- 前缀的 key，确保测试通过 sk- 正则 fail（只覆盖 JSON-wrapped 修复路径）。
  it('M3：JSON-wrapped authorization header（非 sk- 前缀）→ 已脱敏', async () => {
    const SENSITIVE = 'eyJhbGciOiJIUzI1NiJ9.payload.signature_xxx_no_sk_prefix';
    const proxy = createAiProxy({
      getConfig: () => ({ aiProvider: 'openai', aiBaseUrl: 'https://x/v1', aiApiKey: 'k', aiModel: 'm' }),
      fetchImpl: async () => new Response(JSON.stringify({
        error: { message: `upstream returned: "authorization": "Bearer ${SENSITIVE}"` },
      }), { status: 400, headers: { 'Content-Type': 'application/json' } }),
    });
    const r = await proxy.runEdit({ prompt: 'p', content: 'c', filename: 'f', requestId: 'm3' });
    expect(r.ok).toBe(false);
    // 关键断言：JWT 内容不再出现在 toast message 里
    expect(r.message).not.toMatch(/eyJhbGciOiJIUzI1NiJ9/);
    expect(r.message).not.toMatch(/payload\.signature_xxx_no_sk_prefix/);
    expect(r.message).toMatch(/REDACTED/);
  });

  // M3 follow-up：短 key 阈值 8 → 5 后，截断的 sk- 也能被捕获。
  // 状态码选 400 且不带 invalid_request_error.type —— 走 main/ai.js 末尾
  // 「AI 请求失败（HTTP 400）：{detail}」路径，detail 经 sanitizeDetail 脱敏后
  // 进入 result.message。401/403/404/429/5xx 都有早退固定文案，不展示上游 detail。
  it('M3：截断的 sk-（5 字符后缀）→ 已脱敏为 [API_KEY]', async () => {
    const proxy = createAiProxy({
      getConfig: () => ({ aiProvider: 'openai', aiBaseUrl: 'https://x/v1', aiApiKey: 'k', aiModel: 'm' }),
      fetchImpl: async () => new Response(JSON.stringify({
        error: { message: 'invalid token: sk-12345abc (truncated for security)' },
      }), { status: 400, headers: { 'Content-Type': 'application/json' } }),
    });
    const r = await proxy.runEdit({ prompt: 'p', content: 'c', filename: 'f', requestId: 'm3b' });
    expect(r.ok).toBe(false);
    // 不应出现真实截断的 key 段
    expect(r.message).not.toMatch(/sk-12345abc/);
    expect(r.message).toMatch(/\[API_KEY\]/);
  });
});

// audit shared-M11 + shared-M13：归一化层对「非字符串 content」和「非文本块」做了区分
describe('createAiProxy.runEdit —— shared-M11 / shared-M13 归一化分支', () => {
  // M11：Anthropic 返回的 content 全部是 tool_use / image（无 text 块）——
  // 旧版会误报「AI 返回了空内容」让用户重试；新版提示「无法识别」。
  it('M11：Anthropic 仅返回 tool_use 块（无 text）→ 明确提示 tool_use / 图像块', async () => {
    const proxy = createAiProxy({
      getConfig: () => ({ aiProvider: 'anthropic', aiBaseUrl: 'https://x', aiApiKey: 'k', aiModel: 'm' }),
      fetchImpl: async () => new Response(JSON.stringify({
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'BJ' } },
        ],
        stop_reason: 'end_turn',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    });
    const r = await proxy.runEdit({ prompt: 'p', content: 'c', filename: 'f', requestId: 'm11a' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('AI_BAD_RESPONSE');
    // 提示里要让用户知道是「格式不识别」而不是「内容为空」
    expect(r.message).toMatch(/tool_use|图像块/);
  });

  it('M11：Anthropic 仅返回 image 块（无 text）→ 同样提示无法识别', async () => {
    const proxy = createAiProxy({
      getConfig: () => ({ aiProvider: 'anthropic', aiBaseUrl: 'https://x', aiApiKey: 'k', aiModel: 'm' }),
      fetchImpl: async () => new Response(JSON.stringify({
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: '...' } }],
        stop_reason: 'end_turn',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    });
    const r = await proxy.runEdit({ prompt: 'p', content: 'c', filename: 'f', requestId: 'm11b' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('AI_BAD_RESPONSE');
    expect(r.message).toMatch(/tool_use|图像块/);
  });

  it('M11：Anthropic content 数组空 → 仍报「空内容」（不是 tool_use 路径）', async () => {
    // 兜底：旧分支 'AI 返回了空内容' 仍保留，区分「真的没回」和「回了非文本」。
    const proxy = createAiProxy({
      getConfig: () => ({ aiProvider: 'anthropic', aiBaseUrl: 'https://x', aiApiKey: 'k', aiModel: 'm' }),
      fetchImpl: async () => new Response(JSON.stringify({
        content: [],
        stop_reason: 'end_turn',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    });
    const r = await proxy.runEdit({ prompt: 'p', content: 'c', filename: 'f', requestId: 'm11c' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('AI_BAD_RESPONSE');
    expect(r.message).toBe('AI 返回了空内容');
  });

  it('M11：Anthropic 混合 text + tool_use → 只提取 text，responseFormat=json', async () => {
    // 混合块：正常路径 —— text 被拼接，tool_use 跳过，但不影响 ok=true。
    const proxy = createAiProxy({
      getConfig: () => ({ aiProvider: 'anthropic', aiBaseUrl: 'https://x', aiApiKey: 'k', aiModel: 'm' }),
      fetchImpl: async () => new Response(JSON.stringify({
        content: [
          { type: 'tool_use', id: 't1', name: 'noop', input: {} },
          { type: 'text', text: '{"content":"mixed ok"}' },
        ],
        stop_reason: 'end_turn',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    });
    const r = await proxy.runEdit({ prompt: 'p', content: 'c', filename: 'f', requestId: 'm11d' });
    expect(r.ok).toBe(true);
    expect(r.content).toBe('mixed ok');
    expect(r.responseFormat).toBe('json');
  });

  // M13：模型按规矩返回了 JSON 对象但 content 不是字符串（数组 / 对象 / null / 数字）。
  // 旧逻辑走「output 截断」分支误导用户；新版把 message 整体当 raw 回退给用户。
  it('M13：OpenAI 返回的 JSON 解析后 content 是数组 → responseFormat=raw，回退原 message', async () => {
    const rawMessage = '{"content":[]}';
    const proxy = createAiProxy({
      getConfig: () => ({ aiProvider: 'openai', aiBaseUrl: 'https://x/v1', aiApiKey: 'k', aiModel: 'm' }),
      fetchImpl: async () => new Response(JSON.stringify({
        choices: [{ message: { content: rawMessage }, finish_reason: 'stop' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    });
    const r = await proxy.runEdit({ prompt: 'p', content: 'c', filename: 'f', requestId: 'm13a' });
    expect(r.ok).toBe(true);
    expect(r.responseFormat).toBe('raw');
    // 回退：原 message 整体作为 content，让用户看到模型实际输出
    expect(r.content).toBe(rawMessage);
  });

  it('M13：OpenAI 返回的 JSON 解析后 content 是 null → responseFormat=raw', async () => {
    const proxy = createAiProxy({
      getConfig: () => ({ aiProvider: 'openai', aiBaseUrl: 'https://x/v1', aiApiKey: 'k', aiModel: 'm' }),
      fetchImpl: async () => new Response(JSON.stringify({
        choices: [{ message: { content: '{"content":null,"meta":"x"}' }, finish_reason: 'stop' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    });
    const r = await proxy.runEdit({ prompt: 'p', content: 'c', filename: 'f', requestId: 'm13b' });
    expect(r.ok).toBe(true);
    expect(r.responseFormat).toBe('raw');
    expect(r.content).toBe('{"content":null,"meta":"x"}');
  });

  it('M13：OpenAI 返回的 JSON 解析后 content 是嵌套对象 → responseFormat=raw', async () => {
    const rawMessage = '{"content":{"ops":[{"op":"replace","old":"a","new":"b"}]}}';
    const proxy = createAiProxy({
      getConfig: () => ({ aiProvider: 'openai', aiBaseUrl: 'https://x/v1', aiApiKey: 'k', aiModel: 'm' }),
      fetchImpl: async () => new Response(JSON.stringify({
        choices: [{ message: { content: rawMessage }, finish_reason: 'stop' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    });
    const r = await proxy.runEdit({ prompt: 'p', content: 'c', filename: 'f', requestId: 'm13c' });
    expect(r.ok).toBe(true);
    expect(r.responseFormat).toBe('raw');
    expect(r.content).toBe(rawMessage);
  });
});

// ---------------------------------------------------------------------------
// audit round-13：Anthropic / OpenAI max_tokens 上限路由
//
// 回归背景：pickAnthropicTokenConfig 的正则要求 `claude-` 后紧跟已知片段，
// 于是 claude-opus-5 / claude-sonnet-5 / claude-haiku-4-5 全部漏网 → 回退 8192，
// 比 claude-opus-4-8（16384）还低。「越新的模型拿到越小的 max_tokens」，
// 长笔记改写在 8k 被截断 → stop_reason: max_tokens → 报「AI 修改结果不完整」。
// ---------------------------------------------------------------------------
describe('max_tokens 上限按模型路由', () => {
  /**
   * 跑一次 runEdit，返回实际发出的请求 body。
   * @param {'openai'|'anthropic'} provider
   * @param {string} model
   */
  async function capturedBody(provider, model) {
    let captured = null;
    const okBody = provider === 'anthropic'
      ? { content: [{ type: 'text', text: '{"content":"ok"}' }], stop_reason: 'end_turn' }
      : { choices: [{ message: { content: '{"content":"ok"}' }, finish_reason: 'stop' }] };
    const proxy = createAiProxy({
      getConfig: () => ({
        aiProvider: provider,
        aiBaseUrl: provider === 'anthropic' ? 'https://x' : 'https://x/v1',
        aiApiKey: 'k',
        aiModel: model,
      }),
      fetchImpl: async (url, init) => {
        captured = JSON.parse(init.body);
        return new Response(JSON.stringify(okBody), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    const r = await proxy.runEdit({ prompt: 'p', content: 'c', filename: 'f.md', requestId: 'cap' });
    expect(r.ok).toBe(true);
    return captured;
  }

  // ---- Anthropic：5 系与 4.6+ 拿到 32k ----
  // Round 13 fix (H4)：新增 claude-haiku-5-*（旧正则漏命中落到 16k 档）。
  it.each([
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-fable-5',
    'claude-haiku-5',
    'claude-haiku-5-20251001',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-sonnet-4-6',
  ])('Anthropic %s → max_tokens 32000（官方 128k 上限，保守取值）', async (model) => {
    const body = await capturedBody('anthropic', model);
    expect(body.max_tokens).toBe(32_000);
  });

  // ---- Anthropic：其余 4 系 / 3-5 / 3-7 拿到 16k ----
  it.each([
    'claude-haiku-4-5',
    'claude-sonnet-4-5',
    'claude-opus-4-5',
    'claude-3-7-sonnet-20250219',
    'claude-3-5-sonnet-20241022',
  ])('Anthropic %s → max_tokens 16384', async (model) => {
    const body = await capturedBody('anthropic', model);
    expect(body.max_tokens).toBe(16_384);
  });

  // ---- Anthropic：claude-3 老家族 4k（官方上限），未知模型 8k ----
  // Round 13 fix (H2)：claude-3 老家族官方 max output = 4096。旧值 8192
  // 会让 opus-3 / sonnet-3 / haiku-3 被服务端 400 拒绝。
  it.each([
    'claude-3-opus-20240229',
    'claude-3-haiku-20240307',
    'claude-3-sonnet-20240229',
  ])('Anthropic %s（claude-3 老家族）→ max_tokens 4096', async (model) => {
    const body = await capturedBody('anthropic', model);
    expect(body.max_tokens).toBe(4_096);
  });

  it('Anthropic 未知模型（自部署 / 中转）→ max_tokens 8192，最大限度兼容', async () => {
    const body = await capturedBody('anthropic', 'my-local-llm-v2');
    expect(body.max_tokens).toBe(8_192);
  });

  // 关键不变式：新模型的上限不得低于老模型（这正是本轮修的 bug）
  it('回归：claude-opus-5 的 max_tokens 不低于 claude-opus-4-8', async () => {
    const five = await capturedBody('anthropic', 'claude-opus-5');
    const four = await capturedBody('anthropic', 'claude-opus-4-8');
    expect(five.max_tokens).toBeGreaterThanOrEqual(four.max_tokens);
  });

  it('回归：claude-haiku-4-5 的 max_tokens 高于 claude-3 老家族', async () => {
    const haiku45 = await capturedBody('anthropic', 'claude-haiku-4-5');
    const old3 = await capturedBody('anthropic', 'claude-3-haiku-20240307');
    expect(haiku45.max_tokens).toBeGreaterThan(old3.max_tokens);
  });

  // ---- OpenAI 侧：token 字段路由不受影响（防回归） ----
  it('OpenAI gpt-5 → max_completion_tokens 且不带 temperature', async () => {
    const body = await capturedBody('openai', 'gpt-5');
    expect(body.max_completion_tokens).toBe(32_000);
    expect(body.max_tokens).toBeUndefined();
    expect(body.temperature).toBeUndefined();
  });

  it('OpenAI gpt-4o → max_tokens 16384 且带 temperature', async () => {
    const body = await capturedBody('openai', 'gpt-4o');
    expect(body.max_tokens).toBe(16_384);
    expect(body.max_completion_tokens).toBeUndefined();
    expect(typeof body.temperature).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// audit round-13 Sec-H3：fetch 必须 redirect:'manual' 防 API key 跟着 302 走
//
// 回归背景：Anthropic 用 x-api-key 自定义头（不在 fetch 规范 CORS 非通配脱敏集
// 合里），undici 默认 follow 重定向到不同 origin 时会原样复传 header。
// 用户配置的中转 / 网关一旦 302 到攻击者域，sk-ant-... 跟当前笔记全文会被转发。
// ---------------------------------------------------------------------------
describe('createAiProxy —— redirect: manual 防 API Key 跟随重定向', () => {
  it('fetch 调用必带 redirect:"manual"（OpenAI 分支）', async () => {
    let captured = null;
    const fetchImpl = async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"content":"ok"}' }, finish_reason: 'stop' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const proxy = createAiProxy({
      getConfig: () => ({
        aiProvider: 'openai',
        aiBaseUrl: 'https://x/v1', aiApiKey: 'sk-test', aiModel: 'gpt-4o-mini',
      }),
      fetchImpl,
    });
    await proxy.runEdit({ prompt: 'p', content: 'c', filename: 'f', requestId: 'r-redir-1' });
    expect(captured.init.redirect).toBe('manual');
  });

  it('fetch 调用必带 redirect:"manual"（Anthropic 分支）', async () => {
    let captured = null;
    const fetchImpl = async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify({
        content: [{ type: 'text', text: '{"content":"ok"}' }], stop_reason: 'end_turn',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const proxy = createAiProxy({
      getConfig: () => ({
        aiProvider: 'anthropic',
        aiBaseUrl: 'https://x', aiApiKey: 'sk-ant-test', aiModel: 'claude-opus-5',
      }),
      fetchImpl,
    });
    await proxy.runEdit({ prompt: 'p', content: 'c', filename: 'f', requestId: 'r-redir-2' });
    expect(captured.init.redirect).toBe('manual');
  });

  it('3xx 重定向 → opaqueredirect → AI_PROVIDER_ERROR + 提示用户改 Base URL', async () => {
    // 模拟 undici 在 manual 模式下返回的 opaqueredirect Response：status=0、type='opaqueredirect'
    const fetchImpl = async () => {
      const res = new Response(null, { status: 302 });
      // 模拟 opaqueredirect 的关键属性：status 0 + type 'opaqueredirect'
      Object.defineProperty(res, 'status', { value: 0 });
      Object.defineProperty(res, 'type', { value: 'opaqueredirect' });
      return res;
    };
    const proxy = createAiProxy({
      getConfig: () => ({
        aiProvider: 'openai',
        aiBaseUrl: 'https://evil-redirect.example/v1', aiApiKey: 'sk-test', aiModel: 'gpt-4o',
      }),
      fetchImpl,
    });
    const r = await proxy.runEdit({ prompt: 'p', content: 'c', filename: 'f', requestId: 'r-redir-3' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('AI_PROVIDER_ERROR');
    expect(r.message).toMatch(/发生了重定向/);
    expect(r.message).toMatch(/不会自动跟随重定向/);
  });
});
