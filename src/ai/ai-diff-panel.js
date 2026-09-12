// AI 修改差异预览面板
// ============================================================================
//
// 渲染 AI 改稿前后的行级 + 词级 diff。用户可以：
//   - 点 "应用全部修改"：把整篇 nextContent 替换进编辑器
//   - 点每个 region 的 "应用此处"：把单个 region 的 newLines 替换进编辑器
//   - 点 "×"：丢弃 AI 修改，关掉中间面板
//
// 与 ai-controller 协作：
//   组件本身只负责渲染 + 转发按钮事件；所有"修改编辑器"的操作都通过
//   传进来的 onApply* 回调，由 controller 决定怎么改编辑器、重算 diff。
//
// 数据流：
//   diff = { rows, regions, isReadOnly, baseContent, nextContent }
//   - rows 已经是扁平化的行序列（含 context / removed / added），按 regionId 分组
//   - regions 是 [{ id, oldLines, newLines, conflict? }]，每个对应一个"修改块"
//   - isReadOnly = true 表示 AI 给了纯文本回复（不是文档修改），整块只读展示
// ============================================================================

import { escapeHtml, safeRenderMarkdown } from '../utils.js';

/**
 * 把扁平 rows 拆成 context 行 + region 块，渲染时按这个结构走。
 * @param {Array<{id:string, regionId?:string, type:string}>} rows
 * @returns {Array<{type:'context', row:any} | {type:'region', regionId:string, rows:any[]}>}
 */
function buildBlocks(rows) {
  const blocks = [];
  let index = 0;
  while (index < rows.length) {
    const row = rows[index];
    if (!row.regionId) {
      blocks.push({ type: 'context', row });
      index += 1;
      continue;
    }
    const regionId = row.regionId;
    const regionRows = [];
    while (index < rows.length && rows[index].regionId === regionId) {
      regionRows.push(rows[index]);
      index += 1;
    }
    blocks.push({ type: 'region', regionId, rows: regionRows });
  }
  return blocks;
}

/**
 * 渲染一行 diff。
 * - removed 行用红色 - 前缀
 * - added 行用绿色 + 前缀
 * - context 行用空格前缀（与 git diff 一致）
 * - token 粒度的 inline diff（equal/removed/added）会进一步切分
 */
function renderDiffRow(row, hideLineNumbers) {
  const lineNumber = row.type === 'removed' ? row.oldLineNumber : row.newLineNumber;
  const prefix = row.type === 'added' ? '+' : row.type === 'removed' ? '-' : ' ';
  const segmentsHtml = (row.segments || [])
    .map((seg) => {
      const text = seg.text || ' ';
      return `<span class="ai-diff-segment ai-diff-segment-${seg.type}">${escapeHtml(text)}</span>`;
    })
    .join('');

  const numberHtml = hideLineNumbers
    ? ''
    : `<span class="ai-diff-line-number" aria-hidden="true">${Number.isFinite(lineNumber) ? lineNumber : ''}</span>`
      + `<span class="ai-diff-line-prefix" aria-hidden="true">${prefix}</span>`;

  return `
    <div class="ai-diff-line ai-diff-line-${row.type}${hideLineNumbers ? ' ai-diff-line-plain' : ''}" role="row">
      ${numberHtml}
      <span class="ai-diff-line-text" role="gridcell">${segmentsHtml}</span>
    </div>
  `;
}

export class AiDiffPanel {
  /**
   * @param {object} options
   * @param {HTMLElement} options.element - 容器 div
   * @param {(diff:any) => void} options.onApplyRegion - 单 region 应用
   * @param {(diff:any) => void} options.onApplyAll - 全部应用
   * @param {(diff:any) => void} options.onDismiss - 关闭预览
   * @param {(regionId:string, diff:any) => void} [options.onSkipRegion] - 跳过单个 region
   *   （一般用于 conflict 区域 —— 给用户提供细粒度逃生口，避免一次冲突就要放弃整篇 AI 修改）
   */
  constructor({ element, onApplyRegion, onApplyAll, onDismiss, onSkipRegion, splitterElement = null }) {
    this.element = element;
    // AI 拖动 splitter 元素（与 .app-ai 联动显隐）。
    // 设了 splitterElement 后，setDiff 会自动同步它的 hidden。
    this.splitterElement = splitterElement;
    this.onApplyRegion = onApplyRegion || (() => {});
    this.onApplyAll = onApplyAll || (() => {});
    this.onDismiss = onDismiss || (() => {});
    this.onSkipRegion = onSkipRegion || null;
    this._diff = null;
  }

  /**
   * 渲染/更新 diff。diff = null → 显示空状态。
   * @param {object|null} diff
   */
  setDiff(diff) {
    this._diff = diff;
    // 每次 setDiff 之前先清掉上一轮的 click 监听器，否则重复 setDiff 会泄漏。
    if (this._cleanup) this._cleanup();
    this._cleanup = null;
    if (!diff) {
      this.element.hidden = true;
      // 同步把 AI 拖动 splitter 隐藏：避免面板关后 splitter 仍可见占用 grid 列
      if (this.splitterElement) this.splitterElement.hidden = true;
      this.element.replaceChildren();
      return;
    }
    this.element.hidden = false;
    if (this.splitterElement) this.splitterElement.hidden = false;
    // C4+H6 fix (audit)：_renderHtml / innerHTML 抛错会让 setDiff 中断，
    // element 处于 hidden=false 但内部为空 / 半渲染状态，用户看到一个
    // 灰板。这里包 try/catch，失败时降级为错误提示 + 保留 dismiss 按钮。
    try {
      this.element.innerHTML = this._renderHtml(diff);
      this._bindEvents(diff);
    } catch (e) {
      console.error('[ai-diff-panel] setDiff failed:', e);
      // M4 fix (audit)：兜底再显式 unhide —— 理论上 line 115-116 已设置，
      // 但若上一次的 setDiff 走的是 null 分支把 element + splitterElement 都 hidden 了，
      // 本轮进入 try 前 line 115-116 一定执行；但若 _renderHtml 内部有同步逻辑
      // 改了 dataset / 触发了 reflow（极端情况），catch 进来时面板可能仍处于 hidden。
      // 显式再设一次保证失败降级 UI 一定可见、用户能点 dismiss 退出。
      this.element.hidden = false;
      if (this.splitterElement) this.splitterElement.hidden = false;
      this.element.innerHTML = `
        <div class="ai-diff-header">
          <div>
            <h2 class="ai-diff-title">AI 修改预览</h2>
            <p class="ai-diff-summary">渲染失败：${escapeHtml(e && e.message || '未知错误')}</p>
          </div>
          <div class="ai-diff-actions">
            <button class="ai-diff-dismiss" type="button" data-action="dismiss" aria-label="关闭 AI 修改预览">×</button>
          </div>
        </div>
        <div class="ai-diff-empty">Diff 渲染异常，请关闭后重试</div>
      `;
      // 只绑定 dismiss —— 让用户能关掉这个面板
      const onClick = (ev) => {
        const t = ev.target.closest('[data-action]');
        if (t && t.dataset.action === 'dismiss') this.onDismiss(diff);
      };
      this.element.addEventListener('click', onClick);
      this._cleanup = () => this.element.removeEventListener('click', onClick);
    }
  }

  _renderHtml(diff) {
    const isReadOnly = !!diff.isReadOnly;
    const regions = Array.isArray(diff.regions) ? diff.regions : [];
    const regionsById = new Map(regions.map((r) => [r.id, r]));
    const hasApplicableDiff = !isReadOnly && regions.length > 0;
    const summary = isReadOnly
      ? 'AI 普通回复，仅供查看'
      : hasApplicableDiff ? `${regions.length} 处待确认修改` : 'AI 返回内容与当前文档一致';

    const headerActions = hasApplicableDiff
      ? `<button class="ai-diff-apply-all" type="button" data-action="apply-all">应用全部修改</button>`
      : '';
    const header = `
      <div class="ai-diff-header">
        <div>
          <h2 class="ai-diff-title">AI 修改预览</h2>
          <p class="ai-diff-summary">${escapeHtml(summary)}</p>
        </div>
        <div class="ai-diff-actions">
          ${headerActions}
          <button class="ai-diff-dismiss" type="button" data-action="dismiss" aria-label="关闭 AI 修改预览">×</button>
        </div>
      </div>
    `;

    const body = this._renderBody(diff, regionsById);
    return header + body;
  }

  _renderBody(diff, regionsById) {
    if (diff.isReadOnly) {
      // 普通文本回复：整块当 markdown 渲染或纯文本展示。
      // 这里走 DOMPurify（preload 已暴露 window.api.renderMarkdown）保持与 viewer 一致。
      // 没设依赖时退化为 <pre> 纯文本（safeRenderMarkdown 集中处理）。
      const html = safeRenderMarkdown(diff.nextContent || '');
      return `<div class="ai-reply-content markdown-body" role="region" aria-label="AI 普通回复">${html}</div>`;
    }

    const blocks = buildBlocks(diff.rows || []);
    if (blocks.length === 0) {
      return `<div class="ai-diff-empty">AI 返回了空内容</div>`;
    }
    const parts = blocks.map((block) => {
      if (block.type === 'context') {
        return renderDiffRow(block.row, false);
      }
      const region = regionsById.get(block.regionId);
      const hasSkip = this.onSkipRegion && region && region.conflict;
      const conflict = region && region.conflict
        ? `<div class="ai-diff-conflict">${escapeHtml(region.conflict)}</div>`
        : '';
      // conflict 时除了 disabled "应用此处"，再多给一个 "跳过此处" 按钮：
      // 用户放弃这一处但保留其它 region 的应用机会（之前只能 dismiss 整篇 diff）。
      const applyBtn = !region
        ? ''
        : `<button class="ai-diff-region-apply" type="button" data-action="apply-region" data-region-id="${escapeHtml(block.regionId)}"${region.conflict ? ' disabled' : ''}>应用此处</button>`;
      const skipBtn = hasSkip
        ? `<button class="ai-diff-region-skip" type="button" data-action="skip-region" data-region-id="${escapeHtml(block.regionId)}" aria-label="跳过该修改区域，保留其它修改">跳过此处</button>`
        : '';
      const regionHeader = !region
        ? `<div class="ai-diff-conflict">无法定位该修改区域</div>`
        : `<div class="ai-diff-region-actions">${applyBtn}${skipBtn}</div>`;
      const rowsHtml = block.rows.map((r) => renderDiffRow(r, false)).join('');
      return `
        <section class="ai-diff-region" data-region-id="${escapeHtml(block.regionId)}">
          <header class="ai-diff-region-header">${regionHeader}${conflict}</header>
          <div class="ai-diff-region-body">${rowsHtml}</div>
        </section>
      `;
    }).join('');

    return `<div class="ai-diff-fulltext" role="table" aria-label="AI 修改全文对比">${parts}</div>`;
  }

  _bindEvents(diff) {
    const onClick = (e) => {
      const target = e.target.closest('[data-action]');
      if (!target) return;
      // audit fix (Round 13 / Sec-H1)：拒绝 AI 控制内容里的 [data-action]。
      // 威胁：isReadOnly=true（AI 普通文本回复）时，整块内容由 AI 控制的 markdown
      // 渲染得到，DOMPurify 默认不过滤 data-* / <span>/<button> —— 攻击者（或
      // 通过 prompt injection 诱导）可在回复里塞
      // `<span data-action="apply-all" style="position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:2147483647"></span>`
      // 做成全屏透明覆盖层；用户的下一次任意位置点击会沿事件冒泡命中
      // closest('[data-action]') → apply-all → editor.applyUserChange(nextContent)
      // —— 静默把打开的笔记替换为 AI 的聊天回复（数据销毁）。
      // 修复策略：信任域分离 —— read-only 走 markdown-body 这条信任链，事件委托
      // 只接受 panel 自身渲染的「应用全部 / 应用此处 / 跳过 / 关闭」按钮。其他按钮
      // 路径下，AI 内容里的 [data-action] 同样应被忽略（防御未来新按钮路径），用
      // 「目标在 .ai-reply-content 子树内即忽略」统一兜底。
      if (target.closest && target.closest('.ai-reply-content')) return;
      const action = target.dataset.action;
      if (action === 'dismiss') {
        this.onDismiss(diff);
      } else if (action === 'apply-all') {
        this.onApplyAll(diff);
      } else if (action === 'apply-region') {
        const regionId = target.dataset.regionId;
        if (regionId) this.onApplyRegion(regionId, diff);
      } else if (action === 'skip-region') {
        // 仅在 controller 给了 onSkipRegion 时才会渲染这个按钮；防御性再判一次
        const regionId = target.dataset.regionId;
        if (regionId && this.onSkipRegion) this.onSkipRegion(regionId, diff);
      }
    };
    this.element.addEventListener('click', onClick);
    this._cleanup = () => this.element.removeEventListener('click', onClick);
  }

  destroy() {
    if (this._cleanup) this._cleanup();
    this._cleanup = null;
  }
}
