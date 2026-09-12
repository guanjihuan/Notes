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
   * 由用户点击按钮或外部 API 主动选择模式。触发 onChange（用于持久化）。
   * @param {'preview'|'edit'|'split'} mode
   */
  selectMode(mode) {
    if (!EDITOR_MODES.includes(mode)) return;
    if (this.getMode() === mode) return; // 同模式 → 不重复触发
    this._setDOM(mode);
    if (this.onChange) this.onChange(mode);
  }

  /**
   * 同步 DOM 与按钮高亮，但**不**触发 onChange。
   * 用于「外部（持久化设置）改变了模式」的场景，避免循环。
   * @param {'preview'|'edit'|'split'} mode
   */
  setMode(mode) {
    if (!EDITOR_MODES.includes(mode)) return;
    this._setDOM(mode);
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
   */
  cycle() {
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
