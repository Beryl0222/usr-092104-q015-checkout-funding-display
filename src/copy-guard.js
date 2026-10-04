/**
 * 诱导文案守卫。
 *
 * 合规红线：贷款、理财、分期渠道不得以「低门槛」「秒到账」等诱导性表述
 * 进入支付流程。规则发布时逐字段扫描所有面向用户的文案；命中即拒绝发布，
 * 守卫本身只做判定，不修改文案（不允许系统悄悄替运营改写）。
 */

export const BANNED_PHRASES = [
  "低门槛",
  "零门槛",
  "无门槛",
  "秒到账",
  "秒下款",
  "极速到账",
  "即时到账",
  "最快到账",
  "零利息",
  "零利率",
  "免息",
  "零首付",
  "零费用",
  "免费借",
  "随便花",
  "闭眼借",
  "一键借钱",
  "放心借",
  "无需还款",
  "稳赚",
  "保本保息",
  "收益率高达",
  "躺着赚",
];

/** 递归收集对象中所有字符串。 */
function collectStrings(node, acc) {
  if (typeof node === "string") acc.push(node);
  else if (Array.isArray(node)) for (const item of node) collectStrings(item, acc);
  else if (node && typeof node === "object") for (const v of Object.values(node)) collectStrings(v, acc);
  return acc;
}

/**
 * 扫描一份文案对象（或字符串）。
 * @returns {{phrase:string, field_hint?:string}[]} 命中的禁用词列表，空数组表示通过。
 */
export function findInducements(copy) {
  const hits = [];
  for (const text of collectStrings(copy, [])) {
    for (const phrase of BANNED_PHRASES) {
      if (text.includes(phrase) && !hits.some((h) => h.phrase === phrase)) {
        hits.push({ phrase, context: text.length > 60 ? `${text.slice(0, 60)}…` : text });
      }
    }
  }
  return hits;
}
