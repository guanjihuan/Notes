// 极简 EventEmitter
// SettingsStore 等组件需要的事件订阅基础设施。
// 与 Todo List 的实现保持完全一致 —— 不引入任何外部依赖。

export class EventEmitter {
  constructor() {
    this._handlers = new Map();
  }

  on(event, handler) {
    if (!this._handlers.has(event)) {
      this._handlers.set(event, new Set());
    }
    this._handlers.get(event).add(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    const set = this._handlers.get(event);
    if (set) set.delete(handler);
  }

  emit(event, payload) {
    const set = this._handlers.get(event);
    if (!set || set.size === 0) return;
    // audit fix (Settings P3 / event-emitter snapshot)：派发时先对 Set
    // 拍一份快照。Set 在迭代期间的修改语义：
    //   - 新增的 handler：会被访问（ECMA-262 Set 规范）。
    //   - 删除的 handler（如果已访问过）：不影响本次迭代。
    //   - 删除当前正在访问的 handler：行为未定义 / 跨引擎不一致。
    // 一个 handler 内部再去 on/off 同名事件就会触发上面第三条：
    //   - 副作用"重订阅"导致本次 emit 又派发给新 handler（新 handler 收到
    //     上一轮事件，常见 bug）。
    //   - 副作用"自 off"导致部分 handler 被跳过。
    //   - handler 抛错后被 catch 但后续 handler 仍需正常执行 —— 这条原来 OK。
    // 拍快照后所有路径确定性，跨 V8 / JSC / SpiderMonkey 行为一致。
    // 性能：O(n) copy，对 settingsStore 等小规模事件总线无可观测开销。
    const snapshot = Array.from(set);
    for (const h of snapshot) {
      // 二次校验：handler 在前面的执行里可能 off 自己（snapshot 拿到时还在
      // set 里，但下面那次循环已 off），跳过避免重复派发。
      if (!set.has(h)) continue;
      try {
        h(payload);
      } catch (e) {
        console.error(`[EventEmitter] handler for "${event}" threw:`, e);
      }
    }
  }
}
