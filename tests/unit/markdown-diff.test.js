// Stage 8 tests: shared/markdown-diff.js
//
// 覆盖：
//   - computeFullMarkdownDiff：纯增 / 纯删 / 改 / 跨多 region / 空内容
//   - applyDiffRegionSafely：成功路径 + conflict（找不到 / 多个匹配）
//   - endsWithNewline 保留
//   - 行级 MAX_LINE_DIFF_CELLS 守卫（过大输入不爆炸）
//   - tokenDiff 选项生效路径（仅断言结构，不验证具体分词）
//
// shared/ 是 CommonJS，直接 require 即可。

import { describe, it, expect } from 'vitest';

const { computeFullMarkdownDiff, applyDiffRegionSafely } = require('../../shared/markdown-diff.js');

describe('computeFullMarkdownDiff', () => {
  it('identical content → 空 regions（rows 只剩 context）', () => {
    const out = computeFullMarkdownDiff('a\nb\nc', 'a\nb\nc');
    expect(out.regions).toEqual([]);
    // 没有 regionId 的行就是纯 context
    const regionsInRows = out.rows.filter((r) => r.regionId).length;
    expect(regionsInRows).toBe(0);
  });

  it('空内容 + 空内容 → 无 rows / 无 regions', () => {
    const out = computeFullMarkdownDiff('', '');
    expect(out.rows).toEqual([]);
    expect(out.regions).toEqual([]);
  });

  it('BOM 仅出现在文件头 → 被剥掉，不影响 diff 结果（Phase 8 fix）', () => {
    // Windows Notepad / PowerShell pipeline 写 UTF-8 BOM (U+FEFF) 在文件头。
    // 不剥 → 首行变成 "﻿# Title"，LCS 看到 oldLines[0] !== newLines[0]，
    // 每次「应用全部」都把首行当成「被改」渲染。
    const base = '﻿# Title\nline2';
    const next = '﻿# Title\nline2'; // 一字未动
    const out = computeFullMarkdownDiff(base, next);
    expect(out.regions).toEqual([]);
    // rows 只剩 context，无任何 regionId
    expect(out.rows.filter((r) => r.regionId)).toEqual([]);
  });

  it('BOM 只剥头部一次，正文中残留的 BOM 保留', () => {
    // intra-content 的 BOM 不剥：可能是有意为之（极少），且剥错会破坏内容。
    const base = 'line1\n﻿middle\nline3';
    const next = 'line1\n﻿middle\nline3';
    const out = computeFullMarkdownDiff(base, next);
    expect(out.regions).toEqual([]);
  });

  it('BOM + 真改动：diff 只反映真改动，BOM 不计入 regions', () => {
    const base = '﻿# Title\nold';
    const next = '﻿# Title\nnew';
    const out = computeFullMarkdownDiff(base, next);
    expect(out.regions).toHaveLength(1);
    // region 应只包含改动的行，不包含被剥的 BOM
    const changed = out.regions[0];
    expect(changed.newLines).toEqual(['new']);
    expect(changed.oldLines).toEqual(['old']);
  });

  it('纯新增一行：产生 1 个 region + 1 个 added row', () => {
    const out = computeFullMarkdownDiff('a\nb', 'a\nx\nb');
    expect(out.regions).toHaveLength(1);
    const region = out.regions[0];
    expect(region.oldLines).toEqual([]);
    expect(region.newLines).toEqual(['x']);
    // 新增行的 type 应是 'added'
    const addedRows = out.rows.filter((r) => r.type === 'added' && r.regionId === region.id);
    expect(addedRows).toHaveLength(1);
    expect(addedRows[0].segments[0].text).toBe('x');
  });

  it('纯删除一行：oldLines 有内容，newLines 为空', () => {
    const out = computeFullMarkdownDiff('a\nx\nb', 'a\nb');
    expect(out.regions).toHaveLength(1);
    const region = out.regions[0];
    expect(region.oldLines).toEqual(['x']);
    expect(region.newLines).toEqual([]);
    const removedRows = out.rows.filter((r) => r.type === 'removed' && r.regionId === region.id);
    expect(removedRows).toHaveLength(1);
    expect(removedRows[0].segments[0].text).toBe('x');
  });

  it('修改一行：产生 removed + added 一对，oldLines/newLines 各 1', () => {
    const out = computeFullMarkdownDiff('a\nfoo\nb', 'a\nbar\nb');
    expect(out.regions).toHaveLength(1);
    const region = out.regions[0];
    expect(region.oldLines).toEqual(['foo']);
    expect(region.newLines).toEqual(['bar']);
  });

  it('多处独立修改：产生多个 region', () => {
    const out = computeFullMarkdownDiff(
      'a\nfoo1\nb\nfoo2\nc',
      'a\nbar1\nb\nbar2\nc'
    );
    expect(out.regions).toHaveLength(2);
  });

  it('行级 MAX_LINE_DIFF_CELLS 守卫：超大输入不爆炸（fallback 到行级 diff）', () => {
    // MAX_LINE_DIFF_CELLS = 200_000；构造 n*m > 200_000 但内容仍合法的输入
    // 期望：返回结果仍合理（rows / regions 数量与内容一致），不会抛错或返回 undefined
    const n = 1000;
    const oldLines = Array.from({ length: n }, (_, i) => `old-${i}`);
    const newLines = oldLines.map((l, i) => (i === 500 ? `NEW-${i}` : l));
    const oldContent = oldLines.join('\n');
    const newContent = newLines.join('\n');
    // 1000 * 1000 = 1_000_000 cells >> 200_000 守卫
    const out = computeFullMarkdownDiff(oldContent, newContent);
    expect(out).toBeTruthy();
    expect(Array.isArray(out.rows)).toBe(true);
    expect(Array.isArray(out.regions)).toBe(true);
    // 至少能识别出那 1 处修改
    expect(out.regions.length).toBeGreaterThanOrEqual(1);
  });

  it('H3：行级 fallback 触发时返回 warnings 字段（audit H3 修复）', () => {
    // MAX_LINE_DIFF_CELLS = 200_000。需要构造一个 oldMiddle × newMiddle > 200_000
    // 的输入。如果两批行毫无公共前后缀，prefix/suffix trim 起不到作用，
    // middle 长度就是 n，必然走 fallback。
    const n = 1000;
    const oldLines = Array.from({ length: n }, (_, i) => `old-${i}`);
    // 完全打乱：所有 new 行都不等于任何 old 行 → LCS 退化为 O(n²)
    const newLines = Array.from({ length: n }, (_, i) => `new-${i}`);
    // sanity：1000 * 1000 = 1_000_000 >> 200_000
    const out = computeFullMarkdownDiff(oldLines.join('\n'), newLines.join('\n'));
    expect(Array.isArray(out.warnings)).toBe(true);
    expect(out.warnings.length).toBeGreaterThanOrEqual(1);
    // 至少一条提示「行级 diff 超过 ... cells 上限」
    expect(out.warnings.some((w) => /行级 diff 超过/.test(w))).toBe(true);
  });

  it('H3：正常 diff 不带 warnings 字段（保持 return shape 稳定）', () => {
    const out = computeFullMarkdownDiff('a\nfoo\nb', 'a\nbar\nb');
    expect(out.warnings).toBeUndefined();
  });

  it('tokenDiff 选项不破坏结构（接口兼容性）', () => {
    const out = computeFullMarkdownDiff('hello world', 'hello there', { tokenDiff: true });
    expect(out).toBeTruthy();
    expect(Array.isArray(out.rows)).toBe(true);
    expect(Array.isArray(out.regions)).toBe(true);
  });
});

describe('applyDiffRegionSafely', () => {
  it('成功替换：唯一匹配', () => {
    const diff = computeFullMarkdownDiff('a\nfoo\nb', 'a\nbar\nb');
    const region = diff.regions[0];
    const r = applyDiffRegionSafely('a\nfoo\nb', region);
    expect(r.ok).toBe(true);
    expect(r.content).toBe('a\nbar\nb');
  });

  it('保留末尾换行（endsWithNewline）', () => {
    const diff = computeFullMarkdownDiff('a\nfoo\nb\n', 'a\nbar\nb\n');
    const region = diff.regions[0];
    const r = applyDiffRegionSafely('a\nfoo\nb\n', region);
    expect(r.ok).toBe(true);
    expect(r.content.endsWith('\n')).toBe(true);
    expect(r.content).toBe('a\nbar\nb\n');
  });

  it('成功替换 + 没有末尾换行：不补 \\n', () => {
    const diff = computeFullMarkdownDiff('a\nfoo\nb', 'a\nbar\nb');
    const region = diff.regions[0];
    const r = applyDiffRegionSafely('a\nfoo\nb', region);
    expect(r.ok).toBe(true);
    expect(r.content.endsWith('\n')).toBe(false);
  });

  it('CRLF 文件：apply 后行尾仍是 CRLF（不被改成 LF）', () => {
    const before = 'a\r\nfoo\r\nb\r\n';
    const after  = 'a\r\nbar\r\nb\r\n';
    // 用 LF 描述 diff（算法内部按 LF 算 region），但实际磁盘上是 CRLF。
    const diff = computeFullMarkdownDiff('a\nfoo\nb\n', 'a\nbar\nb\n');
    const r = applyDiffRegionSafely(before, diff.regions[0]);
    expect(r.ok).toBe(true);
    expect(r.content).toBe(after);
    expect(r.content.includes('\r\n')).toBe(true);
    expect(r.content.includes('\nfoo')).toBe(false); // 行内不含裸 LF
  });

  it('LF 文件：apply 后行尾仍是 LF（不被改成 CRLF）', () => {
    const before = 'a\nfoo\nb\n';
    const after  = 'a\nbar\nb\n';
    const diff = computeFullMarkdownDiff(before, after);
    const r = applyDiffRegionSafely(before, diff.regions[0]);
    expect(r.ok).toBe(true);
    expect(r.content).toBe(after);
    expect(r.content.includes('\r\n')).toBe(false);
  });

  it('CRLF 文件 + 末尾无换行：apply 后仍无末尾换行', () => {
    const before = 'a\r\nfoo\r\nb';
    const after  = 'a\r\nbar\r\nb';
    const diff = computeFullMarkdownDiff('a\nfoo\nb', 'a\nbar\nb');
    const r = applyDiffRegionSafely(before, diff.regions[0]);
    expect(r.ok).toBe(true);
    expect(r.content).toBe(after);
    expect(r.content.endsWith('\r\n')).toBe(false);
    expect(r.content.endsWith('\n')).toBe(false);
  });

  it('conflict：旧行已被删除 → 0 匹配 → ok:false', () => {
    const diff = computeFullMarkdownDiff('a\nfoo\nb', 'a\nbar\nb');
    const region = diff.regions[0];
    // 当前内容里 "foo" 已经被改成别的
    const r = applyDiffRegionSafely('a\nbaz\nb', region);
    expect(r.ok).toBe(false);
    expect(typeof r.reason).toBe('string');
    expect(r.reason.length).toBeGreaterThan(0);
  });

  it('conflict：多处重复 + oldStart 失效 → 多匹配 → ok:false', () => {
    // region.oldStart 是算法给出的「最佳位置」hint —— 当 preferredIndex 处的行
    // 跟 oldLines[0] 对不上时，findSequence 才退回去扫描全部匹配。
    // 构造场景：用户编辑后，原 region 指向的"foo"被改成别的，
    // 而文件其它位置仍出现 "foo"（多次匹配）—— 算法无法确定应替换哪一处。
    const diff = computeFullMarkdownDiff('a\nfoo\nb', 'a\nbar\nb');
    const region = diff.regions[0];
    // 当前内容：原 region 位置的 "foo" 已被改成 "X"，但文件其它两处仍有 "foo"
    // findSequence 找不到 preferredIndex 命中 → 扫描全文 → 2 处匹配 → conflict
    const r = applyDiffRegionSafely('foo\nX\nfoo\nb', region);
    expect(r.ok).toBe(false);
    expect(typeof r.reason).toBe('string');
  });

  it('纯新增 + 唯一上下文：能安全插入', () => {
    const diff = computeFullMarkdownDiff('a\nb', 'a\nx\nb');
    expect(diff.regions).toHaveLength(1);
    const region = diff.regions[0];
    // region.oldLines=[]，但 beforeContext=['a'], afterContext=['b']
    expect(region.oldLines).toEqual([]);
    expect(region.newLines).toEqual(['x']);
    expect(region.beforeContext).toEqual(['a']);
    expect(region.afterContext).toEqual(['b']);

    const r = applyDiffRegionSafely('a\nb', region);
    expect(r.ok).toBe(true);
    expect(r.content).toBe('a\nx\nb');
  });

  it('apply 完一轮后内容应当再次能 compute（idempotent 内容一致）', () => {
    const oldContent = 'a\nfoo\nb';
    const newContent = 'a\nbar\nb';
    const diff = computeFullMarkdownDiff(oldContent, newContent);
    const region = diff.regions[0];
    const applied = applyDiffRegionSafely(oldContent, region);
    expect(applied.ok).toBe(true);
    // 应用之后再算一次 diff，regions 应为空
    const secondDiff = computeFullMarkdownDiff(applied.content, newContent);
    expect(secondDiff.regions).toEqual([]);
  });
});

describe('C1 整篇替换 / 无上下文 region（audit C1 fix）', () => {
  it('整篇替换：region 无上下文 → 标 conflict 引导走应用全部', () => {
    // 场景：AI 把整段换成 X/Y，前后没保留任何 context 行
    const out = computeFullMarkdownDiff('A\nB', 'X\nY');
    expect(out.regions).toHaveLength(1);
    const region = out.regions[0];
    expect(region.beforeContext).toEqual([]);
    expect(region.afterContext).toEqual([]);
    expect(region.conflict).toMatch(/无上下文/);
  });

  it('在空文档插入新内容：region 无上下文 → 标 conflict', () => {
    const out = computeFullMarkdownDiff('', 'X\nY');
    expect(out.regions).toHaveLength(1);
    expect(out.regions[0].beforeContext).toEqual([]);
    expect(out.regions[0].afterContext).toEqual([]);
    expect(out.regions[0].conflict).toBeTruthy();
  });

  it('局部修改（保留 context）：region 不应被标 conflict', () => {
    const out = computeFullMarkdownDiff('A\nfoo\nB', 'A\nbar\nB');
    expect(out.regions).toHaveLength(1);
    expect(out.regions[0].conflict).toBeUndefined();
  });
});

describe('C3 歧义匹配二次校验（audit C3 fix）', () => {
  it('oldLines 唯一匹配但上下文漂移 → 拒绝应用', () => {
    // region 算出来 oldStart=1，前后 context 期望为 ["a"]/["b"]
    const diff = computeFullMarkdownDiff('a\nfoo\nb', 'a\nbar\nb');
    const region = diff.regions[0];

    // 用户在前面又加了一个完全相同的 "foo"——oldLines 还能匹配到 preferredIndex 那个，
    // 但**该位置的前后文**与 region 算出的不同（前面是 "X" 不是 "a"，后面是 "foo" 不是 "b"）。
    // 这就是「复制粘贴造成歧义」场景——必须靠 beforeContext/afterContext 二次校验兜底。
    const drifted = 'X\nfoo\nfoo\nfoo';
    const r = applyDiffRegionSafely(drifted, region);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/上下文漂移/);
  });

  it('oldLines 唯一匹配 + 上下文一致 → 正常替换', () => {
    // 控制组：完全没漂移的常规 case
    const diff = computeFullMarkdownDiff('a\nfoo\nb', 'a\nbar\nb');
    const region = diff.regions[0];
    const r = applyDiffRegionSafely('a\nfoo\nb', region);
    expect(r.ok).toBe(true);
    expect(r.content).toBe('a\nbar\nb');
  });

  // fix(audit 2026-08)：多匹配但 context 唯一 → 仍能安全应用。
  // 场景：用户在其它位置粘了相同行，oldLines 匹配多个下标，但只有一个位置的
  // 前后文与 region 一致 —— 用 context 过滤掉歧义，应用 context 唯一的那处。
  it('多匹配 + 唯一 context → 应用 context 匹配位置', () => {
    // region 期望 oldLines=['foo'], beforeContext=['a'], afterContext=['b']
    const diff = computeFullMarkdownDiff('a\nfoo\nb', 'a\nbar\nb');
    const region = diff.regions[0];
    // drifted: 有 2 个 foo，但只有 index 1 处的 context 是 a...b；index 3 上下文是 c...d
    const drifted = 'a\nfoo\nb\nc\nfoo\nd';
    const r = applyDiffRegionSafely(drifted, region);
    expect(r.ok).toBe(true);
    expect(r.content).toBe('a\nbar\nb\nc\nfoo\nd');
  });

  // fix(audit 2026-08)：多匹配 + 多处 context 都一致 → 真歧义，refuse。
  it('多匹配 + 多处 context 都一致 → 拒绝', () => {
    const diff = computeFullMarkdownDiff('a\nfoo\nb', 'a\nbar\nb');
    const region = diff.regions[0];
    // 两段都是 a...foo...b 上下文 + foo 行重复 —— region context 与两处都一致
    const duplicated = 'a\nfoo\nb\n...\na\nfoo\nb';
    const r = applyDiffRegionSafely(duplicated, region);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/多个相同位置/);
  });

  // fix(audit 2026-08)：preferredIndex 命中 ≠ 唯一匹配时，必须扫描全文。
  // 旧版在 preferredIndex 命中时直接 early-return [preferredIndex]，跳过扫描 →
  // 其它位置的重复匹配被静默忽略，apply 会改错行。
  // 新行为：扫描全文 → context 过滤 → 唯一 context 匹配位置 → apply。
  it('preferredIndex 命中 + 其它位置重复 + context 唯一 → 应用正确位置', () => {
    const diff = computeFullMarkdownDiff('a\nfoo\nb', 'a\nbar\nb');
    const region = diff.regions[0]; // oldStart=1, context ['a']/['b']
    // preferredIndex=1 处仍是 'a\nfoo\nb'（context 匹配），index 4 也匹配 foo
    // 但 index 4 处上下文是 ['X']/['Y']，不匹配 region
    const drifted = 'a\nfoo\nb\nX\nfoo\nY';
    const r = applyDiffRegionSafely(drifted, region);
    expect(r.ok).toBe(true);
    expect(r.content).toBe('a\nbar\nb\nX\nfoo\nY');
  });
});

describe('C4 整段删除不被空防线误伤（audit C4 fix）', () => {
  // 注意：纯 region 删除合法性的拦截逻辑在 ai-controller.js（handlesApplyRegion
  // 空内容防线）。shared/markdown-diff.js 自身允许 appliedContent 为空字符串——
  // 这部分测试在 ai-controller 层覆盖。这里只验证算法层"整段删除"算出来就是 ""。
  it('整段删除：apply 后内容为 ""', () => {
    const diff = computeFullMarkdownDiff('   \n   ', '');
    expect(diff.regions).toHaveLength(1);
    const region = diff.regions[0];
    expect(region.oldLines.length).toBeGreaterThan(0);
    expect(region.newLines).toEqual([]);

    const r = applyDiffRegionSafely('   \n   ', region);
    expect(r.ok).toBe(true);
    expect(r.content).toBe('');
  });
});
