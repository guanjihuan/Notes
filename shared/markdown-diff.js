// 行级 + 词级 Markdown diff —— 用于 AI 修改预览
// ============================================================================
//
// 从参考项目 markdown.guanjihuan.com 的 src/lib/markdownDiff.ts 移植为 CJS，
// 以便在 main / preload / renderer / 单元测试之间共用同一份算法。
//
// 核心思路：
//   1. 行级 LCS diff（动态规划，O(n*m) 但有上限保护）找到 add/remove/context 序列
//   2. 把连续的 add/remove 序列打包成"region"（一个修改块）
//   3. region 内部做词级 diff（同上，tokenize 后 LCS）
//   4. applyDiffRegionSafely 用 region 上下文（前后各 2 行）安全定位并替换
//
// 关键保护：
//   - MAX_LINE_DIFF_CELLS / MAX_TOKEN_DIFF_CELLS / MAX_TOKEN_DIFF_CHARS
//     防止大文档（>1MB）触发指数级内存 / CPU 爆炸
//   - endsWithNewline 跟踪：拼接回去时保留尾换行，避免与原文件 diff

'use strict';

/**
 * @typedef {Object} DiffSegment
 * @property {'equal'|'removed'|'added'} type
 * @property {string} text
 */

/**
 * @typedef {Object} FullDiffRow
 * @property {string} id
 * @property {string} [regionId]
 * @property {'context'|'removed'|'added'} type
 * @property {number} [oldLineNumber]
 * @property {number} [newLineNumber]
 * @property {DiffSegment[]} segments
 */

/**
 * @typedef {Object} AiDiffRegion
 * @property {string} id
 * @property {number} oldStart
 * @property {string[]} oldLines
 * @property {number} newStart
 * @property {string[]} newLines
 * @property {string[]} beforeContext
 * @property {string[]} afterContext
 * @property {string} [conflict]
 */

/**
 * @typedef {Object} PendingAiDiffProposal
 * @property {string} id
 * @property {string} baseContent
 * @property {string} nextContent
 * @property {boolean} [isReadOnly]
 * @property {FullDiffRow[]} rows
 * @property {AiDiffRegion[]} regions
 */

/**
 * @typedef {Object} ComputeFullMarkdownDiffOptions
 * @property {boolean} [tokenDiff]
 */

/**
 * @typedef {Object} DiffOp
 * @property {'context'|'removed'|'added'} type
 * @property {string} text
 * @property {number} [oldLineNumber]
 * @property {number} [newLineNumber]
 */

const CONTEXT_SIZE = 2;
const MAX_LINE_DIFF_CELLS = 200_000;
const MAX_TOKEN_DIFF_CHARS = 4_000;
const MAX_TOKEN_DIFF_CELLS = 40_000;

function normalizeContent(content) {
  // audit fix：Windows Notepad / 某些 PowerShell pipeline 会写 UTF-8 BOM
  // (U+FEFF) 在文件头。不剥 BOM 会让第一行变成 "\uFEFF# Title"，
  // computeDiffOps 里 oldLines[0] === newLines[0] 永远 false，
  // 每个 BOM-prefixed 文件都会在 AI diff 面板里把首行当成「被改」渲染，
  // 即使内容一字未动。仅在文件起始位置剥一次（intra-content 的 BOM 保留）。
  // \u5BA1\u8BA1\u4FEE\u590D (Round 11 deep-fix P2-1)\uFF1A\u628A BOM \u5265\u9664\u4ECE\u300C\u4EC5\u6587\u4EF6\u5934\u300D\u6269\u5230\u300C\u5168\u6587 BOM \u5B57\u7B26\u300D\u3002
  // \u65E7\u7248 intra-file BOM\uFF08\u4F8B\u5982\u591A\u6B21 cat \u62FC\u63A5\u65F6\u5076\u5C14\u51FA\u73B0\uFF09\u4F1A\u88AB\u5F53\u6210\u6B63\u6587\u4E00\u90E8\u5206\uFF0C
  // \u8BA9\u5BF9\u5E94\u884C\u6C38\u4E0D\u7B49\u4E8E oldLines \u91CC\u540C\u6837\u4F4D\u7F6E\u7684\u884C \u2192 \u6574\u884C\u88AB\u8BEF\u5224\u4E3A\u300C\u4FEE\u6539\u300D\u3002
  // \uFEFF \u5728 Markdown \u91CC\u6CA1\u6709\u4EFB\u4F55\u6709\u610F\u4E49\u7684\u8BED\u4E49\uFF08\u96F6\u5BBD BOM \u6807\u8BB0\uFF09\uFF0C\u5168\u6587\u5265\u662F\u5B89\u5168\u7684\u3002
  //
  // \u884C\u5C3E\u89C4\u6574\uFF1A\r\n \u2192 \n\uFF1B**\u4FDD\u7559\u88F8 \r**\uFF08\u65E7 Mac \u98CE\u683C\u5408\u6CD5\u53EF\u542B\uFF09\u3002
  // \u539F `replace(/\r\n?/g, '\n')` \u4F1A\u541E\u6389\u88F8 \r \u628A\u4E00\u884C\u62C6\u6210\u4E24\u884C\uFF08Round 8 BOM \u4FEE\u590D\u7684\u526F\u4F5C\u7528\uFF09\uFF0C
  // \u73B0\u5728\u6539\u7528 /\r\n/g \u53EA\u5339\u914D CRLF\u3002
  return String(content).replace(/\r\n/g, '\n').replace(/\uFEFF/g, '');
}

function splitLines(content) {
  const normalized = normalizeContent(content);
  if (normalized.length === 0) return [];
  // audit fix：「空文件」与「只有一个换行的文件」语义上等价 —— 都是「无内容行」，
  // 但前者 splitLines 返回 []，后者返回 [""]，diff LCS 在这两种输入下会产生
  // 不同的 ops（added 与 nothing），让 AI diff 偶现「空文件被加了一行」的幽灵。
  // 统一成 []。
  const lines = normalized.endsWith('\n')
    ? normalized.slice(0, -1).split('\n')
    : normalized.split('\n');
  if (lines.length === 1 && lines[0] === '') return [];
  return lines;
}

function joinLines(lines, endsWithNewline, eol = '\n') {
  if (lines.length === 0) return endsWithNewline ? eol : '';
  return `${lines.join(eol)}${endsWithNewline ? eol : ''}`;
}

function computeDiffOps(oldLines, newLines, onFallback) {
  let prefixLength = 0;
  const maxPrefixLength = Math.min(oldLines.length, newLines.length);

  while (prefixLength < maxPrefixLength && oldLines[prefixLength] === newLines[prefixLength]) {
    prefixLength += 1;
  }

  let oldSuffixStart = oldLines.length;
  let newSuffixStart = newLines.length;

  while (
    oldSuffixStart > prefixLength
    && newSuffixStart > prefixLength
    && oldLines[oldSuffixStart - 1] === newLines[newSuffixStart - 1]
  ) {
    oldSuffixStart -= 1;
    newSuffixStart -= 1;
  }

  const oldMiddle = oldLines.slice(prefixLength, oldSuffixStart);
  const newMiddle = newLines.slice(prefixLength, newSuffixStart);
  /** @type {DiffOp[]} */
  const ops = [];

  for (let index = 0; index < prefixLength; index += 1) {
    ops.push({ type: 'context', text: oldLines[index], oldLineNumber: index + 1, newLineNumber: index + 1 });
  }

  if (oldMiddle.length * newMiddle.length > MAX_LINE_DIFF_CELLS) {
    // H3 fix (audit)：cells 超过 MAX_LINE_DIFF_CELLS 时退化到「整段删 + 整段加」
    // fallback。原来的实现不告诉调用方 —— UI 看到「整篇被改」会误以为 AI 整篇重写。
    // onFallback 让 controller toast「diff 过大，已退化为整段替换」。
    if (typeof onFallback === 'function') {
      onFallback(`行级 diff 超过 ${MAX_LINE_DIFF_CELLS} cells 上限，已退化为整段替换（${oldMiddle.length} 行 removed + ${newMiddle.length} 行 added）`);
    }
    oldMiddle.forEach((text, index) => {
      ops.push({ type: 'removed', text, oldLineNumber: prefixLength + index + 1 });
    });
    newMiddle.forEach((text, index) => {
      ops.push({ type: 'added', text, newLineNumber: prefixLength + index + 1 });
    });
  } else {
    // LCS 动态规划
    const dp = Array.from({ length: oldMiddle.length + 1 }, () => new Array(newMiddle.length + 1).fill(0));

    for (let i = oldMiddle.length - 1; i >= 0; i -= 1) {
      for (let j = newMiddle.length - 1; j >= 0; j -= 1) {
        dp[i][j] = oldMiddle[i] === newMiddle[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }

    let i = 0;
    let j = 0;

    while (i < oldMiddle.length && j < newMiddle.length) {
      if (oldMiddle[i] === newMiddle[j]) {
        ops.push({
          type: 'context',
          text: oldMiddle[i],
          oldLineNumber: prefixLength + i + 1,
          newLineNumber: prefixLength + j + 1,
        });
        i += 1;
        j += 1;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        ops.push({ type: 'removed', text: oldMiddle[i], oldLineNumber: prefixLength + i + 1 });
        i += 1;
      } else {
        ops.push({ type: 'added', text: newMiddle[j], newLineNumber: prefixLength + j + 1 });
        j += 1;
      }
    }

    while (i < oldMiddle.length) {
      ops.push({ type: 'removed', text: oldMiddle[i], oldLineNumber: prefixLength + i + 1 });
      i += 1;
    }

    while (j < newMiddle.length) {
      ops.push({ type: 'added', text: newMiddle[j], newLineNumber: prefixLength + j + 1 });
      j += 1;
    }
  }

  for (let index = oldSuffixStart; index < oldLines.length; index += 1) {
    ops.push({
      type: 'context',
      text: oldLines[index],
      oldLineNumber: index + 1,
      newLineNumber: newSuffixStart + index - oldSuffixStart + 1,
    });
  }

  return ops;
}

function findSequence(lines, sequence) {
  if (sequence.length === 0) return [];

  const matchesAt = (index) => sequence.every((line, offset) => lines[index + offset] === line);

  // fix(audit 2026-08)：原版在 preferredIndex 命中时直接 [preferredIndex] 返回，
  // 跳过扫描全文 → 其它位置的重复匹配被静默忽略。背景：AI 从 base 算 diff 时只
  // 有 1 个匹配；但用户编辑后可能在其它位置粘了相同行 → 当前文档有 N 个匹配，
  // preferredIndex hint 仍指向原位置。直接套用 hint 会改错位置（旧位置可能是
  // 用户新增的副本，而非 AI 原意要改的那一行）。
  // 修复：总是扫描全文，仅当只有 1 个匹配时才信任 hint 返回单元素数组。
  // hint 现在在调用方（applyDiffRegionSafely）通过 beforeContext/afterContext 实现，
  // 见 :547+ region clamp 切片。
  const matches = [];
  for (let i = 0; i <= lines.length - sequence.length; i += 1) {
    if (matchesAt(i)) matches.push(i);
  }
  return matches;
}

function tokenize(text) {
  const tokens = [];
  let index = 0;

  while (index < text.length) {
    const char = text[index];
    // 用贪婪匹配，匹配 $...$ 行内数学（Katex 风格的简单 token）
    const mathMatch = char === '$' ? text.slice(index).match(/^\$[^$]+\$/) : null;
    const wordMatch = text.slice(index).match(/^[A-Za-z0-9_]+/);
    const spaceMatch = text.slice(index).match(/^\s+/);

    if (mathMatch) {
      tokens.push(mathMatch[0]);
      index += mathMatch[0].length;
    } else if (spaceMatch) {
      tokens.push(spaceMatch[0]);
      index += spaceMatch[0].length;
    } else if (wordMatch) {
      tokens.push(wordMatch[0]);
      index += wordMatch[0].length;
    } else {
      tokens.push(char);
      index += 1;
    }
  }

  return tokens;
}

function diffTokens(removedText, addedText, onFallback) {
  if (removedText.length + addedText.length > MAX_TOKEN_DIFF_CHARS) {
    // H3 fix (audit)：token 字符数超过上限 → 退化到行级 fallback。
    // 通过 onFallback 把警告挂到 computeFullMarkdownDiff 的 warnings 字段。
    if (typeof onFallback === 'function') {
      onFallback(`词级 diff 超过 ${MAX_TOKEN_DIFF_CHARS} 字符上限，已退化为行级（${removedText.length}+${addedText.length} chars）`);
    }
    return {
      removedSegments: [{ type: 'removed', text: removedText }],
      addedSegments: [{ type: 'added', text: addedText }],
    };
  }

  const oldTokens = tokenize(removedText);
  const newTokens = tokenize(addedText);

  if (oldTokens.length * newTokens.length > MAX_TOKEN_DIFF_CELLS) {
    // H3 fix (audit)：token cells 超上限同样退化。
    if (typeof onFallback === 'function') {
      onFallback(`词级 diff cells 超过 ${MAX_TOKEN_DIFF_CELLS} 上限，已退化为行级（${oldTokens.length}×${newTokens.length} tokens）`);
    }
    return {
      removedSegments: [{ type: 'removed', text: removedText }],
      addedSegments: [{ type: 'added', text: addedText }],
    };
  }

  const dp = Array.from({ length: oldTokens.length + 1 }, () => new Array(newTokens.length + 1).fill(0));

  for (let i = oldTokens.length - 1; i >= 0; i -= 1) {
    for (let j = newTokens.length - 1; j >= 0; j -= 1) {
      dp[i][j] = oldTokens[i] === newTokens[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  /** @type {DiffSegment[]} */
  const removedSegments = [];
  /** @type {DiffSegment[]} */
  const addedSegments = [];
  let i = 0;
  let j = 0;

  const pushSegment = (segments, type, text) => {
    const last = segments[segments.length - 1];
    if (last && last.type === type) {
      last.text += text;
    } else {
      segments.push({ type, text });
    }
  };

  while (i < oldTokens.length && j < newTokens.length) {
    if (oldTokens[i] === newTokens[j]) {
      pushSegment(removedSegments, 'equal', oldTokens[i]);
      pushSegment(addedSegments, 'equal', newTokens[j]);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      pushSegment(removedSegments, 'removed', oldTokens[i]);
      i += 1;
    } else {
      pushSegment(addedSegments, 'added', newTokens[j]);
      j += 1;
    }
  }

  while (i < oldTokens.length) {
    pushSegment(removedSegments, 'removed', oldTokens[i]);
    i += 1;
  }

  while (j < newTokens.length) {
    pushSegment(addedSegments, 'added', newTokens[j]);
    j += 1;
  }

  return { removedSegments, addedSegments };
}

function buildContextRows(lines) {
  return lines.map((text, index) => ({
    id: `context-${index}`,
    type: 'context',
    oldLineNumber: index + 1,
    newLineNumber: index + 1,
    segments: [{ type: 'equal', text }],
  }));
}

function buildChangedRows(regionId, changedOps, options, onFallback) {
  /** @type {FullDiffRow[]} */
  const rows = [];
  const removedOps = changedOps.filter((op) => op.type === 'removed');
  const addedOps = changedOps.filter((op) => op.type === 'added');
  const pairCount = Math.min(removedOps.length, addedOps.length);
  const useTokenDiff = options.tokenDiff !== false;

  for (let i = 0; i < pairCount; i += 1) {
    const removedOp = removedOps[i];
    const addedOp = addedOps[i];
    const { removedSegments, addedSegments } = useTokenDiff
      ? diffTokens(removedOp.text, addedOp.text, onFallback)
      : {
          removedSegments: [{ type: 'removed', text: removedOp.text }],
          addedSegments: [{ type: 'added', text: addedOp.text }],
        };
    rows.push({
      id: `${regionId}-removed-${i}`,
      regionId,
      type: 'removed',
      oldLineNumber: removedOp.oldLineNumber,
      segments: removedSegments.length > 0 ? removedSegments : [{ type: 'removed', text: removedOp.text }],
    });
    rows.push({
      id: `${regionId}-added-${i}`,
      regionId,
      type: 'added',
      newLineNumber: addedOp.newLineNumber,
      segments: addedSegments.length > 0 ? addedSegments : [{ type: 'added', text: addedOp.text }],
    });
  }

  for (let i = pairCount; i < removedOps.length; i += 1) {
    rows.push({
      id: `${regionId}-removed-${i}`,
      regionId,
      type: 'removed',
      oldLineNumber: removedOps[i].oldLineNumber,
      segments: [{ type: 'removed', text: removedOps[i].text }],
    });
  }

  for (let i = pairCount; i < addedOps.length; i += 1) {
    rows.push({
      id: `${regionId}-added-${i}`,
      regionId,
      type: 'added',
      newLineNumber: addedOps[i].newLineNumber,
      segments: [{ type: 'added', text: addedOps[i].text }],
    });
  }

  return rows;
}

/**
 * 计算两段 Markdown 文本的完整 diff。
 * @param {string} baseContent
 * @param {string} nextContent
 * @param {ComputeFullMarkdownDiffOptions} [options]
 * @returns {{ rows: FullDiffRow[], regions: AiDiffRegion[] }}
 */
function computeFullMarkdownDiff(baseContent, nextContent, options = {}) {
  const normalizedBaseContent = normalizeContent(baseContent);
  const normalizedNextContent = normalizeContent(nextContent);
  // H3 fix (audit)：收集 fallback 警告（行级 cells 超 MAX_LINE_DIFF_CELLS /
  // 词级超 MAX_TOKEN_DIFF_CHARS 触发整段替换 / 退化为行级时挂警告），
  // 让 controller toast「diff 过大，已退化为整段替换」/「词级已退化为行级」，
  // 避免 UI 上看到「整篇被改」以为是 AI 整篇重写。
  const warnings = [];
  const emitWarning = (msg) => { warnings.push(msg); };
  if (normalizedBaseContent === normalizedNextContent) {
    return { rows: buildContextRows(splitLines(normalizedNextContent)), regions: [] };
  }

  const oldLines = splitLines(normalizedBaseContent);
  const newLines = splitLines(normalizedNextContent);
  const ops = computeDiffOps(oldLines, newLines, emitWarning);
  /** @type {FullDiffRow[]} */
  const rows = [];
  /** @type {AiDiffRegion[]} */
  const regions = [];
  let index = 0;

  while (index < ops.length) {
    const op = ops[index];

    if (op.type === 'context') {
      rows.push({
        id: `context-${rows.length}`,
        type: 'context',
        oldLineNumber: op.oldLineNumber,
        newLineNumber: op.newLineNumber,
        segments: [{ type: 'equal', text: op.text }],
      });
      index += 1;
      continue;
    }

    const changeStart = index;
    while (index < ops.length && ops[index].type !== 'context') index += 1;
    const changedOps = ops.slice(changeStart, index);
    const oldLinesInRegion = changedOps.filter((item) => item.type === 'removed').map((item) => item.text);
    const newLinesInRegion = changedOps.filter((item) => item.type === 'added').map((item) => item.text);
    const beforeContextStart = Math.max(0, changeStart - CONTEXT_SIZE);
    const afterContextEnd = Math.min(ops.length, index + CONTEXT_SIZE);
    const beforeContext = ops.slice(beforeContextStart, changeStart).filter((item) => item.type === 'context').map((item) => item.text);
    const afterContext = ops.slice(index, afterContextEnd).filter((item) => item.type === 'context').map((item) => item.text);
    const firstOldLine = changedOps.find((item) => item.oldLineNumber !== undefined);
    const firstNewLine = changedOps.find((item) => item.newLineNumber !== undefined);
    const firstOldLineNumber = firstOldLine ? firstOldLine.oldLineNumber : undefined;
    const firstNewLineNumber = firstNewLine ? firstNewLine.newLineNumber : undefined;
    const regionId = `region-${regions.length + 1}`;

    // C1 fix (audit)：若一个 region 完全没有 beforeContext + afterContext，
    // 「应用此处」无法唯一定位（applyDiffRegionSafely 对纯新增/整篇删除 fallback
    // 到 currentLines.length===0 才生效，正常文档永远 conflict）。在 UI 显式标 conflict
    // 引导用户走「应用全部」。这是 AI 返回「整篇替换」或「在空文档插入内容」时的合理退化。
    const needsWholeDocHint = beforeContext.length === 0 && afterContext.length === 0;

    regions.push({
      id: regionId,
      oldStart: firstOldLineNumber !== undefined ? firstOldLineNumber - 1 : Math.max(0, (firstNewLineNumber || 1) - 1),
      oldLines: oldLinesInRegion,
      newStart: firstNewLineNumber !== undefined ? firstNewLineNumber - 1 : Math.max(0, (firstOldLineNumber || 1) - 1),
      newLines: newLinesInRegion,
      beforeContext,
      afterContext,
      ...(needsWholeDocHint ? { conflict: '无上下文定位，请使用「应用全部」' } : {}),
    });
    rows.push(...buildChangedRows(regionId, changedOps, options, emitWarning));
  }

  // H3 fix (audit)：只有真有 fallback 才带 warnings 字段，避免污染 return shape。
  return warnings.length > 0 ? { rows, regions, warnings } : { rows, regions };
}

/**
 * 用 region 安全替换 currentContent 中对应位置的内容。
 * 找不到唯一匹配（0 个或多个）时返回 { ok:false, reason }，供 UI 标红提示。
 * @param {string} currentContent
 * @param {AiDiffRegion} region
 * @returns {{ ok: true, content: string } | { ok: false, reason: string }}
 */
function applyDiffRegionSafely(currentContent, region) {
  const original = String(currentContent);
  const normalized = normalizeContent(original);
  const currentLines = splitLines(normalized);
  const endsWithNewline = normalized.endsWith('\n');
  // 保留原稿行尾：检测是否含 CRLF（含至少一处即视为 CRLF 文件）。
  // 之前 normalizeContent 把 \r\n → \n 后 joinLines 又硬写 \n，
  // 会把 Windows 用户的 .md 文件静默改成 LF —— 污染文件格式。
  const eol = /\r\n/.test(original) ? '\r\n' : '\n';

  if (region.oldLines.length > 0) {
    // findSequence 现在总是扫描全文（不再走 preferredIndex early-return），
    // 拿到所有 oldLines 匹配的下标。再用 beforeContext/afterContext 二次过滤，
    // 既保留 C3 上下文漂移检测，又能在「多个匹配但只有一个上下文一致」时安全应用。
    const allMatches = findSequence(currentLines, region.oldLines, region.oldStart);
    if (allMatches.length === 0) {
      return { ok: false, reason: '无法安全定位该修改位置' };
    }

    // C3 fix (audit)：多匹配时用 context 过滤，定位唯一正确的位置。
    // 场景：用户复制了相同行到多处（如原 c 后面又粘一个 c），preferredIndex 仍
    // 命中旧位置，但旧位置的 context 已和 region 算出时不同；其它新位置的
    // context 同样不对。三个候选都漂移 → "上下文漂移"。
    // 单匹配且有 context 时也照常校验（防止单匹配也漂移的极端情况）。
    if (region.beforeContext.length > 0 || region.afterContext.length > 0) {
      const contextMatches = allMatches.filter((idx) => {
        const beforeActual = currentLines.slice(
          Math.max(0, idx - region.beforeContext.length),
          idx,
        );
        const afterActual = currentLines.slice(
          idx + region.oldLines.length,
          idx + region.oldLines.length + region.afterContext.length,
        );
        return beforeActual.join('\n') === region.beforeContext.join('\n')
          && afterActual.join('\n') === region.afterContext.join('\n');
      });
      if (contextMatches.length === 0) {
        // 所有匹配位置的 context 都不对 → drift。
        return { ok: false, reason: '上下文漂移，无法确定该修改的位置' };
      }
      if (contextMatches.length > 1) {
        // 多处 context 都和 region 一致，但 oldLines 重复了 → 真歧义。
        return { ok: false, reason: '找到多个相同位置，无法判断应应用到哪一处' };
      }
      // 唯一匹配：context 一致的位置就是 base 时的位置，安全应用。
      const nextLines = currentLines.slice();
      nextLines.splice(contextMatches[0], region.oldLines.length, ...region.newLines);
      return { ok: true, content: joinLines(nextLines, endsWithNewline, eol) };
    }

    // 无 context：要求 oldLines 全局唯一。
    if (allMatches.length !== 1) {
      return { ok: false, reason: '找到多个相同位置，无法判断应应用到哪一处' };
    }
    const nextLines = currentLines.slice();
    nextLines.splice(allMatches[0], region.oldLines.length, ...region.newLines);
    return { ok: true, content: joinLines(nextLines, endsWithNewline, eol) };
  }

  // 纯新增：尝试用 beforeContext + afterContext 定位插入点
  const preferredIndex = Math.min(Math.max(region.oldStart, 0), currentLines.length);
  const beforeMatches = findSequence(currentLines, region.beforeContext);
  const afterMatches = findSequence(currentLines, region.afterContext);
  /** @type {number | null} */
  let insertionIndex = null;

  if (
    region.beforeContext.length > 0
    && region.afterContext.length > 0
    // clamp 切片端点：preferredIndex - region.beforeContext.length 在文档开头
    // 可能是负数 → JS 的 slice(-N, 0) 会拿"末尾 N 项"误匹配；显式 clamp 到 0。
    && preferredIndex - region.beforeContext.length >= 0
    && currentLines.slice(preferredIndex - region.beforeContext.length, preferredIndex).join('\n') === region.beforeContext.join('\n')
    && currentLines.slice(preferredIndex, preferredIndex + region.afterContext.length).join('\n') === region.afterContext.join('\n')
  ) {
    insertionIndex = preferredIndex;
  } else if (beforeMatches.length === 1 && afterMatches.length === 1) {
    // P3 fix：before + after 同时各只有一个匹配，但 preferredIndex 错位了。
    // 此时必须校验 before 末尾 === after 起点（即「这两段上下文在文档里相邻」），
    // 否则 before 和 after 是两个独立匹配，盲选 before 会插到错位置。
    const beforeEnd = beforeMatches[0] + region.beforeContext.length;
    if (beforeEnd === afterMatches[0]) {
      insertionIndex = beforeEnd;
    } else {
      // 上下文冲突：让 UI 走 conflict 分支（标灰、应用按钮 disable）。
      return { ok: false, reason: '前后上下文位置冲突，无法确定插入点' };
    }
  } else if (beforeMatches.length === 1) {
    insertionIndex = beforeMatches[0] + region.beforeContext.length;
  } else if (afterMatches.length === 1) {
    insertionIndex = afterMatches[0];
  } else if (currentLines.length === 0) {
    insertionIndex = 0;
  }

  if (insertionIndex === null) {
    return { ok: false, reason: '无法安全定位插入位置' };
  }

  const nextLines = currentLines.slice();
  nextLines.splice(insertionIndex, 0, ...region.newLines);
  return { ok: true, content: joinLines(nextLines, endsWithNewline, eol) };
}

module.exports = {
  computeFullMarkdownDiff,
  applyDiffRegionSafely,
};
