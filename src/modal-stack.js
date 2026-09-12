// 模态栈（最小版：单槽冲突拒绝）
//
// 现象：
//   settingsDialog 与 confirmDialog 都把 DOM 挂到同一个 #modal-root，
//   用 root.replaceChildren(overlay) 覆盖写入。一个还没关就被另一个顶掉，
//   原来 await 的 Promise 永远不会 resolve —— 整条交互挂死。
//
// 策略（用户已选）：
//   已有对话框时拒绝新开（不排队、不顶替），调用方自行处理 toast。
//
// 接口：
//   isOpen()                       → boolean
//   register(overlay)              → void；当前 overlay 入栈
//   unregister(overlay)            → void；从栈中移除
//
// 设计上保持简单：不监听 DOM，避免和 dialog 自己的 dispose 顺序打架。
// 调用方负责 register(open) / unregister(close) 的配对。
//
// 注：早期版本还有 tryReject() / openOrReject() —— 返回 {ok, reason} 让调用方
// 决定是否 toast。该模式与「isOpen + 早返回 + 自己 toast」相比无收益（前者要
// 调用方再分支），实际零调用方，已删。

let currentOverlay = null;

export function isOpen() {
  return currentOverlay !== null && currentOverlay.isConnected;
}

export function register(overlay) {
  // audit fix：拒收非 DOM 元素 / null / undefined / 字符串等。旧版不校验，
  // 任何传错都会让 isOpen() 在 currentOverlay.isConnected 处抛 TypeError，
  // 把「当前是否有模态」这个 hot-path 探测点炸掉，进而影响 IPC 回复路径。
  if (!(overlay instanceof Element)) {
    throw new TypeError('modal-stack.register: overlay 必须是 DOM Element');
  }
  currentOverlay = overlay;
}

export function unregister(overlay) {
  // audit fix：idempotent —— 不匹配时也清掉已断连的引用。否则：overlay A 被
  // 外部 .remove() 后没调 unregister，再 register(B) → currentOverlay=B。
  // 之后某个调试路径 unregister(A)（按旧引用传）会发现不等、什么都不做，
  // 但 B 的 unregister(B) 仍能把 currentOverlay 清成 null —— 这里其实
  // 没问题。真正问题是：A 没调 unregister 又被外部断连，下次 isOpen() 走
  // isConnected 检查返回 false，UI 显示「无模态」但栈里仍持有 dead ref，
  // 调试时 dump 出来是误导的。
  if (currentOverlay === overlay) {
    currentOverlay = null;
    return;
  }
  // 不匹配：若 currentOverlay 已不连到 DOM（外部 .remove()），顺手清掉。
  if (currentOverlay && !currentOverlay.isConnected) {
    currentOverlay = null;
  }
}