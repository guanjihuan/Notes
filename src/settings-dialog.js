// 设置对话框
//
// 三个分区：外观 / AI / 关于
// - 外观：主题配色（视觉 swatch）+ 阅读字号（视觉卡片）+ 阅读行距（视觉卡片）
// - AI：服务提供方（视觉卡片）+ Base URL + API Key + Model + System Prompt
// - 关于：开发者信息 + 主页链接
//
// **功能入口单一来源原则**：已经有即时触发入口的功能不进设置对话框：
// - 数据文件夹 → 侧栏底部「打开 / 切换数据文件夹」（高频操作贴近作用区域）
// - 主题循环 / 置顶 / 视图模式 → 顶部工具栏或托盘菜单
// - 文件列表排序 → 左侧栏工具条
// - 自动保存 → 顶部工具栏按钮
// 见 [[feedback-no-toolbar-duplicate-in-settings]] / [[feedback-prefer-near-affected-area]]。

import { showToast } from './feedback.js';
import { escapeAttr } from './utils.js';
import { isOpen as modalIsOpen } from './modal-stack.js';
import { mountModal } from './modal.js';
// schema 经 preload 的 contextBridge 过桥，不能直接 import
// shared/settings-schema.js —— 那是 CommonJS，renderer 是 Chromium 原生 ESM，
// 没有 CJS 互操作（改扩展名也不行），import 会让整个应用起不来。
const SETTINGS_UI_OPTIONS = (typeof window !== 'undefined'
  && window.api?.settingsSchema?.SETTINGS_UI_OPTIONS) || {};

// 取自 schema —— 这里重新解构成局部常量只是为了让模板字符串更短。
// 一律兜底成空数组：桥缺失时对话框应当渲染出空选项，而不是在 .map 上抛错。
const READER_FONT_SIZES = SETTINGS_UI_OPTIONS.readerFontSize ?? [];
const READER_LINE_HEIGHTS = SETTINGS_UI_OPTIONS.readerLineHeight ?? [];
const THEME_PALETTES = SETTINGS_UI_OPTIONS.themePalette ?? [];
const AI_PROVIDERS = SETTINGS_UI_OPTIONS.aiProvider ?? [];

// 默认 baseURL / model：按 provider 切换「placeholder」提示用户
// OpenAI 兼容：baseURL 含 /v1；Anthropic：baseURL 不含 /v1
const AI_DEFAULTS = {
  openai:    { baseUrl: 'https://api.openai.com/v1',  model: 'gpt-4o-mini' },
  anthropic: { baseUrl: 'https://api.anthropic.com',  model: 'claude-opus-5' },
};

// 配色 swatch 用 CSS 自定义属性渲染真实色块，避免硬编码颜色导致配色变更时不一致。
// 每个 palette 的 strip 由 bg + accent + fg 三段组成，给用户直观的视觉印象。
// audit fix (H4/H5)：default accent 改为 #4f5ec7（与 02-palettes.css 同步，
// 是过 WCAG AA 的真实色，preview 与实际主题保持一致）。
const PALETTE_PREVIEW_COLORS = {
  default:  { bg: '#08090a', accent: '#4f5ec7' },
  ocean:    { bg: '#0b141d', accent: '#6cc5e6' },
  forest:   { bg: '#0e1410', accent: '#76c78d' },
  lavender: { bg: '#14101a', accent: '#c89ce8' },
  sunset:   { bg: '#1a0e14', accent: '#ffa091' },
};
// 配色卡片直接用 schema 的 label，避免「薰衣」 vs「薰衣草」漂移：
// 之前 PALETTE_SHORT_LABEL 给 5 列横排做单字省略，但 schema 标签（最长的
// 「薰衣草」3 字）也塞得下；现在统一只用 schema 描述，没有重复事实源。

// API Key 显示/隐藏切换按钮的图标 + 标签（state-driven）：
// aria-pressed 表示「当前是否处于显示态」，与 icon/aria-label/label-text 同步切换，
// 否则用户/读屏只看到静态"显示/隐藏"，无法判断当前密码框到底是隐藏还是明文。
const EYE_OPEN_SVG = `
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/>
    <circle cx="12" cy="12" r="3"/>
  </svg>
`;
const EYE_OFF_SVG = `
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/>
    <circle cx="12" cy="12" r="3"/>
    <line x1="3" y1="3" x2="21" y2="21"/>
  </svg>
`;
function renderAiKeyToggleLabel(isShown) {
  return isShown
    ? `${EYE_OFF_SVG}<span class="btn-label">隐藏</span>`
    : `${EYE_OPEN_SVG}<span class="btn-label">显示</span>`;
}

// 视觉选择器共用的 ✓ 角标 SVG（state-driven 选中态用）
const CHECK_SVG = `
  <svg viewBox="0 0 14 14" width="9" height="9" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <polyline points="3 7 6 10 11 4"></polyline>
  </svg>
`;

export class SettingsDialog {
  /**
   * @param {object} options
   * @param {object} options.api - window.api
   * @param {object} options.settingsStore - SettingsStore 实例
   * @param {(changes: object) => void|Promise<void>} options.onChanged - 保存后回调
   */
  constructor({ api, settingsStore, onChanged }) {
    this.api = api;
    this.settingsStore = settingsStore;
    this.onChanged = onChanged;
    this.modal = null;
    this._saving = false;
  }

  /**
   * 打开对话框（返回 Promise，关闭时 resolve 为 'saved' 或 'cancel'）
   *
   * @param {object} [options]
   * @param {'ai'} [options.focusSection] - 渲染后自动滚动到对应段并把焦点放在第一个必填空字段上。
   *   用途：用户点 AI 按钮但 AI 未配置 → 直接打开设置并定位到 AI 段，比 toast 更直观。
   */
  async open(options = {}) {
    // 审计修复 (Round 11 P2)：防并发 open() race。
    // 旧版只查 modalIsOpen()（DOM 里有没有 .modal-overlay），但两次快速调用都
    // 在 mountModal 之前命中 → 两次都通过守卫 → 第二次 mountModal 返回 null
    // → 第二次 caller 走 console.error + 静默 resolve 'cancel'，用户无任何反馈。
    // 现在加实例级 _opening 标志（同步置 true），后续调用全拦截；_opening 在
    // Promise finally 里清掉。this.modal 同步状态比 _render 晚，所以加 _opening。
    if (this.modal || this._opening) {
      if (options && options.focusSection) {
        focusSettingsSectionInOpenDialog(options.focusSection);
        return 'cancel';
      }
      showToast('已有对话框打开', 'warning');
      return 'cancel';
    }
    if (modalIsOpen()) {
      // 但是 — 当外部因为「AI 未配置」自动调用打开时，如果设置已经在开，我们不重复弹窗，
      // 而是把当前对话框滚到目标 section（用户已经在设置里，不必再次打扰）。
      if (options && options.focusSection) {
        focusSettingsSectionInOpenDialog(options.focusSection);
        return 'cancel';
      }
      showToast('已有对话框打开', 'warning');
      return 'cancel';
    }

    this._opening = true;
    const initial = this.settingsStore.getAll();

    // 拿到 config.json 的文件名 + 所在目录名 —— API Key hint 用，
    // 让用户知道数据存在哪个文件、能一键打开核对。
    //
    // audit fix (Round 9 CFG-1)：之前读 `cfg.path` / `cfg.dir`，但 main 端
    // `app:get-config-path` 在 M4 脱敏后返回的是 `{name, dirName}` —— 两个字段
    // 恒为 undefined，`initial._configPath` 永不赋值，导致 hint 里的路径与
    // [打开文件夹] 按钮整段模板都不渲染（文案还断在「存储于 config.json」和
    // 「。每次请求」之间）。按 main 的真实契约读 name / dirName。
    // getConfigPath 缺失（旧版 preload）走空串兜底，hint 区降级显示。
    if (typeof this.api.getConfigPath === 'function') {
      try {
        const cfg = await this.api.getConfigPath();
        if (cfg && cfg.name) {
          initial._configName = cfg.name;
          initial._configDirName = cfg.dirName || '';
        }
      } catch { /* 静默：忽略 */ }
    }

    // 一次性把 API Key 真值同步进 initial（main.js getAll 返回 aiApiKey:'' +
    // _hasAiKey 布尔位；reveal 真值必须发生在 _render 之前）。
    //
    // 不这么做会出现两个 bug：
    // 1) 用户清空 input 后 value('' )=== initial.aiApiKey('') → diff 失真，
    //    "已清空" 不会被写入存储，下一次开 dialog 又被 reveal 填回去。
    // 2) reveal 异步期间用户点保存，diff 基线仍是 ''，行为不可预测。
    //
    // 在这里 await 而不是 _render 里 fire-and-forget，能彻底避免
    // 「reveal 异步回来覆盖用户输入」的 race（用户开 dialog 后立刻改 key，
    // 旧 reveal 还在 pending，回来时会把用户的输入覆盖掉）。
    //
    // Q7/Q9 fix (audit)：reveal 必须先 arm —— main.js 端要求 reveal 必须发生在
    // arm 后的 5 秒窗口内（per-sender）。打开设置对话框本身是用户主动行为，
    // （顶部工具栏设置按钮 / AI 未配置时自动跳转到 AI 段 / Ctrl+,）都算用户动作。
    // arm + reveal 都在同一个 async 块内完成，5 秒足够。
    // audit C1 安全修复：reveal 失败时不能静默 —— 否则用户看到空白 Key 字段会以为
    // 没配置过，输入新值后保存把磁盘上原本正常的 Key 覆盖坏掉。
    // _aiKeyRevealFailed 标记传给 _render：input value 仍保持空（用户可手动重填），
    // 但额外渲染一行 hint 告知「Key 已存但无法回显」+ diff 阶段把 aiApiKey 排除
    // （避免空白输入被当成「清空 Key」覆盖磁盘）。
    let _aiKeyRevealFailed = false;
    if (initial._hasAiKey && typeof this.api.armRevealAiKey === 'function' && typeof this.api.revealAiKey === 'function') {
      try {
        const arm = await this.api.armRevealAiKey();
        if (arm && arm.ok) {
          const res = await this.api.revealAiKey();
          if (res && res.ok) {
            // 审计修复 (Round 11 P1)：reveal 返回 ok=true 但 aiApiKey 为空
            // （契约违反或瞬时状态）必须视为失败 —— 否则 input 看似空 + 无 hint +
            // 用户输入新 Key 后保存，diff 会把空 input 视为"清空"或"替换"，静默
            // 覆盖磁盘上原本正常的 Key。把 ok=true 但无 aiApiKey 视为 reveal 失败，
            // 让 hint + diff 守卫生效。
            //
            // audit fix (Settings P2 / validateKey typeof guard)：加 typeof 守卫。
            // res.aiApiKey 契约上是非空字符串，但 main 端契约违反（返回
            // 非 string 类型 —— 例如未来的 API 改动返回 base64 buffer 对象）
            // 会绕过 `if (res.aiApiKey)` 真值检查，把非字符串塞进 initial.aiApiKey。
            // 后续 _save 的 diff 比较 `aiApiKey !== (initial.aiApiKey || '')`
            // 会因类型不同永远不相等，把「未变更」也当成「清空」写入，破坏磁盘
            // 数据。typeof !== 'string' 一律走 reveal 失败路径，hint + 守卫生效。
            if (typeof res.aiApiKey === 'string' && res.aiApiKey) {
              initial.aiApiKey = res.aiApiKey;
            } else {
              _aiKeyRevealFailed = true;
            }
          } else {
            _aiKeyRevealFailed = true;
          }
        } else {
          _aiKeyRevealFailed = true;
        }
      } catch (e) {
        // 审计修复 (Round 11 P3)：catch 里记一条 console.warn 便于排查；
        // UX 不变（仍走 hint 路径），但生产环境有线索可循。
        console.warn('[settings-dialog] reveal failed:', e);
        _aiKeyRevealFailed = true;
      }
    }
    initial._aiKeyRevealFailed = _aiKeyRevealFailed;

    return new Promise((resolve) => {
      this._render(initial, resolve);
      // 渲染后再做跳转：scrollIntoView 需要元素已挂载；focus 也得让出
      // mountModal 的 initial-focus（footer 保存按钮），所以 setTimeout 推一拍。
      if (options && options.focusSection) {
        setTimeout(() => focusSettingsSectionInOpenDialog(options.focusSection), 0);
      }
    }).finally(() => {
      // 审计修复 (Round 11 P2)：无论 resolve 走 cancel / save / 异常，_opening
      // 都要清 —— 否则下一次 open() 被这个标志拦截、永远打不开对话框。
      // 必须在 finally（不是 then）里：异常路径也要恢复。this.modal 的清理
      // 由 modal.js 解绑时同步做，这里只管 _opening。
      this._opening = false;
    });
  }

  _render(initial, resolve) {
    const bodyHtml = [
      this._renderAppearanceSection(initial),
      this._renderAiSection(initial),
      this._renderAboutSection(initial),
    ].join('');
    const footerHtml = `
      <button class="btn btn-secondary" type="button" data-action="close">取消</button>
      <button class="btn btn-primary" type="button" data-action="save">保存</button>
    `;

    const modal = mountModal({
      title: '设置',
      titleId: 'settings-title',
      body: bodyHtml,
      footer: footerHtml,
      onBackdropClose: 'cancel',
      onAction: (action) => {
        // 保存按钮：自己处理异步 + 错误回滚，_save() 内部决定是否关闭
        if (action === 'save') {
          this._save(initial);
          return; // 不返回 'close'，让 _save 决定是否 modal.close
        }
        // 取消按钮 / 任何 data-action 路径（除 save）→ 由 mountModal 统一关闭
        // （不自己调 modal.close，避免与 modal.js 的 close(action) 重复触发）
        return 'close';
      },
    });

    if (!modal) {
      // audit fix (Settings P2 / mountModal silent fail)：之前只 console.error
      // 然后静默 resolve('cancel') —— 用户点「设置」按钮无任何反馈、还以为
      // 自己没点中。同时 toast 一条警告与 console 错误，方便诊断 root 缺失
      // （通常是 index.html 漏挂 #modal-root / 已有 modal 占据单槽）。
      console.error('[settings-dialog] 无法挂载 modal（root 缺失或已有对话框）');
      showToast('无法打开设置对话框，请重试', 'error');
      resolve('cancel');
      return;
    }
    this.modal = modal;
    const signal = modal.abortSignal;
    const overlay = modal.overlay;

    // audit fix (Settings P2 / Ctrl+S)：模态内的快捷保存。
    // 旧版用户改完设置必须离开键盘、精确点 footer「保存」按钮 —— 鼠标路径，
    // 对键盘党不友好。Ctrl+S / Cmd+S 走 _save()，行为与按钮 click 完全一致
    // （含 _saving 防并发 + onChanged 副作用 + modal.close 路径）。
    //   - preventDefault：阻止 Electron / 浏览器默认「保存网页」动作（Electron
    //     默认会弹保存对话框，污染 UX）。
    //   - IME 合成期守卫：与 modal.js Esc 守卫一致 —— 拼音/日语 IME 按 Ctrl+S
    //     可能是「保存候选词」之类的本地操作，未 commit 之前不应触发我们的 save。
    //   - stopPropagation：避免冒泡到 document 触发 app 级别的 Ctrl+S 处理器
    //     （main.js 注册了 'menu:save' via onMenuCommand 走不同的"保存当前笔记"路径，
    //     与"保存设置"语义不同 —— 在设置里要拦截）。
    //   - signal 绑定：modal close 时随 abortSignal 自动解绑，避免泄漏。
    overlay.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      const isSaveCombo = (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey
        && (e.key === 's' || e.key === 'S');
      if (!isSaveCombo) return;
      e.preventDefault();
      e.stopPropagation();
      this._save(initial);
    }, { signal });

    // 外观段：3 个视觉选择器（配色 / 字号 / 行距）+ 实时预览
    this._bindAppearancePickers(overlay, signal);

    // audit fix (H13)：textarea 不能用模板里的 escapeAttr(systemPrompt) 注入内容——
    // escapeAttr 把 < > & 转成 &lt; &gt; &amp;，再次打开设置时用户看到的是字面
    // &amp;lt;b&amp;gt; 这种"双重转义"内容。现在 textarea 模板里只渲染空 body，
    // mount 后用 DOM property 直接赋原值，避开 entity 编解码。
    const aiSystemPromptEl = overlay.querySelector('#settings-ai-system-prompt');
    if (aiSystemPromptEl) aiSystemPromptEl.value = initial.aiSystemPrompt || '';

    // AI Key 显示/隐藏
    const aiKeyInput = overlay.querySelector('#settings-ai-api-key');
    const aiKeyToggle = overlay.querySelector('[data-action="toggle-ai-key"]');
    if (aiKeyInput && aiKeyToggle) {
      aiKeyToggle.addEventListener('click', () => {
        // nextShown = true 表示按下后变为「显示」态（type=text）
        const nextShown = aiKeyInput.type === 'password';
        aiKeyInput.type = nextShown ? 'text' : 'password';
        // 同步图标/文字/aria 状态：之前只有 type 变化，按钮自身没有任何反馈，
        // 用户/读屏无法判断当前是显示还是隐藏态。
        aiKeyToggle.setAttribute('aria-pressed', String(nextShown));
        aiKeyToggle.setAttribute('aria-label', nextShown ? '隐藏 API Key' : '显示 API Key');
        aiKeyToggle.innerHTML = renderAiKeyToggleLabel(nextShown);
        aiKeyInput.focus();
        // 切到显示态 + input 已有值时全选文本，方便复制 / 检查 Key 是否正确；
        // 空 input 跳过（用户接下来要输入，不应全选）。
        if (nextShown && aiKeyInput.value) aiKeyInput.select();
      }, { signal });
    }
    // 对话框关闭时立即清空 API Key input，避免被 DevTools / 截图 / 复制粘贴泄露
    if (typeof modal.setOnClose === 'function') {
      modal.setOnClose(() => {
        if (aiKeyInput) aiKeyInput.value = '';
      });
    }

    // AI Provider 切换：按选中的 provider 改 baseURL / model placeholder + hint 文案。
    // 已填的值不主动清空 —— 用户可能是中转服务（OpenAI 兼容），故意保留旧值。
    const aiProviderRadios = overlay.querySelectorAll('input[name="ai-provider"]');
    const aiBaseUrlInput = overlay.querySelector('#settings-ai-base-url');
    const aiModelInput = overlay.querySelector('#settings-ai-model');
    const aiBaseUrlHint = overlay.querySelector('#settings-ai-base-url-hint');
    if (aiProviderRadios.length && aiBaseUrlInput && aiModelInput) {
      const applyHint = (providerValue) => {
        const defaults = AI_DEFAULTS[providerValue] || AI_DEFAULTS.openai;
        aiBaseUrlInput.placeholder = defaults.baseUrl;
        aiModelInput.placeholder = defaults.model;
        // 句式统一：只讲协议路径是否含 /v1 前缀。"兼容"信息已经在卡片 label 表达。
        if (aiBaseUrlHint) {
          aiBaseUrlHint.innerHTML = providerValue === 'anthropic'
            ? 'Anthropic 兼容：请求路径不含 <code>/v1</code> 前缀。'
            : 'OpenAI 兼容：请求路径含 <code>/v1</code> 前缀。';
        }
      };
      aiProviderRadios.forEach((radio) => {
        radio.addEventListener('change', () => {
          if (radio.checked) applyHint(radio.value);
        }, { signal });
      });

      // 清空 AI 配置：把 5 个字段全部清掉，复位 provider 到默认 openai，
      // placeholder/hint 跟着 reset。**不直接保存** —— 跟 [重置为默认]
      // 行为一致（用户在 [保存] 上决定要不要落盘；不点保存则视为放弃）。
      const clearAiBtn = overlay.querySelector('[data-action="clear-ai"]');
      if (clearAiBtn) {
        clearAiBtn.addEventListener('click', () => {
          // 审计修复 (Round 11 P1-7)：先 blur IME 合成中的 input。
          // 用户在 Key 输入框里 IME 拼音没打完（compositionend 未发）时点清空，
          // 直接置 '' 会丢失正在输入的内容且 IME 状态错乱。blur 让 IME 先 commit/cancel。
          const imeTargets = [aiKeyInput, aiBaseUrlInput, aiModelInput].filter(Boolean);
          const active = document.activeElement;
          if (active && imeTargets.includes(active) && typeof active.blur === 'function') {
            active.blur();
          }
          const aiSystemPromptEl = overlay.querySelector('#settings-ai-system-prompt');
          const openaiRadio = overlay.querySelector('input[name="ai-provider"][value="openai"]');
          if (openaiRadio) {
            openaiRadio.checked = true;
            // 派发 change 让 _bindAppearancePickers 里的委托监听器跑：
            //   - syncSelectedClass 切 .is-selected + ✓ 角标
            //   - ai-provider 的 placeholder / hint 由 aiProviderRadios 单独监听器同步
            openaiRadio.dispatchEvent(new Event('change', { bubbles: true }));
          }
          applyHint('openai');
          aiBaseUrlInput.value = '';
          if (aiKeyInput) aiKeyInput.value = '';
          aiModelInput.value = '';
          if (aiSystemPromptEl) aiSystemPromptEl.value = '';
          // 审计修复 (Round 11 P2-4)：去掉重复的 applyHint('openai')。
          // 上面 dispatch + openaiRadio.checked 已触发 aiProviderRadios 的 change
          // 监听器跑过一次 applyHint，再调一次是冗余。
          showToast('已清空 AI 配置，点保存后生效', 'info', 1800);
          // focus 到 Base URL 让用户能直接接着填；不放 model 是因为清空后
          // 通常会先确认/切换 provider，再选对应模型。
          aiBaseUrlInput.focus();
        }, { signal });
      }
    }

    // 打开 config.json 所在目录 —— 用户点 hint 里的 [打开文件夹] 触发。
    //
    // audit fix (Round 9 CFG-1)：之前走 `app:open-path` 并传 `initial._configDir`，
    // 但那个 handler 强制 target === 当前**数据**目录，配置目录（userData）会被
    // PATH_NOT_ALLOWED 拒掉 —— 即使按钮渲染出来也点不动。改走专用的
    // `app:open-config-dir`（不接参数，路径在主进程内部组合）。
    const openConfigDirBtn = overlay.querySelector('[data-action="open-config-dir"]');
    if (openConfigDirBtn && typeof this.api.openConfigDir === 'function') {
      openConfigDirBtn.addEventListener('click', async () => {
        try {
          const result = await this.api.openConfigDir();
          if (!result || !result.ok) {
            showToast(`打开失败：${(result && (result.message || result.error)) || '未知错误'}`, 'error');
          }
        } catch {
          showToast('打开配置目录失败', 'error');
        }
      }, { signal });
    }

    // 关于段：开发者主页链接走 openExternal（系统默认浏览器打开），
    // 不让 Electron 内嵌 webview 接管，保持与 app.js 中其它外链一致的体验。
    //
    // 委托到 overlay 上而不是给每个 .about-link 单独挂监听：未来如果加更多外链
    // （GitHub / 文档站等），直接复用同一段 click handler 即可。
    //   - preventDefault：阻止默认 href 跳转（Electron 内打开一个空白 webview 是 UX 灾难）
    //   - URL 来自 data-* 属性，模板里已 escapeAttr，运行时直接读取
    //   - openExternal 缺失（极旧 preload）走静默兜底，链接至少还能 hover 看 URL
    const aboutLinks = overlay.querySelectorAll('.about-link[data-external-url]');
    if (aboutLinks.length) {
      overlay.addEventListener('click', async (e) => {
        const target = e.target;
        if (!(target instanceof Element)) return;
        const link = target.closest('.about-link[data-external-url]');
        if (!link) return;
        const url = link.getAttribute('data-external-url');
        if (!url) return;
        e.preventDefault();
        if (typeof this.api.openExternal !== 'function') return;
        try {
          const result = await this.api.openExternal(url);
          if (!result || !result.ok) {
            const msg = result && result.message ? result.message : '无法打开该链接';
            showToast(msg, 'warning');
          }
        } catch {
          showToast('无法打开该链接', 'warning');
        }
      }, { signal });
    }

    modal.setOnClose((value) => {
      this.modal = null;
      // 关闭即重置：成功路径（modal.close('save')）和用户取消（Esc / × / 背景）
      // 都会走这里，不重置的话下次开 dialog 时 _saving=true 会让保存按钮永远禁用。
      this._saving = false;
      resolve(value === 'save' ? 'saved' : 'cancel');
    });
  }

  /** 外观段：3 个 picker 卡片组 + 实时预览 */
  _renderAppearanceSection(initial) {
    // 注意：暗/亮主题循环按钮在顶部工具栏，所以这里不提供「主题」选择；
    // 只提供「配色（palette）」，因为它没有顶部按钮入口。
    const palette = THEME_PALETTES.some(p => p.value === initial.themePalette) ? initial.themePalette : 'default';
    const paletteLabel = THEME_PALETTES.find(p => p.value === palette)?.label || palette;
    const fs = READER_FONT_SIZES.includes(initial.readerFontSize) ? initial.readerFontSize : 17;
    const lh = READER_LINE_HEIGHTS.includes(initial.readerLineHeight) ? initial.readerLineHeight : 1.85;

    // 配色卡片：5 列横排，每张展示该 palette 的 bg + accent 二色条
    const paletteCards = THEME_PALETTES.map((p) => {
      const colors = PALETTE_PREVIEW_COLORS[p.value] || PALETTE_PREVIEW_COLORS.default;
      const isSelected = p.value === palette;
      const shortLabel = p.label;
      return `
        <label class="picker-card palette-card ${isSelected ? 'is-selected' : ''}" data-picker="palette" data-value="${escapeAttr(p.value)}">
          <input type="radio" name="theme-palette" value="${escapeAttr(p.value)}" ${isSelected ? 'checked' : ''}>
          <span class="palette-strip" aria-hidden="true">
            <span class="palette-strip-bg" style="background:${escapeAttr(colors.bg)}"></span>
            <span class="palette-strip-accent" style="background:${escapeAttr(colors.accent)}"></span>
          </span>
          <span class="picker-card-label">${escapeAttr(shortLabel)}</span>
          <span class="picker-card-check" aria-hidden="true">${CHECK_SVG}</span>
        </label>
      `;
    }).join('');

    // 字号卡片：5 张卡，每张渲染一个 "Aa" 样本
    const fontSizeCards = READER_FONT_SIZES.map((n) => {
      const isSelected = n === fs;
      return `
        <label class="picker-card fontsize-card ${isSelected ? 'is-selected' : ''}" data-picker="fontsize" data-value="${n}" style="--sample-size:${n}px">
          <input type="radio" name="reader-font-size" value="${n}" ${isSelected ? 'checked' : ''}>
          <span class="fontsize-preview" aria-hidden="true">Aa</span>
          <span class="fontsize-card-label">${n}</span>
          <span class="picker-card-check" aria-hidden="true">${CHECK_SVG}</span>
        </label>
      `;
    }).join('');

    // 行距卡片：4 张卡，每张渲染 3 行示例文本
    const lineHeightCards = READER_LINE_HEIGHTS.map((n) => {
      const isSelected = n === lh;
      return `
        <label class="picker-card lineheight-card ${isSelected ? 'is-selected' : ''}" data-picker="lineheight" data-value="${n}" style="--sample-lh:${n}">
          <input type="radio" name="reader-line-height" value="${n}" ${isSelected ? 'checked' : ''}>
          <span class="lineheight-preview" aria-hidden="true">行距预览<br>第二行示例<br>第三行示例</span>
          <span class="lineheight-card-label">${n.toFixed(2).replace(/0$/, '')}</span>
          <span class="picker-card-check" aria-hidden="true">${CHECK_SVG}</span>
        </label>
      `;
    }).join('');

    return `
      <section class="settings-section">
        <header class="settings-section-header">
          <span class="settings-section-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="9"></circle>
              <path d="M12 3v18M3 12h18"></path>
            </svg>
          </span>
          <div>
            <h3 class="settings-section-title">外观</h3>
            <p class="settings-section-subtitle">配色风格、阅读字号与行距</p>
          </div>
        </header>
        <div class="form-row">
          <div class="picker-group">
            <div class="picker-group-label">
              <span class="form-label">配色</span>
              <span class="picker-group-value" id="palette-value-label">${escapeAttr(paletteLabel)}</span>
            </div>
            <div class="picker-grid picker-grid-palette" role="radiogroup" aria-label="配色">${paletteCards}</div>
          </div>
        </div>
        <div class="form-row">
          <div class="picker-group">
            <div class="picker-group-label">
              <span class="form-label">阅读字号</span>
              <span class="picker-group-value" id="fontsize-value-label">${fs} px</span>
            </div>
            <div class="picker-grid picker-grid-fontsize" role="radiogroup" aria-label="阅读字号">${fontSizeCards}</div>
          </div>
        </div>
        <div class="form-row">
          <div class="picker-group">
            <div class="picker-group-label">
              <span class="form-label">阅读行距</span>
              <span class="picker-group-value" id="lineheight-value-label">${lh}</span>
            </div>
            <div class="picker-grid picker-grid-lineheight" role="radiogroup" aria-label="阅读行距">${lineHeightCards}</div>
          </div>
        </div>
        <div class="md-preview" id="md-preview" style="--sample-font-size:${fs}px;--sample-line-height:${lh}">
          <div class="md-preview-title">预览 · 所见即所得</div>
          <div class="md-preview-body">
            <div class="md-preview-heading">段落与排版</div>
            <p><strong>这是一段示例文本</strong>，预览选中的<em>排版风格</em>。包含 <code>inline code</code> 和<a href="#">链接</a>的实际观感。</p>
            <blockquote>引用块用左侧色条表达，<em>行距</em>与正文同步跟随。</blockquote>
            <ul>
              <li>列表项，行距也受选中值影响</li>
              <li>第二项，便于对比</li>
            </ul>
            <pre><code># 代码块
print('hello')</code></pre>
          </div>
        </div>
      </section>
    `;
  }

  /**
   * AI 段：用户在设置里填「OpenAI 兼容」API 的配置。
   * - Provider：OpenAI 兼容 (/chat/completions) 或 Anthropic (/v1/messages)
   * - Base URL：按 provider 不同；切换 provider 时自动改 placeholder
   * - API Key：密码框 + 显示/隐藏眼睛按钮，避免在设置里裸明文（但本机本地存储仍然明文）
   * - Model：模型名，自由文本（不同服务命名不一样）
   * - System Prompt：留空时主进程用内置中文 prompt（默认 Markdown 助手）
   *
   * 不做"已配置/未配置"提示 —— 让用户自己知道有没有填；
   * 工具栏 AI 按钮在未配置时给出 toast 提示已足够。
   */
  _renderAiSection(initial) {
    // 初始值都来自 schema（必填项：string 类型 + 空串默认；首次打开是空）
    const provider = AI_PROVIDERS.some(p => p.value === initial.aiProvider) ? initial.aiProvider : 'openai';
    const baseUrl = initial.aiBaseUrl || '';
    const apiKey = initial.aiApiKey || '';
    const model = initial.aiModel || '';
    // audit fix (H13)：systemPrompt 不在模板里 escapeAttr 注入，改在 open() mount 后
    // 直接给 textarea.value 赋值（绕过 entity 编解码，保留用户输入的原貌）。
    // initial.aiSystemPrompt || '';

    const currentHints = AI_DEFAULTS[provider] || AI_DEFAULTS.openai;

    // AI 服务卡片：整宽单列堆叠（grid 1fr），每张只显示 icon + 名称 + hint。
    //
    // 之前是 2 列横排 + 右侧 .aiprovider-protocol 角标，但 hint 文本里已经包含
    // 协议路径（"/chat/completions · ..."），protocol 角标是纯重复信息；
    // 2 列 + 长 hint 还导致文本断行成 3 行（"Azure 等"溢出），视觉拥挤。
    // 只有 2 个 provider，"2 列并排比较"收益小，整宽反而给 hint 留够单行空间。
    //
    // icon 用 "GPT" / "Claude" 文字而不是单字母 "O"/"A" —— 后者在小尺寸下跟数字
    // 0、符号△ 等容易混淆，文字最无歧义。
    const providerCards = AI_PROVIDERS.map((p) => {
      const isSelected = p.value === provider;
      const iconText = p.value === 'anthropic' ? 'Claude' : 'GPT';
      return `
        <label class="picker-card aiprovider-card ${isSelected ? 'is-selected' : ''}" data-picker="aiprovider" data-value="${escapeAttr(p.value)}">
          <input type="radio" name="ai-provider" value="${escapeAttr(p.value)}" ${isSelected ? 'checked' : ''}>
          <span class="aiprovider-icon" aria-hidden="true">${iconText}</span>
          <span class="aiprovider-body">
            <span class="aiprovider-card-label">${escapeAttr(p.label)}</span>
            <span class="aiprovider-card-hint">${escapeAttr(p.hint || '')}</span>
          </span>
          <span class="picker-card-check" aria-hidden="true">${CHECK_SVG}</span>
        </label>
      `;
    }).join('');

    return `
      <section class="settings-section">
        <header class="settings-section-header">
          <span class="settings-section-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 2a4 4 0 0 0-4 4v1H6a3 3 0 0 0-3 3v9a3 3 0 0 0 3 3h12a3 3 0 0 0 3-3v-9a3 3 0 0 0-3-3h-2V6a4 4 0 0 0-4-4z"></path>
              <circle cx="9" cy="13" r="1.2" fill="currentColor" stroke="none"></circle>
              <circle cx="15" cy="13" r="1.2" fill="currentColor" stroke="none"></circle>
              <path d="M9 17h6"></path>
            </svg>
          </span>
          <div>
            <h3 class="settings-section-title">AI</h3>
            <p class="settings-section-subtitle">调用大模型协助修改文档</p>
          </div>
        </header>

        <h4 class="settings-subsection-title">连接</h4>
        <div class="form-row">
          <div class="picker-group">
            <div class="picker-group-label">
              <span class="form-label">服务提供方</span>
            </div>
            <div class="picker-grid picker-grid-aiprovider" role="radiogroup" aria-label="AI 服务提供方">${providerCards}</div>
          </div>
        </div>
        <div class="form-row">
          <label class="form-label" for="settings-ai-base-url">Base URL</label>
          <input
            id="settings-ai-base-url"
            class="form-input form-input-mono"
            type="text"
            value="${escapeAttr(baseUrl)}"
            placeholder="${escapeAttr(currentHints.baseUrl)}"
          >
          <div class="form-hint" id="settings-ai-base-url-hint">${provider === 'anthropic'
            ? 'Anthropic 兼容：请求路径不含 <code>/v1</code> 前缀。'
            : 'OpenAI 兼容：请求路径含 <code>/v1</code> 前缀。'}</div>
        </div>
        <div class="form-row">
          <label class="form-label" for="settings-ai-api-key">API Key</label>
          <div class="form-path-row">
            <input
              id="settings-ai-api-key"
              class="form-input form-input-mono"
              type="password"
              value="${escapeAttr(apiKey)}"
              placeholder="sk-..."
              autocomplete="off"
              spellcheck="false"
            >
            <button
              class="btn btn-secondary btn-with-icon"
              type="button"
              data-action="toggle-ai-key"
              aria-pressed="false"
              aria-label="显示 API Key"
            >${renderAiKeyToggleLabel(false)}</button>
          </div>
          ${initial._aiKeyRevealFailed
            ? `<div class="form-hint form-hint-warning" role="status">
                 Key 已保存但当前无法回显。如要替换请输入完整新 Key；留空不会清空已有 Key（需清空请手动编辑 config.json）。
               </div>`
            : ''}
        </div>
        <div class="form-row">
          <label class="form-label" for="settings-ai-model">模型</label>
          <input
            id="settings-ai-model"
            class="form-input"
            type="text"
            value="${escapeAttr(model)}"
            placeholder="${escapeAttr(currentHints.model)}"
          >
          <div class="form-hint">对应服务的模型标识（具体名称以其文档为准）。</div>
        </div>

        <div class="settings-callout" role="note">
          <span class="settings-callout-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 9v4"></path>
              <path d="M12 17h.01"></path>
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
            </svg>
          </span>
          <div class="settings-callout-text">
            API Key 明文存储于本机 <code>config.json</code>${initial._configName ? `${initial._configDirName ? `（位于 <code>${escapeAttr(initial._configDirName)}</code> 配置目录）` : ''}<button type="button" class="btn-link" data-action="open-config-dir">[打开文件夹]</button>` : ''}。每次请求以 HTTP header 形式发送至上方的 Base URL，请使用你信任的服务。
          </div>
        </div>

        <h4 class="settings-subsection-title">行为</h4>
        <div class="form-row">
          <label class="form-label" for="settings-ai-system-prompt">系统提示词</label>
          <textarea
            id="settings-ai-system-prompt"
            class="form-input form-textarea"
            rows="4"
            placeholder="留空使用内置默认提示词"
          ></textarea>
          <div class="form-hint">让 AI 按特定角色或格式回复；留空时使用内置默认。</div>
        </div>

        <div class="settings-callout settings-callout-danger" role="note">
          <span class="settings-callout-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"></path>
              <path d="M10 11v6"></path>
              <path d="M14 11v6"></path>
              <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"></path>
            </svg>
          </span>
          <div class="settings-callout-text">
            清空 Base URL、API Key、模型与提示词。
            <button
              type="button"
              class="btn-link"
              data-action="clear-ai"
              ${initial._aiKeyRevealFailed
                // 审计修复 (Round 11)：reveal 失败时无法读到磁盘上的 Key 真值，
                // 用户看到 input 空就以为「清空能删 Key」，但 hint 又说「留空不会清空」——
                // [清空 AI 配置] 按钮也会清 input 但要走保存才落盘，落盘后真 Key 真的没了。
                // 直接禁用按钮 + tooltip 引导「手动编辑 config.json」，避免与 hint 自相矛盾。
                ? 'disabled aria-disabled="true" title="Key 无法回显，无法安全清空。请手动编辑 config.json。"'
                : ''}
            >[清空 AI 配置]</button>
          </div>
        </div>
      </section>
    `;
  }

  /**
   * 关于段：开发者信息 + 主页链接。
   *
   * 字段全部硬编码（不是用户可改的设置），所以本段不参与 diff / 保存：
   * - 链接用「关于」段单独的 click 监听器走 openExternal 打开
   * - 段内不放 input / picker，没有需要被 _save 读出的值
   */
  _renderAboutSection(_initial) {
    // 链接硬编码：data-* 属性携带 URL，渲染后由 _render 末尾的 click 委托读取并
    // 走 openExternal。escapeAttr 防止 URL 里出现 " 关闭属性的边界。
    const devName = '关济寰';
    const devUrl = 'https://www.guanjihuan.com/about';
    return `
      <section class="settings-section">
        <header class="settings-section-header">
          <span class="settings-section-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="9"></circle>
              <path d="M12 8h.01"></path>
              <path d="M11 12h1v4h1"></path>
            </svg>
          </span>
          <div>
            <h3 class="settings-section-title">关于</h3>
            <p class="settings-section-subtitle">开发者信息</p>
          </div>
        </header>
        <div class="form-row">
          <div class="about-line">
            <span class="about-label">开发者：</span>
            <span class="about-value">${escapeAttr(devName)}</span>
          </div>
          <div class="about-line">
            <span class="about-label">主页：</span>
            <a
              class="btn-link about-link"
              href="${escapeAttr(devUrl)}"
              data-external-url="${escapeAttr(devUrl)}"
              rel="noopener noreferrer"
            >${escapeAttr(devUrl)}</a>
          </div>
        </div>
      </section>
    `;
  }

  /**
   * 绑定外观段 3 个 picker 的交互：
   * - 切换 card → 同步 .is-selected 视觉态（✓ 角标 + 边框高亮）
   * - 实时更新 .md-preview 的字号/行距
   * - 更新右上角的数值标签
   *
   * ⚠️ .is-selected 必须跟随 radio checked 同步，否则切了 radio
   * 但 ✓ 角标还卡在初始那张卡上（之前只在渲染时设一次）。
   */
  _bindAppearancePickers(overlay, signal) {
    const updatePreviewStyle = (fs, lh) => {
      const preview = overlay.querySelector('#md-preview');
      if (preview) {
        preview.style.setProperty('--sample-font-size', `${fs}px`);
        preview.style.setProperty('--sample-line-height', String(lh));
      }
    };

    // 同步切 .is-selected：找到 radio 所在的 picker-grid，
    // 把所有卡片的 .is-selected 重新对一次 :checked 状态
    const syncSelectedClass = (radio) => {
      const grid = radio.closest('.picker-grid');
      if (!grid) return;
      grid.querySelectorAll('.picker-card').forEach((card) => {
        const r = card.querySelector('input[type="radio"]');
        card.classList.toggle('is-selected', !!(r && r.checked));
      });
    };

    // 委托：整个 modal 上挂一个 change 监听就够了
    overlay.addEventListener('change', (e) => {
      const target = e.target;
      if (!(target instanceof HTMLInputElement)) return;
      const name = target.name;
      if (!name) return;

      if (name === 'theme-palette') {
        syncSelectedClass(target);
        // 用 schema 里的中文 label（不是 value 'default'），跟卡片 label 视觉对齐
        const valueLabel = overlay.querySelector('#palette-value-label');
        if (valueLabel) {
          const opt = THEME_PALETTES.find((p) => p.value === target.value);
          valueLabel.textContent = opt ? opt.label : target.value;
        }
      } else if (name === 'reader-font-size') {
        syncSelectedClass(target);
        const fs = parseInt(target.value, 10);
        const valueLabel = overlay.querySelector('#fontsize-value-label');
        if (valueLabel) valueLabel.textContent = `${fs} px`;
        const lh = parseFloat(overlay.querySelector('input[name="reader-line-height"]:checked')?.value || '1.85');
        updatePreviewStyle(fs, lh);
      } else if (name === 'reader-line-height') {
        syncSelectedClass(target);
        const lh = parseFloat(target.value);
        const valueLabel = overlay.querySelector('#lineheight-value-label');
        if (valueLabel) valueLabel.textContent = String(lh);
        const fs = parseInt(overlay.querySelector('input[name="reader-font-size"]:checked')?.value || '17', 10);
        updatePreviewStyle(fs, lh);
      } else if (name === 'ai-provider') {
        // AI provider 的 is-selected 同样需要同步（picker 通用）
        syncSelectedClass(target);
        // placeholder / hint 的更新在 aiProviderRadios 的 change 里处理
      }
    }, { signal });
  }

  async _save(initial) {
    const modal = this.modal;
    if (!modal) return;
    const overlay = modal.overlay;

    // 【in-flight 保护】双击保存按钮 / 重复 Enter 会触发两次 update；第二次应直接忽略
    if (this._saving) return;
    this._saving = true;

    // 取出保存按钮并禁用，防止重复点击
    const saveBtn = overlay.querySelector('[data-action="save"]');
    if (saveBtn) saveBtn.disabled = true;

    try {
      const paletteChecked = overlay.querySelector('input[name="theme-palette"]:checked');
      const fsChecked = overlay.querySelector('input[name="reader-font-size"]:checked');
      const lhChecked = overlay.querySelector('input[name="reader-line-height"]:checked');
      const aiProviderChecked = overlay.querySelector('input[name="ai-provider"]:checked');
      const aiBaseUrlEl = overlay.querySelector('#settings-ai-base-url');
      const aiApiKeyEl = overlay.querySelector('#settings-ai-api-key');
      const aiModelEl = overlay.querySelector('#settings-ai-model');
      const aiSystemPromptEl = overlay.querySelector('#settings-ai-system-prompt');

      // 任何关键 DOM 缺失都直接放弃（不弹误导性错误）
      if (!paletteChecked || !fsChecked || !lhChecked) {
        console.error('[settings-dialog] 关键输入元素缺失，无法保存');
        showToast('设置对话框内部错误', 'error');
        return;
      }

      const themePalette = paletteChecked.value;
      const readerFontSize = parseInt(fsChecked.value, 10);
      const readerLineHeight = parseFloat(lhChecked.value);

      // AI 字段：trim 后存为字符串（schema 默认是空字符串）。
      // 不强制非空 —— 用户可能想清空 AI 配置。
      // aiProvider 是 enum（radio 选中）：不需要 trim（trim enum 值是 no-op，
      // 还可能掩盖 schema 校验之外的脏数据；schema 兜底拒绝非法值）。
      const aiProvider = aiProviderChecked ? (aiProviderChecked.value || 'openai') : 'openai';
      const aiBaseUrl = aiBaseUrlEl ? (aiBaseUrlEl.value || '').trim() : '';
      const aiApiKey = aiApiKeyEl ? (aiApiKeyEl.value || '').trim() : '';
      const aiModel = aiModelEl ? (aiModelEl.value || '').trim() : '';
      const aiSystemPrompt = aiSystemPromptEl ? (aiSystemPromptEl.value || '').trim() : '';

      // dataDir / fileListSort / autoSaveDebounceMs 已搬出设置对话框
      // （分别由侧栏底部「切换数据文件夹」/ sidebar-sort 工具条 / toolbar 自动保存按钮处理），
      // 这里不再读它们的 input。见 [[feedback-prefer-near-affected-area]]。

      const changes = {};
      if (themePalette !== initial.themePalette) changes.themePalette = themePalette;
      if (readerFontSize !== initial.readerFontSize) changes.readerFontSize = readerFontSize;
      if (readerLineHeight !== initial.readerLineHeight) changes.readerLineHeight = readerLineHeight;
      // AI 字段：与 initial 不一致才写（避免空串覆盖已有值的常见误操作）。
      // audit C1：reveal 失败时 aiApiKey 字段无法回显（input 看似空），
      // 但磁盘上有真值。如果把当前空 input 当成「清空」写入，会把正常 Key 覆盖坏。
      // 这种情况下直接跳过 aiApiKey 字段的 diff —— 用户必须输入完整新 Key 才会被写入。
      if (aiProvider !== (initial.aiProvider || 'openai')) changes.aiProvider = aiProvider;
      if (aiBaseUrl !== (initial.aiBaseUrl || '')) changes.aiBaseUrl = aiBaseUrl;
      // 审计修复 (Round 11 P0)：reveal-failed 路径必须接受用户输入的新 Key。
      // 之前条件 `!initial._aiKeyRevealFailed && aiApiKey !== ...` 在 reveal 失败时
      // 直接 short-circuit，永远不进入 changes.aiApiKey —— 用户按 hint 提示输入新
      // Key 后点保存，新 Key 被静默丢弃，与文案「输入完整新 Key 会被写入」严重不符。
      // 修正：reveal 失败时如果用户输入了非空值视为要替换；只有留空才算「无变更」跳过。
      if (!initial._aiKeyRevealFailed) {
        if (aiApiKey !== (initial.aiApiKey || '')) changes.aiApiKey = aiApiKey;
      } else if (aiApiKey) {
        changes.aiApiKey = aiApiKey;
      }
      if (aiModel !== (initial.aiModel || '')) changes.aiModel = aiModel;
      if (aiSystemPrompt !== (initial.aiSystemPrompt || '')) changes.aiSystemPrompt = aiSystemPrompt;

      if (Object.keys(changes).length === 0) {
        modal.close('save');
        return;
      }

      await this.settingsStore.update(changes);
      // audit fix (Round 4 F7)：onChanged 单独 try/catch。settingsStore.update 已
      // 落盘，但 onChanged 内部可能调主题切换 / 字体刷新等同步副作用报错（如 CSP
      // 拦截 / 用户代理阻止）—— 一旦抛错就阻断主流程，用户看到红色「保存失败」
      // toast，但 config.json 已写入，下次启动仍是新设置，视觉与磁盘状态割裂。
      // 落盘成功就视为「保存成功」，回调错误降级为 warn + 次级 toast 不阻断主流程。
      let onChangedError = null;
      if (this.onChanged) {
        try {
          await this.onChanged(changes);
        } catch (e) {
          onChangedError = e;
          console.warn('[settings-dialog] onChanged 副作用失败（配置已落盘）：', e);
        }
      }
      // audit fix (Round 4 F5)：modal 关闭后不再弹「已保存」。onChanged 期间用户
      // 可能按 Esc / × 关闭 modal —— modal.close 已被调用，DOM 已 unmount，但
      // showToast 仍会弹在右下角，用户视觉上看到「modal 已关 + 突然冒出 toast」
      // 割裂。showToast 前先看 modal 是否仍在 DOM 里。
      if (document.querySelector('.modal-overlay')) {
        if (onChangedError) {
          showToast(`已保存，但部分视觉刷新失败：${onChangedError.message || '未知错误'}`, 'warning', 3500);
        } else {
          showToast('设置已保存', 'success', 1800);
        }
      }
      modal.close('save');
    } catch (e) {
      console.error('[settings-dialog] 保存失败:', e);
      showToast(`保存失败：${e.message}`, 'error');
    }
    // 统一收口：成功 / 失败 / 早退（DOM 缺失 / 无变更）三条路径都走这里。
    // 之前只有 catch 分支复位 _saving —— 成功后 modal.close('save') 直接
    // return，_saving 留在 true；再次 open() 会被 `if (this._saving) return`
    // 误挡，必须 reload 才能恢复（按钮看起来"失灵"，但实际上是状态卡死）。
    this._saving = false;
    if (saveBtn) saveBtn.disabled = false;
  }
}

/**
 * 把当前打开的设置对话框滚到指定 section，并 focus 第一个必填空字段。
 * 用于：「AI 未配置 → 自动打开设置」时已有对话框的场景，以及 open() 的初始 focusSection。
 * 模块级 helper —— 不依赖任何实例状态，直接 query 当前 modal-overlay。
 * @param {'ai'} section
 */
function focusSettingsSectionInOpenDialog(section) {
  const overlay = document.querySelector('.modal-overlay');
  if (!overlay) return;
  if (section === 'ai') {
    // AI 是第 2 个 .settings-section（外观 / AI），但靠 selector 找更稳
    const apiKeyElProbe = overlay.querySelector('#settings-ai-api-key');
    const aiSection = apiKeyElProbe ? apiKeyElProbe.closest('.settings-section') : null;
    if (aiSection) {
      // 滚到 AI 段顶部（用 'instant' 而非 smooth —— 用户已经在等反馈，瞬时跳转不晃眼）
      aiSection.scrollIntoView({ block: 'start', behavior: 'instant' });
    }
    // 焦点：按 Base URL → API Key → Model 顺序，挑第一个空的（用户最缺的那一个）。
    // 全填了则 focus 到 Base URL（这样用户至少能看见该段没漏），避免没目标就啥也不做。
    const baseUrlEl = overlay.querySelector('#settings-ai-base-url');
    const apiKeyEl = overlay.querySelector('#settings-ai-api-key');
    const modelEl = overlay.querySelector('#settings-ai-model');
    const firstEmpty = [baseUrlEl, apiKeyEl, modelEl].find((el) => el && !el.value.trim());
    const target = firstEmpty || baseUrlEl;
    if (target) {
      try { target.focus(); } catch { /* 元素不可聚焦时静默 */ }
    }
  }
}
