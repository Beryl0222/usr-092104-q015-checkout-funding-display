/**
 * 收银台渠道编排应用服务。
 *
 * 维护：资金渠道类别、用户资格、订单可用性、展示规则版本（含灰度证据）、
 * 风险提示、费用明细、用户主动选择、最终扣款回执。
 *
 * 关键边界：
 * - 规则只能决定「如何展示」，不能伪造余额、不能替用户批准授信；
 * - 金融产品不默认选中，确认前必须留下用户逐次显式选择与风险知悉证据；
 * - 会话在组装时冻结规则版本，规则发布/回滚不影响已确认订单；
 * - 结算回调按回执幂等：重复回调只形成一次结算。
 */

import { randomUUID } from "node:crypto";
import { EventStore } from "./event-store.js";
import { equalMonthlyPayment } from "./money.js";
import { resolvePolicy, validatePolicy, kindOfNature } from "./policy.js";

const STATES = Object.freeze({
  COMPOSED: "composed",
  SELECTED: "selected",
  CONFIRMED: "confirmed",
  SETTLED: "settled",
});

export class CheckoutService {
  /**
   * @param {object} seed data/seed.json 结构
   * @param {object} opts {now?:()=>Date, store?:EventStore}
   */
  constructor(seed, opts = {}) {
    this.now = opts.now || (() => new Date());
    this.store = opts.store || new EventStore();

    this.channels = new Map(seed.funding_channels.map((c) => [c.channel_id, c]));
    this.users = new Map(seed.users.map((u) => [u.user_id, u]));
    this.grants = seed.credit_grants || [];
    this.merchants = new Map((seed.merchants || []).map((m) => [m.merchant_id, m]));
    this.orders = new Map(seed.orders.map((o) => [o.order_id, o]));

    /** @type {Map<number, object>} 规则版本号 -> 规则（含 status）。 */
    this.policies = new Map();
    /** @type {Map<string, object>} session_id -> 会话读模型。 */
    this.sessions = new Map();
    /** @type {Map<string, object>} order_id -> 回执。 */
    this.receipts = new Map();
    /** 结算幂等：receipt_id -> 已入账回调。 */
    this.settledCallbacks = new Map();

    for (const p of seed.policies || []) this._admitSeedPolicy(p);
  }

  ts() {
    return this.now().toISOString();
  }

  // ───────────────────────── 规则管理 ─────────────────────────

  _admitSeedPolicy(policy) {
    // 种子规则同样经过发布校验；校验失败直接拒绝启动。
    const errors = validatePolicy(policy, this.channels);
    if (errors.length) throw new Error(`种子规则 v${policy.version} 不合规：${errors.join("；")}`);
    this.policies.set(policy.version, { ...policy, status: policy.status || "active" });
    this.store.append(this._envelope("POLICY_PUBLISHED", "display_policy", policy.policy_id, {
      policy_id: policy.policy_id,
      policy_version: policy.version,
      status: "active",
      scope: policy.scope,
      change_note: policy.change_note,
      published_by: policy.published_by,
      published_at: policy.published_at,
      seed: true,
    }, policy.version, `展示规则 v${policy.version} 发布`));
  }

  /**
   * 发布新规则版本。版本号在当前最大版本上 +1，父版本自动记录。
   * @returns {object} 已发布规则
   */
  publishPolicy(input) {
    const nextVersion = Math.max(0, ...this.policies.keys()) + 1;
    const parent = this.policies.get(nextVersion - 1);
    const policy = {
      ...input,
      policy_id: input.policy_id || (parent && parent.policy_id) || "checkout_rules",
      version: nextVersion,
      parent_version: parent ? parent.version : null,
      status: "active",
      published_at: this.ts(),
    };
    const errors = validatePolicy(policy, this.channels);
    if (errors.length) {
      const err = new Error(`规则 v${nextVersion} 校验未通过`);
      err.errors = errors;
      throw err;
    }
    this.policies.set(nextVersion, policy);
    this.store.append(this._envelope("POLICY_PUBLISHED", "display_policy", policy.policy_id, {
      policy_id: policy.policy_id,
      policy_version: nextVersion,
      parent_version: policy.parent_version,
      status: "active",
      scope: policy.scope,
      change_note: policy.change_note,
      published_by: policy.published_by || "unknown",
      published_at: policy.published_at,
    }, nextVersion, `展示规则 v${nextVersion} 发布`));
    return policy;
  }

  /**
   * 回滚规则：将高于 targetVersion 的版本置为 rolled_back。
   * 只影响之后新组装的会话；已存在会话（无论是否确认）的快照不变。
   */
  rollbackPolicy(targetVersion, reason = "合规回滚") {
    if (!this.policies.has(targetVersion)) throw new Error(`回滚目标版本不存在：v${targetVersion}`);
    const maxActive = Math.max(...[...this.policies.values()].filter((p) => p.status === "active").map((p) => p.version));
    for (const v of this.policies.keys()) {
      if (v > targetVersion) this.policies.get(v).status = "rolled_back";
    }
    const event = this.store.append(this._envelope("POLICY_ROLLED_BACK", "display_policy", "checkout_rules", {
      policy_id: "checkout_rules",
      from_version: maxActive,
      to_version: targetVersion,
      reason,
      rolled_back_by: "compliance-office",
    }, targetVersion, `展示规则由 v${maxActive} 回滚至 v${targetVersion}`));
    return { to_version: targetVersion, event_id: event.event_id };
  }

  listPolicies() {
    return [...this.policies.values()].map((p) => ({
      version: p.version,
      status: p.status,
      scope: p.scope,
      change_note: p.change_note,
      published_at: p.published_at,
    }));
  }

  // ───────────────────────── 会话组装 ─────────────────────────

  /** 查询用户在某渠道上的资格与可用性（只读真实数据，不伪造、不授信）。 */
  _eligibility(user, channel) {
    if (channel.kind === "bank_card") {
      if (!user.bank_cards.includes(channel.channel_id)) return { qualified: false, reason: "未绑定该银行卡" };
      return { qualified: true, available: true };
    }
    if (channel.kind === "account_balance") {
      return { qualified: true, available: true, available_cents: user.balance_cents };
    }
    if (channel.kind === "money_fund") {
      if (!user.money_fund_shares_cents) return { qualified: false, reason: "未持有该货币基金" };
      return { qualified: true, available: true, available_cents: user.money_fund_shares_cents };
    }
    // 金融产品：资格来自独立授信核心的有效授信；展示层只能读取。
    const grant = this.grants.find(
      (g) => g.status === "active" && g.user_ids.includes(user.user_id) && g.channel_ids.includes(channel.channel_id)
    );
    if (!grant) return { qualified: false, reason: "未获得授信（资格由授信核心独立审批）" };
    return {
      qualified: true,
      grant_id: grant.grant_id,
      available_credit_cents: grant.available_credit_cents,
      credit_source: grant.source,
      available: true, // 额度对订单是否足够在 _availability 中结合金额判定
    };
  }

  _availability(elig, channel, amountCents) {
    if (!elig.qualified) return { enabled: false, unavailable_reason: elig.reason, excluded: true };
    if (channel.kind === "account_balance" || channel.kind === "money_fund") {
      if (elig.available_cents < amountCents) {
        return { enabled: false, unavailable_reason: `可用 ${elig.available_cents} 分，不足支付本笔订单` };
      }
    }
    if (channel.requires_grant && elig.available_credit_cents < amountCents) {
      return { enabled: false, unavailable_reason: "授信可用额度不足（数据来自授信核心）" };
    }
    return { enabled: true };
  }

  _feeQuote(channel, policy, amountCents) {
    if (channel.kind === "installment") {
      const pricing = policy.pricing[channel.channel_id];
      const q = equalMonthlyPayment(amountCents, pricing.annual_rate_bp, channel.installment_terms);
      return {
        fee_type: "installment_interest",
        rate_description: pricing.rate_description,
        annual_rate_bp: pricing.annual_rate_bp,
        ...q,
      };
    }
    if (channel.kind === "consumer_credit") {
      return { fee_type: "credit_bill", total_fee_cents: 0, note: "按时全额还款无额外费用，逾期按合同计息" };
    }
    return { fee_type: "none", total_fee_cents: 0, note: "使用自有资金，无额外费用" };
  }

  /**
   * 组装收银台会话：解析灰度规则 → 资格/可用性过滤 → 生成冻结展示快照。
   */
  composeSession({ user_id, order_id, app_version = "1.0.0", client = { device: "web" } }) {
    const user = this.users.get(user_id);
    if (!user) throw new Error(`用户不存在：${user_id}`);
    const order = this.orders.get(order_id);
    if (!order) throw new Error(`订单不存在：${order_id}`);

    const { policy, considered } = resolvePolicy(this.policies, { merchant_id: order.merchant_id, app_version });

    const groups = [{ nature: "own_funds", channels: [] }, { nature: "credit_product", channels: [] }];
    let defaultChannelId = null;

    for (const cid of policy.channel_order) {
      const channel = this.channels.get(cid);
      const elig = this._eligibility(user, channel);
      const av = this._availability(elig, channel, order.amount_cents);
      const copy = policy.channel_copy[cid];
      const view = {
        channel_id: channel.channel_id,
        kind: channel.kind,
        nature: channel.nature,
        name: channel.name,
        tagline: copy.tagline,
        description: channel.description,
        risk_warning: copy.risk_warning,
        cancel_consequence: copy.cancel_consequence,
        requires_explicit_ack: channel.nature === "credit_product",
        enabled: av.enabled,
        excluded: !!av.excluded,
        unavailable_reason: av.unavailable_reason || null,
        redemption_note: channel.redemption_note || null,
        funds_info: null,
        fee: this._feeQuote(channel, policy, order.amount_cents),
      };
      if (channel.kind === "account_balance" || channel.kind === "money_fund") {
        view.funds_info = { label: channel.kind === "account_balance" ? "账户可用余额" : "持有基金份额（折合）", amount_cents: elig.available_cents || 0, source: "账户核心" };
      }
      if (channel.requires_grant && elig.qualified) {
        view.funds_info = { label: "授信可用额度", amount_cents: elig.available_credit_cents, source: elig.credit_source, grant_id: elig.grant_id };
      }
      groups[channel.nature === "own_funds" ? 0 : 1].channels.push(view);
    }

    // 默认项只能是规则指定的自有资金渠道；若规则默认项当前不可用（如余额不足），
    // 回退到展示顺序中第一个可用的自有资金渠道；都不可用则不预选。金融产品永不参与默认。
    const ownViews = groups[0].channels;
    const defaultView = ownViews.find((c) => c.channel_id === policy.default_channel_id);
    if (defaultView && defaultView.enabled) {
      defaultChannelId = policy.default_channel_id;
    } else {
      const fallback = ownViews.find((c) => c.enabled);
      defaultChannelId = fallback ? fallback.channel_id : null;
    }

    const sectionCopy = policy.sections;
    const snapshot = {
      session_id: randomUUID(),
      order_id,
      merchant_id: order.merchant_id,
      user_id,
      app_version,
      client,
      composed_at: this.ts(),
      state: STATES.COMPOSED,
      order: { order_id, subject: order.subject, amount_cents: order.amount_cents },
      policy: {
        policy_id: policy.policy_id,
        version: policy.version,
        change_note: policy.change_note,
        published_by: policy.published_by,
        published_at: policy.published_at,
      },
      resolution: {
        merchant_id: order.merchant_id,
        app_version,
        considered, // 每个版本为何命中/未命中——灰度证据
      },
      groups: groups.map((g) => ({ nature: g.nature, ...sectionCopy[g.nature], channels: g.channels })),
      default_channel_id: defaultChannelId,
      selected_channel_id: defaultChannelId,
      selection: null,
    };

    this.sessions.set(snapshot.session_id, snapshot);
    this.store.append(this._envelope("SESSION_COMPOSED", "checkout_session", snapshot.session_id, {
      session_id: snapshot.session_id,
      order_id,
      merchant_id: order.merchant_id,
      user_id,
      app_version,
      policy_id: policy.policy_id,
      policy_version: policy.version,
      resolution: snapshot.resolution,
      default_channel_id: defaultChannelId,
      displayed_channels: snapshot.groups.map((g) => ({
        nature: g.nature,
        channels: g.channels.map((c) => ({
          channel_id: c.channel_id,
          enabled: c.enabled,
          excluded: c.excluded,
          requires_explicit_ack: c.requires_explicit_ack,
        })),
      })),
    }, policy.version, `收银台会话按规则 v${policy.version} 组装`));
    return snapshot;
  }

  // ───────────────────────── 用户主动选择 ─────────────────────────

  /**
   * 用户选择渠道。
   * 金融产品必须携带显式证据：explicit_selection=true（键盘/点击的主动动作）
   * 且 risk_acknowledged=true（已阅读风险提示）。禁止任何默认/自动/推荐服务代选。
   */
  selectChannel(sessionId, channelId, evidence = {}) {
    const s = this._getSession(sessionId);
    if (s.state === STATES.CONFIRMED || s.state === STATES.SETTLED) {
      throw new Error("订单已确认，渠道选择已冻结，规则回滚或重复操作不得变更");
    }
    const view = s.groups.flatMap((g) => g.channels).find((c) => c.channel_id === channelId);
    if (!view) throw new Error("该渠道不在本次展示范围内");
    if (view.excluded) throw new Error(`渠道不可用：${view.unavailable_reason || "用户不具备资格"}`);
    if (!view.enabled) throw new Error(`渠道当前不可用：${view.unavailable_reason}`);

    const selectionEvidence = {
      selected_at: this.ts(),
      action_source: evidence.action_source || "user_manual", // user_manual（键盘/点击）；服务端拒绝其它来源
      explicit_selection: evidence.explicit_selection === true,
      risk_acknowledged: evidence.risk_acknowledged === true,
      client_event_id: evidence.client_event_id || null,
    };

    if (view.nature === "credit_product") {
      if (evidence.action_source && evidence.action_source !== "user_manual") {
        throw new Error("金融产品必须由用户主动选择，推荐服务不得代选");
      }
      if (!selectionEvidence.explicit_selection) {
        throw new Error("金融产品必须由用户显式选择，不接受默认选中或系统代选");
      }
      if (!selectionEvidence.risk_acknowledged) {
        throw new Error("金融产品必须勾选已知悉风险提示、总费用与还款责任后才能选择");
      }
    }

    s.selected_channel_id = channelId;
    s.state = STATES.SELECTED;
    s.selection = { channel_id: channelId, ...selectionEvidence, fee_snapshot: view.fee };

    const channel = this.channels.get(channelId);
    this.store.append(this._envelope("CHANNEL_SELECTED", "checkout_session", sessionId, {
      session_id: sessionId,
      order_id: s.order_id,
      channel_id: channelId,
      channel_kind: channel.kind,
      channel_nature: channel.nature,
      policy_version: s.policy.version,
      ...selectionEvidence,
      fee_snapshot: view.fee,
    }, s.policy.version, `用户主动选择${channel.nature === "credit_product" ? "金融产品" : "支付工具"}：${channel.name}`));
    return s.selection;
  }

  // ───────────────────────── 确认与结算 ─────────────────────────

  /** 确认前总费用汇总：订单金额 + 渠道费用。 */
  previewConfirmation(sessionId) {
    const s = this._getSession(sessionId);
    if (!s.selected_channel_id) throw new Error("尚未选择资金渠道");
    const view = s.groups.flatMap((g) => g.channels).find((c) => c.channel_id === s.selected_channel_id);
    const feeCents = view.fee.total_fee_cents || 0;
    return {
      channel_id: view.channel_id,
      channel_name: view.name,
      channel_nature: view.nature,
      amount_cents: s.order.amount_cents,
      fee_cents: feeCents,
      total_repay_cents: s.order.amount_cents + feeCents,
      risk_warning: view.risk_warning,
      cancel_consequence: view.cancel_consequence,
      fee_detail: view.fee,
    };
  }

  /**
   * 用户确认支付。冻结：所选渠道、费用口径、规则版本；此后规则回滚不影响本单。
   */
  confirmPayment(sessionId) {
    const s = this._getSession(sessionId);
    if (s.state === STATES.CONFIRMED || s.state === STATES.SETTLED) {
      return this.receipts.get(s.order_id); // 重复确认幂等返回同一回执
    }
    if (s.state !== STATES.SELECTED || !s.selection) throw new Error("请先选择资金渠道");
    const preview = this.previewConfirmation(sessionId);
    const channel = this.channels.get(s.selected_channel_id);

    const receipt = {
      receipt_id: randomUUID(),
      order_id: s.order_id,
      session_id: sessionId,
      merchant_id: s.merchant_id,
      user_id: s.user_id,
      channel_id: s.selected_channel_id,
      channel_kind: channel.kind,
      channel_nature: channel.nature,
      amount_cents: preview.amount_cents,
      fee_cents: preview.fee_cents,
      total_repay_cents: preview.total_repay_cents,
      fee_detail: preview.fee_detail,
      policy_version_frozen: s.policy.version,
      selection_evidence: s.selection,
      risk_warning: preview.risk_warning,
      cancel_consequence: preview.cancel_consequence,
      confirmed_at: this.ts(),
      settlement: null,
    };
    s.state = STATES.CONFIRMED;
    this.receipts.set(s.order_id, receipt);

    this.store.append(this._envelope("PAYMENT_CONFIRMED", "payment_receipt", receipt.receipt_id, {
      receipt_id: receipt.receipt_id,
      session_id: sessionId,
      order_id: s.order_id,
      channel_id: receipt.channel_id,
      channel_nature: receipt.channel_nature,
      amount_cents: receipt.amount_cents,
      fee_cents: receipt.fee_cents,
      total_repay_cents: receipt.total_repay_cents,
      policy_version_frozen: receipt.policy_version_frozen,
      credit_explicit_evidence: channel.nature === "credit_product" ? receipt.selection_evidence : null,
      confirmed_at: receipt.confirmed_at,
    }, s.policy.version, `支付确认（${channel.nature === "credit_product" ? "借款" : "自有资金"}渠道，规则 v${s.policy.version} 已冻结）`));
    return receipt;
  }

  /**
   * 支付渠道异步扣款回调。幂等：同一回执只形成一次结算，
   * 重复回调（含不同 callback_id）返回 duplicate=true，不产生第二条入账。
   */
  recordSettlementCallback(callback) {
    const receipt = this.receipts.get(callback.order_id);
    if (!receipt) throw new Error(`订单尚未确认，回调无对应回执：${callback.order_id}`);
    if (receipt.settlement) {
      return { duplicate: true, settled: true, receipt_id: receipt.receipt_id, settlement: receipt.settlement };
    }
    const amount = Number(callback.amount_cents);
    if (!Number.isInteger(amount) || amount !== receipt.amount_cents) {
      throw new Error(`回调金额 ${amount} 与回执金额 ${receipt.amount_cents} 不一致，拒绝入账`);
    }
    const settlement = {
      callback_id: callback.callback_id || randomUUID(),
      gateway: callback.gateway || "unknown",
      status: callback.status || "success",
      amount_cents: amount,
      settled_at: callback.settled_at || this.ts(),
    };
    receipt.settlement = settlement;
    const session = this.sessions.get(receipt.session_id);
    if (session) session.state = STATES.SETTLED;

    this.store.append(this._envelope("SETTLEMENT_RECORDED", "payment_receipt", receipt.receipt_id, {
      receipt_id: receipt.receipt_id,
      order_id: receipt.order_id,
      session_id: receipt.session_id,
      channel_id: receipt.channel_id,
      amount_cents: amount,
      gateway: settlement.gateway,
      callback_id: settlement.callback_id,
      settled_at: settlement.settled_at,
    }, receipt.policy_version_frozen, `扣款回执：实际扣款 ${amount} 分，一次性结算`));
    return { duplicate: false, settled: true, receipt_id: receipt.receipt_id, settlement };
  }

  // ───────────────────────── 查询 ─────────────────────────

  getSession(id) {
    return this._getSession(id);
  }

  getReceiptByOrder(orderId) {
    return this.receipts.get(orderId) || null;
  }

  _getSession(id) {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`会话不存在：${id}`);
    return s;
  }

  _envelope(type, aggregateType, aggregateId, data, version, summary) {
    return {
      event_id: randomUUID(),
      event_type: type,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      occurred_at: this.ts(),
      version,
      summary,
      data,
    };
  }
}

export { STATES, kindOfNature };
