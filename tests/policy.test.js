import assert from "node:assert/strict";
import test from "node:test";

import { resolvePolicy, semverGte, validatePolicy } from "../src/policy.js";

const channels = new Map([
  ["card", { channel_id: "card", kind: "bank_card", nature: "own_funds" }],
  ["balance", { channel_id: "balance", kind: "account_balance", nature: "own_funds" }],
  ["fund", { channel_id: "fund", kind: "money_fund", nature: "own_funds" }],
  ["credit", { channel_id: "credit", kind: "consumer_credit", nature: "credit_product" }],
  ["inst3", { channel_id: "inst3", kind: "installment", nature: "credit_product", installment_terms: 3 }],
]);

function policy(over = {}) {
  return {
    policy_id: "checkout_rules",
    version: 1,
    status: "active",
    scope: { merchant_ids: ["*"], min_app_version: "1.0.0" },
    channel_order: ["card", "balance", "fund", "credit", "inst3"],
    default_channel_id: "card",
    sections: {
      own_funds: { title: "支付工具", description: "自有资金" },
      credit_product: { title: "金融产品", description: "借款需主动选择" },
    },
    channel_copy: {
      card: { tagline: "储蓄卡", cancel_consequence: "原路退回" },
      balance: { tagline: "余额", cancel_consequence: "退回余额" },
      fund: { tagline: "赎回基金", risk_warning: "基金不等同存款", cancel_consequence: "退回余额" },
      credit: { tagline: "下月还款", risk_warning: "这是消费贷款，逾期计息并影响征信", cancel_consequence: "退款冲抵账单" },
      inst3: { tagline: "分3期", risk_warning: "这是分期贷款，总费用高于订单金额", cancel_consequence: "按合同处理" },
    },
    pricing: {
      inst3: { annual_rate_bp: 720, method: "equal_monthly_payment", rate_description: "年化利率7.20%" },
    },
    ...over,
  };
}

test("基线合规规则通过发布校验", () => {
  assert.deepEqual(validatePolicy(policy(), channels), []);
});

test("默认渠道是金融产品时拒绝发布", () => {
  const errors = validatePolicy(policy({ default_channel_id: "credit" }), channels);
  assert.ok(errors.some((e) => e.includes("默认渠道必须是自有资金")));
});

test("默认渠道为分期渠道同样拒绝（任何贷款/分期都不得默认选中）", () => {
  const errors = validatePolicy(policy({ default_channel_id: "inst3" }), channels);
  assert.ok(errors.some((e) => e.includes("金融产品不得默认选中")));
});

test("默认渠道不在排序中拒绝发布", () => {
  // 排序只含储蓄卡，默认项却是余额（渠道真实存在但不在本次排序中）
  const errors = validatePolicy(
    policy({ channel_order: ["card"], default_channel_id: "balance" }),
    channels
  );
  assert.ok(errors.some((e) => e.includes("默认渠道必须在 channel_order")));
});

test("金融产品缺少风险提示或取消后果时拒绝发布", () => {
  const bad = policy();
  bad.channel_copy.credit.risk_warning = "  ";
  const errors = validatePolicy(bad, channels);
  assert.ok(errors.some((e) => e.includes("必须配置风险提示")));
});

test("分期缺少可计算费用口径时拒绝发布", () => {
  const bad = policy();
  bad.pricing.inst3 = { method: "equal_monthly_payment" };
  assert.ok(validatePolicy(bad, channels).some((e) => e.includes("annual_rate_bp")));
});

test("排序引用不存在渠道或出现重复时拒绝发布", () => {
  const bad = policy({ channel_order: ["card", "ghost"] });
  assert.ok(validatePolicy(bad, channels).some((e) => e.includes("不存在的渠道")));
  const dup = policy({ channel_order: ["card", "card"] });
  assert.ok(validatePolicy(dup, channels).some((e) => e.includes("重复")));
});

test("诱导文案（低门槛/秒到账）导致规则拒绝发布", () => {
  const bad = policy();
  bad.channel_copy.credit.tagline = "低门槛秒到账";
  const errors = validatePolicy(bad, channels);
  assert.ok(errors.some((e) => e.includes("低门槛")));
  assert.ok(errors.some((e) => e.includes("秒到账")));
});

test("灰度解析：商户 + 最低客户端版本同时命中才适用", () => {
  const v1 = policy();
  const v2 = policy({
    version: 2,
    scope: { merchant_ids: ["m_demo"], min_app_version: "2.1.0" },
  });
  const map = new Map([[1, v1], [2, v2]]);

  assert.equal(resolvePolicy(map, { merchant_id: "m_demo", app_version: "2.1.0" }).policy.version, 2);
  assert.equal(resolvePolicy(map, { merchant_id: "m_demo", app_version: "2.0.0" }).policy.version, 1);
  assert.equal(resolvePolicy(map, { merchant_id: "m_other", app_version: "3.0.0" }).policy.version, 1);

  const { considered } = resolvePolicy(map, { merchant_id: "m_demo", app_version: "2.0.0" });
  const v2Entry = considered.find((c) => c.version === 2);
  assert.equal(v2Entry.merchant_hit, true);
  assert.equal(v2Entry.version_hit, false);
  assert.equal(v2Entry.matched, false);
});

test("灰度解析：rolled_back 版本不再命中，回滚后回落到旧版本", () => {
  const v1 = policy();
  const v2 = policy({ version: 2, scope: { merchant_ids: ["m_demo"], min_app_version: "1.0.0" } });
  v2.status = "rolled_back";
  const map = new Map([[1, v1], [2, v2]]);
  assert.equal(resolvePolicy(map, { merchant_id: "m_demo", app_version: "3.0.0" }).policy.version, 1);
});

test("无任何适用规则时抛出错误", () => {
  const v1 = policy({ scope: { merchant_ids: ["m_only"], min_app_version: "1.0.0" } });
  assert.throws(() => resolvePolicy(new Map([[1, v1]]), { merchant_id: "m_x", app_version: "1.0.0" }), /没有适用/);
});

test("semverGte 版本比较", () => {
  assert.equal(semverGte("2.1.0", "2.1.0"), true);
  assert.equal(semverGte("3.0.0", "2.1.0"), true);
  assert.equal(semverGte("2.0.9", "2.1.0"), false);
  assert.equal(semverGte("2.1", "2.1.0"), true);
});
