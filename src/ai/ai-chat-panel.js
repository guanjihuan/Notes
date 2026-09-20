// AI 对话面板（底部 dock）
// ============================================================================
//
// 给一段自然语言修改要求 + 当前文件内容，发给主进程调 AI。
// 状态机：idle → submitting → (success | error | cancelled) → idle
// 不持有 diff 数据（diff 走 AiDiffPanel / AiController）。
//
// 职责边界：
//   - 状态展示（status / error 通过 onNotify 转发到状态栏 #status-ai chip）
//   - 收集用户输入
//   - 防 IME（compositionstart/end 期间不响应 Enter）
//   - 失败重试：失败后用户改完提示词直接按 Enter 重新提交，不用关面板
//
// 状态展示迁移（[feedback-ai-tips-into-status-bar]）：原本写在自己
// .ai-chat-status-row 的过程/错误文案，现在通过 onNotify(text, type) 转发
// 给外部（通常是 statusbar 上的 AI chip）。dock 本身只剩输入行，不再占底部一行。
// ============================================================================

import { AI_ERROR } from './ai-status.js';

function createRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `ai-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 长提示词软警告阈值（按字符计，UTF-8 近似字节；CJK 是 3 字节/字符，这里保守
 * 按 ASCII 1 字节算，实际 CJK 阈值会更大一些，方向是「宁可漏报也不骚扰」）。
 * 32KB 是经验阈值：超过后多数模型服务开始明显变慢，部分服务开始截断。
 */
const LONG_PROMPT_BYTES = 32 * 1024;

/**
 * 把 controller 的中性状态文案映射到 chip 的视觉类型。
 * panel 这一侧不深推；不识别就回退 'success'（中性 muted）。
 * - 空文本 → 'idle'（chip 回到"无动作"中性态，只显示 "AI" 标签）
 * - '正在发送...' → running
 * - '正在取消...' → running（用户操作中）
 * - '已取消...' → cancelled
 * 其它走 success。controller 在三处显式调 onNotify(_, 'diff')，不走这条路径。
 *
 * 注：空文本返回 'success' 会让 chip 的 success dot 一直亮着，掩盖「已回到
 * 无动作态」的信号 —— 用户看到 chip 高亮会以为还有事在跑。所以空文本走 'idle'.
 *
 * @param {string} text
 * @returns {'idle'|'running'|'cancelled'|'success'}
 */
function inferStatusType(text) {
  if (!text) return 'idle';
  if (text.indexOf('正在发送') === 0 || text.indexOf('正在取消') === 0) return 'running';
  if (text.indexOf('已取消') === 0) return 'cancelled';
  // 'info' 是 panel 主动调的（如长提示词提示），不参与被动推断
  return 'success';
}

export class AiChatPanel {
  /**
   * @param {object} options
   * @param {HTMLElement} options.element - 容器 div（已在 index.html 写好骨架）
   * @param {(payload: {prompt:string, requestId:string}) => Promise<{ok:boolean, id?:string, content?:string, responseFormat?:string, error?:string, message?:string}>} options.onSubmit
   * @param {(requestId:string) => void} options.onCancel
   * @param {(text:string, type:'idle'|'running'|'cancelled'|'error'|'success'|'diff') => void} [options.onNotify]
   *   把过程/错误文案转发到外部 UI（statusbar 上的 #status-ai chip）。不传则静默丢弃。
   */
  constructor({ element, onSubmit, onCancel, onNotify }) {
    this.element = element;
    this.onSubmit = onSubmit;
    this.onCancel = onCancel;
    this.onNotify = typeof onNotify === 'function' ? onNotify : null;
    this._open = false;
    this._enabled = true;
    this._submitting = false;
    this._composing = false;
    this._currentRequestId = null;
    this._cancelled = null; // Set：被用户取消的 requestId 集合；懒创建于 _triggerCancel
    this._listeners = [];
    this._bind();
  }

  _bind() {
    const input = this.element.querySelector('.ai-chat-input');
    const submitBtn = this.element.querySelector('.ai-chat-submit');
    const toggleBtn = this.element.querySelector('.ai-chat-toggle');

    if (input) {
      this._listeners.push([input, 'input', () => {
        this._syncSubmitButton();
        this._syncLongPromptHint();
      }]);
      this._listeners.push([input, 'compositionstart', () => { this._composing = true; }]);
      this._listeners.push([input, 'compositionend', () => { this._composing = false; }]);
      // 兜底：IME 异常不发 compositionend 时，_composing 会永远卡 true，
      // 导致 Enter 永久失效。blur 时强制重置（用户切走时输入已结束）。
      this._listeners.push([input, 'blur', () => { this._composing = false; }]);
      this._listeners.push([input, 'keydown', (e) => {
        // Enter = 提交（不 Shift）；IME 输入中不发
        if (e.key === 'Enter' && !e.shiftKey && !this._composing) {
          e.preventDefault();
          this._triggerSubmit();
        }
      }]);
    }
    // 没有 .ai-chat-form 包装时（index.html 当前结构），按钮点击就是触发的来源
    if (submitBtn) {
      this._listeners.push([submitBtn, 'click', (e) => {
        // submitting 时：点击 = 取消（需要在 _triggerSubmit 之前 preventDefault）
        if (this._submitting) {
          e.preventDefault();
          this._triggerCancel();
          return;
        }
        // 否则：提交
        e.preventDefault();
        this._triggerSubmit();
      }]);
    }
    if (toggleBtn) {
      this._listeners.push([toggleBtn, 'click', () => this.close()]);
    }
    for (const [el, ev, fn] of this._listeners) {
      el.addEventListener(ev, fn);
    }
  }

  open() {
    this._open = true;
    this.element.hidden = false;
    // C1 fix (audit)：close→open 路径上若 _submitting 状态残留（IPCF 还没回包），
    // input.disabled 仍为 true，输入框会被永久禁用。这里走 _inputShouldBeDisabled()
    // 合并所有禁用条件，_submitting 自身的回包路径仍会通过 finally 再次同步状态。
    const input = this.element.querySelector('.ai-chat-input');
    if (input) input.disabled = this._inputShouldBeDisabled();
    this._syncSubmitButton();
    // 自动聚焦输入框（用户点按钮来开）
    requestAnimationFrame(() => {
      const el = this.element.querySelector('.ai-chat-input');
      if (el && !el.disabled) el.focus();
    });
  }

  close() {
    this._open = false;
    this.element.hidden = true;
    // 关闭时若还有请求：撤销
    if (this._submitting) this._triggerCancel();
    // P3 fix：hung 请求兜底 —— _triggerCancel 只是把 cancel 发给主进程；如果 AI
    // 服务永远不回包，_triggerSubmit 的 await 永远不会 resolve，finally 永远跑不到，
    // _submitting 卡在 true。close 不强制复位，下次 open 时用户按提交会被
    // `if (this._submitting) return` 挡住、误以为按钮坏了。
    // audit fix (Phase O-L18)：原 `if (this._submitting && this._canceling)` 是
    // 死代码 —— _canceling 从未置 true（line 376-377 注释明确说不设），整个 if
    // 分支永远不进。简化：仅看 _submitting；notify 不动（让残留的 in-flight
    // 旧请求自己跑完）。输入框 / 输入按钮的 disabled 由下次 open() + setEnabled() 同步。
    if (this._submitting) {
      this._submitting = false;
      this._currentRequestId = null;
      this._syncSubmitButton();
    }
    // 优化 (Round 14)：close 也清 stage 定时器。hung 请求场景下
    // _triggerSubmit 的 finally 永远不会跑，stageTimer 仍在 fire 调
    // this._notify，会用 stages[stageIdx].text 覆盖 close() 刚刚写出的
    // '' / idle chip —— 用户看到关 dock 后 chip 还在升级文案，体验割裂。
    if (this._stageTimer) {
      clearInterval(this._stageTimer);
      this._stageTimer = null;
    }
    // 关掉 dock 时清掉状态栏 chip —— 否则 chip 会留下上次的"已应用"或"AI 请求失败"
    // 残留，让用户误以为是新请求的结果
    this._notify('', 'idle');
  }

  isOpen() {
    return this._open;
  }

  /**
   * 当主进程给出新内容（成功路径），清空输入框。
   * 失败 / 取消保留输入框，方便用户改完直接重试。
   */
  resetInput() {
    const input = this.element.querySelector('.ai-chat-input');
    if (input) input.value = '';
    this._syncSubmitButton();
  }

  /**
   * 强制重置整个面板状态（status / error / submitting / 输入框 disabled）。
   * controller 在 onFileChanged / closeAll 时调用，避免切文件后残留
   * "正在提交…" 状态 / 错误行。
   *
   * Bug-3 fix (audit)：同时清掉 _cancelled Set —— 切文件/重置时可能还有
   * "用户取消但 await 还没回" 的 requestId 留在 Set 里。reset 不清的话：
   *   1. 用户在新文件重新提交 → 触发 _triggerSubmit 的 cancelled.has(requestId)
   *      检查时，可能误命中旧 requestId（UUID 冲突概率虽低，但存在）；
   *   2. Set 只增不减，长期使用会有轻微内存泄漏。
   * _cancelled 是懒创建（_triggerCancel 第一次调用时），所以这里要 lazy-init。
   */
  reset() {
    this._submitting = false;
    this._canceling = false;
    this._currentRequestId = null;
    if (this._cancelled) this._cancelled.clear();
    // 优化 (Round 14)：reset 也清 stage 定时器 —— controller 在
    // onFileChanged / closeAll 调 reset，旧 panel 残留的定时器 fire 时
    // 会调过时的 this._notify 覆盖新 panel 已经写出的 chip 文案。
    if (this._stageTimer) {
      clearInterval(this._stageTimer);
      this._stageTimer = null;
    }
    const input = this.element.querySelector('.ai-chat-input');
    if (input) {
      input.disabled = !this._enabled;
      input.value = '';
    }
    this._notify('', 'idle');
    this._syncSubmitButton();
  }

  /**
   * 没有打开文件 / 没有可修改内容时，禁用面板。
   * @param {boolean} enabled
   */
  setEnabled(enabled) {
    this._enabled = !!enabled;
    const input = this.element.querySelector('.ai-chat-input');
    const submitBtn = this.element.querySelector('.ai-chat-submit');
    if (input) {
      input.disabled = this._inputShouldBeDisabled();
      input.placeholder = this._enabled ? '描述你想如何修改当前文档...' : '请先打开一个 Markdown 文件';
    }
    if (submitBtn) submitBtn.disabled = this._inputShouldBeDisabled();
  }

  /**
   * 单一来源：输入框 / 提交按钮的 disabled 取值。
   * 把"未启用 + 提交中 + 空输入"三个条件集中在一处 —— open() / setEnabled() /
   * _syncSubmitButton() / finally 路径都走这里，避免某条路径漏合并 _submitting 状态
   * 而让用户在 AI 响应期间又能输入新内容（会让新输入框内容与正在响应的内容竞速）。
   * @returns {boolean}
   */
  _inputShouldBeDisabled() {
    return !this._enabled || !!this._submitting;
  }

  /**
   * 应用启动后调用：根据"是否有打开的文件"同步 disabled。
   * @param {boolean} hasFile
   */
  syncFileState(hasFile) {
    this.setEnabled(hasFile);
  }

  _syncSubmitButton() {
    const input = this.element.querySelector('.ai-chat-input');
    const submitBtn = this.element.querySelector('.ai-chat-submit');
    if (!submitBtn) return;
    if (this._submitting) {
      submitBtn.textContent = '取消';
      submitBtn.dataset.mode = 'cancel';
      // a11y #1（critical）：按钮文字在「生成修改 / 取消」之间切换时，
      // aria-label 必须同步 —— 屏幕阅读器只读 aria-label，不读 textContent，
      // 否则用户听到的还是 "生成修改"，与可见状态完全失配。
      submitBtn.setAttribute('aria-label', '取消 AI 请求');
    } else {
      const empty = !input || input.value.trim().length === 0;
      submitBtn.textContent = '生成修改';
      submitBtn.dataset.mode = 'submit';
      submitBtn.setAttribute('aria-label', '生成 AI 修改');
      // 非 submitting 时只受「未启用 + 空输入」影响（_inputShouldBeDisabled 已隐含 !_submitting）
      submitBtn.disabled = !this._enabled || empty;
    }
  }

  /**
   * audit fix (Phase L3-AI 1)：超长提示词的软警告。
   *
   * 用户在 AI dock 里粘贴一大段（比如复制整个章节当 prompt），主进程要把全文
   * 拼进 IPC payload 一次性送给模型服务。提示词越长，IPC 序列化 / 网络上传 /
   * 模型处理时间都线性涨，且超出模型上下文窗口会被服务端截断甚至 400。
   *
   * UX：仅在 input value 跨过 LONG_PROMPT_BYTES（≈32KB）阈值时，向 onNotify
   * 推一条短提示到 statusbar 的 #status-ai chip；用户删回阈值下后立刻清回
   * idle（不污染后续 submit/cancel 的 chip 文案）。
   *
   * 注意：不算 input.value 实际 trim 后的 prompt 字节——用户粘的是「即将提交的
   * 文本」，input.value 是最接近的真相；trim 后的差异在 32KB 量级上无意义。
   * 不要在这里 throw —— 监听器抛错会让 input 整体崩（绑定时未用 { signal }，
   * addEventListener 会把异常往上抛到 dispatch）。
   */
  _syncLongPromptHint() {
    const input = this.element.querySelector('.ai-chat-input');
    if (!input) return;
    // chip 已被 submit / cancel / error 占用时不抢戏；只在 idle 状态下显示提示
    if (this._submitting) return;
    const len = input.value.length;
    if (len >= LONG_PROMPT_BYTES) {
      const kb = Math.round(len / 1024);
      this._notify(`提示词较长（约 ${kb} KB），AI 响应可能变慢`, 'info');
    } else if (len === 0) {
      // 空输入让 chip 回到 idle；用户已清空提示词就别再保留长提示
      this._notify('', 'idle');
    }
    // 中间区间（>0 且 < 阈值）保持现状：不打扰用户
  }

  async _triggerSubmit() {
    if (!this.onSubmit) return;
    if (this._submitting) return;
    if (!this._enabled) return;
    const input = this.element.querySelector('.ai-chat-input');
    const prompt = (input && input.value || '').trim();
    if (!prompt) {
      // M7 fix (audit)：守卫失败的分支也会被 Enter 触发（例如上一次 success 后用户
      // 直接回车提交空字符串）。早返回前把 chip 清回 idle，避免 chip 残留上一次的
      // success / running 视觉误导用户以为"还有事在跑"或"已经提交过了"。
      this._notify('', 'idle');
      return;
    }

    const requestId = createRequestId();
    this._currentRequestId = requestId;
    this._submitting = true;
    this._canceling = false;
    this._notify('正在发送请求…', 'running');
    this._syncSubmitButton();
    if (input) input.disabled = true;

    // 优化 (Round 14)：AI 请求飞行期 chip 文案分阶段升级。
    // 主进程默认超时 300s，普通网络往返 2~5s 体感就让人焦虑；服务慢时用户
    // 只能盯着一个静态的「正在发送请求…」 猜后台在干嘛。按 elapsed 时间
    // 推进 4 个 stage，逐步把"等待"语义升级成"正在处理 / 服务较慢 / 非常慢"，
    // 配合 running 脉冲（CSS）持续闪烁给视觉反馈，让用户感觉系统在干活。
    // 单 setInterval 每 2s 推进一次，避免起 4 个 setTimeout 各自清理。
    // 全部 stage ≤ 60 字（app.js#updateStatusAi 截断保护），保证状态栏窄时不撑爆。
    const startTs = Date.now();
    const stages = [
      { afterMs: 0,    text: '正在发送请求…' },
      { afterMs: 8000, text: 'AI 正在处理…' },
      { afterMs: 25_000, text: 'AI 响应较慢，请耐心等待' },
      { afterMs: 60_000, text: 'AI 响应非常慢，可点取消重试' },
    ];
    let stageIdx = 0;
    const stageTimer = setInterval(() => {
      if (this._currentRequestId !== requestId) {
        clearInterval(stageTimer);
        return;
      }
      const elapsed = Date.now() - startTs;
      while (stageIdx < stages.length - 1 && elapsed >= stages[stageIdx + 1].afterMs) {
        stageIdx += 1;
      }
      this._notify(stages[stageIdx].text, 'running');
    }, 2000);
    this._stageTimer = stageTimer;

    try {
      const result = await this.onSubmit({ prompt, requestId });
      // 已被新请求顶掉（用户点了"取消"或再次提交）：静默
      if (this._currentRequestId !== requestId) return;
      // P1-3 fix (audit)：用户主动点了「取消」→ 忽略该 requestId 的响应，
      // 不 resetInput，不展示 AI 结果。
      if (this._cancelled && this._cancelled.has(requestId)) {
        this._cancelled.delete(requestId);
        this._notify('已取消 AI 请求', 'cancelled');
        return;
      }
      if (result && result.ok) {
        // 成功状态文案由 controller 算（依赖是否有 diff）后调用 setStatus
        this.resetInput();
        // 输入框保持 disabled 由 setEnabled 决定
      } else if (result && result.error === AI_ERROR.ERR_CANCELLED) {
        this._notify('已取消 AI 请求', 'cancelled');
      } else {
        const msg = (result && result.message) ? result.message : 'AI 修改失败';
        this._notify(msg, 'error');
      }
    } catch (e) {
      if (this._currentRequestId !== requestId) return;
      // L17 fix (audit)：catch 分支的 e.message 可能来自 IPC 序列化失败 / 主进程
      // 抛错 / controller 内部 bug，里面可能含路径 / stack / 内部常量。与其
      // echo 给用户（泄露内部细节），不如走中性文案 + console 留痕供排查。
      console.error('[ai-chat-panel] onSubmit threw:', e);
      this._notify('AI 修改失败，请稍后重试', 'error');
    } finally {
      clearInterval(stageTimer);
      if (this._stageTimer === stageTimer) this._stageTimer = null;
      if (this._currentRequestId === requestId) {
        this._submitting = false;
        this._canceling = false;
        this._currentRequestId = null;
        const i = this.element.querySelector('.ai-chat-input');
        if (i) i.disabled = !this._enabled;
        this._syncSubmitButton();
      }
    }
  }

  _triggerCancel() {
    if (!this._submitting) return;
    if (!this._currentRequestId) return;
    const oldRequestId = this._currentRequestId;
    // P1-3 fix (audit)：先标记该 requestId 为 cancelled，让 _triggerSubmit
    // 后续 await 返回时直接丢弃（不 resetInput / 不应用结果）。
    if (!this._cancelled) this._cancelled = new Set();
    this._cancelled.add(oldRequestId);
    // P2-1 fix (audit)：onCancel 抛错不要立即写 error 行 —— 让 _triggerSubmit
    // 的 result 分支统一根据 error code 决定显示「已取消」或「失败」。
    try {
      if (this.onCancel) this.onCancel(oldRequestId);
    } catch (e) {
      console.warn('[ai-chat-panel] onCancel threw:', e);
    }
    // audit fix (Phase L3-RACE 1)：cancel 后立刻允许用户提交新 prompt，不必等
    // 主进程响应真正 abort 后 _triggerSubmit 的 finally 才复位 _submitting。
    // 旧 _triggerSubmit 的 finally 因 currentRequestId !== requestId 会跳过状态
    // 重置（看下面那个 `if (this._currentRequestId === requestId)` 守卫），
    // 所以提前清是安全的；用户立刻打新 prompt + Enter 不会被 `if (this._submitting) return` 拦住。
    // 真正的取消通知由旧 _triggerSubmit 的 _cancelled.has 分支产生 '已取消 AI 请求'。
    this._submitting = false;
    this._currentRequestId = null;
    this._notify('已取消 AI 请求', 'cancelled');
    const input = this.element.querySelector('.ai-chat-input');
    if (input) input.disabled = !this._enabled;
    this._syncSubmitButton();
  }

  /**
   * controller 调：强制取消（用于切文件等场景）—— 即使 chatPanel 自己不知道
   * 这次提交是否还"在 submitting 状态"，都把 IPC cancel 发出去。
   * @param {string} requestId
   */
  cancelRequest(requestId) {
    if (typeof requestId === 'string' && requestId) {
      // L6 fix (audit)：先把 requestId 加进 _cancelled —— 即使 IPC aiCancel 失败
      // （main 端找不到 pending、abort 没赶上），_triggerSubmit 的 await 返回时
      // 仍会命中 _cancelled.has() 短路，显示「已取消」而不是误导性错误信息。
      if (!this._cancelled) this._cancelled = new Set();
      this._cancelled.add(requestId);
      if (this.onCancel) {
        try {
          this.onCancel(requestId);
        } catch (e) {
          // audit fix (1.2)：controller 在切文件 / 用户强退等关键路径调用本方法，
          // 即便 IPC 失败也不应给用户弹红色错误行（瞬时态冲突、误导）。
          // 只在 console 留痕即可。
          console.warn('[ai-chat-panel] cancelRequest 抛错:', e);
        }
      }
    }
  }

  /**
   * controller 调：更新 chip 状态文案（兼容层 —— 旧 controller 路径会继续用）。
   * 内部按文案前缀推断 chip 视觉类型（running / cancelled / success）。
   * 若 controller 想强制类型（如 'diff'），请直接调 onNotify。
   * @param {string} text
   */
  setStatus(text) {
    this._notify(text || '', inferStatusType(text));
  }

  /**
   * controller 调：把错误文案写到 chip（danger 色）。
   * @param {string} text
   */
  setError(text) {
    this._notify(text || '', 'error');
  }

  /**
   * 内部统一出口：把 (text, type) 转发到 onNotify，未注入则静默。
   * 见 [feedback-ai-tips-into-status-bar]：所有 AI 相关提示都收进底部状态栏 chip，
   * 不再在 dock 底部单开一行。
   * @param {string} text
   * @param {'idle'|'running'|'cancelled'|'error'|'success'|'diff'} type
   */
  _notify(text, type) {
    if (this.onNotify) {
      try { this.onNotify(text || '', type); } catch { /* 不让 UI 异常阻断 AI 流程 */ }
    }
  }

  destroy() {
    for (const [el, ev, fn] of this._listeners) {
      el.removeEventListener(ev, fn);
    }
    this._listeners = [];
    // P3-5 fix (audit)：destroy 也要清内部状态，避免 bindMountPoint 重新
    // 调用时旧实例残留 _composing / _submitting / _canceling / _currentRequestId
    this._composing = false;
    this._submitting = false;
    this._canceling = false;
    this._currentRequestId = null;
    this._cancelled = null;
    // 优化 (Round 14)：清掉飞行期 stage 定时器，避免 destroy 后定时器
    // 还在 fire 调过时的 this._notify（onNotify 闭包可能指向旧 UI 入口）。
    if (this._stageTimer) {
      clearInterval(this._stageTimer);
      this._stageTimer = null;
    }
  }
}
