// 通用输入对话框 —— Electron 渲染端不支持 window.prompt() / window.alert()，
// 我们基于 mountModal 自己搭一个。
//
// 用法（语义与 window.prompt() 完全一致，便于替换）：
//   const value = await showPromptDialog({
//     title: '重命名',
//     message: '重命名为（自动补 .md 后缀）',  // 可选；放在输入框上方
//     defaultValue: '当前名',                  // 可选；默认空串
//     placeholder: '请输入…',                  // 可选
//     inputLabel: '文件名',                    // 可选；屏幕阅读器朗读用
//     confirmLabel: '确定',                     // 可选
//     cancelLabel: '取消',                     // 可选
//     selectAllOnOpen: true,                   // 可选；默认 true，模仿 window.prompt()
//     validate: (raw) => {                     // 可选；客户端预校验
//       if (!raw.trim()) return '文件名不能为空';
//       if (/[/\\]/.test(raw)) return '文件名不能包含路径分隔符';
//       return null;                            // null = 通过
//     },
//   });
//   if (value == null) return;                  // 用户取消 → null
//   const trimmed = value.trim();              // 确认 → 原样字符串（含前后空格，由调用方决定是否 trim）
//
// 设计要点：
//   - 完全跑在 mountModal 上，复用 ARIA / focus-trap / Esc / overlay-click / 单槽冲突
//   - Enter 提交（焦点在 input 内时），Esc / × / 点背景 = 取消
//   - 打开时全选默认文字（模仿 window.prompt() 行为，便于「重命名」场景直接覆盖）
//   - mountModal 失败（#modal-root 缺失 / 已有 modal）→ 退化到 window.prompt()
//     （与 confirm-dialog.js 的兜底一致；理论上 Electron renderer 里没有 prompt，
//      但保持接口形态一致）
//   - 可选 validate：返回 null = 通过；返回字符串 = 在 input 下方显示为错误，
//     dialog 保持打开、不关闭。空字符串 = 通过（无错误信息）。
//
// 边界：
//   - 只读 / 不写 ctx 之外的全局状态
//   - 调用方负责校验空字符串、文件名合法性等

import { escapeHtml, escapeAttr } from './utils.js';
import { mountModal } from './modal.js';
// audit fix (Phase L2 #7)：modal 被另一个对话框占位时给用户 toast，避免
// 重要操作（重命名 / 新建文件）静默失败。
import { showToast } from './feedback.js';

const DEFAULT_CONFIRM_LABEL = '确定';
const DEFAULT_CANCEL_LABEL = '取消';
const INPUT_ID = 'prompt-dialog-input';
const ERROR_ID = 'prompt-dialog-error';

/**
 * 显示一个输入对话框
 * @param {object} options
 * @param {string} options.title - 标题（必填）
 * @param {string} [options.message] - 正文（可选；放在输入框上方）
 * @param {string} [options.defaultValue=''] - 输入框初始值
 * @param {string} [options.placeholder] - 输入框 placeholder
 * @param {string} [options.inputLabel] - 输入框 label（屏幕阅读器朗读；视觉上仍可见）
 * @param {string} [options.confirmLabel='确定'] - 确认按钮文本
 * @param {string} [options.cancelLabel='取消'] - 取消按钮文本
 * @param {boolean} [options.selectAllOnOpen=true] - 打开时是否全选默认文字
 * @param {(raw: string) => (string|null|undefined)} [options.validate] -
 *   客户端预校验；返回 null/undefined = 通过；返回字符串 = 错误消息（dialog 保持打开）
 * @returns {Promise<string|null>} 用户输入的字符串；取消时返回 null
 */
export function showPromptDialog({
  title,
  message = '',
  defaultValue = '',
  placeholder = '',
  inputLabel = '',
  confirmLabel = DEFAULT_CONFIRM_LABEL,
  cancelLabel = DEFAULT_CANCEL_LABEL,
  selectAllOnOpen = true,
  validate = null,
} = {}) {
  return new Promise((resolve) => {
    if (!title) {
      // 没有标题 → 与 mountModal 行为一致地退化，避免静默卡住调用方
      resolve(null);
      return;
    }

    const messageHtml = message
      ? `<p class="confirm-message">${escapeHtml(message)}</p>`
      : '';
    // 审计修复 (Round 11 vol.2)：输入框下方预留给 validate 错误信息；
    // 初始为空（无错误态），validate 触发时填文案 + aria-invalid。
    const bodyHtml = `
      ${messageHtml}
      <div class="form-row">
        <label class="form-label" for="${INPUT_ID}">${escapeHtml(inputLabel || title)}</label>
        <input
          id="${INPUT_ID}"
          class="form-input"
          type="text"
          ${placeholder ? `placeholder="${escapeAttr(placeholder)}"` : ''}
          value="${escapeAttr(defaultValue)}"
          maxlength="255"
          autocomplete="off"
          spellcheck="false"
          aria-describedby="${ERROR_ID}"
        >
        <p id="${ERROR_ID}" class="form-error" role="alert" hidden></p>
      </div>
    `;

    const footerHtml = `
      <button class="btn btn-secondary" type="button" data-action="cancel">${escapeHtml(cancelLabel)}</button>
      <button class="btn btn-primary" type="button" data-action="confirm">${escapeHtml(confirmLabel)}</button>
    `;

    // tryConfirm 必须先声明（即便 body 还没渲染）—— 因为 mountModal 的 onAction
    // 回调是延迟触发的，user 真正点按钮 / 按 Enter 时 inputEl / errorEl 都已就绪。
    // 这里只放一个 forward declaration；函数体和引用在 inputEl 之后才生效。
    // audit fix (Phase L1-Settings P1)：Enter 与按钮 click 必须走完全同一条
    // validate 路径。早期版本 Enter 直接 modal.close('confirm') 跳过校验，
    // 导致重命名场景输入非法名 → dialog 静默关闭 → IPC 拒、用户输入丢失。
    let tryConfirm = () => undefined;

    const modal = mountModal({
      title,
      body: bodyHtml,
      footer: footerHtml,
      // 初始焦点放到输入框（focus-trap 在 queueMicrotask 里调 focus）
      initialFocus: `#${INPUT_ID}`,
      // Esc / × / 点背景 = 取消（与浏览器原生 prompt 一致）
      onBackdropClose: 'cancel',
      onAction: (action) => {
        // cancel 直接让 mountModal 关闭；confirm 委托给 tryConfirm，
        // 由它决定「validate 失败保持打开」或「成功 close」。
        if (action === 'cancel') return 'close';
        if (action === 'confirm') {
          // 返回 undefined（mountModal 不再负责关闭），因为 tryConfirm 内部
          // 已经按需调用 modal.close('confirm')。
          tryConfirm();
          return undefined;
        }
        return undefined;
      },
    });

    if (!modal) {
      // mountModal 失败（#modal-root 缺失 / 已有 modal 占位）
      // 注意：不能 fallback 到 window.prompt() —— Electron 渲染端 prompt() 会抛错
      // （'prompt() is and will not be supported'），正好是我们要绕开的坑。
      // 兜底行为：当作取消处理（resolve null），并 toast 提示用户，让重要
      // 操作（重命名 / 新建文件）不会静默无反应（audit L2 #7）。
      showToast('已有对话框打开，请先关闭后再试', 'warning');
      resolve(null);
      return;
    }

    const inputEl = modal.body.querySelector(`#${INPUT_ID}`);
    const errorEl = modal.body.querySelector(`#${ERROR_ID}`);
    if (!inputEl) {
      // 极端兜底：input 没渲染出来 —— 直接关掉并 resolve(null)，不挂死调用方
      modal.close('cancel');
      resolve(null);
      return;
    }

    // 错误显示/清除：单点维护行内错误 UI 行为（aria-invalid + 文本 + hidden）。
    function showError(msg) {
      if (!errorEl) return;
      errorEl.textContent = msg;
      errorEl.hidden = false;
      inputEl.setAttribute('aria-invalid', 'true');
      inputEl.classList.add('is-invalid');
    }
    function clearError() {
      if (!errorEl) return;
      errorEl.textContent = '';
      errorEl.hidden = true;
      inputEl.removeAttribute('aria-invalid');
      inputEl.classList.remove('is-invalid');
    }

    // 用户每次输入都清错误 —— 让他们看到「错误已识别，现在改正」反馈。
    // 守卫：在没 validate 的场景下也保留（clearError 是 no-op 安全）。
    inputEl.addEventListener('input', () => {
      if (inputEl.getAttribute('aria-invalid') === 'true') clearError();
    }, { signal: modal.abortSignal });

    // 单一 resolve 出口：所有关闭路径（Cancel / × / Esc / 背景 / Confirm / Enter）都走这里
    modal.setOnClose((value) => {
      // Promise resolve 是幂等的，重复调用安全
      if (value === 'cancel') resolve(null);
      else resolve(inputEl.value);
    });

    // IME composition 跟踪 —— CJK 输入法按 Enter 是「确认候选词」而非「提交表单」。
    // 不跟踪会让正在打拼音的用户按 Enter 直接关闭弹窗，丢掉半截输入。
    // 参考 src/ai/ai-chat-panel.js 的 _composing 模式（更严谨的 compositionstart/end）。
    let composing = false;
    inputEl.addEventListener('compositionstart', () => { composing = true; }, { signal: modal.abortSignal });
    inputEl.addEventListener('compositionend', () => { composing = false; }, { signal: modal.abortSignal });
    inputEl.addEventListener('blur', () => { composing = false; }, { signal: modal.abortSignal });

    // 单一确认入口：按钮 click 与 Enter 键都路由到这里。
    // audit fix (Phase L1-Settings P1)：早期 Enter 直接 modal.close('confirm')，
    // 完全绕过 validate 校验。重命名场景输入非法名（路径分隔符 / 保留设备名）
    // 按 Enter → dialog 静默关闭 → IPC 拒、用户 typed text 丢失、错误只通过
    // 通用 toast 模糊暴露。现在 validate 失败时显示行内红字并保持打开，
    // 与按钮 click 走完全同一条路径。
    tryConfirm = () => {
      // 客户端预校验（Round 11 vol.2）：返回 null/undefined = 通过；
      // 返回字符串 = 错误消息（dialog 保持打开）。
      if (typeof validate === 'function') {
        let errMsg = null;
        try {
          errMsg = validate(inputEl.value);
        } catch (e) {
          // validate 自身抛错 → 当成错误消息展示（不静默吞）
          errMsg = (e && typeof e.message === 'string' && e.message) || '输入校验失败';
        }
        if (errMsg) {
          showError(errMsg);
          // input 焦点留在原位（用户改完再确认）
          try { inputEl.focus({ preventScroll: true }); } catch { /* ignore */ }
          return;
        }
        clearError();
      }
      modal.close('confirm');
    };

    // Enter 提交（焦点在 input 内时）；与 form submit 等价但更直接。
    // 守卫 e.isComposing + composing flag：拼音 / 日语 IME 用 Enter 确认候选词时不应触发提交。
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing && !composing) {
        e.preventDefault();
        tryConfirm();
      }
    }, { signal: modal.abortSignal });

    // 打开时全选默认文字（模仿 window.prompt() 行为）。
    // focus-trap 内部已用 queueMicrotask 调 focus，我们在它之后排一个 microtask 即可。
    if (selectAllOnOpen && defaultValue) {
      queueMicrotask(() => {
        try { inputEl.select(); } catch { /* input 已不在 DOM */ }
      });
    }
  });
}