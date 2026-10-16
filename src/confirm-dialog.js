// 通用确认对话框
// 复用 .modal-overlay / .modal / .btn-primary / .btn-secondary 样式（src/styles.css）。
//
// 用于：
//   - 切换文件前的「未保存改动」提示
//   - 外部修改冲突时的「保留我的 / 使用外部」选择
//   - 未来扩展（删除 / 重命名等）
//
// 返回 Promise resolve 一个按钮 value（默认 'cancel' / 'confirm'）。
// 用户按 Esc 或点击背景 → resolve('cancel')。
//
// 骨架来自 src/modal.js；这里只关心「标题 / 正文 / 按钮列表」三件事。

import { escapeHtml, escapeAttr } from './utils.js';
import { mountModal } from './modal.js';
// audit fix (Phase L2 #7)：modal 被另一个对话框占位时给用户 toast，避免
// 重要冲突（未保存改动 / 外部修改）静默 cancel 后用户误以为已生效。
import { showToast } from './feedback.js';

/**
 * 预置图标 SVG（与设置对话框 .settings-section-icon 同语言：24×24 viewBox,
 * stroke-based, 1.8px stroke-width）。调用方传 icon 名字即可，不必内联 SVG。
 *
 * - warning：警告三角 —— 未保存改动 / 放弃前提醒
 * - danger：圆形 × —— 删除 / 不可逆操作
 * - conflict：双向箭头 —— 外部修改冲突
 * - info：圆形 i —— 一般信息提示
 */
const CONFIRM_ICONS = {
  warning: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M12 3L2 21h20L12 3z"/>
    <line x1="12" y1="10" x2="12" y2="14"/>
    <circle cx="12" cy="17.5" r="0.5" fill="currentColor" stroke="none"/>
  </svg>`,
  danger: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9"/>
    <line x1="8" y1="8" x2="16" y2="16"/>
    <line x1="16" y1="8" x2="8" y2="16"/>
  </svg>`,
  conflict: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9"/>
    <polyline points="16 10 16 6 12 6"/>
    <polyline points="8 14 8 18 12 18"/>
    <line x1="16" y1="6" x2="18" y2="8"/>
    <line x1="8" y1="18" x2="6" y2="16"/>
  </svg>`,
  info: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9"/>
    <line x1="12" y1="11" x2="12" y2="17"/>
    <circle cx="12" cy="7.5" r="0.5" fill="currentColor" stroke="none"/>
  </svg>`,
};

/**
 * 显示一个确认对话框
 * @param {object} options
 * @param {string} options.title - 标题
 * @param {string} options.message - 正文（支持简单 HTML，会被 escape）
 * @param {Array<{value:string,label:string,variant?:'primary'|'secondary'|'danger'}>} options.buttons - 按钮列表；最后一个按钮 = 默认焦点
 * @param {'warning'|'danger'|'conflict'|'info'|string} [options.icon] - 预置图标名或自定义 SVG 字符串；不传则不显示图标
 * @returns {Promise<string|null>} 被点击按钮的 value；用户取消（Esc / 点击背景 / 关闭按钮）时返回 'cancel'；
 *          modal 已被另一个对话框占用（无法打开）时返回 null（同时弹 toast 提示用户）
 */
// 按钮 variant 白名单 —— 防 audit A10：调用方若误传 'foo' 等非法值，
// 之前会得到 `btn btn-foo`，CSS 没这个类，按钮变成无样式的纯文本。
const BUTTON_VARIANTS = new Set(['primary', 'secondary', 'danger']);

export function showConfirmDialog({ title, message, buttons = [], icon }) {
  return new Promise((resolve) => {
    const footerHtml = buttons.map((b) => {
      const variant = BUTTON_VARIANTS.has(b.variant)
        ? b.variant
        : (b.value === 'cancel' ? 'secondary' : 'primary');
      return `<button class="btn btn-${variant}" type="button" data-action="${escapeAttr(b.value)}">${escapeHtml(b.label)}</button>`;
    }).join('');

    // 图标区域：预置名 → 取内置 SVG；自定义 SVG 字符串 → 直接用；无 → 不渲染。
    // icon 颜色由 CSS 的 .confirm-icon-wrap 变体控制（warning 走 --warning, danger 走 --danger）。
    const iconSvg = icon ? (CONFIRM_ICONS[icon] || icon) : '';
    // iconVariant 用于 CSS 着色：预置名直接传，自定义 SVG 默认走 'info'。
    const iconVariant = icon ? (CONFIRM_ICONS[icon] ? icon : 'info') : '';
    const iconHtml = iconSvg
      ? `<div class="confirm-icon-wrap confirm-icon-${escapeAttr(iconVariant)}">${iconSvg}</div>`
      : '';

    const bodyHtml = `${iconHtml}<p class="confirm-message">${escapeHtml(message)}</p>`;

    const modal = mountModal({
      title,
      body: bodyHtml,
      footer: footerHtml,
      onAction: () => {
        // 任一按钮按下：返回 'close' 由 mountModal 统一负责关闭
        // —— 自己不调 modal.close，避免与 modal.js 的 close(action) 重复触发
        return 'close';
      },
      onBackdropClose: 'cancel',
    });

    // 给 confirm 类型 modal 加专属 class —— CSS 用来收窄宽度（confirm 文案短，
    // 不需要 settings dialog 的 560px）、调整 body padding 与 icon 布局。
    if (modal) modal.modal.classList.add('modal--confirm');

    if (!modal) {
      // P1-3：modal 已被另一个对话框占用（罕见但会发生，比如用户在设置对话框
      // 开着时按 Ctrl+S）。旧实现降级到 window.confirm —— 但 confirm 是浏览器
      // 原生模态，会与现有 custom modal 同屏出现：用户先关掉原生框，custom
      // modal 还浮在上面，体验割裂。
      // 这里改为「静默 cancel」：把决定权交还给调用方，由它决定是排队重试还是
      // 干脆放弃（settings dialog 的 preUpdateHook 就是这么用的）。
      //
      // audit fix (Phase L2 #7)：但「重要冲突」场景（未保存改动、外部修改冲突）
      // 静默 cancel 等于丢数据 —— 用户看到「啥都没发生」，可能误以为已保存。
      // 给一个 toast 提示用户「先关闭占用方」，与 settings-dialog 的行为对齐。
      //
      // fix(audit 2026-08)：原版与「用户主动取消」都返回 'cancel'，导致调用方
      // （app.js 外部修改冲突）把 modal-occupied 误识别为用户主动选择「暂不处理」
      // → 静默推进 lastSavedMtimeMs → 后续外部修改被吞。改为返回 null，让调用方
      // 能区分「对话框没出来」与「用户主动取消」。
      showToast('已有对话框打开，请先关闭后再试', 'warning');
      resolve(null);
      return;
    }

    modal.setOnClose(resolve);
  });
}
