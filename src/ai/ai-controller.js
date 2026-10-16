// AI 控制器
// ============================================================================
//
// 把"AI 对话面板 + AI 差异面板 + 编辑器"串成一个状态机。
//
// 状态：
//   - chatPanelOpen: bool       AI 输入面板是否展开
//   - pendingDiff:   object|null   AI 返回的待应用修改（rows + regions）
//   - isSubmitting:  bool       正在等主进程回包
//
// 数据流：
//   用户输入 prompt
//     → chatPanel.onSubmit(prompt, requestId)
//     → window.api.aiEdit({...})   （主进程调 OpenAI 兼容 API）
//     → 拿到 { content, responseFormat }
//     → computeFullMarkdownDiff(currentContent, content) 算出 regions
//     → setPendingDiff({ rows, regions, baseContent, nextContent })
//     → diffPanel.setDiff(...)  在中间面板渲染
//   用户点 "应用此处" / "应用全部"
//     → editor.applyUserChange(newContent)  // 标脏
//     → 重算 diff（基于新内容）；regions 全部应用完则关掉 diffPanel
//
// 内容变化时（用户继续编辑、撤销/重做、autosave 落地）也要重算 diff，
// 让"应用一部分后还剩多少"始终正确。
// ============================================================================

import { AiChatPanel } from './ai-chat-panel.js';
import { AiDiffPanel } from './ai-diff-panel.js';
import { AI_STATUS, AI_ERROR, aiErrorMessage } from './ai-status.js';

/**
 * 取 pendingDiff 的「不可变提交快照」：originalBaseContent 优先，缺时回退
 * baseContent。apply / skip 漂移判定统一用此函数 —— 避免每个调用点重复
 * `originalBaseContent || baseContent` 表达式，也方便后续把 baseContent
 * 拆为「可变重算基线」/「不可变提交快照」两个独立字段时只改一处。
 * @param {{originalBaseContent?: string, baseContent?: string} | null | undefined} pd
 * @returns {string}
 */
function getImmutableBase(pd) {
  if (!pd) return '';
  return pd.originalBaseContent || pd.baseContent || '';
}

/**
 * 给一段行级 lines 构造只读 context rows（用于 AI 普通回复展示）。
 * 行号必须与 shared/markdown-diff.js 的 splitLines 严格一致 —— 否则 viewer
 * 行号与 diff 行号错位，撤销 / 光标定位跑偏。
 * @param {string} content
 * @returns {Array<{id:string, type:'context', newLineNumber:number, segments:Array<{type:'equal', text:string}>}>}
 */
function linesToContextRows(content) {
  // H1 fix (audit)：用与 splitLines 一致的「normalize + endsWith 处理」逻辑，
  // 替代原来的 `/\r\n?|\n/` split。两者对裸 \r 旧 Mac 风格的行号会差 1：
  //   - 原 split("\r") = ["", ""] → 2 行
  //   - normalize 后 splitLines("\r") = [""] → 1 行
  // renderer 不能 import CJS（shared/* 是 CommonJS），所以内联等价实现。
  const normalized = String(content || '').replace(/\r\n?/g, '\n');
  const lines = normalized.length === 0
    ? []
    : (normalized.endsWith('\n') ? normalized.slice(0, -1).split('\n') : normalized.split('\n'));
  return lines.map((line, index) => ({
    id: `readonly-${index}`,
    type: 'context',
    newLineNumber: index + 1,
    segments: [{ type: 'equal', text: line }],
  }));
}

/**
 * @param {object} options
 * @param {object} options.api - window.api
 * @param {object} options.editor - MarkdownEditor 实例
 * @param {object} options.state - app.js 的 state
 * @param {(msg:string, type?:string, duration?:number) => void} options.toast
 * @param {() => object} options.getSettings - 读最新设置（settingsStore.getAll）
 * @param {() => void} [options.onAfterApply] - 成功 apply region / all 后通知外部刷新 viewer。
 *   preview 模式下 scheduleLivePreview 只在 split 模式刷新 viewer，AI 改动只能通过
 *   这个回调让 viewer 看到（否则用户感觉"点了应用，文件没反应"）。
 * @param {() => void|Promise<void>} [options.onOpenSettings] - 未配置时调：直接打开设置对话框
 *   并把焦点定位到 AI 段。AI 按钮 / 提交时检测到未配置都会触发，比 toast 更直接 —— 让用户
 *   能立刻看到「还差什么」而不是看到一条转瞬即逝的警告。
 * @param {(text:string, type:import('./ai-status.js').AI_STATUS[keyof import('./ai-status.js').AI_STATUS]) => void} [options.notify]
 *   把 AI 过程/结果文案转发到外部 UI（statusbar 上的 #status-ai chip）。由 controller
 *   主动调：setStatus / setError 在 chatPanel 内部已经转发到 onNotify，但 controller
 *   想明确标注类型（如 AI_STATUS.DIFF）时直接调本回调（绕过 chatPanel 的 inferStatusType）。
 * @param (() => boolean) [options.isSettingsOpen] - 设置对话框当前是否打开。打开时
 *   togglePanel 会拒绝打开 AI dock 并 toast（双向互斥，避免 AI dock 透过 modal
 *   半透明背景露在设置对话框背后造成视觉重叠 / 误点）。未传则视为永远关闭。
 * @param {(isOpen:boolean) => void} [options.onDiffOpenChange] - AI 修复预览面板（中间 diff 面板）
 *   显隐状态变化时回调（true = 面板可见、false = 隐藏）。调用方收到 true 后可
 *   强制编辑器切到编辑模式并禁用预览 / 双栏切换；收到 false 后还原。回调仅在
 *   「与上一次状态不同」时触发，避免 setPendingDiff 内部多次刷新造成重复回调。
 */
export function createAiController({
  api, editor, state, toast, getSettings, onAfterApply, onOpenSettings, notify, isSettingsOpen, onDiffOpenChange,
}) {
  if (!api || !api.aiEdit) {
    console.error('[ai-controller] api.aiEdit 不可用；preload 没暴露 AI 桥？');
  }
  if (!editor) throw new Error('[ai-controller] editor 必填');

  // 状态
  let pendingDiff = null;
  let lastAppliedContent = null; // 防止 content 变化时无限重算自己
  let currentRequestId = null;  // 用于切文件时取消 in-flight 请求（见 onFileChanged）
  // P0-1 fix (audit)：单调 generation 计数器。handleSubmit 入参时捕获，
  // await 后比对 —— 文件切换 / 取消 / 重新提交都会 ++generation 把旧请求废弃。
  // 防止 AI 响应覆盖新文件的 pendingDiff（数据丢失风险）。
  let requestGeneration = 0;
  // 防抖 timer：onContentChanged 不再每个 keystroke 都跑 sync DP
  let recomputeTimer = null;
  // AI 修复预览显隐状态：用于在 syncBodyFlag 检测到状态翻转时回调 onDiffOpenChange。
  // 初始 false —— pendingDiff 默认 null，面板隐藏。
  let diffOpenState = false;

  // 安全 notify 闭包：notify 可选注入，未传则静默（与 panel 内部 _notify 同款语义）。
  // controller 在 4 处显式调（AI_STATUS.DIFF / AI_STATUS.IDLE），其余走 chatPanel.setStatus 转发。
  const safeNotify = (text, type) => {
    if (typeof notify !== 'function') return;
    try { notify(text || '', type); } catch { /* 不让 UI 异常阻断 AI 流程 */ }
  };

  function isChatOpen() {
    return chatPanel && chatPanel.isOpen();
  }

  function isConfigured() {
    const s = typeof getSettings === 'function' ? (getSettings() || {}) : {};
    // P1-1 fix (audit)：renderer 端 aiApiKey 是空字符串（main.js 已过滤），
    // 真值标识走 _hasAiKey 布尔位 —— 也兼容旧测试 / 老 settings 直接传 aiApiKey 的情况
    const hasKey = !!s._hasAiKey || !!String(s.aiApiKey || '').trim();
    return !!(String(s.aiBaseUrl || '').trim() && hasKey && String(s.aiModel || '').trim());
  }

  function recomputeDiffFromBase() {
    // 用户在编辑器里继续改了内容：基于最新内容 + AI 的 nextContent 重算
    if (!pendingDiff || pendingDiff.isReadOnly) return;
    if (!api.aiDiffCompute) return;
    const current = safeGetContent();
    if (current === null) return; // editor 抛错已被 safeGetContent 记录，不重算
    if (current === lastAppliedContent) return; // 没变化
    const opts = pickDiffOptions(current, pendingDiff.nextContent);
    let next;
    try {
      // audit A5：未包 try/catch 会让 sync 抛错冒到 editor.onChange → app.js
      // 的 IPC 链断裂。降级为 toast，不影响编辑器继续工作。
      next = api.aiDiffCompute(current, pendingDiff.nextContent, opts);
    } catch (e) {
      if (typeof toast === 'function') toast('重算差异失败：' + (e && e.message || '未知'), 'error');
      return;
    }
    if (!next || !next.regions || next.regions.length === 0) {
      // 全部应用完了（或没了）→ 关闭 diff
      setPendingDiff(null);
    } else {
      pendingDiff = { ...pendingDiff, baseContent: current, ...next };
      lastAppliedContent = current;
      if (diffPanel) diffPanel.setDiff(pendingDiff);
    }
    syncBodyFlag();
  }

  function pickDiffOptions(base, next) {
    const totalLen = (base || '').length + (next || '').length;
    const baseLines = (base || '').split(/\r\n?|\n/).length;
    const nextLines = (next || '').split(/\r\n?|\n/).length;
    // 超过 80k 字符或 12 万行乘积 → 关闭 token 粒度（避免 DP 爆炸）
    return {
      tokenDiff: totalLen <= 80_000 && baseLines * nextLines <= 120_000,
    };
  }

  /**
   * 取编辑器当前内容。失败返回 null 而非 ''：
   * 若失败时 fallback 成 ''，applyDiff 链路会把真实编辑器内容当成空文本，
   * 后续 editor.applyUserChange(nextContent) 就把用户文档替换为 AI 基于空文本生成的内容 —— 静默销毁。
   * 调用方必须 null-check 并中止 AI 流程。
   */
  function safeGetContent() {
    try { return editor.getContent(); }
    catch (e) {
      // audit fix (Phase O-L20)：catch 不直接把 e 整个写 console.warn。
      // 写整个 e 会让 e.message（含 CM6 state doc 摘要 / 光标位置）落到主进程
      // notes-main.log（用户私有 logs/，同机其他用户不可读但仍属日志积压）；
      // 改成只打错误名 + 行号，不附 message。
      console.warn('[ai-controller] safeGetContent 失败:', e && e.name ? e.name : 'Error');
      return null;
    }
  }

  function setPendingDiff(diff) {
    pendingDiff = diff;
    lastAppliedContent = diff ? safeGetContent() : null;
    if (diffPanel) diffPanel.setDiff(diff);
    syncBodyFlag();
  }

  /**
   * 校验 pendingDiff 仍然属于当前打开的文件。
   * audit H162/H163：之前 handleApplyRegion / handleApplyAll 直接读 safeGetContent()，
   * 不检查 pendingDiff 是为哪个文件算的 —— 用户提交 AI → 等响应 → 切到另一个文件 →
   * 点「应用」，会把 A 的 diff region 算进 B 的内容里（可能命中 / 可能不命中 →
   * 即使命中也是把 A 的修改写到 B，数据丢失）。
   * 现在所有 setPendingDiff 都带上 myFile，apply 前再核对一次。
   *
   * audit fix：返回字段从 `reason` 改名为 `message`。原因：app.js save flow
   * 里 `reason` 是「state code」（STALE / NO_CHANGES / DELEGATED 等用于
   * decideSaveToast 分支的短串），而这里 `reason` 实际存的是人类可读
   * 字符串 —— 同名不同语义，调用方读 `check.reason` 还得猜它是 code 还是
   * message。改成 `message` 后与 main IPC 错误形状 `{ok:false, error, message}`
   * 对齐，调用方一眼就知道是直接给 toast 的文本（这里 `error` 不存在 —— AI
   * 流这几个 state 没有跨进程错误码概念，只有给用户看的中文）。
   *
   * @returns {{ ok: true } | { ok: false, message: string }}
   */
  function ensurePendingDiffMatchesCurrentFile() {
    if (!pendingDiff) return { ok: false, message: '没有待应用的 AI 修改' };
    const expected = pendingDiff.forFilePath;
    const current = state.currentFile && state.currentFile.path;
    if (expected == null || current == null || expected !== current) {
      return {
        ok: false,
        message: '当前文件已切换，原 AI 修改已失效（请重新提交）',
      };
    }
    return { ok: true };
  }

  function syncBodyFlag() {
    // 中间面板：body.dataset.aiDiffOpen = 'true' 时 CSS 插入一列
    // 注意：isReadOnly 也要让面板打开 —— AI 普通回复（regions=[]）也算"有 AI 内容要展示"
    const has = !!pendingDiff && (
      pendingDiff.isReadOnly ||
      (pendingDiff.regions || []).length > 0
    );
    document.body.dataset.aiDiffOpen = has ? 'true' : 'false';
    // 通知外部「AI 修复预览」显隐状态变化 —— 外部据此强制编辑器切到编辑模式
    // 并禁用预览 / 双栏切换。仅在状态翻转时回调一次，避免 setPendingDiff 内部
    // 多次刷新造成重复通知。
    if (typeof onDiffOpenChange === 'function' && has !== diffOpenState) {
      diffOpenState = has;
      try { onDiffOpenChange(has); } catch { /* 不让 UI 异常阻断 AI 流程 */ }
    }
  }

  // 创建面板实例（DOM 必须在 bindMountPoint 之后才能实例化）
  let chatPanel = null;
  let diffPanel = null;

  function bindMountPoint(chatElement, diffElement, splitterElement = null) {
    // Round 13 fix (H9)：bind 重入前先让 in-flight 状态整体失效 —— 旧实现
    // 只 destroy 旧 panel，没 ++requestGeneration / 清 currentRequestId /
    // 清 pendingDiff，老 handleSubmit await 后还会写「新 panel」的
    // pendingDiff（闭包捕获 panel 变量引用）。现在递增 generation 让旧
    // in-flight 自然走 stale 分支丢弃；同时清掉 pendingDiff 避免新 panel
    // 一上来就显示老 diff。
    requestGeneration++;
    if (currentRequestId && chatPanel && typeof chatPanel.cancelRequest === 'function') {
      try { chatPanel.cancelRequest(currentRequestId); } catch { /* ignore */ }
    }
    currentRequestId = null;
    pendingDiff = null;
    // audit fix (2026-09-21)：重置 diffOpenState 让 syncBodyFlag 在新面板上能正确
    // 触发 onDiffOpenChange(true)。之前只调 onDiffOpenChange(false) 通知外部，
    // 但闭包变量 diffOpenState 没复位 —— 后续 setPendingDiff(non-null) → syncBodyFlag
    // 比较 `has !== diffOpenState`，若上次是 true → 永远 true，下一次打开面板不再回调。
    // 生产路径只 bind 一次不触发；HMR / 未来 runtime remount 才会暴露。
    diffOpenState = false;
    if (typeof onDiffOpenChange === 'function') {
      try { onDiffOpenChange(false); } catch { /* ignore */ }
    }

    // 3rd-agent fix：重复 bind 要先销毁旧实例，否则旧 listener 残留、
    // 旧 _submitting 状态无法被新 controller 感知。
    if (chatPanel && typeof chatPanel.destroy === 'function') {
      try { chatPanel.destroy(); } catch { /* ignore */ }
    }
    if (diffPanel && typeof diffPanel.destroy === 'function') {
      try { diffPanel.destroy(); } catch { /* ignore */ }
    }

    chatPanel = new AiChatPanel({
      element: chatElement,
      onSubmit: handleSubmit,
      onCancel: handleCancel,
      // 让 panel 内部的过程/错误文案（正在发送 / 已取消 / AI 请求失败 等）
      // 走 onNotify → app.js 的 updateStatusAi → statusbar 上的 #status-ai chip。
      // 详见 [feedback-ai-tips-into-status-bar]。
      onNotify: notify,
      // P2-23：未配置时点击「⚙ 设置」内联链直接打开设置对话框。
      // 与 togglePanel 中 !isConfigured() → onOpenSettings 同源。
      onOpenSettings: () => {
        if (typeof onOpenSettings === 'function') {
          try { onOpenSettings(); } catch { /* ignore */ }
        }
      },
    });
    // 一开始禁用（直到用户打开文件）
    chatPanel.syncFileState(!!state.currentFile);
    // P2-23：bootstrap 时同步 AI 配置态（影响 placeholder 三态文案 + 内联设置链）
    chatPanel.setConfigured(isConfigured());

    diffPanel = new AiDiffPanel({
      element: diffElement,
      onApplyRegion: handleApplyRegion,
      onApplyAll: handleApplyAll,
      onDismiss: handleDismiss,
      onSkipRegion: handleSkipRegion,
      splitterElement,
    });
    // 默认无 diff：hidden
    diffPanel.setDiff(null);
  }

  async function handleSubmit({ prompt, requestId }) {
    if (!isConfigured()) {
      // 未配置：直达设置对话框（焦点定位到 AI 段），让用户能立刻看到缺什么。
      // toast 留给 dialog 自己展示，比一条转瞬即逝的提示更直接。
      if (typeof onOpenSettings === 'function') {
        try {
          await onOpenSettings();
        } catch {
          // dialog 自身挂了不要让用户干等 —— 给个明确的可执行下一步
          if (typeof toast === 'function') toast('无法自动打开设置对话框，请从菜单 / 工具栏手动打开', 'error');
        }
      }
      // 给状态栏 chip 一个明确文案，避免触发 _triggerSubmit 的 'AI 修改失败' 兜底。
      return { ok: false, error: AI_ERROR.NOT_CONFIGURED, message: aiErrorMessage(AI_ERROR.NOT_CONFIGURED) };
    }
    if (!state.currentFile) {
      if (typeof toast === 'function') toast('请先打开一个 Markdown 文件', 'warning', 2500);
      return { ok: false, error: AI_ERROR.NO_FILE, message: aiErrorMessage(AI_ERROR.NO_FILE) };
    }

    // P0-1 fix (audit)：捕获提交时的文件对象 + 单调 generation。
    // await 之后比对：文件已切换 / generation 已递增 → 视为 stale，
    // 丢弃本响应（防止 AI 修改错文件 —— 数据丢失风险）。
    const myGen = ++requestGeneration;
    const myFile = state.currentFile;
    const filename = myFile.name || '';
    // H4 fix (audit)：拿到 prompt 后再读最新内容，避免 stale baseContent。
    const contentSnapshot = safeGetContent();
    if (contentSnapshot === null) {
      return { ok: false, error: AI_ERROR.EDITOR_UNAVAILABLE, message: aiErrorMessage(AI_ERROR.EDITOR_UNAVAILABLE) };
    }
    // 记录当前请求 id：切文件时调 aiCancel 主动终止，避免 AI 响应
    // 回到一个已经不相关的文档（详见 onFileChanged）。
    currentRequestId = requestId;

    // H2 fix (audit)：提交时立刻清掉旧 pendingDiff，避免 awaiting 期间中间面板
    // 显示上一次 AI 的陈旧 diff（用户点了"应用此处"以为对的是新请求）。
    if (pendingDiff) {
      setPendingDiff(null);
    }

    let result;
    try {
      result = await api.aiEdit({ prompt, content: contentSnapshot, filename, requestId });
    } catch (e) {
      currentRequestId = null;
      return { ok: false, error: 'IPC_FAILED', message: e && e.message || 'IPC 异常' };
    }
    // P0-1 fix (audit)：await 之后做 stale 检查 —— 注意 currentRequestId 只在
    // 我们仍是「最新一次提交」时才清掉，否则会让并发的下一次提交找不到自己
    // 的 requestId（onFileChanged / destroy 看 currentRequestId 决定是否取消
    // in-flight 请求）。audit M1 fix：currentRequestId 必须在 stale 检查通过后
    // 才允许清，且只在我们仍是 currentRequestId 的持有者时清。
    if (myGen !== requestGeneration || state.currentFile?.path !== myFile?.path) {
      // L2 fix (audit)：路径比较替代对象身份。openFile 会基于 reload/mtime 更新
      // state.currentFile = { ...state.currentFile, mtimeMs, size }（新对象），
      // 旧身份比较会让「同一文件路径、仅 mtime 更新」误判为已切文件，
      // 把刚回的 AI 响应丢进 stale 分支。改用路径字符串比较。
      if (currentRequestId === requestId) currentRequestId = null;
      return {
        ok: false,
        error: AI_ERROR.GENERATION_STALE,
        message: aiErrorMessage(AI_ERROR.GENERATION_STALE),
      };
    }
    // 通过 stale 检查：清掉我们的 requestId 句柄，让 onFileChanged 不再尝试
    // 取消这个请求（它马上就要 resolve 了）。
    currentRequestId = null;

    if (!result || result.ok !== true) {
      return { ok: false, error: (result && result.error) || 'UNKNOWN', message: (result && result.message) || 'AI 修改失败' };
    }

    const aiContent = result.content || '';
    const isRaw = result.responseFormat === 'raw';
    if (isRaw) {
      // AI 没改文档，只是回复一段文字
      // originalBaseContent 必须填：apply 漂移判断靠它（与下方非 readOnly 分支对齐），
      // 缺它会回退到 baseContent，被 recompute 覆写后漂移保护失效。
      setPendingDiff({
        id: result.id,
        baseContent: contentSnapshot,
        originalBaseContent: contentSnapshot,
        nextContent: aiContent,
        isReadOnly: true,
        rows: linesToContextRows(aiContent),
        regions: [],
        forFilePath: myFile && myFile.path, // audit H162：标记这个 diff 属于哪个文件
      });
      if (chatPanel) chatPanel.setStatus('AI 已返回普通回复，未生成文档修改');
      return { ok: true, isRawResponse: true };
    }

    // 算 diff
    const opts = pickDiffOptions(contentSnapshot, aiContent);
    let diffResult;
    try {
      diffResult = api.aiDiffCompute(contentSnapshot, aiContent, opts);
    } catch (e) {
      return { ok: false, error: 'DIFF_FAILED', message: '计算差异失败：' + (e && e.message || '未知') };
    }

    if (!diffResult.regions || diffResult.regions.length === 0) {
      // AI 返回内容与原文一致（已经过 schema 比较过，但 baseContent 可能在
      // 期间被外部改过，所以再次校验）。
      // 与非 readOnly 分支保持对称：都设 originalBaseContent = contentSnapshot，
      // 让下游读到 originalBaseContent || baseContent 时语义一致。
      setPendingDiff({
        id: result.id,
        baseContent: contentSnapshot,
        originalBaseContent: contentSnapshot,
        nextContent: aiContent,
        isReadOnly: true,
        rows: linesToContextRows(aiContent),
        regions: [],
        forFilePath: myFile && myFile.path,
      });
      if (chatPanel) chatPanel.setStatus('AI 返回内容与当前文档一致');
      return { ok: true, isRawResponse: false };
    }

    setPendingDiff({
      id: result.id,
      baseContent: contentSnapshot,
      originalBaseContent: contentSnapshot,
      nextContent: aiContent,
      isReadOnly: false,
      rows: diffResult.rows,
      regions: diffResult.regions,
      forFilePath: myFile && myFile.path,
    });
    if (chatPanel) {
      const text = `AI 已返回，请在中间面板确认（${diffResult.regions.length} 处修改）`;
      // AI_STATUS.DIFF：chip 用 accent-soft 高亮，让用户一眼看到"中间面板有 N 处待确认"
      // 显式 notify 而非 setStatus —— 后者会被 panel 内部推断为 success（中性 muted），
      // 弱化了关键状态的视觉权重。
      safeNotify(text, AI_STATUS.DIFF);
    }
    // H3 fix (audit)：diff 引擎 fallback 时（行级 cells 超 MAX_LINE_DIFF_CELLS /
    // 词级超 MAX_TOKEN_DIFF_CHARS）会附带 warnings 字段。告知用户「diff 退化为
    // 整段替换」或「词级已退化为行级」，避免 UI 上看到「整篇被改」以为是 AI 整篇重写。
    if (Array.isArray(diffResult.warnings) && diffResult.warnings.length > 0 && typeof toast === 'function') {
      diffResult.warnings.forEach((msg) => toast(msg, 'warning', 5000));
    }
    return { ok: true, isRawResponse: false };
  }

  function handleCancel(requestId) {
    // 取消 in-flight 请求；++generation 让 handleSubmit 在 await 返回后
    // 走 stale 分支（即使主进程 IPC 失败没真取消，也阻止后续 setPendingDiff）。
    requestGeneration++;
    // L5 fix (audit)：清掉 currentRequestId —— 否则 onFileChanged / destroy 看到
    // 非空 currentRequestId 会再发一次 cancel（重复 IPC）+ 误以为还有 in-flight 请求。
    currentRequestId = null;
    if (api.aiCancel) api.aiCancel(requestId);
  }

  function handleApplyRegion(regionId /*, diff */) {
    if (!pendingDiff) return;
    // audit fix (Round 13 / Sec-H1)：isReadOnly=true 的 diff 没有可应用 region
    // （regions:[]），且 nextContent 是 AI 普通文本回复而非文档修改。panel 不会
    // 渲染 apply 按钮，但事件委托若被 AI 控制的 [data-action] 元素覆盖（Sec-H1
    // 已加 closest('.ai-reply-content') 兜底），仍可能在 controller 这里再次走到
    // apply 路径 —— editor.applyUserChange(aiChatReply) 会把打开的笔记替换为
    // AI 的聊天文本。二次守一道：readOnly 时直接拒绝，连 region 查询都不跑。
    if (pendingDiff.isReadOnly) return;
    // audit H162：apply 前确认 pendingDiff 还是当前文件的。
    // onFileChanged 在切换文件时会 setPendingDiff(null) —— 但有一种竞态：
    // 用户提交 AI → 等响应 → 切到 B 文件（pendingDiff 被清）→ 切回 A 文件
    // （onFileChanged 不会再清，因为已经清过了）→ 此时 pendingDiff 是 null，
    // 但如果 controller 在切到 B 之前刚生成 pendingDiff 且切回 A 后没刷新，
    // 那 pendingDiff 仍存在但属于 A。下面这层 forFilePath 校验兜底。
    const check = ensurePendingDiffMatchesCurrentFile();
    if (!check.ok) {
      if (typeof toast === 'function') toast(check.message, 'error', 3000);
      setPendingDiff(null);
      return;
    }
    const region = pendingDiff.regions.find((r) => r.id === regionId);
    if (!region) return;

    const current = safeGetContent();
    if (current === null) {
      if (typeof toast === 'function') toast('无法读取编辑器内容，已停止应用', 'error');
      return;
    }

    let result;
    try {
      result = api.aiDiffApply(current, region);
    } catch (e) {
      if (typeof toast === 'function') toast('应用失败：' + (e && e.message || '未知'), 'error');
      // audit fix (Round 9)：chatPanel status 与 toast 同步 —— 否则面板里
      // 还停留在「已应用 N 处修改」/「待确认」的旧状态，用户以为成功了。
      if (chatPanel) chatPanel.setStatus('AI 应用失败，可重试');
      return;
    }
    if (!result.ok) {
      // 在该 region 上标 conflict，UI 灰掉"应用此处"按钮
      pendingDiff = {
        ...pendingDiff,
        regions: pendingDiff.regions.map((r) => r.id === regionId ? { ...r, conflict: result.reason } : r),
      };
      // audit fix (1.3)：冲突时**不修改** lastAppliedContent —— 编辑器内容没变，
      // 用户先前若有手动编辑，safeGetContent() 返回的是漂移值，把它写回 lastAppliedContent
      // 会让 onContentChanged 跳过本应触发的 recompute。
      // pendingDiff.baseContent 是当前 diff 的基线，保持原状即可。
      if (diffPanel) diffPanel.setDiff(pendingDiff);
      // audit fix (Round 9)：同步 chatPanel status 让用户知道 apply 失败。
      if (chatPanel) chatPanel.setStatus('该处无法应用，请用「跳过」放弃');
      return;
    }

    // M5 fix (audit)：对称 handleApplyAll 的空内容保护 —— applyDiffRegionSafely
    // 在极端场景（region 跨边界 + 上下文匹配失败）可能算出 "" 或纯空白。
    // applyUserChange('') 会把区域对应行静默清空（数据丢失），必须挡住。
    // C4 fix (audit)：但 region.oldLines.length > 0 时算「整段删除」是合法语义
    // （AI 明确有内容可删），此时 appliedContent 为空是正确的，不能挡。
    const appliedContent = result.content;
    const isLegitimateDelete = region.oldLines.length > 0;
    if (
      typeof appliedContent !== 'string'
      || (!isLegitimateDelete && appliedContent.replace(/\s+/g, '').length === 0)
    ) {
      if (typeof toast === 'function') {
        toast('AI 返回内容为空，已拒绝应用该处（请用「跳过」放弃该修改）', 'error', 4000);
      }
      // 把 region 标 conflict 让用户走「跳过」逃生口
      pendingDiff = {
        ...pendingDiff,
        regions: pendingDiff.regions.map((r) => r.id === regionId ? { ...r, conflict: 'AI 返回内容为空' } : r),
      };
      if (diffPanel) diffPanel.setDiff(pendingDiff);
      syncBodyFlag();
      // audit fix (Round 9)：同步 chatPanel status。
      if (chatPanel) chatPanel.setStatus('AI 返回内容为空，请「跳过」放弃');
      return;
    }

    // 应用：替换编辑器内容（标脏）
    try {
      editor.applyUserChange(appliedContent);
    } catch (e) {
      // audit fix (Phase O-M1)：IME 合成期间抛 EDITOR_COMPOSING 阻止 apply，
      // 提示用户稍后再试（不要显示「写入编辑器失败」误导成磁盘错误）。
      if (e && e.message === 'EDITOR_COMPOSING') {
        if (typeof toast === 'function') toast('编辑器正在输入中文，请稍后再试', 'warning');
        // audit fix (Round 9)：同步 chatPanel status —— chip 仍显示
        // 「待确认 N 处」会让用户以为还在 diff 模式可用。
        if (chatPanel) chatPanel.setStatus('正在输入中文，请稍后再试');
        return;
      }
      if (typeof toast === 'function') toast('写入编辑器失败：' + (e && e.message || '未知'), 'error');
      // audit fix (Round 9)：同步 chatPanel status。
      if (chatPanel) chatPanel.setStatus('写入编辑器失败，可重试');
      return;
    }
    // M5 fix (audit)：apply 成功后立即把 pendingDiff.baseContent 推进到 result.content，
    // 不要等到下面的 compute 抛错 / 不更新就早返回。baseContent 必须始终反映
    // 「编辑器的当前实际内容」—— 后续任何重算 / onFileChanged 比对都依赖它。
    // 旧顺序里如果 aiDiffCompute 抛错，编辑器是新内容、pendingDiff.baseContent
    // 还是旧内容，用户看到「已应用的修改没体现在剩余 diff 里」的诡异行为。
    // 同时把 originalBaseContent 也同步推进到 result.content —— 否则后续
    // 「应用全部」会与残留的 submit-time 快照对比误判漂移，强制 readOnly。
    pendingDiff = { ...pendingDiff, baseContent: result.content, originalBaseContent: result.content };
    // preview 模式修复：apply 后立即通知外部刷新 viewer。split 模式下
    // scheduleLivePreview 会覆盖（防双触发不致命 —— loadContentLive 幂等）。
    if (typeof onAfterApply === 'function') {
      try { onAfterApply(); } catch { /* 不让 viewer 渲染失败阻断 apply */ }
    }

    // 用 AI 改后的 base 重算剩余 diff
    let remaining;
    try {
      // audit A5：与 recomputeDiffFromBase 同理，包 try/catch 防 sync 抛错。
      remaining = api.aiDiffCompute(result.content, pendingDiff.nextContent, pickDiffOptions(result.content, pendingDiff.nextContent));
    } catch (e) {
      if (typeof toast === 'function') toast('重算差异失败：' + (e && e.message || '未知'), 'error');
      // audit fix (Round 9)：同步 chatPanel status。
      if (chatPanel) chatPanel.setStatus('重算差异失败');
      return;
    }
    if (!remaining || !remaining.regions || remaining.regions.length === 0) {
      // 全部应用完
      if (typeof toast === 'function') toast('已应用所有 AI 修改', 'success', 1500);
      setPendingDiff(null);
      if (chatPanel) chatPanel.setStatus('已应用所有 AI 修改');
    } else {
      pendingDiff = { ...pendingDiff, baseContent: result.content, ...remaining };
      lastAppliedContent = result.content;
      if (diffPanel) diffPanel.setDiff(pendingDiff);
      syncBodyFlag();
      // H3 fix (audit)：partial apply 后 chatPanel status 也要更新（regions 数量变了）
      if (chatPanel) {
        // AI_STATUS.DIFF：剩余待确认数要靠 chip 高亮 —— 见 handleSubmit 的同款注释
        safeNotify(`已应用 1 处修改，还剩 ${remaining.regions.length} 处待确认`, AI_STATUS.DIFF);
      }
    }
  }

  function handleApplyAll(/* diff */) {
    if (!pendingDiff) return;
    // audit fix (Round 13 / Sec-H1)：与 handleApplyRegion 同款 —— isReadOnly
    // 状态不可能有合法 apply 路径，nextContent 是 AI 普通聊天文本，覆盖编辑器
    // 即等于「把笔记销毁换成聊天回复」。详见 handleApplyRegion 同处注释。
    if (pendingDiff.isReadOnly) return;
    // audit H163：与 handleApplyRegion 同款校验，挡住「跨文件覆盖」数据丢失。
    const check = ensurePendingDiffMatchesCurrentFile();
    if (!check.ok) {
      if (typeof toast === 'function') toast(check.message, 'error', 3000);
      setPendingDiff(null);
      return;
    }
    const next = pendingDiff.nextContent;
    // P0 fix：拒绝空内容覆盖 —— AI 返回 '' 时（截断 / 服务异常 / 提示词诱导），
    // applyDiffRegionSafely 也会算出"全删"region，"应用全部"就会把用户文档
    // 静默替换成空串（这里就是 clearCurrentFile 之外的另一条销毁路径）。
    // 校验放在最后一道关卡前：next 必须有非空白字符。
    if (typeof next !== 'string' || next.replace(/\s+/g, '').length === 0) {
      if (typeof toast === 'function') {
        toast('AI 返回内容为空，已拒绝应用（请用「跳过」逐条处理，或重新提交）', 'error', 4000);
      }
      // 把当前 diff 标成 readOnly、关掉 apply 路径，让用户能继续查看 / skip 单条
      pendingDiff = {
        ...pendingDiff,
        isReadOnly: true,
      };
      if (diffPanel) diffPanel.setDiff(pendingDiff);
      syncBodyFlag();
      return;
    }
    // M4 fix (audit)：用户在等待 AI 时可能继续编辑文档。pendingDiff.baseContent
    // 是提交时的快照，若当前编辑器内容已不同，「应用全部」会用 nextContent
    // 直接覆盖整个文档，**丢掉用户在等待期间做的修改**（数据丢失）。
    //
    // 审计修复 (Round 11)：之前只弹一条 toast 警告但 apply 照常进行 —— 5 秒
    // 警告用户根本来不及反应，apply 已完成、用户的修改被静默覆盖。
    // 现在 drift 检出后把 pendingDiff 标成 isReadOnly=true（diffPanel 会隐藏
    // "应用全部" / "应用此处" 按钮），强制用户「逐条 skip / apply」让决定更精细，
    // 或者撤销自己的编辑后重提。最坏情况保留全删路（用户主动重提后 baseContent
    // 重新对齐，apply 不再丢失任何东西）。
    const currentForApply = safeGetContent();
    // 漂移判定必须用「提交时的不可变快照」originalBaseContent，而非 pendingDiff.baseContent
    // —— 后者会被 recomputeDiffFromBase 在每次用户输入后覆写为当前内容，导致本保护永远不触发、
    // 「应用全部」静默覆盖用户等待期间的手动修改（数据丢失）。
    if (currentForApply !== null && currentForApply !== getImmutableBase(pendingDiff)) {
      if (typeof toast === 'function') {
        toast('你在等待 AI 时已修改过文档，「应用全部」会覆盖未在 diff 内的修改，已切换为逐条确认', 'warning', 4000);
      }
      if (chatPanel) chatPanel.setStatus('已切换逐条确认模式（你等待时编辑过文档）');
      pendingDiff = {
        ...pendingDiff,
        isReadOnly: true,
      };
      if (diffPanel) diffPanel.setDiff(pendingDiff);
      syncBodyFlag();
      return;
    }
    try {
      editor.applyUserChange(next);
    } catch (e) {
      // audit fix (Phase O-M1)：同上，IME 合成期间拒绝 apply。
      if (e && e.message === 'EDITOR_COMPOSING') {
        if (typeof toast === 'function') toast('编辑器正在输入中文，请稍后再试', 'warning');
        // audit fix (Round 9)：同步 chatPanel status（与 handleApplyRegion 对齐）。
        if (chatPanel) chatPanel.setStatus('正在输入中文，请稍后再试');
        return;
      }
      if (typeof toast === 'function') toast('写入编辑器失败：' + (e && e.message || '未知'), 'error');
      // audit fix (Round 9)：同步 chatPanel status。
      if (chatPanel) chatPanel.setStatus('写入编辑器失败，可重试');
      return;
    }
    // preview 模式修复：apply 后立即通知外部刷新 viewer（见 handleApplyRegion 同处注释）
    if (typeof onAfterApply === 'function') {
      try { onAfterApply(); } catch { /* 同上 */ }
    }
    if (typeof toast === 'function') toast('已应用所有 AI 修改', 'success', 1500);
    setPendingDiff(null);
    if (chatPanel) chatPanel.setStatus('已应用所有 AI 修改');
  }

  /**
   * audit fix：从 diff 列表中丢弃一个 region（一般是 conflict 标了之后用户放弃应用）。
   * 旧版本唯一的恢复路径是「dismiss 整个 diff」—— 一旦某个 region 因上下文变更无法
   * 安全定位（conflict），其它 region 也跟着没法继续用。这里给出细粒度逃生口：
   *   - 从 pendingDiff.rows / regions 中过滤掉该 region；
   *   - 重算剩余 diff（如果 baseContent 因为后续编辑已经漂移，需要基于当前内容重算）；
   *   - 如果没有 region 剩了，就 dismiss。
   *
   * audit fix (H1-settings / H162)：补文件匹配守卫 —— 之前 handleApply* 已经有
   * ensurePendingDiffMatchesCurrentFile()，handleSkipRegion 漏了同样的保护：
   * 用户提 AI → 等响应 → 切到另一文件 → 旧 diff panel 仍可见（pendingDiff 没被
   * 清掉？实际 onFileChanged 会清，但 render 早于清 / 残留 region 仍可见），点
   * 「跳过」会改写为别的文件的 regions 数组（甚至把整个 diff 关掉）。和 apply
   * 同样会造成「A 的修改写到 B」类数据事故。
   */
  function handleSkipRegion(regionId) {
    if (!pendingDiff) return;
    // 与 handleApply* 一致：先确认 pendingDiff 还属于当前文件
    const guard = ensurePendingDiffMatchesCurrentFile();
    if (!guard.ok) {
      if (typeof toast === 'function') toast(guard.message, 'warning', 2500);
      setPendingDiff(null);
      return;
    }
    const filtered = (pendingDiff.regions || []).filter((r) => r.id !== regionId);
    const filteredRows = (pendingDiff.rows || []).filter((row) => row.regionId !== regionId);

    // 如果 baseContent 没变，直接用过滤后的 rows；否则重算（保持 diff 与最新编辑器同步）
    const current = safeGetContent();
    if (current === null) {
      if (typeof toast === 'function') toast('无法读取编辑器内容，已停止操作', 'error');
      return;
    }
    let nextRows = filteredRows;
    let nextRegions = filtered;
    let nextBase = getImmutableBase(pendingDiff);
    const skippedRegion = (pendingDiff.regions || []).find((r) => r.id === regionId);
    // 漂移判定同 handleApplyAll：用提交时的不可变快照 originalBaseContent，
    // 避免 recompute 把 baseContent 覆写为当前内容后，漏掉"用户等待期间已编辑"的重算。
    if (current !== getImmutableBase(pendingDiff) && pendingDiff.nextContent) {
      try {
        const recomputed = api.aiDiffCompute(current, pendingDiff.nextContent, pickDiffOptions(current, pendingDiff.nextContent));
        if (recomputed && Array.isArray(recomputed.rows) && Array.isArray(recomputed.regions)) {
          nextRows = recomputed.rows;
          nextRegions = recomputed.regions;
          nextBase = current;
          // 用户已编辑 → 新 regions 由当前内容 + AI nextContent 重算得出。
          // 但「跳过 regionId」是用户明确的意图 —— 简单丢弃 ID 是不够的：
          // recomputed.regions 是新生成的 ID，旧的 regionId 在新集合里压根不存在。
          // best effort：把 oldLines 文本与被跳过的 region 相同的 region 一并剔除。
          // 边界：用户编辑使 skippedRegion.oldLines 在 current 里已经不存在
          // （例如用户直接把那几行删了），recompute 也不会再生成对应 region，filter 是 no-op。
          if (skippedRegion && Array.isArray(skippedRegion.oldLines)) {
            const skippedKey = skippedRegion.oldLines.join('\n');
            // 1) 把「oldLines 与被跳过 region 相同」的新 region 剔除
            nextRegions = nextRegions.filter((r) => !(Array.isArray(r.oldLines) && r.oldLines.join('\n') === skippedKey));
            // 2) 把指向被跳过 region 的 row 剔除（如果旧 ID 还残留在 row 数组里）
            nextRows = nextRows.filter((row) => row.regionId !== skippedRegion.id);
          }
        } else {
          // 审计修复 (Round 11 P1-4)：recomputed 无效（null / 缺 rows/regions）也必须 bail。
          // catch 分支已有 return，但 try 内部"recompute 走通但返回无效 shape"会落到
          // 下面 if (!nextRegions...) 用 stale baseContent + filtered（旧 regions）继续
          // 渲染，diff panel 看着正常但实际没重算 → 用户以为重新算了实际还是旧的。
          // 失败就放弃本次 skip，不让 diff panel 进入误导态。
          if (typeof toast === 'function') toast('重算差异失败：返回结果无效，已跳过本次跳过操作', 'error');
          return;
        }
      } catch (e) {
        if (typeof toast === 'function') toast('重算差异失败：' + (e && e.message || '未知'), 'error');
        return;
      }
    }

    if (!nextRegions || nextRegions.length === 0) {
      // 跳过之后没 region 了，关掉 diff 面板
      if (typeof toast === 'function') toast('已跳过该修改', 'success', 1500);
      setPendingDiff(null);
      if (chatPanel) chatPanel.setStatus('已跳过该修改，无更多待确认');
      return;
    }

    pendingDiff = {
      ...pendingDiff,
      // originalBaseContent 跟随 nextBase 推进：下一次 skip / apply 的漂移
      // 判定窗口不再包含本步跳过造成的编辑差异，否则「跳 1 → 再跳 1」
      // 都会被假漂移触发重算。
      baseContent: nextBase,
      originalBaseContent: nextBase,
      rows: nextRows,
      regions: nextRegions,
    };
    lastAppliedContent = current;
    if (diffPanel) diffPanel.setDiff(pendingDiff);
    syncBodyFlag();
    if (chatPanel) {
      // AI_STATUS.DIFF：skip 一处后剩余待确认数要靠 chip 高亮
      safeNotify(`已跳过 1 处修改，还剩 ${nextRegions.length} 处待确认`, AI_STATUS.DIFF);
    }
  }

  function handleDismiss() {
    setPendingDiff(null);
    // dismiss 把 chip 收回到 idle —— 显式 notify 而非 setStatus('')：
    // setStatus('') 会被 panel 内部推断为 'success'（保持 muted 文字），
    // 我们要的是真正清空（chip 文字回到 "AI"），用 AI_STATUS.IDLE 类型最准。
    safeNotify('', AI_STATUS.IDLE);
  }

  /**
   * 工具栏按钮 / 快捷键调：切 AI 输入面板
   * @returns {boolean} true 表示打开了面板
   */
  function togglePanel() {
    if (!chatPanel) return false;
    if (chatPanel.isOpen()) {
      chatPanel.close();
      return false;
    }
    // audit fix (Phase L3-AI 4)：AI dock 与设置对话框互斥。
    // openSettingsDialog 已经在打开时主动 close dock 并 close 后还原，但用户在
    // 设置打开期间手动点 AI 按钮（侧栏 btn-ai / 状态栏 chip / 快捷键）会让
    // chatPanel.open() 把 dock 显示出来，视觉上从 modal 半透明背景后透出，与
    // 设置对话框重叠 → 误点率高。这里守一道：设置打开时拒绝开 dock 并 toast。
    if (typeof isSettingsOpen === 'function' && isSettingsOpen()) {
      if (typeof toast === 'function') {
        toast('设置对话框打开时无法打开 AI 面板，请先关闭设置', 'info');
      }
      return false;
    }
    if (!isConfigured()) {
      // 未配置：直达设置对话框（焦点定位到 AI 段），让用户能立刻补 Base URL / Key / Model。
      if (typeof onOpenSettings === 'function') {
        try {
          // onOpenSettings 可能是 async：catch 同步 throw，.catch 接住 Promise 拒绝
          const r = onOpenSettings();
          if (r && typeof r.catch === 'function') r.catch(() => {
            if (typeof toast === 'function') toast('无法自动打开设置对话框，请从菜单 / 工具栏手动打开', 'error');
          });
        } catch {
          if (typeof toast === 'function') toast('无法自动打开设置对话框，请从菜单 / 工具栏手动打开', 'error');
        }
      }
      return false;
    }
    chatPanel.open();
    return true;
  }

  /**
   * 全部关闭（chat dock + diff 面板）。
   * diff 跟随 chat 一起关：让"AI 修改"按钮成为唯一的开关入口。
   */
  function closeAll() {
    if (chatPanel) chatPanel.close();
    // 关 dock 时也清掉防抖 timer，避免 pendingDiff=null 之后又触发 recompute
    if (recomputeTimer) { clearTimeout(recomputeTimer); recomputeTimer = null; }
    requestGeneration++;
    // L5 fix (audit)：关 dock 也清掉 currentRequestId + 发一次 cancel。
    // 否则再 open 时 controller 以为自己还有 in-flight 请求，新提交会被
    // onFileChanged/destroy 看到 currentRequestId 还在，重复发 cancel。
    if (currentRequestId && chatPanel && typeof chatPanel.cancelRequest === 'function') {
      try { chatPanel.cancelRequest(currentRequestId); } catch { /* ignore */ }
    }
    currentRequestId = null;
    setPendingDiff(null);
    if (chatPanel && typeof chatPanel.reset === 'function') {
      // 3rd-agent fix：清掉 _submitting / 输入框残留，避免下次 open 时 input 永久 disabled
      chatPanel.reset();
    }
  }

  /**
   * 文件切换时同步：清掉 pendingDiff、把新内容当基线
   * 同时取消 in-flight 的 AI 请求 —— 否则响应回来时 contentSnapshot 还是
   * 上一个文件的内容，会让面板把不相关的 diff 渲染出来。
   */
  function onFileChanged(newFile) {
    // 取消进行中的 AI 请求（chatPanel 知道自己的 _currentRequestId）
    if (chatPanel && currentRequestId) {
      chatPanel.cancelRequest(currentRequestId);
      currentRequestId = null;
    }
    // P0-1 fix (audit)：递增 generation 让 in-flight handleSubmit 失败，
    // 并清掉任何挂起的 debounced recompute（新文件的内容基线不再准确）
    if (recomputeTimer) { clearTimeout(recomputeTimer); recomputeTimer = null; }
    requestGeneration++;
    // 切换文件时放弃当前 diff（避免误应用）
    setPendingDiff(null);
    if (chatPanel) {
      chatPanel.syncFileState(!!newFile);
      // 3rd-agent fix：reset 比单独清 status/error 更彻底 —— 也会把
      // _submitting=false + input.disabled=false，避免切文件后输入框永久禁用
      chatPanel.reset();
    }
  }

  /**
   * 编辑器内容变化时：重算 diff（让用户看到"已应用部分还剩多少"）
   * P1-3 fix (audit)：防抖 —— 连续 keystroke 只跑一次 DP
   * （pickDiffOptions 把 tokenDiff 限制在 ≤80k / ≤120k 行乘积，但每个
   * keystroke 仍触发同步 DP 会卡顿）。
   *
   * 优化 (Round 14)：100ms → 300ms —— 用户连续打字时
   * "每个 keystroke 都触发 DP + 全量 innerHTML 重渲染" 是可见卡顿。
   * 300ms 让用户停手后才跑，体感上不卡；setDiff 内部已经把重渲染延后到
   * 下一帧（详见 ai-diff-panel.js#scheduleRender），这里只需保证
   * 「最后一次按键 → 一次重算 + 重渲染」即可。
   */
  function onContentChanged() {
    if (!pendingDiff) return;
    if (recomputeTimer) clearTimeout(recomputeTimer);
    recomputeTimer = setTimeout(() => {
      recomputeTimer = null;
      recomputeDiffFromBase();
    }, 300);
  }

  /**
   * 销毁 controller：撤销所有 panel listener、清掉防抖 timer、取消 in-flight 请求。
   * 用于页面卸载 / HMR 重置 —— 避免旧实例的 click 监听器 + debounced setTimeout
   * 在新 controller 实例运行时继续触发（MutationObserver 在 src/app.js 的 pagehide
   * 已用类似清理路径）。
   */
  function destroy() {
    if (recomputeTimer) {
      clearTimeout(recomputeTimer);
      recomputeTimer = null;
    }
    // 递增 generation 让 in-flight handleSubmit 自然废弃（不再写 pendingDiff）
    requestGeneration++;
    if (chatPanel && typeof chatPanel.cancelRequest === 'function' && currentRequestId) {
      try { chatPanel.cancelRequest(currentRequestId); } catch { /* ignore */ }
      currentRequestId = null;
    }
    if (chatPanel && typeof chatPanel.destroy === 'function') {
      try { chatPanel.destroy(); } catch { /* ignore */ }
    }
    if (diffPanel && typeof diffPanel.destroy === 'function') {
      try { diffPanel.destroy(); } catch { /* ignore */ }
    }
    chatPanel = null;
    diffPanel = null;
    pendingDiff = null;
    lastAppliedContent = null;
    setPendingDiff(null);
  }

  return {
    bindMountPoint,
    togglePanel,
    closeAll,
    destroy,
    isChatOpen: () => isChatOpen(),
    hasPendingDiff: () => !!pendingDiff,
    onFileChanged,
    onContentChanged,
    // P2-23：settings 改了（Base URL / API Key / Model）后调用，
    // 把最新配置态推给 chatPanel 让 placeholder 立即切换「未配置」↔「描述修改」。
    refreshConfigured: () => {
      if (chatPanel && typeof chatPanel.setConfigured === 'function') {
        chatPanel.setConfigured(isConfigured());
      }
    },
  };
}
