/**
 * 展示规则（display_policy）：发布校验、灰度解析、回滚。
 *
 * 规则只决定「可以怎样展示」：排序、分组、文案、风险提示、费用口径。
 * 红线（在发布时强制，违规规则不得入库）：
 * 1. 默认渠道必须是自有资金渠道，且必须存在于排序中；
 * 2. 金融产品（消费信贷/分期）必须配置非空风险提示与取消后果；
 * 3. 分期必须配置可计算的费用口径；
 * 4. 全部面向用户文案不得包含诱导性表述。
 */

import { findInducements } from "./copy-guard.js";

export const CREDIT_KINDS = new Set(["consumer_credit", "installment"]);

export function kindOfNature(kind) {
  if (kind === "bank_card" || kind === "account_balance" || kind === "money_fund") return "own_funds";
  if (kind === "consumer_credit" || kind === "installment") return "credit_product";
  throw new Error(`未知渠道类型：${kind}`);
}

/** 简易语义版本比较：a >= b。 */
export function semverGte(a, b) {
  const pa = String(a).split(".").map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return true;
}

function nonEmpty(s) {
  return typeof s === "string" && s.trim().length > 0;
}

/**
 * 校验待发布规则。
 * @param {object} policy 待发布规则
 * @param {Map} channelById 渠道目录（渠道主数据，规则不能杜撰渠道）
 * @returns {string[]} 错误列表，空数组表示可发布
 */
export function validatePolicy(policy, channelById) {
  const errors = [];
  const requireText = (cond, msg) => {
    if (!cond) errors.push(msg);
  };

  requireText(policy && typeof policy === "object", "规则必须是对象");
  if (errors.length) return errors;
  requireText(policy.policy_id, "缺少 policy_id");
  requireText(Number.isInteger(policy.version) && policy.version >= 1, "version 必须为正整数");
  requireText(Array.isArray(policy.channel_order) && policy.channel_order.length > 0, "channel_order 必须是非空数组");
  requireText(nonEmpty(policy.default_channel_id), "必须指定 default_channel_id");

  const order = policy.channel_order || [];
  for (const cid of order) {
    const ch = channelById.get(cid);
    requireText(!!ch, `排序引用了不存在的渠道：${cid}`);
  }
  if (new Set(order).size !== order.length) errors.push("channel_order 存在重复渠道");

  const defaultChannel = channelById.get(policy.default_channel_id);
  if (defaultChannel) {
    requireText(defaultChannel.nature === "own_funds", "默认渠道必须是自有资金支付工具，金融产品不得默认选中");
    requireText(order.includes(policy.default_channel_id), "默认渠道必须在 channel_order 中");
  }

  // 排序中任何金融产品都不得携带默认标记——默认项唯一且必须为自有资金（上面已保证）。
  const copy = policy.channel_copy || {};
  for (const cid of order) {
    const ch = channelById.get(cid);
    if (!ch) continue;
    const c = copy[cid] || {};
    requireText(nonEmpty(c.tagline), `渠道 ${cid} 缺少展示短句 tagline`);
    requireText(nonEmpty(c.cancel_consequence), `渠道 ${cid} 缺少取消后果说明`);
    if (ch.nature === "credit_product") {
      requireText(nonEmpty(c.risk_warning), `金融产品 ${cid} 必须配置风险提示`);
      if (ch.kind === "installment") {
        const p = (policy.pricing || {})[cid];
        requireText(
          !!p && Number.isInteger(p.annual_rate_bp) && p.annual_rate_bp >= 0 && p.method === "equal_monthly_payment",
          `分期渠道 ${cid} 必须配置 annual_rate_bp 与 equal_monthly_payment 费用口径`
        );
        requireText(nonEmpty(p && p.rate_description), `分期渠道 ${cid} 缺少利率说明文案`);
      }
    }
  }

  // 诱导文案守卫：扫描所有展示文案（分组、短句、提示、取消后果、利率说明）。
  const hits = findInducements({ sections: policy.sections, channel_copy: policy.channel_copy, pricing: policy.pricing });
  for (const h of hits) errors.push(`诱导性表述「${h.phrase}」不得进入支付流程（命中：${h.context}）`);

  return errors;
}

/**
 * 灰度解析：在当前有效规则版本中，选择适用于该商户+客户端版本的最高版本。
 * 商户名单（"*" 表示全量）与最低客户端版本同时满足才命中灰度。
 *
 * @param {Map<number, object>} versionMap version -> policy（含 status）
 * @param {{merchant_id:string, app_version:string}} ctx
 * @returns {{policy:object, considered:object[]}}
 */
export function resolvePolicy(versionMap, { merchant_id, app_version }) {
  const considered = [];
  const matches = [];
  for (const policy of versionMap.values()) {
    if (policy.status !== "active") continue;
    const scope = policy.scope || {};
    const merchants = Array.isArray(scope.merchant_ids) ? scope.merchant_ids : ["*"];
    const merchantHit = merchants.includes("*") || merchants.includes(merchant_id);
    const versionHit = !scope.min_app_version || semverGte(app_version || "1.0.0", scope.min_app_version);
    const entry = {
      version: policy.version,
      scope: scope,
      merchant_hit: merchantHit,
      version_hit: versionHit,
      matched: merchantHit && versionHit,
    };
    considered.push(entry);
    if (entry.matched) matches.push(policy);
  }
  if (matches.length === 0) throw new Error("没有适用于该商户/客户端版本的有效展示规则");
  matches.sort((a, b) => b.version - a.version);
  return { policy: matches[0], considered };
}
