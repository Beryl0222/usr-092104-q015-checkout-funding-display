/**
 * 合规规则端到端测试：发布拦截、组装区隔、主动选择、灰度证据、回滚不变性、回调幂等、审计一致性。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { CHANNEL_CATALOG, CHANNEL_GROUP, RULE_CODES } from "../src/domain/enums.js";
import { composeCheckout, findSolicitingPhrases, validatePolicyDraft } from "../src/domain/rules.js";
import { EventStore } from "../src/server/store.js";
import { PolicyService } from "../src/server/policy-service.js";
import { CheckoutService } from "../src/server/checkout-service.js";
import { buildAuditReport } from "../src/server/audit.js";
import { availabilityProvider, baselinePolicy, eligibilityProvider, pricingProvider } from "../src/server/seed.js";

function newSystem() {
  const store = new EventStore(null);
  const policies = new PolicyService(store, { channelCatalog: CHANNEL_CATALOG });
  const pub = policies.publish({ policy: baselinePolicy(), scope: {}, published_by: "test" });
  assert.equal(pub.errors.length, 0);
  const checkout = new CheckoutService(store, {
    policies,
    channelCatalog: CHANNEL_CATALOG,
    eligibilityProvider,
    availabilityProvider,
    pricingProvider,
  });
  return { store, policies, checkout };
}

function compose(checkout, overrides = {}) {
  return checkout.compose({
    session_id: `sess-${Math.random()}`,
    order_id: `ORD-${Math.random()}`,
    merchant_id: "M001",
    user_id: "user-001",
    client_version: "8.5.0",
    amount: 19900,
    ...overrides,
  });
}

// ---------- R-PAY-004 诱导文案 ----------
test("诱导文案黑名单命中常见变体", () => {
  assert.deepEqual(findSolicitingPhrases("低 门 槛，秒到账！"), ["低门槛", "秒到账"]);
  assert.deepEqual(findSolicitingPhrases("正常中性说明文案"), []);
});

// ---------- 策略发布期合规拦截 ----------
test("违规策略发布被拦截：信贷置顶 + 信贷默认 + 诱导文案", () => {
  const { policies } = newSystem();
  const bad = {
    group_order: ["CREDIT", "PAYMENT_TOOL", "WEALTH"],
    channel_rules: {
      CONSUMER_CREDIT: { rank: 100, default_selected: true, marketing_text: "低门槛秒到账，人人可借" },
      BANK_CARD: { rank: 90 },
    },
  };
  const { version, errors } = policies.publish({ policy: bad, published_by: "pm" });
  assert.equal(version, null);
  const codes = new Set(errors.map((e) => e.code));
  assert.ok(codes.has(RULE_CODES.GROUP_SEPARATION), "信贷分组不得置顶");
  assert.ok(codes.has(RULE_CODES.NO_CREDIT_DEFAULT), "信贷不得默认选中");
  assert.ok(codes.has(RULE_CODES.NO_SOLICITING_COPY), "诱导文案必须拦截");
});

test("货币基金配置为默认选中同样被拦截（理财不得默认）", () => {
  const errors = validatePolicyDraft(
    { version: 9, group_order: ["PAYMENT_TOOL", "WEALTH", "CREDIT"], channel_rules: { MONEY_FUND: { default_selected: true } } },
    { channelCatalog: CHANNEL_CATALOG },
  );
  assert.ok(errors.some((e) => e.code === RULE_CODES.NO_CREDIT_DEFAULT));
});

// ---------- R-PAY-001/002/003 组装行为 ----------
test("推荐分把信贷打到最高，也不能把信贷顶到首位或设为默认", () => {
  const { checkout } = newSystem();
  const snap = compose(checkout, {
    recommendations: [
      { channel_code: "CONSUMER_CREDIT", score: 999 },
      { channel_code: "INSTALLMENT", score: 998 },
      { channel_code: "ACCOUNT_BALANCE", score: 95 },
      { channel_code: "BANK_CARD", score: 90 },
    ],
  });
  assert.deepEqual(snap.groups.map((g) => g.group), ["PAYMENT_TOOL", "WEALTH", "CREDIT"]);
  assert.equal(snap.default_channel_code, "BANK_CARD", "默认项必须是支付工具基线配置（银行卡）");
  const creditGroup = snap.groups.find((g) => g.group === CHANNEL_GROUP.CREDIT);
  for (const ch of creditGroup.channels) {
    assert.equal(ch.requires_explicit_ack, true);
    assert.notEqual(ch.channel_code, snap.default_channel_code);
  }
  // 支付组内推荐分生效：账户余额在银行卡之上？基线默认固定银行卡，但组内排序按分数
  const payCodes = snap.groups[0].channels.map((c) => c.channel_code);
  assert.ok(payCodes.indexOf("ACCOUNT_BALANCE") < payCodes.indexOf("BANK_CARD"));
});

test("用户资格与订单可用性排除渠道：user-002 看不到信贷/理财；小金额订单无分期", () => {
  const { checkout } = newSystem();
  const snap = compose(checkout, { user_id: "user-002", amount: 19900 });
  const visible = snap.groups.flatMap((g) => g.channels.map((c) => c.channel_code));
  assert.deepEqual(visible.sort(), ["ACCOUNT_BALANCE", "BANK_CARD"]);
  assert.ok(snap.suppressed.some((s) => s.channel_code === "CONSUMER_CREDIT" && s.reason === "NOT_ELIGIBLE"));

  const snap2 = compose(checkout, { user_id: "user-001", amount: 5000 });
  assert.ok(snap2.suppressed.some((s) => s.channel_code === "INSTALLMENT" && s.reason === "NOT_AVAILABLE"));
});

test("余额只读透传真实账务数据，编排层不伪造", () => {
  const { checkout } = newSystem();
  const snap = compose(checkout);
  const bank = snap.groups.flatMap((g) => g.channels).find((c) => c.channel_code === "BANK_CARD");
  assert.equal(bank.balance.amount, 520000);
  assert.equal(bank.balance.as_of_real, true);
  const credit = snap.groups.flatMap((g) => g.channels).find((c) => c.channel_code === "CONSUMER_CREDIT");
  assert.equal(credit.balance, null, "信贷不展示授信额度，额度由资金方审批，编排层不代批");
});

// ---------- R-PAY-005/006 费用透明与借款知情确认 ----------
test("借款渠道必须主动勾选知情确认；支付渠道直接可选", () => {
  const { checkout } = newSystem();
  let snap = compose(checkout, { amount: 20000, session_id: "s1", order_id: "O1" });
  assert.throws(
    () => checkout.select("s1", { channel_code: "CONSUMER_CREDIT" }),
    /主动勾选知情确认/,
  );
  const ok = checkout.select("s1", {
    channel_code: "CONSUMER_CREDIT",
    explicit_ack: true,
    ack_text: "我已知情确认这是借款并支付利息",
  });
  assert.equal(ok.selection.user_active_choice, true);
  assert.equal(ok.selection.was_default, false);
  const q = ok.selection.cost_quote;
  assert.ok(q.components.some((c) => c.type === "INTEREST"), "必须展示利息");
  assert.equal(q.total, 20000 + Math.round(20000 * 0.072 * 1));

  // 未展示渠道禁止选择
  assert.throws(() => checkout.select("s1", { channel_code: "FAKE_CHANNEL" }), /不在本次展示清单/);
});

// ---------- R-PAY-007 灰度证据 ----------
test("灰度策略仅命中 M002 × 客户端≥8.5.0，快照内保留证据", () => {
  const { policies, checkout } = newSystem();
  const v2 = {
    ...baselinePolicy(),
    channel_rules: {
      ...baselinePolicy().channel_rules,
      BANK_CARD: { rank: 90, label: "银行卡（储蓄卡）", subtitle: "使用银行存款支付" },
      ACCOUNT_BALANCE: { rank: 100, default_selected: true, label: "账户余额", subtitle: "使用支付账户余额支付" },
    },
  };
  const pub = policies.publish({
    policy: v2,
    scope: { merchant_ids: ["M002"], client_version: { min: "8.5.0" } },
    published_by: "pm-gray",
    activate_as_current: false,
  });
  assert.equal(pub.version, 2);

  const gray = compose(checkout, { merchant_id: "M002", client_version: "8.5.0", session_id: "g1", order_id: "OG1" });
  assert.equal(gray.policy_version, 2);
  assert.equal(gray.gray, true);
  assert.equal(gray.default_channel_code, "ACCOUNT_BALANCE");
  assert.deepEqual(gray.matched_scope.merchant_ids, ["M002"]);

  const oldClient = compose(checkout, { merchant_id: "M002", client_version: "8.3.0", session_id: "g2", order_id: "OG2" });
  assert.equal(oldClient.policy_version, 1);
  const otherMerchant = compose(checkout, { merchant_id: "M001", client_version: "8.5.0", session_id: "g3", order_id: "OG3" });
  assert.equal(otherMerchant.policy_version, 1);
});

// ---------- R-PAY-008 回滚不改变已确认选择 ----------
test("规则回滚后：已确认订单仍冻结旧版本与选择；新会话走回滚版本", () => {
  const { policies, checkout } = newSystem();
  const v2 = {
    ...baselinePolicy(),
    channel_rules: {
      ...baselinePolicy().channel_rules,
      BANK_CARD: { rank: 90, label: "银行卡", subtitle: "银行存款" },
      ACCOUNT_BALANCE: { rank: 100, default_selected: true, label: "账户余额", subtitle: "余额支付" },
    },
  };
  policies.publish({ policy: v2, scope: { merchant_ids: ["M002"] }, published_by: "pm" });

  // 在 v2 下完成选择+确认
  const snap = compose(checkout, { merchant_id: "M002", session_id: "rb1", order_id: "ORB1" });
  assert.equal(snap.policy_version, 2);
  checkout.select("rb1", { channel_code: "ACCOUNT_BALANCE" });
  const conf = checkout.confirm("rb1");
  assert.equal(conf.confirmation.policy_version_frozen, 2);
  assert.equal(conf.confirmation.channel_code, "ACCOUNT_BALANCE");

  // 回滚到 v1
  const r = policies.rollback({ to_version: 1, reason: "合规演练回滚" });
  assert.equal(r.from_version, 2);

  // 旧会话状态原样保留
  const frozen = checkout.getSession("rb1");
  assert.equal(frozen.policy_version, 2);
  assert.equal(frozen.confirmation.channel_code, "ACCOUNT_BALANCE");
  assert.equal(frozen.state, "CONFIRMED");
  assert.throws(() => checkout.select("rb1", { channel_code: "BANK_CARD" }), /已确认/);

  // 新会话命中 v1，默认项恢复银行卡
  const after = compose(checkout, { merchant_id: "M002", session_id: "rb2", order_id: "ORB2" });
  assert.equal(after.policy_version, 1);
  assert.equal(after.default_channel_code, "BANK_CARD");
});

// ---------- R-PAY-009 重复回调只结算一次 ----------
test("同一渠道流水号重复回调仅产生一次结算", () => {
  const { store, checkout } = newSystem();
  compose(checkout, { session_id: "cb1", order_id: "OCB1", amount: 19900 });
  checkout.select("cb1", { channel_code: "BANK_CARD" });
  checkout.confirm("cb1");

  const payload = { callback_id: "CB-1", order_id: "OCB1", session_id: "cb1", channel_code: "BANK_CARD", status: "SUCCESS", amount: 19900 };
  const r1 = checkout.onCallback({ ...payload });
  assert.equal(r1.settled, true);
  assert.equal(r1.consistency_ok, true);
  const r2 = checkout.onCallback({ ...payload });
  const r3 = checkout.onCallback({ ...payload });
  assert.deepEqual([r2.settled, r3.settled], [false, false]);
  assert.equal(r2.reason, "DUPLICATE_CALLBACK");

  const settled = store.all().filter((e) => e.event_type === "PAYMENT_SETTLED");
  assert.equal(settled.length, 1);
  const callbacks = store.all().filter((e) => e.event_type === "CALLBACK_RECEIVED");
  assert.equal(callbacks.length, 3);
  assert.equal(callbacks.filter((e) => e.duplicate_of_settled).length, 2);
});

test("换流水号对同一订单再次回调也不得二次结算", () => {
  const { checkout } = newSystem();
  compose(checkout, { session_id: "cb2", order_id: "OCB2" });
  checkout.select("cb2", { channel_code: "BANK_CARD" });
  checkout.confirm("cb2");
  checkout.onCallback({ callback_id: "A", order_id: "OCB2", session_id: "cb2", channel_code: "BANK_CARD", status: "SUCCESS", amount: 19900 });
  const again = checkout.onCallback({ callback_id: "B", order_id: "OCB2", session_id: "cb2", channel_code: "BANK_CARD", status: "SUCCESS", amount: 19900 });
  assert.equal(again.settled, false);
  assert.equal(again.reason, "ORDER_ALREADY_SETTLED");
});

test("回调金额与确认快照不一致时：结算留痕但一致性校验失败", () => {
  const { checkout } = newSystem();
  compose(checkout, { session_id: "cb3", order_id: "OCB3", amount: 19900 });
  checkout.select("cb3", { channel_code: "BANK_CARD" });
  checkout.confirm("cb3");
  const r = checkout.onCallback({ callback_id: "C", order_id: "OCB3", session_id: "cb3", channel_code: "BANK_CARD", status: "SUCCESS", amount: 99999 });
  assert.equal(r.settled, true);
  assert.equal(r.consistency_ok, false);
});

test("未确认会话收到成功回调不得结算", () => {
  const { checkout } = newSystem();
  compose(checkout, { session_id: "cb4", order_id: "OCB4" });
  checkout.select("cb4", { channel_code: "BANK_CARD" });
  const r = checkout.onCallback({ callback_id: "D", order_id: "OCB4", session_id: "cb4", channel_code: "BANK_CARD", status: "SUCCESS", amount: 19900 });
  assert.equal(r.settled, false);
  assert.equal(r.reason, "SESSION_NOT_CONFIRMED");
});

// ---------- 审计报告 ----------
test("合规全流程审计报告结论为 PASS，且单次结算核对通过", () => {
  const { store, checkout } = newSystem();
  compose(checkout, { session_id: "a1", order_id: "OA1" });
  checkout.select("a1", { channel_code: "BANK_CARD" });
  checkout.confirm("a1");
  checkout.onCallback({ callback_id: "E", order_id: "OA1", session_id: "a1", channel_code: "BANK_CARD", status: "SUCCESS", amount: 19900 });
  checkout.onCallback({ callback_id: "E", order_id: "OA1", session_id: "a1", channel_code: "BANK_CARD", status: "SUCCESS", amount: 19900 });

  const report = buildAuditReport(store);
  assert.equal(report.violations.length, 0, JSON.stringify(report.violations));
  assert.match(report.conclusion, /PASS/);
  assert.equal(report.settlement_summary.single_settlement_guaranteed, true);
  assert.equal(report.settlement_summary.duplicate_callbacks_ignored, 1);
  const row = report.settlement_summary.per_order.find((x) => x.order_id === "OA1");
  assert.deepEqual([row.callbacks, row.settlements], [2, 1]);
});

test("审计能发现展示与扣款不一致（FAIL）", () => {
  const { store, checkout } = newSystem();
  compose(checkout, { session_id: "a2", order_id: "OA2", amount: 19900 });
  checkout.select("a2", { channel_code: "BANK_CARD" });
  checkout.confirm("a2");
  checkout.onCallback({ callback_id: "F", order_id: "OA2", session_id: "a2", channel_code: "BANK_CARD", status: "SUCCESS", amount: 88888 });
  const report = buildAuditReport(store);
  assert.ok(report.violations.some((v) => v.rule === RULE_CODES.IDEMPOTENT_SETTLEMENT));
  assert.match(report.conclusion, /FAIL/);
});
