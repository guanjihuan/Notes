// ESLint flat config
// 两个 block：
//   1. main / preload / scripts/ —— Node CJS 环境（require / module / process / __dirname）
//   2. src/ —— 浏览器 ESM 环境（无 Node globals；importmap 暴露的 codemirror / @codemirror/* 是 ESM 模块，
//                              不是 globals，不写进 globals 表）
//
// 规则严格度按"项目当前状态可一键通过"为基线：recommended + 关键 hygiene，不强制风格化（prettier 不上）。

const js = require('@eslint/js');

module.exports = [
  // eslint.config.js 自身：Node CJS
  {
    files: ['eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
      },
    },
  },
  // 全局忽略
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      '.playwright-mcp/**',
      'scripts/_dbg-*.png',
      'tmp-*.mjs',     // 临时验证脚本
      'scripts/**/*.mjs', // 一次性 ad-hoc debug 脚本（playwright / repro 等），不是生产代码
      'src/styles/**', // Stage 4 之后才有
      'tests/**',      // 测试文件用 vitest globals（describe/it/expect/vi），
                       // 由 vitest.config.js 负责；不需要 ESLint 强校验。
    ],
  },

  // Block 1: Node CJS —— main / preload / scripts / shared
  {
    files: [
      'main.js',
      'main/**/*.js',
      'preload.js',
      'scripts/**/*.js',
      'shared/**/*.js',
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        // Node
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        module: 'readonly',
        require: 'readonly',
        exports: 'writable',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        // Electron（main/preload 直接 require 进来的）
        app: 'readonly',
        BrowserWindow: 'readonly',
        ipcMain: 'readonly',
        ipcRenderer: 'readonly',
        contextBridge: 'readonly',
        Menu: 'readonly',
        Tray: 'readonly',
        dialog: 'readonly',
        shell: 'readonly',
        screen: 'readonly',
        nativeImage: 'readonly',
        globalShortcut: 'readonly',
        // preload 在 Electron sandbox 下能引用 window（与 renderer 的隔离 window 不同）
        window: 'readonly',
        document: 'readonly',
        // Node 18+ 内置 Web API（main/ai.js 用 fetch + AbortController）
        fetch: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-async-promise-executor': 'off', // preload 有 await in new Promise 的合法用法
    },
  },

  // Block 2: renderer ESM —— src/**
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        // Browser
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        location: 'readonly',
        history: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        IntersectionObserver: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        getComputedStyle: 'readonly',
        queueMicrotask: 'readonly',
        MutationObserver: 'readonly',
        crypto: 'readonly',
        Element: 'readonly',
        HTMLElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLTextAreaElement: 'readonly',
        Event: 'readonly',
        CustomEvent: 'readonly',
        KeyboardEvent: 'readonly',
        MouseEvent: 'readonly',
        DOMParser: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        Blob: 'readonly',
        File: 'readonly',
        FileReader: 'readonly',
        Promise: 'readonly',
        Map: 'readonly',
        Set: 'readonly',
        WeakMap: 'readonly',
        WeakSet: 'readonly',
        Date: 'readonly',
        Math: 'readonly',
        JSON: 'readonly',
        Number: 'readonly',
        String: 'readonly',
        Array: 'readonly',
        Object: 'readonly',
        Error: 'readonly',
        TypeError: 'readonly',
        RangeError: 'readonly',
        Symbol: 'readonly',
        Proxy: 'readonly',
        Reflect: 'readonly',
        parseInt: 'readonly',
        parseFloat: 'readonly',
        isNaN: 'readonly',
        isFinite: 'readonly',
        encodeURIComponent: 'readonly',
        decodeURIComponent: 'readonly',
        // CodeMirror 是 ESM 模块，通过 importmap 解析 —— 不属于 globals
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  // 全局规则调整（适用于两个 block）
  {
    rules: {
      'no-undef': 'error', // 强制：renderer 不能用 process.*
      'no-prototype-builtins': 'off', // 旧代码里有 obj.hasOwnProperty(...) 调用
    },
  },
];
