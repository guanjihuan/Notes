// Vitest 配置（Stage 7）
//
// 设计：
//   - 测试目录：tests/unit/** （按模块名就近放：stats / editor-theme / modal / ...）
//   - 默认环境：node（最快；config-store / stats / editor-theme 这些纯函数）
//   - 标记 // @vitest-environment jsdom 的文件用 jsdom（modal / file-ops 涉及 DOM）
//   - 不跑 tests/_fixtures/ 之类的辅助文件 —— glob 只覆盖 *.test.js

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.js'],
    // 默认 node 环境；需要 DOM 的文件用 /* @vitest-environment jsdom */ 标记
    environment: 'node',
    // 测试结束清掉临时文件
    clearMocks: true,
  },
});