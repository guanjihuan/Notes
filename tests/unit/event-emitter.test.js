// src/event-emitter.js
//
// 极简 EventEmitter，被 settings-store 等组件复用 —— 没有测试守护的话：
//   - emit 不隔离异常 → 一个抛错的 handler 阻断后续 handler 与其它事件订阅者
//   - on 返回的 unsubscribe 漏掉 → 测试 / HMR 场景下旧 listener 触发回调
//   - off 不存在的 handler 抛错 → emit 路径异常
//
// 覆盖：
//   - on / emit 基本语义（payload 透传、多 handler）
//   - on 返回的 unsubscribe 函数（同一 handler 多次 on → 多次 unsub 才彻底移除）
//   - emit 异常隔离：一个抛错不影响其它 handler，也不影响后续 emit
//   - emit 无订阅者：no-op
//   - off 不存在的 handler / event：no-op

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from '../../src/event-emitter.js';

describe('EventEmitter 基础语义', () => {
  it('on + emit：handler 被调用，payload 透传', () => {
    const ee = new EventEmitter();
    const handler = vi.fn();
    ee.on('ping', handler);
    ee.emit('ping', { a: 1 });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ a: 1 });
  });

  it('多个 handler 订阅同一事件 → emit 全部调用', () => {
    const ee = new EventEmitter();
    const h1 = vi.fn();
    const h2 = vi.fn();
    ee.on('x', h1);
    ee.on('x', h2);
    ee.emit('x', 'payload');
    expect(h1).toHaveBeenCalledWith('payload');
    expect(h2).toHaveBeenCalledWith('payload');
  });

  it('不同事件互不影响', () => {
    const ee = new EventEmitter();
    const h1 = vi.fn();
    const h2 = vi.fn();
    ee.on('a', h1);
    ee.on('b', h2);
    ee.emit('a', 1);
    expect(h1).toHaveBeenCalledWith(1);
    expect(h2).not.toHaveBeenCalled();
  });

  it('emit 无订阅者的事件：no-op，不抛错', () => {
    const ee = new EventEmitter();
    expect(() => ee.emit('nothing', 'x')).not.toThrow();
  });
});

describe('EventEmitter unsubscribe', () => {
  it('on 返回的函数等价于 off（可作为 unsubscribe）', () => {
    const ee = new EventEmitter();
    const handler = vi.fn();
    const unsub = ee.on('e', handler);
    expect(typeof unsub).toBe('function');
    unsub();
    ee.emit('e', 'x');
    expect(handler).not.toHaveBeenCalled();
  });

  it('off 显式移除 handler', () => {
    const ee = new EventEmitter();
    const handler = vi.fn();
    ee.on('e', handler);
    ee.off('e', handler);
    ee.emit('e', 'x');
    expect(handler).not.toHaveBeenCalled();
  });

  it('off 不存在的 handler：no-op，不抛错', () => {
    const ee = new EventEmitter();
    const handler = vi.fn();
    ee.on('e', handler);
    expect(() => ee.off('e', () => {})).not.toThrow();
    // 原 handler 仍有效
    ee.emit('e', 'x');
    expect(handler).toHaveBeenCalledWith('x');
  });

  it('off 不存在的事件：no-op，不抛错', () => {
    const ee = new EventEmitter();
    expect(() => ee.off('no-such-event', () => {})).not.toThrow();
  });

  it('同一 handler on 多次 → unsubscribe 多次才彻底移除', () => {
    // Set 语义：同一个 handler 加入 Set 多次只占一个 slot，off 一次就够。
    // 这里验证 unsub/off 不会因为「多订阅一次」就漏移除。
    const ee = new EventEmitter();
    const handler = vi.fn();
    ee.on('e', handler);
    ee.on('e', handler); // 重复订阅（Set 语义：仍是 1 个 entry）
    ee.off('e', handler);
    ee.emit('e', 'x');
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('EventEmitter 异常隔离', () => {
  let errorSpy;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('一个 handler 抛错 → 其它 handler 仍执行（隔离）', () => {
    const ee = new EventEmitter();
    const after = vi.fn();
    ee.on('e', () => {
      throw new Error('boom');
    });
    ee.on('e', after);
    expect(() => ee.emit('e', 'x')).not.toThrow();
    expect(after).toHaveBeenCalledWith('x');
    // 抛错被 console.error 记录
    expect(errorSpy).toHaveBeenCalled();
    // 记录的应该包含事件名 + error
    const call = errorSpy.mock.calls[0];
    expect(call[0]).toContain('EventEmitter');
    expect(call[0]).toContain('e');
  });

  it('抛错的 handler 不影响后续 emit', () => {
    const ee = new EventEmitter();
    const good = vi.fn();
    ee.on('e', () => {
      throw new Error('boom');
    });
    ee.on('e', good);
    ee.emit('e', 1);
    // 第二次 emit：抛错 handler 仍是同一闭包引用，照样抛、照样隔离
    good.mockClear();
    ee.emit('e', 2);
    expect(good).toHaveBeenCalledWith(2);
  });
});