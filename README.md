# Notes

本地优先的 Markdown 阅读 / 编辑工具。`.md` 文件即笔记，文件即数据 —— 看到和磁盘上一字不差，复制走就是备份。

![tests](https://img.shields.io/badge/tests-1217%2F59%20passing-brightgreen) ![Electron](https://img.shields.io/badge/Electron-44-47848F) ![Node](https://img.shields.io/badge/node-%3E%3D20.18-339933) ![MIT](https://img.shields.io/badge/license-MIT-blue)

## 特点

- 所见即所得 —— 保存时原样写回，不会重排 Markdown 格式
- 默认离线 —— 不配 AI 就永不联网；API Key 走系统密钥库（Windows DPAPI / macOS Keychain / Linux libsecret）
- 桌面级体验 —— CodeMirror 6 编辑器 + 实时预览双栏，键盘快捷键齐全
- 抗意外 —— 原子写盘、外部修改检测、退出保护，断电不留半截
- 托盘常驻 —— 关窗不等于退出，单击托盘图标恢复

## 5 分钟上手

需要 Node.js 20.18 或更高（[下载](https://nodejs.org/)）。

```bash
git clone <仓库地址> notes
cd notes
npm install
npm start
```

首次启动会在主目录创建 `Notes` 文件夹（Windows 是 `C:\Users\<你>\Notes`，macOS / Linux 是 `~/Notes`），并把欢迎页复制进去。把任意 `.md` 文件丢进那个文件夹，左侧栏立刻出现。

按 `Ctrl + ,` 打开设置。工具栏已经有「主题 / 视图 / 自动保存」等按钮，设置里不会出现重复入口。

## 阅读与编辑

- `Ctrl + E` 在「预览 / 编辑 / 双栏」之间循环
- `Ctrl + F` 按文件名实时过滤侧栏
- `Ctrl + N` 新建笔记，`Ctrl + S` 保存（IME 拼音合成中不会误触发），`Ctrl + W` 关闭当前文件
- `Ctrl + Shift + F` 聚焦模式 —— 隐藏工具栏 / 侧栏 / 状态栏，纯净阅读
- 状态栏实时显示当前章节标题
- 外链走系统浏览器；同目录 `.md` 相对链接在 Notes 内打开；`#标题` 锚点文内跳转
- `![](img/a.png)` 相对路径图片直接渲染

## AI 改稿

`Ctrl + Shift + A` 打开底部 AI 面板。输入你想怎么改（润色 / 翻译 / 总结 / 续写），AI 给出行级 + 词级 diff，逐段应用或一键应用全部，不满意随时取消。

| 协议 | 适用服务 | Base URL 要点 |
|---|---|---|
| OpenAI 兼容 | OpenAI / DeepSeek / Moonshot / 自部署 | 必须含 `/v1` |
| Anthropic 兼容 | Claude 系列 / 第三方中转 | 不含 `/v1` |

API Key 默认脱敏显示，点眼睛图标露出明文。不配 AI 不影响其它功能。

## 整理侧栏

- **拖到文件夹上 = 移动**。拖拽时按住 `Ctrl`（macOS 是 `Cmd`）= 复制，文件夹会递归复制，软链接会被跳过
- 侧栏聚焦时：`Ctrl + X` 剪切，`Ctrl + C` 复制，`Ctrl + V` 粘贴到当前正在浏览的目录
- 右键菜单功能同上。**侧栏空白区域右键也能粘贴**到当前目录（剪贴板为空时该菜单项禁用）
- 目标文件夹已有同名项时自动加 `(2)` / `(3)` ... 改名避免覆盖
- 不能把文件夹拖进自己或子孙目录（会被拦下）

## 数据安全

- **API Key 加密** —— 写盘前加密，运行时主进程栈上才解出明文
- **外部修改检测** —— 其他编辑器改了文件会提示重新加载（正在打字时不打断）
- **退出保护** —— 有未保存改动关窗 / 退托盘，先问「保存 / 丢弃 / 取消」
- **原子写盘** —— 写到临时文件再 rename
- **数据目录自动回退** —— U 盘拔了 / 网盘断连自动切回默认目录
- **云盘友好** —— OneDrive / 坚果云 / iCloud 做过专门适配

## 数据文件夹

| 系统 | 默认路径 |
|---|---|
| Windows | `C:\Users\<你>\Notes` |
| macOS | `~/Notes` |
| Linux | `$HOME/Notes` |

设置里可以改成任意目录。状态栏最左段（紧贴当前路径）有三个 icon-only 按钮：打开、切换、回到默认。

## 快捷键

> Mac 把 `Ctrl` 换成 `Cmd`，下表通用。

| 快捷键 | 作用 |
|---|---|
| `Ctrl + F` | 聚焦文件搜索 |
| `Ctrl + N` | 新建笔记 |
| `Ctrl + S` | 保存（IME 合成中不触发写盘）|
| `Ctrl + W` | 关闭当前文件 |
| `Ctrl + E` | 预览 / 编辑 / 双栏切换 |
| `Ctrl + Shift + F` | 切换聚焦模式 |
| `Ctrl + Shift + T` | 切换主题 |
| `Ctrl + Shift + A` | 切换 AI 面板 |
| `Ctrl + ,` | 打开设置 |
| `Ctrl + R` | 重新加载界面 |
| `Ctrl + X / C / V` | 剪切 / 复制 / 粘贴（侧栏聚焦时）|
| `Esc`（搜索框内）| 清空搜索 |
| `F12` | 打开 DevTools |

窗口是无边框自绘标题栏，Windows / Linux 上看不到菜单栏，但上表所有快捷键全部生效。

## 常见问题

**搜索文件没反应？**
看设置里的「数据文件夹」对不对。某些云盘实时监听不可靠，按 `Ctrl + R` 手动刷新。

**AI 提示「无法连接到服务」？**
OpenAI 兼容协议 Base URL 必须含 `/v1`，Anthropic 不含。点眼睛图标露出 API Key 明文，确认没多余空格 / 换行。按 `F12` 看完整错误码。

**中文 Windows 启动报错？**
Electron 在中文路径下启动会报错。两种办法：

1. 推荐：把项目挪到纯英文路径，如 `D:\Projects\notes`
2. 用管理员 cmd 建符号链接：
   ```cmd
   mklink /D C:\dev\notes "C:\当前\中文路径\Notes"
   ```
   然后在 `C:\dev\notes` 跑 `npm install && npm start`

**控制台中文乱码？**
用 `npm start`，别用 `npm run start:raw`。前者自动把控制台切到 UTF-8。

**笔记文件会被改动吗？**
不会。读什么就显示什么，保存时原样写回 —— 不会偷偷重排 Markdown 格式。

**怎么更新到新版本？**
```bash
git pull
npm install
npm start
```
你的 `~/Notes` 笔记文件夹完全独立，更新代码不影响数据。

## 给开发者

```bash
npm start            # 启动（自动处理中文 Windows 编码）
npm test             # 全部单测（1217 用例 / 59 文件）
npm run test:watch   # watch 模式
npm run check        # 语法 + IPC 通道配对
npm run lint         # ESLint
npm run build:win    # 打包 Windows 安装包 → dist/
npm run build:mac    # 打包 macOS → dist/
npm run build:linux  # 打包 Linux AppImage → dist/
```

```
Notes/
├── main.js              # Electron 主进程入口
├── preload.js           # IPC 桥（contextBridge）
├── index.html           # UI 框架 + CSP + importmap
├── main/                # 主进程：ai / config-store / file-ops / fs-watcher / secret-store
├── src/                 # 渲染端：UI 组件 + CSS 分片（01-12）+ AI 面板
├── shared/              # 主 / preload / 渲染端共享：schema / diff / sanitize
├── data/                # 首次启动种子化的欢迎页（1 篇）
├── scripts/             # 启动包装 / 语法检查 / IPC 校验
└── tests/
    ├── unit/            # vitest 单测（59 文件 / 1217 用例）
    └── manual/          # 手工视觉验证产物（不进版本库）
```

## License

MIT
