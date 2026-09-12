# Notes

桌面端 Markdown 阅读与编辑器。读取指定文件夹里的 `.md` 文件，可就地编辑保存。

![tests](https://img.shields.io/badge/tests-642%2F28%20passing-brightgreen) ![Electron](https://img.shields.io/badge/Electron-44-47848F) ![Node](https://img.shields.io/badge/node-%3E%3D20.18-339933) ![MIT](https://img.shields.io/badge/license-MIT-blue)

## 简介

- **文件即真相**：界面显示什么，磁盘上就是什么。
- **保存由你决定**：默认 `Ctrl + S` 手动保存；工具栏可一键开启自动保存。
- **完全本地**：所有文件就在你电脑上的指定文件夹里，复制走就是备份。
- **AI 可选**：内置修改助手，支持 OpenAI / Anthropic 兼容协议，不启用则永不联网。

## 快速开始

```bash
npm install
npm start
```

要求 Node ≥ 20.18（见 `.nvmrc`）。首次启动会在用户主目录创建 `Notes` 文件夹，把 `.md` 文件放进去即可在左侧栏看到。

> **Windows + 中文路径**：Electron 在含中文路径下启动会报错。两种解决：
> 1. 把项目移到纯 ASCII 路径，如 `D:\Projects\notes`
> 2. 用管理员 cmd 建符号链接：`mklink /D C:\dev\notes "C:\path\to\中文路径\Notes"`，在 `C:\dev\notes` 跑 `npm install && npm start`

## 命令

```bash
npm start              # 启动（UTF-8 包装，推荐；中文 Windows 别用 start:raw）
npm test               # 全部单测（642 用例 / 28 文件）
npm run test:watch     # watch 模式
npm run check          # 语法 + IPC 通道配对
npm run lint           # ESLint
npm run build:win      # Windows → dist/（NSIS 安装包）
npm run build:mac      # macOS   → dist/
npm run build:linux    # Linux   → dist/（AppImage）
```

## 功能

### 阅读与编辑

- 侧栏文件列表，按文件名实时过滤（`Ctrl + F`）
- 三种视图：预览 / 编辑 / 双栏（`Ctrl + E` 循环切换）
- 暗 / 亮主题 × 5 套配色（默认 / 海洋 / 森林 / 薰衣草 / 夕阳），正交可选
- 工具栏一键窗口置顶
- 链接智能处理：外链走系统浏览器；同目录 `.md` 相对链接在 Notes 内打开；`#标题` 锚点文内跳转
- 相对路径图片（`![](img/a.png)`）直接渲染
- 状态栏实时高亮当前阅读章节
- 聚焦模式隐藏工具栏 / 侧栏 / 状态栏（`Ctrl + Shift + F`）
- 系统托盘：关闭窗口保留托盘图标，单击恢复
- 右键菜单：阅读视图复制 / 全选；编辑器复制 / 剪切 / 粘贴 / 全选

### 数据安全

- 外部修改自动检测：其他编辑器改了文件会提示重新加载（IME 合成期间不打断）
- 退出保护：有未保存改动时关闭窗口 / 退出托盘都会先问「保存 / 丢弃 / 取消」
- 原子写盘（`tmp + rename`），断电不留半截文件
- 数据目录自动回退：当前目录不可用（U 盘拔了 / 网盘断连）时自动切回默认目录
- 监听对云同步盘（OneDrive / 坚果云等）也可靠

### AI 修改

- 工具栏唤起底部对话面板
- 双协议：OpenAI 兼容（`/chat/completions`）与 Anthropic 兼容（`/v1/messages`）
- 行级 + 词级 diff 高亮，可逐 region 应用或一键应用全部
- 提交后可随时取消，状态干净复位

## 设置

`Ctrl + ,` 打开设置对话框。

**数据** — 数据文件夹：留空用默认 `~/Notes`；切换时旧目录失效会自动回退

**外观** — 配色 5 套 × 2 主题；阅读字号 14/15/17/19/22；阅读行距 1.5/1.7/1.85/2.0

**行为** — 文件列表排序（名称 / 修改时间）；自动保存（编辑停下 500 ms 后落盘）

**AI** — 服务提供方 / Base URL / API Key（明文存本机 `settings.json`，UI 默认脱敏）/ 模型 / 系统提示（留空用内置中文 Markdown 助手 prompt）

主题 / 置顶 / 视图模式在工具栏有独立按钮，**同一功能只保留一个入口**。

## 快捷键

| 快捷键 | 作用 |
|---|---|
| `Ctrl/Cmd + N` | 新建笔记 |
| `Ctrl/Cmd + F` | 聚焦文件搜索（编辑器内改为 CM6 查找） |
| `Ctrl/Cmd + S` | 保存（IME 合成中拒绝物理写盘） |
| `Ctrl/Cmd + E` | 切换视图模式（预览 → 编辑 → 双栏） |
| `Ctrl/Cmd + ,` | 打开设置 |
| `Ctrl/Cmd + R` | 重新加载界面（脏状态会先确认） |
| `Ctrl/Cmd + Shift + T` | 切换主题 |
| `Ctrl/Cmd + Shift + F` | 切换聚焦模式 |
| `Ctrl/Cmd + Shift + A` | 切换 AI 面板 |
| `Esc`（搜索框内） | 清空搜索 |
| `F12` | 打开 DevTools |

窗口为无边框（自绘标题栏），Windows / Linux 上看不到菜单栏，但上表快捷键全部直接可用。

## 数据文件夹

| 平台 | 默认路径 |
|---|---|
| Windows | `C:\Users\<你>\Notes` |
| macOS | `~/Notes` |
| Linux | `$HOME/Notes` |

可在设置里改成任意目录。**所有文件就在这里** —— 复制走就是备份。

## 项目结构

```
Notes/
├── main.js              # Electron 主进程
├── main/                # 主进程模块（ai、file-ops、fs-watcher、config-store）
├── preload.js           # IPC bridge
├── index.html           # UI 框架 + CSP + importmap
├── src/                 # 渲染端（ai/ 面板、styles/ CSS 分片）
├── shared/              # 主进程 / preload / 渲染端共享
├── data/welcome.md      # 首次启动种子文件
├── scripts/             # 启动包装（launch.js）+ 静态检查（check-syntax / check-ipc）
└── tests/
    ├── unit/            # 28 个测试文件，642 用例（vitest）
    └── manual/          # 手工视觉验证产物（不进版本库）
```

## 故障排除

**文件列表不更新**
- 检查设置里的数据目录
- 某些云同步盘的 `fs.watch` 不可靠，已加轮询 + watchdog 自愈
- `Ctrl + R` 手动重新加载（脏状态会先确认）

**控制台中文乱码** — 用 `npm start`，别用 `start:raw`

**AI 提示"无法连接到服务"**
- 检查 Base URL：OpenAI 兼容需含 `/v1`，Anthropic 不含
- 核对 API Key（点"显示"露出明文）
- `F12` → console 看完整错误码（参考 `shared/ai-errors.js`）

**启动报错**
- 路径含中文（仅 Windows）→ 见上文"快速开始"
- Node 版本低于 20.18：`nvm use`（仓库根目录有 `.nvmrc`）
- `F12` → console 看渲染进程堆栈

## License

MIT
