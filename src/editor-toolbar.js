// 视图模式切换控件
// 三态：preview（默认）/ edit / split
// 状态写 document.body.dataset.editorMode，CSS 据此切布局。

export const EDITOR_MODES = ['preview', 'edit', 'split'];

export class EditorToolbar {
  /**
   * @param {object} options
   * @param {object} options.elements - 三个按钮元素引用 { btnPreview, btnEdit, btnSplit }
   * @param {(mode:'preview'|'edit'|'split') => void} options.onChange - 模式变化回调
   */
  constructor({ elements, onChange }) {
    this.elements = elements;
    this.onChange = onChange;
    // 模式锁：临时把视图锁在某个模式（null = 不锁）。用于「AI 修复预览
    // 出现时强制编辑」等场景 —— setMode / selectMode / cycle 都会落到锁定值，
    // 用户点 toolbar / 状态栏 chip / Ctrl+E 切不到其它模式。
    this._modeLock = null;

    if (elements.btnPreview) {
      elements.btnPreview.addEventListener('click', () => this.selectMode('preview'));
    }
    if (elements.btnEdit) {
      elements.btnEdit.addEventListener('click', () => this.selectMode('edit'));
    }
    if (elements.btnSplit) {
      elements.btnSplit.addEventListener('click', () => this.selectMode('split'));
    }
  }

  /**
   * 临时锁定视图模式。锁定后任何切换（按钮 / cycle / 外部 setMode）都会被吸到该模式。
   * 传 null 解除锁定。锁定值必须为合法模式，否则忽略。
   *
   * 配合 applyEditorMode 使用：调用方先 setModeLock 再 applyEditorMode(锁定值)，
   * DOM / state 一起落到目标模式；解除时 setModeLock(null) 后 applyEditorMode(state.editorMode)
   * 走正常的 md/non-md 禁用逻辑。
   *
   * @param {'preview'|'edit'|'split'|null} mode
   */
  setModeLock(mode) {
    if (mode === null) {
      this._modeLock = null;
      return;
    }
    if (!EDITOR_MODES.includes(mode)) return;
    this._modeLock = mode;
  }

  /**
   * 由用户点击按钮或外部 API 主动选择模式。触发 onChange（用于持久化）。
   * @param {'preview'|'edit'|'split'} mode
   */
  selectMode(mode) {
    if (!EDITOR_MODES.includes(mode)) return;
    // 模式锁：拒绝一切「切到非锁定模式」的请求（按钮 / Ctrl+E / 状态栏 chip 都走这里）
    if (this._modeLock !== null && mode !== this._modeLock) return;
    if (this.getMode() === mode) return; // 同模式 → 不重复触发
    this._setDOM(mode);
    if (this.onChange) this.onChange(mode);
  }

  /**
   * 同步 DOM 与按钮高亮，但**不**触发 onChange。
   * 用于「外部（持久化设置）改变了模式」的场景，避免循环。
   *
   * 模式锁生效时，setMode 会被吸到锁定值 —— 这是关键：applyEditorMode 被外部调用
   * （比如 AI 修复预览打开时其它地方误触发 applyEditorMode('preview')）也会被纠正回锁定模式。
   * @param {'preview'|'edit'|'split'} mode
   */
  setMode(mode) {
    if (!EDITOR_MODES.includes(mode)) return;
    const target = this._modeLock !== null ? this._modeLock : mode;
    this._setDOM(target);
  }

  /**
   * 取当前模式（从 dataset 读，保证跟 DOM 一致）
   */
  getMode() {
    return document.body.dataset.editorMode || 'preview';
  }

  /**
   * 三态循环：preview → edit → split → preview
   * 触发 onChange 回调。
   *
   * 模式锁生效时，cycle 不切模式（仅做一次 DOM 对齐，防御 lock 期间其它路径改了 dataset）。
   */
  cycle() {
    if (this._modeLock !== null) {
      if (this.getMode() !== this._modeLock) {
        this._setDOM(this._modeLock);
      }
      return;
    }
    const cur = this.getMode();
    const idx = EDITOR_MODES.indexOf(cur);
    const next = EDITOR_MODES[(idx + 1) % EDITOR_MODES.length];
    this.selectMode(next);
  }

  _setDOM(mode) {
    document.body.dataset.editorMode = mode;
    const map = {
      preview: this.elements.btnPreview,
      edit: this.elements.btnEdit,
      split: this.elements.btnSplit,
    };
    Object.entries(map).forEach(([k, btn]) => {
      if (!btn) return;
      const active = k === mode;
      btn.classList.toggle('is-active', active);
      // 让屏幕阅读器/键盘用户也能感知当前模式；icon-only 按钮尤其依赖此属性
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }
}
