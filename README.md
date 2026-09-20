# Notes

本地优先的 Markdown 阅读与编辑工具。界面看到的和磁盘上的 `.md` 文件一模一样 —— 复制走就是备份。

![tests](https://img.shields.io/badge/tests-947%2F34%20passing-brightgreen) ![Electron](https://img.shields.io/badge/Electron-44-47848F) ![Node](https://img.shields.io/badge/node-%3E%3D20.18-339933) ![MIT](https://img.shields.io/badge/license-MIT-blue)

## 它是什么

Notes 把一个文件夹变成笔记本。`.md` 文件就是笔记，**文件即数据**，没有数据库也没有专有格式。内置 CodeMirror 6 编辑器，`Ctrl + S` 落盘，也可开启自动保存。

8 套配色（default / ocean / forest / sunset / rose / amber / slate / mono），暗 / 亮各一版，字号行距可调。不联网也能用 —— AI 是可选插件，**不配置就永不联网**。

---

## 5 分钟上手

需要 [Node.js 20.18 或更高](https://nodejs.org/)。

```bash
git clone <仓库地址> notes
cd notes
npm install
npm start
```

首次启动会在用户主目录创建 `Notes` 文件夹（Windows 是 `C:\Users\<你>\Notes`，macOS / Linux 是 `~/Notes`），并把欢迎页等 4 篇引导文档复制进去。把任意 `.md` 文件拖进那个文件夹，左侧栏立刻显示。

按 `Ctrl + ,` 打开设置。主题 / 置顶 / 视图模式 / 自动保存在工具栏有独立按钮，**设置里不会出现重复入口**。

---

## 日常使用

### 阅读与编辑

- `Ctrl + E` 在「预览 → 编辑 → 双栏」之间循环
- `Ctrl + F` 侧栏搜索框按文件名实时过滤
- `Ctrl + S` 保存，`Ctrl + N` 新建笔记，`Ctrl + W` 关闭当前文件
- `Ctrl + Shift + F` 聚焦模式，隐藏工具栏 / 侧栏 / 状态栏，纯净阅读
- 状态栏实时显示当前阅读到的章节标题
- 链接分流：外链走系统浏览器；同目录 `.md` 相对链接在 Notes 内打开；`#标题` 锚点文内跳转
- 相对路径图片（`![](img/a.png)`）直接渲染

### AI 修改

`Ctrl + Shift + A` 打开底部 AI 面板。描述你想怎么改（润色 / 翻译 / 总结 / 续写），AI 给出行级 + 词级 diff，可逐段应用或一键应用全部，不满意随时取消。

协议选择：

| 选项 | 适用服务 | Base URL 末尾 |
|---|---|---|
| OpenAI 兼容 | OpenAI / DeepSeek / Moonshot / Azure / 自部署 | 必须含 `/v1` |
| Anthropic 兼容 | Claude 系列 / 第三方中转 | 不含 `/v1` |

API Key 默认脱敏显示，点眼睛图标露出明文。**不配也不影响其它功能**。

---

## 数据安全

- **外部修改检测** —— 其他编辑器改了文件会提示重新加载（正在打字时不打断）
- **退出保护** —— 有未保存改动就关窗 / 退托盘，会先问「保存 / 丢弃 / 取消」
- **原子写盘** —— 断电也不会留下半截文件
- **数据目录自动回退** —— U 盘拔了 / 网盘断连时自动切回默认目录
- **云同步盘友好** —— OneDrive / 坚果云 / iCloud 都做过专门适配
- **关窗 ≠ 退出** —— 应用缩到系统托盘，单击恢复，右键看菜单

---

## 数据文件夹

| 系统 | 默认路径 |
|---|---|
| Windows | `C:\Users\<你>\Notes` |
| macOS | `~/Notes` |
| Linux | `$HOME/Notes` |

可在设置里改成任意目录。状态栏左段（紧贴当前路径）有三个 icon-only 按钮：打开、切换、回到默认。

---

## 快捷键速查

| 快捷键 | 作用 |
|---|---|
| `Ctrl/Cmd + F` | 聚焦文件搜索 |
| `Ctrl/Cmd + N` | 新建笔记 |
| `Ctrl/Cmd + S` | 保存（IME 合成中不触发写盘） |
| `Ctrl/Cmd + W` | 关闭当前文件 |
| `Ctrl/Cmd + E` | 切换视图模式 |
| `Ctrl/Cmd + ,` | 打开设置 |
| `Ctrl/Cmd + R` | 重新加载界面 |
| `Ctrl/Cmd + Shift + T` | 切换主题 |
| `Ctrl/Cmd + Shift + F` | 切换聚焦模式 |
| `Ctrl/Cmd + Shift + A` | 切换 AI 面板 |
| `Esc`（搜索框内） | 清空搜索 |
| `F12` | 打开 DevTools |

窗口是无边框自绘标题栏，**Windows / Linux 上看不到菜单栏**，但上表所有快捷键全部生效。

---

## 常见问题

**搜索文件没反应？**
检查设置里的「数据文件夹」是不是对的。某些云盘的实时监听不可靠，按 `Ctrl + R` 手动刷新。

**AI 提示「无法连接到服务」？**
核对 Base URL：OpenAI 兼容需含 `/v1`，Anthropic 不含。点眼睛图标露出 API Key 明文，确认没多余空格。按 `F12` 看完整错误码。

**中文 Windows 启动报错？**
Electron 在中文路径下启动会报错。两种办法：

1. 把项目挪到纯英文路径（推荐），如 `D:\Projects\notes`
2. 用管理员 cmd 建符号链接：
   ```cmd
   mklink /D C:\dev\notes "C:\当前\中文路径\Notes"
   ```
   然后在 `C:\dev\notes` 跑 `npm install && npm start`

**控制台中文乱码？**
用 `npm start`，**不要用 `npm run start:raw`**。前者会自动把控制台切到 UTF-8。

**笔记文件会被改动吗？**
不会。读什么就显示什么，保存时原样写回 —— **不会偷偷重排 Markdown 格式**。

---

## 给开发者

```bash
npm start              # 启动（推荐，自动处理中文 Windows 编码）
npm test               # 全部单测（947 用例 / 34 文件）
npm run test:watch     # watch 模式
npm run check          # 语法 + IPC 通道配对
npm run lint           # ESLint
npm run build:win      # 打包 Windows 安装包 → dist/
npm run build:mac      # 打包 macOS → dist/
npm run build:linux    # 打包 Linux AppImage → dist/
```

```
Notes/
├── main.js              # Electron 主进程入口
├── preload.js           # IPC 桥（contextBridge）
├── index.html           # UI 框架 + CSP + importmap
├── main/                # 主进程模块：ai / config-store / file-ops / fs-watcher
├── src/                 # 渲染端：UI 组件 + CSS 分片 + AI 面板
├── shared/              # 主 / preload / 渲染端共享：schema / diff / 错误码
├── data/                # 首次启动种子化的引导文档（4 篇）
├── scripts/             # 启动包装 + 静态检查
└── tests/
    ├── unit/            # vitest 单测（34 个文件，947 用例）
    └── manual/          # 手工视觉验证产物（不进版本库）
```

---

## License

MIT
