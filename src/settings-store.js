// 设置存储
// 封装主进程 IPC 的 getSettings / saveSettings，提供本地缓存和 change 事件订阅。
//
// 持久化由主进程负责（userData/config.json），这里只做内存缓存 + 同步广播。
//
// 关键能力（Stage 7 增强）：
//   - preUpdateHook：写主进程前可拦截；返回 false 取消（用于「未保存改动时改 dataDir」之类场景）
//   - 单调 token：并发的 update 调用，后到的响应不会覆盖后到的状态（audit #9）

import { EventEmitter } from './event-emitter.js';

// schema 经 preload 的 contextBridge 过桥，不能直接 import
// shared/settings-schema.js —— 那是 CommonJS，而 renderer 是 Chromium
// 原生 ESM（nodeIntegration:false），没有 CJS 互操作，import 会让整个应用起不来。
// preload 先于 renderer 模块求值，所以这里在顶层取值是安全的。
const DEFAULT_SETTINGS = (typeof window !== 'undefined'
  && window.api?.settingsSchema?.DEFAULT_SETTINGS) || {};

/**
 * 归一化设置对象。桥不可用时退化为「默认值 + 已知键覆盖」。
 * @param {*} raw
 */
function coerceLoadedSettings(raw) {
  if (typeof window !== 'undefined' && typeof window.api?.coerceLoadedSettings === 'function') {
    return window.api.coerceLoadedSettings(raw);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_SETTINGS };
  const out = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (key in raw) out[key] = raw[key];
  }
  return out;
}

export class SettingsStore extends EventEmitter {
  /**
   * @param {object} api - window.api（由 preload 注入的 contextBridge API）
   */
  constructor(api) {
    super();
    this.api = api;
    this._settings = { ...DEFAULT_SETTINGS };
    this._loaded = false;
    // preUpdateHook: (partial, currentSettings) => boolean | Promise<boolean>
    // 返回 false 取消 update（不会写入内存，也不会触发 IPC）。
    // 用于 app.js 在 dataDir 变更时先检查编辑器是否有未保存改动（audit #1）。
    this._preUpdateHook = null;
    // 单调递增 token：每次 update 自增；响应回来时只接受 token 匹配的写入。
    // 防止「A 提交 → B 提交 → B 响应先到 → A 响应后到覆盖 B 的状态」（audit #9）。
    this._updateToken = 0;
  }

  /**
   * 注册 preUpdateHook。同一时刻只允许一个 hook；后注册的覆盖前者。
   * hook 抛错视作「拒绝更新」。
   * @param {(partial: object, current: object) => boolean | Promise<boolean>} hook
   */
  setPreUpdateHook(hook) {
    this._preUpdateHook = typeof hook === 'function' ? hook : null;
  }

  /**
   * 取当前注册的 preUpdateHook。返回函数或 null。
   * 供需要在临时覆盖前先备份、用完再恢复的场景（例如 app.js 的 settings 对话框
   * 临时挂一个 dataDir 脏检查的 hook，关闭后还原）。
   */
  getPreUpdateHook() {
    return this._preUpdateHook;
  }

  /**
   * 从主进程拉取设置到内存
   */
  async load() {
    if (!this.api || typeof this.api.getSettings !== 'function') {
      console.warn('[settings-store] window.api.getSettings 不可用，使用默认值');
      this._settings = { ...DEFAULT_SETTINGS };
      this._loaded = true;
      this.emit('change', { settings: this._settings });
      return this._settings;
    }
    try {
      const remote = await this.api.getSettings();
      this._settings = coerceLoadedSettings(remote);
    } catch (e) {
      console.error('[settings-store] load 失败:', e);
      this._settings = { ...DEFAULT_SETTINGS };
    }
    this._loaded = true;
    this.emit('change', { settings: this._settings });
    return this._settings;
  }

  /**
   * 读取单个设置
   */
  get(key) {
    return this._settings[key];
  }

  /**
   * 读取所有设置
   */
  getAll() {
    return { ...this._settings };
  }

  /**
   * 部分更新设置（异步写入主进程）
   *
   * 策略：乐观更新 —— 先在本地应用，立刻 emit 'change' 通知监听者；
   * 然后异步写主进程。**失败时回滚到写入前的值并再 emit 一次 'change'**，
   * 否则界面会停留在一个磁盘上并不存在的状态（比如显示着一个校验失败的 dataDir）。
   *
   * 并发安全：每次 update 取一个单调递增 token；响应回来时若 token 已被新调用顶掉，
   * 直接丢弃响应（不在本地应用），避免后到的旧响应覆盖新状态（audit #9）。
   *
   * @param {object} partial
   * @returns {Promise<object>} 持久化后的完整设置
   * @throws {Error} 主进程校验失败（例如 dataDir 不存在）、IPC 异常、或 preUpdateHook 拒绝
   */
  async update(partial) {
    if (!partial || typeof partial !== 'object') return this._settings;

    // preUpdateHook 拦截（audit #1）
    if (this._preUpdateHook) {
      let proceed = true;
      try {
        proceed = await this._preUpdateHook(partial, this._settings);
      } catch (e) {
        console.error('[settings-store] preUpdateHook 抛错:', e);
        proceed = false;
      }
      if (!proceed) {
        throw new Error('SETTINGS_UPDATE_CANCELLED');
      }
    }

    // 取 token；并发的 update 会拿到不同 token，旧的 IPC 响应会被丢弃
    const myToken = ++this._updateToken;

    // 立刻在本地应用（乐观更新）。
    // L3 fix (audit)：屏蔽 aiApiKey —— 真实值仍通过 api.saveSettings 发给主进程，
    // 但 _settings 缓存不存真值。主进程 echo 的 settings 也是脱敏后的（aiApiKey=''），
    // 写盘后 getAll() 也只返回 ''。这样乐观窗口期内（IPC 飞行中）任何 read path
    // （getAll / emit 的 settings）都拿不到真值。
    // L9 fix (audit)：emit 的 `changes` payload 也 redact aiApiKey —— 之前
    // partial.aiApiKey 是明文发出去的，虽然当前唯一监听器 syncBehaviorPrefsUI
    // 只读 theme/font 等无关字段，但防御性 redact 让「将来新增监听器不会
    // 因为忘了过滤而拿到真值」。'***' 而不是 ''，保留「字段被改过」的语义
    // （partial.aiApiKey === '' 不一定代表用户清空 Key，也可能是 reveal 后又改）。
    const before = { ...this._settings };
    const cachedPartial = { ...partial };
    const emitChanges = { ...partial };
    if ('aiApiKey' in cachedPartial) {
      cachedPartial.aiApiKey = ''; // 不缓存真值
      emitChanges.aiApiKey = '***'; // 通知监听器「Key 字段有变」但不暴露值
    }
    this._settings = { ...this._settings, ...cachedPartial };
    this.emit('change', { settings: this._settings, changes: emitChanges, previous: before });

    if (!this.api || typeof this.api.saveSettings !== 'function') {
      return this._settings;
    }

    const rollback = (reason) => {
      // 只有当我们仍是「最新调用」时才回滚；否则让新调用的状态保留
      if (myToken !== this._updateToken) return;
      const failed = { ...this._settings };
      this._settings = before;
      // audit fix (H2-settings)：原 emit 用 `changes: before`，那是「写之前」的
      // 旧值快照，下游若按正常语义解读会把旧值当成新变更去应用。回滚的语义
      // 应当是「刚才那批 partial 提交失败、状态已退回」—— changes 给 partial
      // （试图落盘但失败的内容），previous 给 failed（被撤回的中间态），并附
      // rolledBack=true + reason 让监听器按异常路径分支处理。
      //
      // Phase N 修复：redact aiApiKey —— partial 里可能含用户刚输入的真值 Key。
      // emitChanges 已用 '***' 占位（L9 fix），这里同样把 partial 的 aiApiKey 抹掉，
      // 防止监听器从 changes payload 里拿回真值。
      const emitChanges = { ...partial };
      if ('aiApiKey' in emitChanges) emitChanges.aiApiKey = '***';
      this.emit('change', {
        settings: this._settings,
        changes: emitChanges,
        previous: failed,
        rolledBack: true,
        reason,
      });
    };

    let res;
    try {
      res = await this.api.saveSettings(partial);
    } catch (e) {
      console.error('[settings-store] update IPC 异常:', e);
      rollback(e?.message);
      throw e;
    }

    // 响应已过时：被新调用顶掉了；直接丢弃（不应用也不回滚，新调用有自己的 before）
    if (myToken !== this._updateToken) {
      return this._settings;
    }

    // 主进程返回 { ok:false, error } 表示校验失败（如目录不存在）
    if (res && res.ok === false) {
      const message = res.error || '保存设置失败';
      rollback(message);
      throw new Error(message);
    }

    // 当前协议：{ ok:true, settings }
    if (res && res.settings && typeof res.settings === 'object') {
      this._settings = coerceLoadedSettings(res.settings);
    }
    return this._settings;
  }

  /**
   * 是否已从主进程加载
   */
  isLoaded() {
    return this._loaded;
  }
}
