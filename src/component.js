// 可销毁组件的样板（AbortController mixin）
//
// 之前大部分 class（FileList / MarkdownViewer / Toolbar / EditorToolbar / ContextMenu）
// 在构造函数里直接 `element.addEventListener(...)` 挂 listener，却没有统一的
// dispose 路径。结果：
//   - 单例组件销毁时无法 unbind，listener 持有闭包 → GC 不掉
//   - 测试 / HMR 场景下，组件替换时旧 listener 仍触发回调
//   - listener 多起来后还得手动写 `this._abort()` / `removeEventListener`，无样板
//
// 这个文件提供一个一次性 AbortController + 在 signal 上挂 listener 的薄封装：
//
//   class FileList {
//     constructor(opts) {
//       const disposable = createDisposable(this);
//       this.disposable = disposable;       // 暴露 signal（必要时给外部用）
//       this.addEventListener = disposable.addEventListener;
//       this.dispose = disposable.dispose;
//       element.addEventListener('click', (e) => ..., { signal: disposable.signal });
//     }
//   }
//
// 调用 `instance.dispose()` 一次性 abort 所有挂在这个 signal 上的 listener。

/**
 * @typedef {object} Disposable
 * @property {AbortSignal} signal - 给 addEventListener({ signal }) 用
 * @property {typeof HTMLElement.prototype.addEventListener} addEventListener
 *   包装版 addEventListener，自动挂 signal。等价于手动传 { signal: this.signal }。
 * @property {(fn: () => void) => void} addAbort - 注册 abort 时一次性执行的清理逻辑
 * @property {() => void} dispose - 触发 abort + 标记 disposed；幂等
 * @property {boolean} isDisposed - 当前是否已 dispose
 */

/**
 * 给目标对象（通常是一个 class 实例）添加可销毁 listener 能力。
 * 注意：本函数不会修改 target 的原型链 —— 只挂你需要的属性。调用方决定挂哪些。
 *
 * @param {object} [target] - 用来挂 mixin 属性的对象（默认返回独立对象）
 * @returns {Disposable}
 */
export function createDisposable(target = {}) {
  const controller = new AbortController();
  let disposed = false;

  /**
   * 包装 addEventListener：默认注入当前 signal，省略 opts 时等价于
   * `{ signal: controller.signal, capture: false, passive: false }`。
   * 注意：opts 里有 signal 时以调用方为准（允许覆盖，例如与其它组件共享 signal）。
   */
  function addEventListener(elementOrTarget, type, handler, opts) {
    if (!elementOrTarget || typeof elementOrTarget.addEventListener !== 'function') {
      throw new TypeError('addEventListener: target 不支持 addEventListener');
    }
    const merged = mergeOptsWithSignal(opts, controller.signal);
    elementOrTarget.addEventListener(type, handler, merged);
  }

  function addAbort(fn) {
    if (typeof fn !== 'function') return;
    if (controller.signal.aborted) {
      // 已经 abort 了，立即同步执行（与 AbortSignal 的「后注册的 abort listener 同步触发」语义一致）
      try { fn(); } catch { /* ignore */ }
      return;
    }
    controller.signal.addEventListener('abort', () => {
      try { fn(); } catch { /* ignore */ }
    }, { once: true });
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    controller.abort();
  }

  target.signal = controller.signal;
  target.addEventListener = addEventListener;
  target.addAbort = addAbort;
  target.dispose = dispose;
  // audit fix (renderer-M12)：原本无脑用 Object.defineProperty 覆盖 isDisposed，
  // 子类如果有自己的 isDisposed getter/setter（如 lifecycle tracking）会被悄悄
  // 顶掉 —— mixin 的不变量没保证。先看 target 自身是否已声明 isDisposed，
  // 有就让宿主定义胜出（已有 own / 显式 prototype 定义都跳）；只在完全没
  // 这个属性时才注入 mixin 的 getter。
  if (!Object.prototype.hasOwnProperty.call(target, 'isDisposed')
      && !Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), 'isDisposed')) {
    Object.defineProperty(target, 'isDisposed', {
      get() { return disposed; },
      enumerable: true,
    });
  }

  return /** @type {Disposable} */ (target);
}

/**
 * 把 signal 合并到 opts 里。
 *   - opts === undefined       → { signal }
 *   - opts 已有 signal          → 不动（调用方说了算）
 *   - opts 是 AddEventListenerOptions 对象（boolean 是 capture）→ 扩展为对象
 *
 * @param {AddEventListenerOptions|boolean|undefined} opts
 * @param {AbortSignal} signal
 * @returns {AddEventListenerOptions|boolean}
 */
function mergeOptsWithSignal(opts, signal) {
  if (opts === undefined || opts === null) {
    return { signal };
  }
  if (typeof opts === 'boolean') {
    // 旧 API：opts = useCapture。signal 在 capture 阶段拦截意义不大，但语义上没问题。
    return { capture: opts, signal };
  }
  if (typeof opts === 'object' && 'signal' in opts) {
    return opts;
  }
  return { ...opts, signal };
}
