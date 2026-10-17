// 文件操作层（Stage 4c 抽离）
//
// 渲染端文件 CRUD：创建、重命名、删除、显示。
// 全部走 IPC 调用主进程，结果落到 toast / state / 当前视图上。
//
// 设计：
//   - 接收上下文对象（state / controls / api / callbacks），不直接 import app.js
//   - 通过 createFileOps(ctx) factory 暴露，避免任何模块级副作用
//   - 公开 API 仅 showFileListContextMenu / createNewFile；其他函数仅内部互调
//
// 边界：
//   - 不读 currentFile / isDirty 等 state 字段之外的全局
//   - 不调 updateWindowTitle / syncSaveButton 等 UI 同步函数以外的回调
//     （完整名单见 ctx.callbacks）

// 文件系统 errno → 中文友好提示：Round 4 收尾后抽离到 shared/friendly-fs-error.js，
// preload 暴露成 window.api.friendlyFsError。本文件内部 + 测试都走这一份，
// 不再各自维护 mapping —— 避免 EROFS / ENAMETOOLONG / ENOTDIR / ENOTEMPTY 文案
// 漂移。本文件调用点直接用 window.api.friendlyFsError(...)。

import { showToast } from './feedback.js';
import { showPromptDialog } from './prompt-dialog.js';
import { showConfirmDialog } from './confirm-dialog.js';
import { isMarkdownFile, basenameOf } from './utils.js';
// 救援工具：与 src/app.js 共享同一份命名 / toast / friendlyFsError 逻辑，
// 这里只关心「我有 content、想救回」。详见 src/rescue.js 注释。
import { rescueDirtyContent } from './rescue.js';
// 审计修复 (Round 11 deep-fix P1-1)：create / delete / rename 三个回调的入口
// 在读 state.isDirty 之前必须先 syncDirtyFromEditor —— 否则 CJK 用户在 IME
// 合成期调「新建 / 删除 / 重命名」时，state.isDirty 是 stale false，跳过
// dirty 确认 → 直接销毁用户当前编辑的内容。app.js save() / openFile() /
// 关窗已经走这个路径（详见 src/dirty-sync.js 注释）；file-ops 这一层之前漏了。
import { syncDirtyFromEditor } from './dirty-sync.js';

// 审计修复 (Round 11 vol.2)：客户端文件名预校验。
//
// 镜像 main/file-ops.js resolveRenameName / resolveFileName 的「输入合法性」检查
// （路径分隔符 / Windows 保留字符 / 保留设备名 / 控制字符 / 非空）。
// 不镜像 main 的「存在性 + 自动避让」逻辑 —— 那是 IPC 端的事，rename/create 都
// 走 main 协商，不在 renderer 重复实现。
//
// 为什么不共享同一份代码：main 是 CJS（require('fs') + path.join 路径协商），
// renderer 是 ESM 且不能 require Node 模块。共享会带来上下文桥 / bundle 复杂度。
// 退而求其次：把这条规则文档化在 main + 本注释，变更时手工同步 —— 改动频次极低
// （Windows 保留设备名清单基本不变），双拷贝维护成本可控。
const WIN_RESERVED_DEVICE_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/**
 * 校验输入是否可作为文件名（含扩展名或无）。返回 null = 通过；返回字符串 = 错误消息。
 * 用于 prompt-dialog 的 validate 选项，在用户点确认时立即拦截，不让非法值走到 IPC。
 *
 * @param {string} raw
 * @returns {string|null}
 */
function validateFileName(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return '文件名不能为空';
  const name = raw.trim();
  if (/[/\\]/.test(name) || name.includes('..')) return '文件名不能包含路径分隔符或 ..';
  if (/[<>:"|?*]/.test(name)) return '文件名包含 Windows 保留字符（< > : " | ? *）';
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(name)) return '文件名包含非法字符';
  // Windows 保留设备名（取最后一个 . 之前的部分判断；与 main resolveRenameName 保持一致）
  const lastDot = name.lastIndexOf('.');
  const baseForReserved = (lastDot > 0 ? name.slice(0, lastDot) : name).toUpperCase();
  if (WIN_RESERVED_DEVICE_NAMES.has(baseForReserved)) {
    return `"${baseForReserved}" 是 Windows 保留设备名，不允许作为文件名`;
  }
  return null;
}

/**
 * 校验输入是否可作为文件夹名。镜像 main resolveFolderName 的输入合法性检查。
 * 不校验「重名」—— 那是 IPC 端的事，folder:create 也走主进程协商，不在 renderer 重复实现。
 *
 * 与 validateFileName 保持一致：文件夹名**也做扩展名切割**，按基名判定保留设备名。
 * Windows 对目录同样按基名保留设备名（"CON.txt" / "AUX.abc" 都算保留，扩展名被忽略），
 * 不切割会漏掉 "CON.txt" 这类非法名（客户端校验通过却最终在主进程 / 文件系统被拒）。
 *
 * 共享注释见上方 WIN_RESERVED_DEVICE_NAMES：
 *   main 是 CJS（require('fs')），renderer 是 ESM 不能 require Node 模块；
 *   退而求其次把规则文档化在 main + renderer 两处注释，改动频次极低（Windows 保留设备名
 *   清单基本不变），双拷贝维护成本可控。
 *
 * @param {string} raw
 * @returns {string|null}
 */
function validateFolderName(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return '文件夹名不能为空';
  const name = raw.trim();
  if (/[/\\]/.test(name) || name.includes('..')) return '文件夹名不能包含路径分隔符或 ..';
  if (/[<>:"|?*]/.test(name)) return '文件夹名包含 Windows 保留字符（< > : " | ? *）';
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(name)) return '文件夹名包含非法字符';
  // Windows 对文件夹同样按「基名」判定保留设备名（"CON.txt" / "AUX.abc" 都算保留），
  // 与文件一致：取最后一个 . 之前的部分判断。不切割会漏掉 "CON.txt" 这类非法名。
  const lastDotF = name.lastIndexOf('.');
  const baseForReservedF = (lastDotF > 0 ? name.slice(0, lastDotF) : name).toUpperCase();
  if (WIN_RESERVED_DEVICE_NAMES.has(baseForReservedF)) {
    return `"${baseForReservedF}" 是 Windows 保留设备名，不允许作为文件夹名`;
  }
  return null;
}

/**
 * @typedef {object} FileOpsCtx
 * @property {object} state - 共享状态对象（含 currentFile / isDirty / lastSavedMtimeMs）
 * @property {object} controls - { fileList, viewer, editor, contextMenu }
 *   注意（P2-9）：editor 由 app.js bootstrap 延迟实例化，controls.editor 必须
 *   经 getter 运行时现取（app.js 用对象字面量 getter 提供），本模块内部
 *   一律走 getEditor()，不在构造时解构缓存。
 * @property {object} api - preload contextBridge 暴露的 window.api
 * @property {object} callbacks - { openFile, updateWindowTitle, updateStatusStats, syncSaveButton, clearCurrentFile, applyEditorMode, onFileChanged? }
 */

/**
 * @param {FileOpsCtx} ctx
 */
export function createFileOps(ctx) {
  const { state, controls, api, callbacks } = ctx;
  if (!state || !controls || !api || !callbacks) {
    throw new Error('[file-ops] ctx 必须包含 state / controls / api / callbacks');
  }
  const { contextMenu, viewer, fileList } = controls;
  // P2-9（audit C-4）：app.js 顶层不再 new MarkdownEditor（CM6 dynamic import，
  // bootstrap 里才实例化），createFileOps 在模块 eval 时 controls.editor 还是
  // null —— 不能构造时解构缓存，必须运行时现取。app.js 侧 controls 用对象
  // 字面量 getter 提供活视图（tests/unit/file-ops-lazy-editor.test.js 锁死）。
  const getEditor = () => controls.editor;
  const { openFile, updateWindowTitle, clearCurrentFile } = callbacks;

  /**
   * editor.getContent() 安全读取：editor 未实例化（null）或无该方法时回 ''。
   * 仅 bootstrap 完成前的事件路径才可能命中 null 分支，正常恒非空。
   */
  function _editorContentOrEmpty() {
    const ed = getEditor();
    return (ed && typeof ed.getContent === 'function') ? ed.getContent() : '';
  }

  /**
   * 时间戳格式化（用于「未命名-20260824-1530」这种默认文件名）。
   */
  function formatStampForName(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  }

  /**
   * 在系统文件管理器中显示条目（文件 / 文件夹 分支）。
   * - 文件（editable / binary）：走 `shell:show-item-in-folder`，通过
   *   shell.showItemInFolder 实现「打开父目录并选中文件」语义
   *   （macOS = Reveal，Win/Linux = 资源管理器选中）。
   * - 文件夹：走 `shell:open-dir`，通过 shell.openPath 直接打开目录本身
   *   —— showItemInFolder 在主进程会 stat.isFile() 校验，目录会被拒
   *   （NOT_A_FILE），用户点「在文件夹中显示」反而弹错误 toast。
   *
   * Stage 8：folder 条目仍保留该入口，期望是「用系统文件管理器打开这个目录」
   * （参见 showFileListContextMenu 注释）。
   */
  async function revealFile(file) {
    if (!file || !file.path) return;
    // 文件夹条目不能用 showItemInFolder（主进程会 stat.isFile() 校验，
    // 目录被拒 → 弹「不是一个文件」）。改走 openDir，让 shell.openPath
    // 打开目录本身（Win/linux 进 Explorer，macOS 进 Finder）。
    const isFolder = file.entryType === 'folder';
    const result = isFolder
      ? await api.openDir(file.path)
      : await api.showItemInFolder(file.path);
    if (!result || !result.ok) {
      showToast(`显示失败：${window.api.friendlyFsError(result && result.code, result && result.message)}`, 'error');
    }
  }

  /**
   * 删除文件：弹 confirm → 走 shell.trashItem → 如果是当前打开的文件则清空视图。
   * 即便 IPC 返回 FILE_NOT_FOUND，也照样清空视图（说明文件已不在数据目录里）。
   *
   * Phase 2 audit 修复 (P1 BUG #4)：删除飞行期 fs-watcher 可能先推 files:changed
   * （A 不在 entries），onFilesChanged 的 rescue 分支会把当前 dirty 内容救到
   * `<A>-rescued-<stamp>.md`（与被删的 A 内容相同），然后 clearCurrentFile —
   * 这是「删除」操作的孤儿副作用。修复：进 deleteFile 前设 state.deletingPath =
   * file.path；onFilesChanged rescue 分支遇此标记跳过 rescue。finally 清标记
   * —— 不论 IPC 成功/失败/discarded。
   */
  async function deleteFile(file) {
    if (!file || !file.path) return;
    // 审计修复 (Round 11 deep-fix P1-1)：syncDirtyFromEditor 把 editor.isDirty()
    // 真相同步到 state.isDirty，避免 IME 合成期删除当前文件时跳过 dirty 确认
    // 静默销毁内容。详见 src/dirty-sync.js + app.js#syncDirtyFromEditor。
    syncDirtyFromEditor(state, getEditor());
    const isCurrent = state.currentFile && state.currentFile.path === file.path;
    // 删除当前文件 + 有未保存改动 → 二次确认
    if (isCurrent && state.isDirty) {
      const choice = await showConfirmDialog({
        title: '删除未保存的文件',
        message: `「${file.name}」有未保存改动。删除（移至回收站）后无法恢复，确定继续？`,
        icon: 'danger',
        buttons: [
          { value: 'cancel', label: '取消', variant: 'secondary' },
          { value: 'confirm', label: '删除', variant: 'danger' },
        ],
      });
      if (choice !== 'confirm') return;
    }
    // Phase 2 audit (P1 BUG #4)：设删除守卫，挡住 fs-watcher rescue 误触发
    state.deletingPath = file.path;
    try {
      const result = await api.deleteFile(file.path);
      if (!result || !result.ok) {
        if (result && result.error === 'FILE_NOT_FOUND') {
          // 文件/文件夹已不在了（用户手动删过、外部工具删过）。dirty 状态下不能直接
          // clearCurrentFile 丢内容 —— 先救到 <base>-rescued-<stamp>.md，再清视图
          // （与 renameCurrentOrFile 的 FILE_NOT_FOUND 路径对齐）。state.deletingPath
          // 已设，挡住 onFilesChanged rescue 分支的并发救回，由本函数自己救一次。
          if (state.isDirty && state.currentFile && state.currentFile.path === file.path) {
            // 命名 / toast 文案 / 错误码 vs message 判断全部收口到 src/rescue.js。
            rescueDirtyContent({
              api,
              originalName: state.currentFile.name,
              content: _editorContentOrEmpty(),
              event: '文件已不在',
            });
          } else {
            showToast('文件已不存在', 'warning');
          }
          // 与 renameCurrentOrFile 对齐：dirty 救回 / 非脏提示后都清掉已删除文件的视图，
          // 否则会留下一个指向已删除文件的空壳视图（之前漏了 clearCurrentFile）。
          if (state.currentFile && state.currentFile.path === file.path) {
            clearCurrentFile();
          }
          return;
        } else {
          showToast(`删除失败：${window.api.friendlyFsError(result && result.code, result && result.message)}`, 'error');
          return;
        }
      }
      showToast(`已移至回收站：${file.name}`, 'success', 1500);
      if (isCurrent) {
        // 走集中清理：状态归零 + 清空 viewer/editor + 解除文件列表高亮。
        // 注意不再单独写 syncSaveButton / updateWindowTitle / updateStatusStats，
        // clearCurrentFile 内部已统一处理（并把 lastSavedMtimeMs 重置为 null，
        // 而不是这里的 0 —— 与文件被删、目录切换等其它路径行为一致）。
        clearCurrentFile();
      }
    } finally {
      // 不论成败都清守卫 —— 否则下次 fs-watcher 事件还会被误判为「正在删除」
      state.deletingPath = null;
    }
  }

  /**
   * 重命名文件：弹 prompt 让用户输入新文件名。
   * 若是当前打开的文件，同步 state.currentFile 的 path/name 以让 UI 反映。
   *
   * 用户反馈：「重命名不要自动补后缀」—— 这里显示完整文件名（含 .md）让用户
   * 自由编辑：可以改成 bar.md / bar.txt / 干脆去掉扩展名。新建文件场景也
   * 走同一思路（createNewFile 注释）：默认值直接带 .md，主进程
   * resolveFileName / resolveRenameName 都「用户输入什么就用什么」。
   */
  async function renameCurrentOrFile(file) {
    if (!file || !file.path) return;
    // 审计修复 (Round 11 deep-fix P1-1)：sync editor.isDirty() → state.isDirty。
    // rename 的 dirty 检查在 FILE_NOT_FOUND 路径下出现，IME 期间跳过会丢 IME buffer。
    syncDirtyFromEditor(state, getEditor());
    const raw = await showPromptDialog({
      title: '重命名文件',
      message: '新文件名（可改为其他扩展名）',
      defaultValue: file.name,
      confirmLabel: '重命名',
      validate: validateFileName,
    });
    if (raw == null) return;
    const newName = raw.trim();
    if (!newName) {
      showToast('文件名不能为空', 'warning');
      return;
    }
    if (newName === file.name) return;
    // Phase 2 audit 修复 (P1 BUG #3)：设重命名守卫挡住 fs-watcher race 误触发 rescue。
    // 主进程 renameWithRetry 累计 50+100+200=350ms 可能超过 fs-watcher 300ms 防抖
    // 窗口，rename IPC 还没 resolve 时 fs-watcher 先把「A 已不在 + B 已出现」推到
    // renderer，onFilesChanged 的 rescue 分支会把当前 dirty 内容救到
    // `<A>-rescued-<stamp>.md`（内容 = editor 内容 = 与重命名后的 B 完全相同）→
    // 孤儿文件。守卫：进 renameFile 前设 state.renamingPath = file.path，onFilesChanged
    // rescue 分支遇此标记 + state.currentFile.path 一致 → 跳过 rescue。
    // finally 中：先更新 state.currentFile.path，再清守卫（顺序很重要 —— 否则守卫清
    // 在 path 更新之前，fs-watcher 又来一次看到旧 path 仍会被误判为删除）。
    state.renamingPath = file.path;
    try {
    const result = await api.renameFile(file.path, newName);
    if (!result || !result.ok) {
      // 与 deleteFile 对齐：原文件已不在（被外部删过 / 同步盘撤回）→ 静默清视图，
      // 否则编辑器里仍显示"刚被改名的旧路径文件"，但磁盘上已无对应文件。
      // 这里不抛"重命名失败"的红色 toast —— 因为失败的根本原因是文件没了，不是用户
      // 输入的 newName 不合法（那种情况主进程会回 EEXIST / PATH_NOT_ALLOWED）。
      if (result && result.error === 'FILE_NOT_FOUND') {
        // Phase 2 audit 修复 (P1 BUG #5)：rename 飞行期原文件被外部删除
        // → dirty 内容不能直接 clearCurrentFile 丢。先取 editor.getContent()
        // 救到 rescue 文件，再清。复用 onFilesChanged rescue 的 createFile 模式。
        if (state.isDirty && state.currentFile && state.currentFile.path === file.path) {
          // 与文件其它 IPC 调用对齐用 ctx.api（createFile / renameFile / deleteFile
          // 都从 ctx 解构），不再直连 window.api。命名 / 写盘 / toast 收口到
          // src/rescue.js，自动处理 friendlyFsError 错误码 vs message 的语义
          // （之前这里是漏掉 `r?.message ||` 的 bug —— 用户会看到「救回失败：
          // INVALID_NAME」这种原始业务码而不是中文提示）。
          rescueDirtyContent({
            api,
            originalName: state.currentFile.name,
            content: _editorContentOrEmpty(),
            event: '原文件已被删除',
          });
        } else {
          showToast('文件已不存在', 'warning');
        }
        if (state.currentFile && state.currentFile.path === file.path) {
          clearCurrentFile();
        }
        return;
      }
      showToast(`重命名失败：${window.api.friendlyFsError(result && result.code, result && result.message)}`, 'error');
      return;
    }
    if (state.currentFile && state.currentFile.path === file.path) {
      const newMeta = {
        path: result.path,
        name: result.name,
        mtimeMs: result.mtimeMs,
        size: result.size, // P2-6：状态栏 size 也需要更新
      };
      // Phase N 修复：扩展名变化（foo.md → foo.txt）必须重算 currentFileIsMarkdown。
      // 旧实现只更新 path/name，state.currentFileIsMarkdown 保留旧值 → viewer 仍
      // 走 loadContent (markdown 渲染)、applyEditorMode 不重跑 → 工具栏 preview/split
      // 按钮仍 enabled、用户可能在 .txt 文件里看到假 markdown 渲染。
      const wasMd = state.currentFileIsMarkdown;
      const isMd = isMarkdownFile(result.path);
      state.currentFile = { ...state.currentFile, ...newMeta };
      state.currentFileIsMarkdown = isMd;
      // P2 fix：同步刷新 lastSavedMtimeMs —— fs-watcher 会因 rename 触发
      // files-changed，setFiles 之后 onFilesChanged 会比对 state.files 的
      // mtimeMs 与 lastSavedMtimeMs；如果不写后者，会被误判为「文件被外部修改」弹 rescue 提示。
      state.lastSavedMtimeMs = result.mtimeMs;
      // P2 fix：fs-watcher 触发 setFiles 时，新文件 path 还没出现在列表里
      // （旧 path 已不在），file-list 会把 activePath 清空（见 setFiles 内 onFileRemoved 分支）。
      // 主动 setActive 把高亮迁到新 path，避免「编辑器里有内容但侧栏看不到高亮」。
      if (fileList && typeof fileList.setActive === 'function') {
        try { fileList.setActive(result.path); } catch { /* 不让 setActive 异常阻断 rename 流程 */ }
      }
      // P1-5：viewer 也要同步 —— 笔记里的 <img src="./foo.png"> 是相对路径，
      // viewer 用 viewer.currentFile.path 当 baseDir，路径不变就 404。
      // setFileMeta 在 path 变化时自动重跑 resolveRelativeImages；
      // path 没变则只刷状态栏。
      viewer.setFileMeta(newMeta);
      // 扩展名在 md ↔ 非 md 之间切换：viewer 内部 DOM 仍渲染旧内容。
      // setFileMeta 只更新 metadata + 重跑相对图解析，**不**重渲染主体。
      // 需要主动调 loadContent / showUnsupportedFile 切换 viewer 主区域；
      // 再调 applyEditorMode 让工具栏按钮可用性 跟着对。
      if (wasMd !== isMd) {
        try {
          const currentContent = _editorContentOrEmpty();
          if (isMd) {
            viewer.loadContent(state.currentFile, currentContent);
          } else {
            viewer.showUnsupportedFile(state.currentFile);
          }
        } catch (e) {
          console.warn('[file-ops] rename viewer 切换失败:', e);
        }
        // applyEditorMode 会按 state.currentFileIsMarkdown 重置预览按钮 disabled、
        // setReadOnly、updateStatusMode/Stats/Scroll。
        if (typeof callbacks.applyEditorMode === 'function') {
          callbacks.applyEditorMode(state.editorMode);
        }
      }
      updateWindowTitle();
      // audit fix (Round 9)：rename 后通知 AI controller。理由同 discard_local：
      // path 变了（content 也可能因扩展名切换而被 viewer 重渲染）—— AI 的
      // pendingDiff 持有的 baseContent / forFilePath 与磁盘现状已经脱节，
      // 不通知就会触发「AI 算 diff → 用户点应用 → setExternalContent 覆盖
      // 刚保存的 rename 后内容」这条 stale apply 路径。AI controller 内部
      // 自己负责 cancel + clearPendingDiff + requestGeneration++。
      if (typeof callbacks.onFileChanged === 'function') {
        try { callbacks.onFileChanged(state.currentFile); } catch (e) {
          console.warn('[file-ops] rename 通知 AI 失败:', e);
        }
      }
    }
    showToast(`已重命名为：${result.name}`, 'success', 1500);
    } finally {
      // 顺序：先在上面把 state.currentFile.path 更新到 result.path，再清守卫。
      // 如果在这里调 state.renamingPath = null 而 state.currentFile.path 还是旧值，
      // 此时 fs-watcher 再来一次事件（很常见的二次触发）会看到 state.currentFile.path
      // (旧) !== state.renamingPath (旧) → 不命中守卫 → 走 rescue 路径。
      // 注意：本 finally 跑到这里，state.currentFile.path 已经被赋值成 result.path
      // （上面 line 197 的 state.currentFile = { ...state.currentFile, ...newMeta }），
      // 所以现在清守卫是安全的。
      state.renamingPath = null;
    }
  }

  /**
   * 「新建笔记」入口：弹 prompt 取名 → 走 createFile → 自动打开新文件。
   *
   * 2026-09 设计优化后，调用入口只剩两个：
   *   - 侧栏空白区域右键菜单的「新建文件」（src/app.js#showSidebarEmptyContextMenu）
   *   - 文件夹条目右键菜单的「在文件夹中新建文件」（showFileListContextMenu 的
   *     `new_file_in` 项，传 entry.path 作 targetDir）
   * 侧栏顶部原「+」按钮已移除；旧的「顶部 + 按钮」注释保留会让后续维护者
   * grep 不到调用点。Stage 8 把 state.currentDir 透传给 api.createFile，让新
   * 文件落在当前浏览的子目录里（而不是永远落到数据根）。
   *
   * 用户反馈（2026-08-28）：「新建笔记时直接把后缀放在文件名后面，而不是自动
   * 加上」—— 默认值已带 .md，用户可见 / 可改（直接改 .txt 等）。主进程
   * resolveFileName 也对齐 resolveRenameName：用户输入什么就用什么，
   * 不再强制补 .md / 自动加后缀。这样想建一个 .txt 纯文本笔记 / .json
   * 数据笔记时不再需要「先建 .md → 重命名成 .txt」两步。
   *
   * @param {string} [targetDir] 可选：在某个文件夹内新建时传入该文件夹绝对路径
   *   （侧栏右键文件夹 → 「在文件夹中新建文件」）。省略则落在当前浏览目录
   *   state.currentDir。prompt 文案据 targetDir 显示「当前文件夹：xxx」。
   */
  async function createNewFile(targetDir) {
    // 审计修复 (Round 11 deep-fix P1-1)：entry sync 把 editor.isDirty() 真相同步给
    // state.isDirty —— 防止 IME 合成期点「新建」时 stale-false 跳过 dirty 确认，
    // 用户的 CJK buffer 静默丢失。
    syncDirtyFromEditor(state, getEditor());
    if (state.isDirty) {
      // 给用户一个机会先保存当前文件 —— 新建会丢掉未保存改动
      const choice = await showConfirmDialog({
        title: '新建笔记',
        message: `「${state.currentFile?.name || '当前笔记'}」有未保存改动，新建后会被丢弃。`,
        icon: 'warning',
        buttons: [
          { value: 'cancel', label: '取消', variant: 'secondary' },
          { value: 'confirm', label: '丢弃并新建', variant: 'danger' },
        ],
      });
      if (choice !== 'confirm') return;
      // 用户已经确认丢弃当前改动。openFile 内部还会按 isDirty 再问一次「放弃改动 / 保存并打开」，
      // 但用户在第一步已经表态「继续新建（丢弃）」，不应该再问一遍。
      // audit fix：把 clearCurrentFile() 推迟到名字 prompt 成功 + 创建成功之后。
      // 旧顺序：先 clearCurrentFile → 弹 prompt → 用户取消 → 当前文件已经清空了，
      // 即便用户只是「改个名字」，也已经把刚才确认要丢弃的改动实际丢了，但还没真新建。
      // 新顺序：保持 isDirty / currentFile 不变直到名字 OK + createFile 成功，
      // 然后再清。如果用户在 prompt 阶段取消，编辑器内容原样保留。
    }
    const defaultName = `未命名-${formatStampForName(new Date())}.md`;
    // Stage 8：在子目录里新建时，prompt 文案补一段「当前文件夹：xxx」让用户清楚新文件落哪。
    // 根目录时维持原样。
    // 用户反馈（2026-08-28）：默认名直接带 .md 后缀（与重命名一致），用户想换成
    // .txt / .json / 其他扩展名可直接编辑；不再「自动补」。
    const breadcrumbTail = (state.breadcrumb && state.breadcrumb.length > 0)
      ? state.breadcrumb.map((s) => s.name).join('/')
      : '';
    // targetDir 非空 ⇒ 在某个文件夹内新建，提示用该文件夹名而非当前浏览路径
    const targetLabel = targetDir ? basenameOf(targetDir) : breadcrumbTail;
    const message = targetLabel
      ? `新笔记的名称（含扩展名，默认 .md）\n当前文件夹：${targetLabel}`
      : '新笔记的名称（含扩展名，默认 .md）';
    const raw = await showPromptDialog({
      title: '新建笔记',
      message,
      defaultValue: defaultName,
      confirmLabel: '创建',
      validate: validateFileName,
    });
    if (raw == null) return;
    const name = raw.trim();
    if (!name) {
      showToast('文件名不能为空', 'warning');
      return;
    }
    // 落点：targetDir 优先（右键文件夹内新建），否则当前浏览目录 state.currentDir。
    // 主进程负责 auto-mkdir（用户主动在该目录下新建）。
    const dir = targetDir || state.currentDir || '';
    const result = await api.createFile(name, { dir });
    if (!result || !result.ok) {
      showToast(`新建失败：${window.api.friendlyFsError(result && result.code, result && result.message)}`, 'error');
      return;
    }
    // 名字 prompt + IPC 都成功了才清空当前文件（覆盖上面推迟的 clearCurrentFile）
    if (state.isDirty) clearCurrentFile();
    showToast(`已创建：${result.name}`, 'success', 1500);
    // 主动打开新文件（不等 files:changed）
    await openFile({
      path: result.path,
      name: result.name,
      size: result.size,
      mtimeMs: result.mtimeMs,
    });
  }

  /**
   * 新建文件夹：弹 prompt 取名 → 走 folder:create。
   * 设计上**不自动进入**新建的空目录，保持当前视图不变（用户继续浏览原目录列表）。
   * 自动进入会让上下文跳动，且 fs-watcher 会推「新增一条」让侧栏自动出现新条目。
   *
   * 落点：state.currentDir（当前浏览目录），与 createNewFile 同源语义。
   * 默认值不带 .md / 任何后缀 —— 文件夹不要扩展名。
   *
   * @param {string} [targetDir] 可选：在某个文件夹内新建时传入该文件夹绝对路径
   *   （侧栏右键文件夹 → 「在文件夹中新建文件夹」）。省略则落在当前浏览目录。
   */
  async function createNewFolder(targetDir) {
    syncDirtyFromEditor(state, getEditor());
    if (state.isDirty) {
      const choice = await showConfirmDialog({
        title: '新建文件夹',
        message: `「${state.currentFile?.name || '当前笔记'}」有未保存改动，新建后会被丢弃。`,
        icon: 'warning',
        buttons: [
          { value: 'cancel', label: '取消', variant: 'secondary' },
          { value: 'confirm', label: '丢弃并新建', variant: 'danger' },
        ],
      });
      if (choice !== 'confirm') return;
      // 与 createNewFile 同源：在 prompt 阶段保持 dirty 文件不变，成功建完才清。
      // 若用户取消 prompt，编辑器内容原样保留。
    }
    const defaultName = `新建文件夹-${formatStampForName(new Date())}`;
    const breadcrumbTail = (state.breadcrumb && state.breadcrumb.length > 0)
      ? state.breadcrumb.map((s) => s.name).join('/')
      : '';
    // targetDir 非空 ⇒ 在某个文件夹内新建，提示用该文件夹名而非当前浏览路径
    const targetLabel = targetDir ? basenameOf(targetDir) : breadcrumbTail;
    const message = targetLabel
      ? `新文件夹的名称（不含扩展名）\n当前文件夹：${targetLabel}`
      : '新文件夹的名称（不含扩展名）';
    const raw = await showPromptDialog({
      title: '新建文件夹',
      message,
      defaultValue: defaultName,
      confirmLabel: '创建',
      validate: validateFolderName,
    });
    if (raw == null) return;
    const name = raw.trim();
    if (!name) {
      showToast('文件夹名不能为空', 'warning');
      return;
    }
    const dir = targetDir || state.currentDir || '';
    const result = await api.createFolder(name, { dir });
    if (!result || !result.ok) {
      showToast(`新建文件夹失败：${window.api.friendlyFsError(result && result.code, result && result.message)}`, 'error');
      return;
    }
    // 推迟清空当前文件 —— 与 createNewFile 同源语义（用户已经同意丢弃 → 现在建成功再清）。
    if (state.isDirty) clearCurrentFile();
    showToast(`已创建文件夹：${result.name}`, 'success', 1500);
    // 不自动进入新文件夹 —— fs-watcher 会把新条目推到侧栏，用户需要时再点。
  }

  /**
   * 重命名文件夹：弹 prompt 取新名 → 走 folder:rename。
   * 若被重命名的是当前目录或其祖先上的某一段，需要 callback 把
   * state.currentDir / fs-watcher / breadcrumb 同步到新路径。
   * 决策权交给 caller 的 `wasEntryAffectingCurrentDir` + `navigateToRelDir` 回调。
   */
  async function renameFolder(entry) {
    if (!entry || !entry.path || entry.entryType !== 'folder') return;
    syncDirtyFromEditor(state, getEditor()); // 与 file rename 对齐：IME 合成期避免 stale state
    const raw = await showPromptDialog({
      title: '重命名文件夹',
      message: '新文件夹名称（不含扩展名）',
      defaultValue: entry.name,
      confirmLabel: '重命名',
      validate: validateFolderName,
    });
    if (raw == null) return;
    const newName = raw.trim();
    if (!newName) {
      showToast('文件夹名不能为空', 'warning');
      return;
    }
    if (newName === entry.name) return;
    const result = await api.renameFolder(entry.path, newName);
    if (!result || !result.ok) {
      showToast(`重命名失败：${window.api.friendlyFsError(result && result.code, result && result.message)}`, 'error');
      return;
    }
    showToast(`已重命名为：${result.name}`, 'success', 1500);

    // 重命名影响当前路径：把 state.currentDir / currentRelDir / fs-watcher 同步过去
    const { wasEntryAffectingCurrentDir, computeCurrentRelAfterRename, navigateToRelDir } = callbacks;
    if (typeof wasEntryAffectingCurrentDir === 'function'
        && typeof computeCurrentRelAfterRename === 'function'
        && typeof navigateToRelDir === 'function') {
      if (wasEntryAffectingCurrentDir(entry.path)) {
        const newRel = computeCurrentRelAfterRename(entry.path, entry.name, result.path, result.name);
        if (newRel != null) {
          try {
            await navigateToRelDir(newRel);
          } catch (e) {
            console.warn('[file-ops] rename 后续 navigateToRelDir 失败:', e);
          }
        }
      }
    }
  }

  /**
   * 删除文件夹：弹 confirm → 走 file:delete（主进程已支持 folder 分支）。
   * 用户反馈设计："删除成功后将视图导到父级" —— 不因文件夹被删而失位。
   *
   * 复用 file:delete IPC 的 isFolder 分支：
   *   - 主进程调用 shell.trashItem（macOS / Windows 把整树挪到回收站）
   *   - 失败兜底 fs.rmdir（仅对空目录）
   *   - 返回 result.isFolder（本函数用不上 —— 不需要判断 file vs folder，调用方已知是 folder）
   *
   * 文件级 dirty 内容由 onFilesChanged 后续触发 rescue —— shell.trashItem 异步移走之后
   * fs-watcher 会推「文件已不在」，state.currentFile 被清同时 dirty 内容被 rescue。
   */
  async function deleteFolder(entry) {
    if (!entry || !entry.path || entry.entryType !== 'folder') return;
    syncDirtyFromEditor(state, getEditor());
    const choice = await showConfirmDialog({
      title: '删除文件夹',
      message: `「${entry.name}」将被移至回收站（含其全部内容）。\n\n若其中有正在编辑的笔记，未保存内容会另存为「<基名>-rescued-<时间戳>.md」。`,
      icon: 'danger',
      buttons: [
        { value: 'cancel', label: '取消', variant: 'secondary' },
        { value: 'confirm', label: '删除', variant: 'danger' },
      ],
    });
    if (choice !== 'confirm') return;

    // 记下删除前目录影响 —— 用 callback 判断被删的是否影响当前路径
    const { wasEntryAffectingCurrentDir, parentRelForRemovedEntry, navigateToRelDir } = callbacks;
    const affectCurrent = typeof wasEntryAffectingCurrentDir === 'function'
      && wasEntryAffectingCurrentDir(entry.path);

    const result = await api.deleteFile(entry.path);
    if (!result || !result.ok) {
      if (result && result.error === 'FILE_NOT_FOUND') {
        showToast('文件夹已不存在', 'warning');
      } else {
        showToast(`删除失败：${window.api.friendlyFsError(result && result.code, result && result.message)}`, 'error');
        return;
      }
    }
    showToast(`已移至回收站：${entry.name}`, 'success', 1500);

    // 被删的是当前目录或其祖先 → 导航到被删 entry 的父级
    if (affectCurrent && typeof navigateToRelDir === 'function') {
      const parentRel = typeof parentRelForRemovedEntry === 'function'
        ? parentRelForRemovedEntry(entry.path, entry.name)
        : '';
      try {
        await navigateToRelDir(parentRel);
      } catch (e) {
        console.warn('[file-ops] deleteFolder 后续 navigateToRelDir 失败:', e);
      }
    }
  }

  /**
   * 把条目（文件 / 文件夹）移动到目标目录。
   * 拖拽到文件夹、右键「剪切 → 粘贴」都走这里。
   *
   * 与 rename 的差异：move 不改扩展名、不动编辑器内容（只是换目录），
   * 所以**不需要** syncDirtyFromEditor 的脏确认（用户当前的编辑内容仍留在编辑器里）。
   *
   * 若被移动的条目是当前打开的文件（或它的某个祖先文件夹里包含打开的文件）：
   * 更新 state.currentFile 的 path/name（mirror renameCurrentOrFile 的同步分支），
   * 让侧栏高亮 / 状态栏 / 图片相对路径都跟过去。
   *
   * @param {{path:string,name:string,entryType?:string}} entry
   * @param {string} destDir 目标目录绝对路径
   */
  async function moveEntry(entry, destDir) {
    if (!entry || !entry.path || !destDir) return null;
    // 飞行守卫（rename / delete 的 renamingPath / deletingPath 同款，app.js
    // onFilesChanged 消费）：await moveFile（renameWithRetry + stat 最坏 350ms，
    // SMB/OneDrive 上更高）可能晚于 fs-watcher 的 300ms 防抖完成 —— watcher 会
    // 先推「源没了」的 files:changed。没有守卫，onFilesChanged 会把打开文件
    // 误判为「被外部删除」，触发 rescue 孤儿文件 / 清空编辑器。
    state.movingPath = entry.path;
    try {
      const result = await api.moveFile(entry.path, destDir);
      if (!result || !result.ok) {
        showToast(`移动失败：${window.api.friendlyFsError(result && result.code, result && result.message)}`, 'error');
        return result || null;
      }
      showToast(`已移动到：${result.name}`, 'success', 1500);
      // 移动涉及当前打开文件 → 同步路径 / 状态栏 / viewer 相对图解析
      // 覆盖两种情况：
      //   1) 移动的就是打开的文件本身（state.currentFile.path === entry.path）
      //   2) 移动的是打开文件的祖先文件夹（state.currentFile.path 在 entry.path 之下）——
      //      audit 修复：之前只覆盖情况 1，导致情况 2 下 state.currentFileRelDir /
      //      currentFile.path 仍指向旧位置，onFilesChanged 把"旧目录的移除事件"
      //      误判为"当前文件被删除"，触发 rescue + 写一个孤儿 .md 到根目录。
      if (state.currentFile && state.currentFile.path) {
        const cfPath = state.currentFile.path;
        if (cfPath === entry.path) {
          _applyMoveToOpenFile(result);
        } else if (result.entryType === 'folder'
            && (cfPath.startsWith(entry.path + '\\') || cfPath.startsWith(entry.path + '/'))) {
          // 祖先文件夹被移走 → 重新拼出文件新路径。remainder 以一个路径分隔符
          // 开头（'\sub\file.md' / '\file.md'）。新路径 = 被移动文件夹的**实际**
          // 新位置 result.path（重名避让时会被改名，≠ destDir + 原名）+ remainder。
          // 旧实现用 destDir + remainder，丢掉了被移动文件夹自身那一段名字 →
          // 路径整个拼错。
          const remainder = cfPath.slice(entry.path.length);
          const cut = Math.max(remainder.lastIndexOf('\\'), remainder.lastIndexOf('/'));
          const newFilePath = result.path + remainder;
          const newName = remainder.slice(cut + 1);
          // relDir 要指向**文件所在目录**：result.relDir 只是被移动文件夹的新
          // 父目录，还须拼上文件夹的新名（result.name）与文件夹内的相对目录段
          // （'\sub\file.md' → 'sub'）。旧实现直接写 result.relDir，打开文件
          // 在子目录里时 onFilesChanged 的 payloadRel 门永远错配。
          const innerDirSegs = cut > 0
            ? remainder.slice(0, cut).replace(/^[\\/]+/, '').replace(/\\/g, '/')
            : '';
          const relDir = typeof result.relDir === 'string'
            ? [result.relDir, result.name, innerDirSegs].filter((s) => s).join('/')
            : '';
          _applyMoveToOpenFile({
            path: newFilePath,
            name: newName,
            mtimeMs: state.currentFile.mtimeMs,
            size: state.currentFile.size,
            relDir,
          });
        }
      }
      return result;
    } finally {
      // 仿 rename 的顺序：post-await 先更新 currentFile.path / relDir，守卫
      // 最后清 —— 晚到的旧目录事件已按新路径走常规 diff。
      state.movingPath = null;
    }
  }

  /**
   * 把条目（文件 / 文件夹）复制到目标目录。
   * 拖拽（按住 Ctrl/Cmd）/ 右键「复制 → 粘贴」走这里。
   * 复制不影响当前打开的文件（源不变），无需同步 state.currentFile。
   *
   * @param {{path:string,name:string,entryType:string}} entry
   * @param {string} destDir 目标目录绝对路径
   */
  async function copyEntry(entry, destDir) {
    if (!entry || !entry.path || !destDir) return null;
    const result = await api.copyFile(entry.path, destDir);
    if (!result || !result.ok) {
      showToast(`复制失败：${window.api.friendlyFsError(result && result.code, result && result.message)}`, 'error');
      return result || null;
    }
    showToast(`已复制到：${result.name}`, 'success', 1500);
    return result;
  }

  /**
   * 被「移动」的当前打开文件：把磁盘新路径同步到 state / viewer / 侧栏高亮 / AI。
   * move 不改变扩展名，所以不触发 内容重渲染（与 rename 带扩展名切换的路径不同）。
   * 逻辑收口自 renameCurrentOrFile 的同步分支。
   */
  function _applyMoveToOpenFile(result) {
    // result 由 moveEntry 在 IPC 成功后传入，永不为 null（moveEntry 已有 !result.ok 守卫）。
    const newMeta = {
      path: result.path,
      name: result.name,
      mtimeMs: result.mtimeMs,
      size: result.size,
    };
    state.currentFile = { ...state.currentFile, ...newMeta };
    state.lastSavedMtimeMs = result.mtimeMs;
    // 移动后文件所在目录变了：同步 currentFileRelDir（来自主进程 file:move 返回的
    // POSIX relDir），否则 onFilesChanged 仍用旧目录比对，会把"旧目录的移除事件"
    // 误判为"当前文件被删除"并清空编辑器（见 app.js onFilesChanged 的 payloadRel 比对）。
    if (typeof result.relDir === 'string') {
      state.currentFileRelDir = result.relDir;
    }
    if (fileList && typeof fileList.setActive === 'function') {
      try { fileList.setActive(result.path); } catch { /* 不让 setActive 异常阻断流程 */ }
    }
    // viewer 用 currentFile.path 当相对图片 baseDir，路径变了必须重跑
    viewer.setFileMeta(newMeta);
    updateWindowTitle();
    // 路径变化 → AI pendingDiff 的 baseContent / forFilePath 脱节 → 通知清盘
    if (typeof callbacks.onFileChanged === 'function') {
      try { callbacks.onFileChanged(state.currentFile); } catch (e) {
        console.warn('[file-ops] move 通知 AI 失败:', e);
      }
    }
  }

  /**
   * 文件列表右键菜单：
   *   文件条目：剪切 / 复制 / 粘贴 / 重命名 / 在文件夹中显示 / 删除
   *   文件夹条目：在文件夹中新建文件 / 在文件夹中新建文件夹 / （以上 + 文件条目全套）
   *
   * Stage 8：folder 条目也解锁「重命名」。
   * 文件夹条目顶部多一组「在该文件夹内新建」，落点指向被右击的文件夹
   * （右键文件夹 → 「在文件夹中新建文件」直接建进它里面）；
   * 侧栏空白右键的「新建」则落在当前浏览目录（见 src/app.js#showSidebarEmptyContextMenu）。
   * 剪切 / 复制把条目记到 clipboard（state.clipboard，由上层回调维护）；
   * 粘贴仅在 clipboard 非空时可用（当前浏览目录为目标）。
   */
  function showFileListContextMenu(entry, x, y) {
    const isFolder = entry && entry.entryType === 'folder';
    const items = [];
    // 文件夹条目：顶部加「在该文件夹内新建」一组，落点指向被右击的文件夹
    // （与侧栏空白右键「新建」落当前目录相对，这里是「建进这个文件夹」）。
    if (isFolder) {
      items.push({ label: '在文件夹中新建文件', value: 'new_file_in' });
      items.push({ label: '在文件夹中新建文件夹', value: 'new_folder_in' });
      items.push({ separator: true, value: '' });
    }
    items.push({ label: '剪切', value: 'cut' });
    items.push({ label: '复制', value: 'copy' });
    items.push({ label: '粘贴', value: 'paste', disabled: !state.clipboard });
    items.push({ separator: true, value: '' });
    items.push({ label: '重命名', value: 'rename' });
    items.push({ label: '在文件夹中显示', value: 'reveal' });
    items.push({ separator: true, value: '' });
    items.push({ label: '删除', value: 'delete', danger: true });
    contextMenu.show({
      x, y, items,
      onSelect: (value) => {
        if (value === 'new_file_in') {
          createNewFile(entry.path);
        } else if (value === 'new_folder_in') {
          createNewFolder(entry.path);
        } else if (value === 'cut') {
          if (typeof callbacks.onCut === 'function') callbacks.onCut(entry);
        } else if (value === 'copy') {
          if (typeof callbacks.onCopy === 'function') callbacks.onCopy(entry);
        } else if (value === 'paste') {
          if (typeof callbacks.onPaste === 'function') callbacks.onPaste();
        } else if (value === 'rename') {
          if (isFolder) renameFolder(entry);
          else renameCurrentOrFile(entry);
        } else if (value === 'reveal') {
          revealFile(entry);
        } else if (value === 'delete') {
          if (isFolder) deleteFolder(entry);
          else deleteFile(entry);
        }
      },
    });
  }

  return {
    showFileListContextMenu,
    createNewFile,
    createNewFolder,
    moveEntry,
    copyEntry,
    // 暴露给测试 / 调试用
    renameCurrentOrFile,
    renameFolder,
    deleteFile,
    deleteFolder,
    revealFile,
    formatStampForName,
  };
}