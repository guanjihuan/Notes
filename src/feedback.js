// 轻量反馈组件
// 仅保留 toast —— Notes 是只读阅读器，不需要 confirmDialog / inputDialog / contextMenu。

const TOAST_DEFAULT_DURATION = 3000;
// 同时存在的 toast 上限 —— 超出时关闭最早创建的，避免极端情况下无限堆积占满 DOM。
const MAX_VISIBLE_TOASTS = 5;

/**
 * 显示一个 toast 消息
 * @param {string} message - 消息内容
 * @param {'info'|'success'|'warning'|'error'} [type='info']
 * @param {number} [duration=3000] - 自动关闭毫秒数；0 表示不自动关闭
 */
export function showToast(message, type = 'info', duration = TOAST_DEFAULT_DURATION) {
  const container = document.getElementById('toast-container');
  if (!container) {
    // 无 toast container 是早期启动或测试环境（#toast-container 还没挂上），
    // 静默丢弃 —— 这里原本的 console.log 会在生产控制台产生噪声，没人在读。
    return;
  }

  // 超出上限时立刻同步移除最早的 toast（不等淡出动画）—— 顶部满的时候底部瞬间
  // 消失一条是可接受的，比排队等淡出再插队让用户以为 toast 卡住了要直观。
  // 同时打上 dismissed 标记，避免它自身的自动关闭 timer / click handler
  // 在 toast 已脱离 DOM 后还跑回调（虽然 parentElement 检查能拦住，但
  // dataset 检查短路更稳，少一次 console 输出）。
  while (container.children.length >= MAX_VISIBLE_TOASTS) {
    const oldest = container.firstElementChild;
    if (!oldest) break;
    if (oldest.parentElement === container) {
      oldest.dataset.dismissed = '1';
      container.removeChild(oldest);
    }
  }

  const toast = document.createElement('div');
  toast.className = `toast is-${type}`;
  toast.setAttribute('role', 'status');
  toast.textContent = message;

  container.appendChild(toast);

  let timer = null;
  if (duration > 0) {
    timer = setTimeout(() => dismiss(), duration);
  }

  // 点击立即关闭
  toast.addEventListener('click', () => dismiss());

  function dismiss() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    // 防止 transition 重入：若已经在淡出中，直接返回
    if (toast.dataset.dismissed === '1') return;
    toast.dataset.dismissed = '1';
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-4px)';
    toast.style.transition = 'opacity 150ms ease, transform 150ms ease';
    setTimeout(() => {
      if (toast.parentElement === container) {
        container.removeChild(toast);
      }
    }, 150);
  }
}
