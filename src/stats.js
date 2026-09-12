// 文本统计 —— 词数 / 行数 / 字符数 的单一来源
//
// 单一来源原因：
//   之前 editor.getStats() 走 view.state.doc.lines（CM6 逻辑行），viewer.getStats()
//   走 source.split('\n').length —— 同一份内容在 preview / edit 模式下状态栏
//   「N 行」会跳变（例如尾部空行 / 长内容折行）。这里把行数算法收敛为：
//   - 源文本 = source 给的（无论从 CM6 还是从 viewer 缓存）
//   - 行数 = 非空行数（至少 1）
//
// CJK 分词算法保留 utils.countWords 的版本（已迭代到正确版本）：
//   - 中文 / 日文 / 韩文字符按字符计
//   - 拉丁 / 数字按空白分词后再过滤纯标点
//   - 不重叠计数

/**
 * 统计 CJK 友好的词数。
 * 实现细节见 utils.countWords（语义相同，只是换了模块）。
 *
 * @param {string} text
 * @returns {number}
 */
export function countWords(text) {
  if (!text || typeof text !== 'string') return 0;
  const trimmed = text.trim();
  if (!trimmed) return 0;
  const cjkRe = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
  const cjkCount = (trimmed.match(cjkRe) || []).length;
  const latinPart = trimmed.replace(cjkRe, ' ');
  const latinCount = (latinPart.match(/\S+/g) || [])
    .filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
  return cjkCount + latinCount;
}

/**
 * 统一统计：基于「源文档」字符串同时给出 chars/words/lines。
 *
 * - chars = source.length（不含末尾 trimming；CM6 doc.toString() 不含末尾换行）
 * - words = countWords(source)（CJK 单字 + 拉丁词）
 * - lines = 非空行数（至少 1，纯空白内容 = 1 行）
 *
 * 用 source 而不是 bodyElement.textContent：
 *   切预览 / 编辑时状态栏「N 行」不会跳变。textContent 是渲染后的纯文本，
 *   与 markdown 源（特别是 HTML / 列表 / 代码块）数量上不同。
 *
 * @param {string} source
 * @returns {{chars:number, words:number, lines:number}}
 */
export function getTextStats(source) {
  const text = typeof source === 'string' ? source : '';
  if (!text) return { chars: 0, words: 0, lines: 0 };
  // 非空行数：split 出所有行，去掉纯空白，再取长度。
  // 纯空白内容（只有 \n / 空格）→ 0 行，让 formatStatusStats 走「0 词」分支。
  // 之前用 `|| 1` 把「空」和「刚好 1 行内容」都映射成 1，新打开的空白文件
  // 状态栏立刻显示「1 行」误导用户以为已有内容（audit L8）。
  const lines = text.split('\n').filter((ln) => ln.trim().length > 0).length;
  return {
    chars: text.length,
    words: countWords(text),
    lines,
  };
}

/**
 * 渲染状态栏 chip 文案。
 *   - 0 行 / 0 词时不显示（由 caller 决定）
 *   - 单文件被删或为空 → `${words} 词`
 *   - 正常 → `${words} 词 · ${lines} 行`
 *
 * @param {{words:number, lines:number}} stats
 * @returns {string}
 */
export function formatStatusStats(stats) {
  const words = (stats.words || 0).toLocaleString('zh-CN');
  const lines = stats.lines || 0;
  return lines > 0 ? `${words} 词 · ${lines} 行` : `${words} 词`;
}
