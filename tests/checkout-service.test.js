import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CheckoutService } from "../src/checkout-service.js";
import { buildAuditReport } from "../src/audit.js";

async function newService() {
  const seed = JSON.parse(await readFile(new URL("../data/seed.json", import.meta.url), "utf8"));
  return new CheckoutService(seed);
}

const byId = (s, cid) => s.groups.flatMap((g) => g.channels).find((c) => c.channel_id === cid);
const selectCredit = (svc, s, cid = "credit_pay") =>
  svc.selectChannel(s.session_id, cid, {
    explicit_selection: true,
    risk_acknowledged: true,
    action_source: "user_manual",
    client_event_id: "evt-1",
  });

// ─────────────── 组装：类别区隔 / 资格 / 可用性 / 默认项 ───────────────

test("会话分为支付工具与金融产品两个结构分组，各自标记资金性质", async () => {
  const svc = await newService();
  const s = svc.composeSession({ user_id: "u_credit", order_id: "ord_demo_001", app_version: "2.1.0" });
  assert.deepEqual(s.groups.map((g) => g.nature), ["own_funds", "credit_product"]);
  // v2 灰度排序：余额、货币基金、储蓄卡
  assert.deepEqual(s.groups[0].channels.map((c) => c.kind), ["account_balance", "money_fund", "bank_card"]);
  assert.deepEqual(s.groups[1].channels.map((c) => c.kind), ["consumer_credit", "installment"]);
  assert.ok(s.groups[0].title.includes("自己的钱"));
  assert.ok(s.groups[1].title.includes("借款"));
  for (const c of s.groups[1].channels) {
    assert.equal(c.nature, "credit_product");
    assert.equal(c.requires_explicit_ack, true);
    assert.ok(c.risk_warning);
  }
});

test("灰度规则 v2 只对 m_demo + 客户端≥2.1.0 生效，其余回落 v1", async () => {
  const svc = await newService();
  const gray = svc.composeSession({ user_id: "u_credit", order_id: "ord_demo_001", app_version: "2.1.0" });
  assert.equal(gray.policy.version, 2);
  assert.equal(gray.default_channel_id, "acct_balance");

  const oldClient = svc.composeSession({ user_id: "u_credit", order_id: "ord_demo_001", app_version: "1.9.0" });
  assert.equal(oldClient.policy.version, 1);
  assert.equal(oldClient.default_channel_id, "card_debit_6228");

  const oldMerchant = svc.composeSession({ user_id: "u_credit", order_id: "ord_legacy_001", app_version: "3.0.0" });
  assert.equal(oldMerchant.policy.version, 1);
});

test("未获授信用户看不到（资格排除）信贷与分期渠道，且不暴露任何额度数据", async () => {
  const svc = await newService();
  const s = svc.composeSession({ user_id: "u_no_credit", order_id: "ord_demo_001", app_version: "2.1.0" });
  const credit = byId(s, "credit_pay");
  const inst = byId(s, "installment_3");
  assert.equal(credit.enabled, false);
  assert.equal(credit.excluded, true);
  assert.match(credit.unavailable_reason, /授信核心/);
  assert.equal(credit.funds_info, null);
  assert.equal(inst.excluded, true);
});

test("余额不足渠道置灰不可选，展示层不得伪造余额使其可用", async () => {
  const svc = await newService();
  const s = svc.composeSession({ user_id: "u_balance_low", order_id: "ord_demo_001", app_version: "2.1.0" });
  // v2 默认项是余额，但该用户余额仅 5000 分 < 10000 分：不得预选
  assert.equal(s.default_channel_id, "card_debit_6228");
  const balance = byId(s, "acct_balance");
  assert.equal(balance.enabled, false);
  assert.match(balance.unavailable_reason, /不足/);
  assert.equal(balance.funds_info.amount_cents, 5000);
  assert.throws(() => svc.selectChannel(s.session_id, "acct_balance"), /不可用/);
});

test("任何版本下金融产品都不会成为默认项", async () => {
  const svc = await newService();
  for (const [user, ver] of [["u_credit", "2.1.0"], ["u_credit", "1.0.0"], ["u_no_credit", "2.1.0"]]) {
    const s = svc.composeSession({ user_id: user, order_id: "ord_demo_001", app_version: ver });
    assert.notEqual(s.default_channel_id, "credit_pay");
    assert.notEqual(s.default_channel_id, "installment_3");
    assert.ok(
      s.default_channel_id === null || byId(s, s.default_channel_id).nature === "own_funds",
      `默认项必须是自有资金或为空（user=${user}, v=${ver}）`
    );
  }
});

// ─────────────── 主动选择与金融产品显式证据 ───────────────

test("金融产品缺少显式选择或风险知悉证据时被拒绝", async () => {
  const svc = await newService();
  const s = svc.composeSession({ user_id: "u_credit", order_id: "ord_demo_001", app_version: "2.1.0" });
  await assert.rejects(
    async () => svc.selectChannel(s.session_id, "credit_pay", { action_source: "user_manual" }),
    /显式选择/
  );
  await assert.rejects(
    async () =>
      svc.selectChannel(s.session_id, "credit_pay", { explicit_selection: true, action_source: "user_manual" }),
    /风险/
  );
});

test("非用户主动来源（推荐服务代选）金融产品一律拒绝", async () => {
  const svc = await newService();
  const s = svc.composeSession({ user_id: "u_credit", order_id: "ord_demo_001", app_version: "2.1.0" });
  assert.throws(
    () =>
      svc.selectChannel(s.session_id, "credit_pay", {
        explicit_selection: true,
        risk_acknowledged: true,
        action_source: "recommendation_default",
      }),
    /推荐服务不得代选/
  );
});

test("金融产品显式选择后留下逐次证据（时间、来源、知悉标记、费用快照）", async () => {
  const svc = await newService();
  const s = svc.composeSession({ user_id: "u_credit", order_id: "ord_demo_001", app_version: "2.1.0" });
  const sel = selectCredit(svc, s);
  assert.equal(sel.explicit_selection, true);
  assert.equal(sel.risk_acknowledged, true);
  assert.equal(sel.action_source, "user_manual");
  assert.ok(sel.selected_at);
});

test("切换渠道后重新选金融产品需再次知悉（不沿用上一次勾选）", async () => {
  const svc = await newService();
  const s = svc.composeSession({ user_id: "u_credit", order_id: "ord_demo_001", app_version: "2.1.0" });
  selectCredit(svc, s);
  svc.selectChannel(s.session_id, "card_debit_6228");
  // 服务端：不带证据再次选信贷仍被拒绝
  assert.throws(
    () => svc.selectChannel(s.session_id, "credit_pay", { action_source: "user_manual" }),
    /显式选择/
  );
});

// ─────────────── 费用与确认 ───────────────

test("确认前可看清资金性质、总费用（分期含利息）与取消后果", async () => {
  const svc = await newService();
  const s = svc.composeSession({ user_id: "u_credit", order_id: "ord_demo_001", app_version: "2.1.0" });
  svc.selectChannel(s.session_id, "installment_3", {
    explicit_selection: true,
    risk_acknowledged: true,
    action_source: "user_manual",
  });
  const p = svc.previewConfirmation(s.session_id);
  assert.equal(p.channel_nature, "credit_product");
  assert.equal(p.amount_cents, 10000);
  assert.equal(p.fee_cents, 120);
  assert.equal(p.total_repay_cents, 10120);
  assert.match(p.risk_warning, /分期贷款/);
  assert.ok(p.cancel_consequence);
});

test("未选择渠道不能确认；选择被排除的渠道不能确认", async () => {
  const svc = await newService();
  const s = svc.composeSession({ user_id: "u_no_credit", order_id: "ord_demo_001", app_version: "2.1.0" });
  assert.throws(() => svc.confirmPayment(s.session_id), /先选择/);
  assert.throws(
    () => svc.selectChannel(s.session_id, "credit_pay", { action_source: "user_manual" }),
    /不可用|授信/
  );
});

// ─────────────── 回滚不改变已确认订单 ───────────────

test("规则回滚后：已确认订单仍冻结确认时版本；新会话解析到回落后的版本", async () => {
  const svc = await newService();
  const s = svc.composeSession({ user_id: "u_credit", order_id: "ord_demo_001", app_version: "2.1.0" });
  assert.equal(s.policy.version, 2);
  selectCredit(svc, s);
  const receipt = svc.confirmPayment(s.session_id);
  assert.equal(receipt.policy_version_frozen, 2);

  svc.rollbackPolicy(1, "暂停灰度");
  const after = svc.getReceiptByOrder("ord_demo_001");
  assert.equal(after.policy_version_frozen, 2, "回执冻结版本不得被回滚改写");
  assert.equal(after.channel_id, "credit_pay", "已确认选择不得被回滚改变");

  const fresh = svc.composeSession({ user_id: "u_credit", order_id: "ord_demo_001", app_version: "2.1.0" });
  assert.equal(fresh.policy.version, 1, "新会话应使用回落后的规则");
});

test("已确认会话拒绝再次选择渠道（选择冻结）", async () => {
  const svc = await newService();
  const s = svc.composeSession({ user_id: "u_credit", order_id: "ord_demo_001", app_version: "2.1.0" });
  svc.selectChannel(s.session_id, "card_debit_6228");
  svc.confirmPayment(s.session_id);
  assert.throws(() => selectCredit(svc, s), /已确认/);
});

test("重复确认幂等：返回同一回执，不产生第二份确认", async () => {
  const svc = await newService();
  const s = svc.composeSession({ user_id: "u_credit", order_id: "ord_demo_001", app_version: "2.1.0" });
  svc.selectChannel(s.session_id, "card_debit_6228");
  const r1 = svc.confirmPayment(s.session_id);
  const r2 = svc.confirmPayment(s.session_id);
  assert.equal(r1.receipt_id, r2.receipt_id);
  const confirms = svc.store.list({ event_type: "PAYMENT_CONFIRMED" });
  assert.equal(confirms.length, 1);
});

// ─────────────── 结算回调幂等 ───────────────

test("重复支付回调只形成一次结算（不同 callback_id 也被拦截）", async () => {
  const svc = await newService();
  const s = svc.composeSession({ user_id: "u_credit", order_id: "ord_demo_001", app_version: "2.1.0" });
  svc.selectChannel(s.session_id, "card_debit_6228");
  svc.confirmPayment(s.session_id);

  const first = svc.recordSettlementCallback({ order_id: "ord_demo_001", callback_id: "cb-1", amount_cents: 10000 });
  assert.equal(first.duplicate, false);
  const second = svc.recordSettlementCallback({ order_id: "ord_demo_001", callback_id: "cb-2", amount_cents: 10000 });
  assert.equal(second.duplicate, true);
  assert.equal(second.settlement.callback_id, "cb-1");

  const rows = svc.store.list({ event_type: "SETTLEMENT_RECORDED" });
  assert.equal(rows.length, 1, "事件流中只能有一条结算事件");
});

test("回调金额与回执不一致时拒绝入账", async () => {
  const svc = await newService();
  const s = svc.composeSession({ user_id: "u_credit", order_id: "ord_demo_001", app_version: "2.1.0" });
  svc.selectChannel(s.session_id, "card_debit_6228");
  svc.confirmPayment(s.session_id);
  assert.throws(
    () => svc.recordSettlementCallback({ order_id: "ord_demo_001", callback_id: "cb-x", amount_cents: 9999 }),
    /不一致/
  );
  assert.equal(svc.store.list({ event_type: "SETTLEMENT_RECORDED" }).length, 0);
});

test("未确认订单的回调无对应回执，拒绝入账", async () => {
  const svc = await newService();
  const s = svc.composeSession({ user_id: "u_credit", order_id: "ord_demo_001", app_version: "2.1.0" });
  assert.throws(() => svc.recordSettlementCallback({ order_id: "ord_demo_001", callback_id: "cb", amount_cents: 10000 }), /尚未确认/);
});

// ─────────────── 发布 / 审计 / 哈希链 ───────────────

test("运行期发布违规规则（默认信贷/诱导文案）被拒绝，且不产生发布事件", async () => {
  const svc = await newService();
  const before = svc.store.list({ event_type: "POLICY_PUBLISHED" }).length;
  const base = svc.policies.get(2);
  const draft = JSON.parse(JSON.stringify(base));
  delete draft.version; delete draft.status; delete draft.published_at; delete draft.parent_version;
  draft.default_channel_id = "credit_pay";
  draft.channel_copy.credit_pay.tagline = "秒到账低门槛";
  assert.throws(() => svc.publishPolicy(draft), /校验未通过/);
  assert.equal(svc.store.list({ event_type: "POLICY_PUBLISHED" }).length, before);
});

test("审计包：自有资金完整链路全部检查通过", async () => {
  const svc = await newService();
  const s = svc.composeSession({ user_id: "u_credit", order_id: "ord_demo_001", app_version: "2.1.0" });
  svc.selectChannel(s.session_id, "card_debit_6228");
  svc.confirmPayment(s.session_id);
  svc.recordSettlementCallback({ order_id: "ord_demo_001", callback_id: "cb-1", amount_cents: 10000 });
  const report = buildAuditReport(svc, { session_id: s.session_id });
  assert.equal(report.overall_passed, true, report.checks.filter((c) => !c.passed).map((c) => `${c.id}:${c.detail}`).join("|"));
  assert.equal(report.receipt.settlement_event_count, 1);
});

test("审计包：金融产品链路能证明显式选择、版本冻结与单次结算（含回滚）", async () => {
  const svc = await newService();
  const s = svc.composeSession({ user_id: "u_credit", order_id: "ord_demo_001", app_version: "2.1.0" });
  selectCredit(svc, s, "installment_3");
  svc.confirmPayment(s.session_id);
  svc.recordSettlementCallback({ order_id: "ord_demo_001", callback_id: "cb-1", amount_cents: 10000 });
  svc.recordSettlementCallback({ order_id: "ord_demo_001", callback_id: "cb-2", amount_cents: 10000 });
  svc.rollbackPolicy(1, "审计演练回滚");

  const report = buildAuditReport(svc, { session_id: s.session_id });
  assert.equal(report.overall_passed, true);
  const find = (id) => report.checks.find((c) => c.id === id);
  assert.equal(find("B2_credit_explicit").passed, true);
  assert.equal(find("B3_credit_not_default").passed, true);
  assert.equal(find("D1_single_settlement").passed, true);
  assert.equal(find("E1_freeze_after_rollback").passed, true);
  assert.equal(report.receipt.policy_version_frozen, 2);
  assert.equal(report.policy_rollbacks.length, 1);
  assert.equal(report.selection_evidence.explicit_selection, true);
});

test("哈希链：篡改任一历史事件导致链校验失败", async () => {
  const svc = await newService();
  const s = svc.composeSession({ user_id: "u_credit", order_id: "ord_demo_001", app_version: "2.1.0" });
  svc.selectChannel(s.session_id, "card_debit_6228");
  assert.equal(svc.store.verifyChain().ok, true);

  const events = svc.store.list();
  const victim = events.find((e) => e.event_type === "CHANNEL_SELECTED");
  victim.data.channel_id = "credit_pay"; // 事后篡改选择
  const result = svc.store.verifyChain();
  assert.equal(result.ok, false);
  assert.equal(result.broken_at, victim.event_id);

  // 审计检查 F1 必须失败
  const report = buildAuditReport(svc, { session_id: s.session_id });
  assert.equal(report.checks.find((c) => c.id === "F1_hash_chain").passed, false);
  assert.equal(report.overall_passed, false);
});
