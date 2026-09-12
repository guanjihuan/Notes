// Heading slug 的唯一算法（preload + renderer 共用）
//
// 唯一调用点：把 heading 文本转成 [A-Za-z0-9-]+ 形式的 slug id。
// 因为 preload（marked renderer.heading）和 renderer 端都会
// 产生「指向同一 DOM 节点」的 id，必须用同一份算法 —— 否则
// 文内锚点会因 id 不一致定位失败。
//
// 设计取舍：
//   - 保留 \p{L} / \p{N} / \p{M}：CJK（含扩展平面 A/B/...）+ 拉丁扩展字母都能保留
//   - 删除 markdown 行内 HTML 标签 / 反引号 / 星号 / 下划线 / 波浪号：
//     这些「标记符号」不应进 id，否则直接复制渲染出的 id 会得到带引号的字符串
//     （下划线一并剥离，与 marked 旧默认行为一致；GitHub 是保留的，
//     但那会让 `hello_world` / `_em_` 这种 heading 算成同一个 base，撞名重）
//   - 空白 → `-`；不裁首尾 `-`：避免 `# --foo--` → `foo` 这种出乎用户意料的别名
//   - 纯符号 / 空白输入返回 `''`：由 `slugifyHeading`（带 `seenSlugs` 的版本）
//     兜底成 `'section'`，保证渲染出的 DOM id 非空可点击
//
// 这份文件被两类消费者使用：
//   - preload.js（CJS，require）：marked renderer 决定 DOM 上的真实 id
//   - src/outline.js（renderer ESM）：源码级镜像一份（renderer 不能 import CJS）
// 改算法 = 同步改两边 + 测试 + 检查 outline.test.js 与 slug.test.js 的期望值。

'use strict';

/**
 * 把 heading 文本转成「基础 slug」（无重复检测、无空值兜底）。
 *
 * 返回空串意味着：原文剥完 HTML + 行内标记后什么都不剩（纯符号 heading）。
 * outline.js 用这一点判断是否要跳过这个 heading（导航没意义）。
 * preload.js 的 slugifyHeading 把它当 base，再走 `|| 'section'` 兜底 + 撞名加后缀。
 *
 * @param {string} raw
 * @returns {string}
 */
function slugifyHeadingBase(raw) {
  // audit fix (shared-M5)：先 normalize('NFC') 把 NFD 字符串（如 macOS
  // 默认文件系统产出的 café 这种「e + 组合 ́」）合并成预组合字符，
  // 再做后续 replace。否则 NFD 与 NFC 的同一逻辑 heading 会生成两个不同
  // DOM id，outline 点击就会跳到错误锚点。Windows / WSL / 云盘同步经常会
  // 带来混合 normalization，这个守卫保证 slug 只看逻辑字符。
  return String(raw)
    .normalize('NFC')
    .replace(/<[^>]*>/g, '')          // 行内 HTML
    .replace(/[`*_~]/g, '')           // 行内标记符号
    .trim()
    .toLowerCase()
    // \p{L} = 任意 Unicode 字母（含中日韩），\p{N} = 数字，\p{M} = 组合记号
    .replace(/[^\p{L}\p{N}\p{M}\s-]/gu, '')
    .replace(/\s+/g, '-');
}

/**
 * 带重复检测的 slug 生成器。
 *
 * 同名 heading 在文档内会得到 `-1`、`-2`、... 后缀（marked 默认行为）。
 * 调用方负责在每次「解析整篇文档」前清空 `seenSlugs`，让计数按文档重置。
 * 空 base 回退 `'section'`，保证 id 始终非空可点击。
 *
 * @param {string} raw
 * @param {Set<string>} seenSlugs - 已被本次解析用过的 slug 集合
 * @returns {string}
 */
function slugifyHeading(raw, seenSlugs) {
  const base = slugifyHeadingBase(raw) || 'section';
  let slug = base;
  let i = 1;
  while (seenSlugs.has(slug)) {
    slug = `${base}-${i}`;
    i += 1;
  }
  seenSlugs.add(slug);
  return slug;
}

module.exports = {
  slugifyHeadingBase,
  slugifyHeading,
};