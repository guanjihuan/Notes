// 工具栏组件
// 绑定主题切换 / 置顶 / 设置 / 窗口控件按钮的事件。
//
// 与 Todo List 的 toolbar.js 区别：去掉了「添加 todo」+ 搜索框 + 视图切换，
// 只留下窗口控制 + 应用级开关。

export class Toolbar {
  /**
   * @param {object} options
   * @param {object} options.elements - 按钮元素引用
   * @param {() => void} options.onThemeClick
   * @param {() => void} options.onPinClick
   * @param {() => void} options.onSettingsClick
   * @param {() => void} options.onResetLayoutClick
   * @param {() => void} options.onMinimize
   * @param {() => void} options.onToggleMaximize
   * @param {() => void} options.onClose
   */
  constructor({ elements, onThemeClick, onPinClick, onSettingsClick, onResetLayoutClick, onMinimize, onToggleMaximize, onClose }) {
    this.elements = elements;

    if (elements.btnTheme && onThemeClick) {
      elements.btnTheme.addEventListener('click', onThemeClick);
    }
    if (elements.btnPin && onPinClick) {
      elements.btnPin.addEventListener('click', onPinClick);
    }
    if (elements.btnSettings && onSettingsClick) {
      elements.btnSettings.addEventListener('click', onSettingsClick);
    }
    if (elements.btnResetLayout && onResetLayoutClick) {
      elements.btnResetLayout.addEventListener('click', onResetLayoutClick);
    }
    if (elements.btnMin && onMinimize) {
      elements.btnMin.addEventListener('click', onMinimize);
    }
    if (elements.btnMax && onToggleMaximize) {
      elements.btnMax.addEventListener('click', onToggleMaximize);
    }
    if (elements.btnClose && onClose) {
      elements.btnClose.addEventListener('click', onClose);
    }
  }
}
