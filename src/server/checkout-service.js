/**
 * 收银台编排服务：组装展示 → 用户选择 → 确认 → 回调 → 单次结算。
 *
 * 不变量：
 * 1. 每次组装把“命中的规则版本 + 完整展示快照”写入事件，客服与审计可回放当次真实展示。
 * 2. 选择只能来自当次展示快照中的可见渠道；借贷渠道必须附带用户主动勾选确认。
 * 3. 确认后订单选择锁定；规则回滚不改写任何已确认快照（R-PAY-008）。
 * 4. 支付回调按渠道流水号幂等：重复回调只追加证据事件，最多产生一次结算（R-PAY-009）。
 */
import { AGGREGATE_TYPE, CHANNEL_GROUP, EVENT_TYPE } from "../domain/enums.js";
import { composeCheckout, quoteCost } from "../domain/rules.js";

export class CheckoutService {
  /**
   * @param {import('./store.js').EventStore} store
   * @param {object} deps
   * @param {import('./policy-service.js').PolicyService} deps.policies
   * @param {object} deps.channelCatalog
   * @param {object} deps.eligibilityProvider   {lookup(userId): Record<code,{eligible,reason}>}
   * @param {object} deps.availabilityProvider {lookup(userId, order): Record<code,{available,reason,balance}>}
   * @param {object} deps.pricingProvider      {quote(userId, channelCode, amount): pricing}
   */
  constructor(store, { policies, channelCatalog, eligibilityProvider, availabilityProvider, pricingProvider }) {
    this.store = store;
    this.policies = policies;
    this.channelCatalog = channelCatalog;
    this.eligibility = eligibilityProvider;
    this.availability = availabilityProvider;
    this.pricing = pricingProvider;
    /** sessionId -> 组装态（内存投影，同时完整落在事件里） */
    this.sessions = new Map();
    /** 渠道回调流水号 -> 是否已结算（幂等键） */
    this.settledCallbacks = new Map();
    /** orderId -> receiptId（一笔订单一张回执） */
    this.receiptByOrder = new Map();
    this._replay();
  }

  _replay() {
    for (const e of this.store.all()) {
      if (e.event_type === EVENT_TYPE.SESSION_COMPOSED) {
        this.sessions.set(e.aggregate_id, {
          session_id: e.aggregate_id,
          order_id: e.order_id,
          merchant_id: e.merchant_id,
          user_id: e.user_id,
          policy_version: e.policy_version,
          snapshot: e.display_snapshot,
          state: "COMPOSED",
        });
      } else if (e.event_type === EVENT_TYPE.CHANNEL_SELECTED) {
        const s = this.sessions.get(e.aggregate_id);
        if (s) {
          s.state = "SELECTED";
          s.selection = e.selection;
        }
      } else if (e.event_type === EVENT_TYPE.PAYMENT_CONFIRMED) {
        const s = this.sessions.get(e.aggregate_id);
        if (s) {
          s.state = "CONFIRMED";
          s.confirmation = e.confirmation;
        }
      } else if (e.event_type === EVENT_TYPE.SESSION_CANCELLED) {
        const s = this.sessions.get(e.aggregate_id);
        if (s) s.state = "CANCELLED";
      } else if (e.event_type === EVENT_TYPE.PAYMENT_SETTLED) {
        this.settledCallbacks.set(e.callback_id, e.aggregate_id);
        this.receiptByOrder.set(e.order_id, e.aggregate_id);
      }
    }
  }

  /** 组装一次收银台展示。 */
  compose({ session_id, order_id, merchant_id, user_id, client_version, amount, currency = "CNY", recommendations = [] }) {
    const resolved = this.policies.resolveVersion({ merchant_id, client_version });
    const channels = Object.values(this.channelCatalog);
    const eligibility = this.eligibility.lookup(user_id);
    const availability = this.availability.lookup(user_id, { order_id, amount });

    const view = composeCheckout({
      policy: resolved.policy,
      channels,
      eligibility,
      availability,
      recommendations,
    });

    // 费用试算（供展示，最终以确认时冻结报价为准）
    for (const group of view.groups) {
      for (const item of group.channels) {
        const pricing = this.pricing.quote(user_id, item.channel_code, amount);
        item.cost_quote = quoteCost({ channel: this.channelCatalog[item.channel_code], orderAmount: amount, pricing });
        item.currency = currency;
      }
    }

    const snapshot = {
      composed_for: { order_id, merchant_id, user_id, client_version, amount, currency },
      policy_version: resolved.version,
      matched_scope: resolved.matched_scope,
      gray: resolved.gray,
      groups: view.groups,
      default_channel_code: view.default_channel_code,
      suppressed: view.suppressed,
      applied_rules: view.applied_rules,
    };

    this.store.append({
      event_type: EVENT_TYPE.SESSION_COMPOSED,
      aggregate_type: AGGREGATE_TYPE.CHECKOUT_SESSION,
      aggregate_id: session_id,
      summary: `订单 ${order_id} 按规则 v${resolved.version} 组装收银台（默认：${view.default_channel_code ?? "无"}）`,
      payload: {
        order_id,
        merchant_id,
        user_id,
        client_version,
        policy_version: resolved.version,
        gray_evidence: {
          merchant_id,
          client_version,
          matched_scope: resolved.matched_scope,
          gray: resolved.gray,
        },
        display_snapshot: snapshot,
      },
    });
    this._fold(this.store.all().at(-1));
    return snapshot;
  }

  _fold(e) {
    if (e.event_type === EVENT_TYPE.SESSION_COMPOSED) {
      this.sessions.set(e.aggregate_id, {
        session_id: e.aggregate_id,
        order_id: e.order_id,
        merchant_id: e.merchant_id,
        user_id: e.user_id,
        policy_version: e.policy_version,
        snapshot: e.display_snapshot,
        state: "COMPOSED",
      });
    }
  }

  /**
   * 用户主动选择渠道。
   * @param {object} body
   * @param {boolean} [body.explicit_ack] 借贷渠道必须为 true，并记录确认文案与确认时间
   */
  select(sessionId, { channel_code, explicit_ack = false, ack_text = null }) {
    const s = this.sessions.get(sessionId);
    if (!s) throw httpError(404, "会话不存在或已过期");
    if (s.state === "CONFIRMED") throw httpError(409, "订单已确认，渠道选择不可更改（规则回滚亦不改变已确认选择）");
    if (s.state === "CANCELLED") throw httpError(409, "会话已取消");
    if (s.state === "SELECTED" && s.selection.channel_code === channel_code) {
      return { event_id: null, selection: s.selection, idempotent: true };
    }

    const visible = s.snapshot.groups.flatMap((g) => g.channels);
    const item = visible.find((c) => c.channel_code === channel_code);
    if (!item) throw httpError(400, "该渠道不在本次展示清单中，禁止选择未展示渠道");

    const def = this.channelCatalog[channel_code];
    if (def.group === CHANNEL_GROUP.CREDIT) {
      if (!explicit_ack) throw httpError(403, "借贷渠道需要您主动勾选知情确认后才能选择");
      if (!ack_text) throw httpError(403, "缺少借款知情确认文案留证");
    }

    const selection = {
      channel_code,
      channel_name: item.name,
      group: item.group,
      fund_nature: item.fund_nature,
      user_active_choice: true,
      default_channel_code_at_compose: s.snapshot.default_channel_code,
      was_default: channel_code === s.snapshot.default_channel_code,
      explicit_ack: def.group === CHANNEL_GROUP.CREDIT ? true : null,
      ack_text: def.group === CHANNEL_GROUP.CREDIT ? ack_text : null,
      cost_quote: item.cost_quote,
      selected_at: new Date().toISOString(),
    };

    this.store.append({
      event_type: EVENT_TYPE.CHANNEL_SELECTED,
      aggregate_type: AGGREGATE_TYPE.CHECKOUT_SESSION,
      aggregate_id: sessionId,
      summary: `用户主动选择「${item.name}」（${def.group === CHANNEL_GROUP.CREDIT ? "借款，已勾选知情确认" : "自有资金"}）`,
      payload: { order_id: s.order_id, selection },
    });
    const e = this.store.all().at(-1);
    s.state = "SELECTED";
    s.selection = selection;
    return { event_id: e.event_id, selection };
  }

  /** 确认付款：冻结费用与取消后果说明，锁定选择。 */
  confirm(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) throw httpError(404, "会话不存在");
    if (s.state !== "SELECTED") throw httpError(409, "请先主动选择资金渠道");
    const item = s.snapshot.groups.flatMap((g) => g.channels).find((c) => c.channel_code === s.selection.channel_code);

    const confirmation = {
      order_id: s.order_id,
      channel_code: s.selection.channel_code,
      fund_nature: s.selection.fund_nature,
      amount: s.snapshot.composed_for.amount,
      currency: s.snapshot.composed_for.currency,
      cost_total: s.selection.cost_quote.total,
      cost_components: s.selection.cost_quote.components,
      cancellation: cancellationFor(this.channelCatalog[s.selection.channel_code]),
      policy_version_frozen: s.policy_version,
      confirmed_at: new Date().toISOString(),
    };

    this.store.append({
      event_type: EVENT_TYPE.PAYMENT_CONFIRMED,
      aggregate_type: AGGREGATE_TYPE.CHECKOUT_SESSION,
      aggregate_id: sessionId,
      summary: `订单 ${s.order_id} 确认经「${item.name}」支付，费用合计 ${confirmation.cost_total}`,
      payload: { order_id: s.order_id, confirmation },
    });
    const e = this.store.all().at(-1);
    s.state = "CONFIRMED";
    s.confirmation = confirmation;
    return { event_id: e.event_id, confirmation };
  }

  cancel(sessionId, { reason }) {
    const s = this.sessions.get(sessionId);
    if (!s) throw httpError(404, "会话不存在");
    if (s.state === "CONFIRMED") throw httpError(409, "订单已确认并进入扣款流程，请按退款/撤单规则处理");
    if (s.state === "CANCELLED") return { cancelled: true };
    this.store.append({
      event_type: EVENT_TYPE.SESSION_CANCELLED,
      aggregate_type: AGGREGATE_TYPE.CHECKOUT_SESSION,
      aggregate_id: sessionId,
      summary: `用户在确认前取消订单 ${s.order_id}：${reason ?? "未填写"}`,
      payload: { order_id: s.order_id, reason: reason ?? null },
    });
    s.state = "CANCELLED";
    return { cancelled: true };
  }

  /**
   * 支付结果回调。每次回调都留证；仅首次成功回调产生一次结算。
   * @param {object} cb {callback_id, order_id, session_id, channel_code, status, amount, settled_at}
   */
  onCallback(cb) {
    const required = ["callback_id", "order_id", "session_id", "channel_code", "status", "amount"];
    for (const k of required) if (cb[k] === undefined) throw httpError(400, `回调缺少字段：${k}`);

    const duplicate = this.settledCallbacks.has(cb.callback_id);
    this.store.append({
      event_type: EVENT_TYPE.CALLBACK_RECEIVED,
      aggregate_type: AGGREGATE_TYPE.PAYMENT_RECEIPT,
      aggregate_id: this.receiptByOrder.get(cb.order_id) ?? `receipt-${cb.order_id}`,
      summary: duplicate ? `重复回调 ${cb.callback_id}（幂等忽略，不再次结算）` : `收到支付回调 ${cb.callback_id}`,
      payload: { ...cb, duplicate_of_settled: duplicate },
    });

    if (duplicate || cb.status !== "SUCCESS") {
      return { settled: false, duplicate, reason: duplicate ? "DUPLICATE_CALLBACK" : `STATUS_${cb.status}` };
    }
    if (this.receiptByOrder.has(cb.order_id)) {
      // 同一订单已被另一个流水号结算过
      return { settled: false, duplicate: true, reason: "ORDER_ALREADY_SETTLED" };
    }

    const s = this.sessions.get(cb.session_id);
    if (!s || s.state !== "CONFIRMED") {
      // 会话不存在或用户尚未确认：记录回调证据但绝不结算
      return { settled: false, duplicate: false, reason: "SESSION_NOT_CONFIRMED" };
    }
    const mismatch =
      s.order_id !== cb.order_id ||
      s.selection?.channel_code !== cb.channel_code ||
      s.confirmation?.amount !== cb.amount;

    const receiptId = `receipt-${cb.order_id}`;
    this.store.append({
      event_type: EVENT_TYPE.PAYMENT_SETTLED,
      aggregate_type: AGGREGATE_TYPE.PAYMENT_RECEIPT,
      aggregate_id: receiptId,
      summary: mismatch
        ? `结算对账异常：回调与确认快照不一致（订单 ${cb.order_id}）`
        : `订单 ${cb.order_id} 结算成功，渠道 ${cb.channel_code}，金额 ${cb.amount}`,
      payload: {
        order_id: cb.order_id,
        session_id: cb.session_id,
        callback_id: cb.callback_id,
        channel_code: cb.channel_code,
        amount: cb.amount,
        currency: cb.currency ?? s?.confirmation?.currency ?? "CNY",
        confirmed_channel_code: s?.confirmation?.channel_code ?? null,
        confirmed_amount: s?.confirmation?.amount ?? null,
        consistency_ok: !mismatch,
        settled_at: cb.settled_at ?? new Date().toISOString(),
      },
    });
    this.settledCallbacks.set(cb.callback_id, receiptId);
    this.receiptByOrder.set(cb.order_id, receiptId);
    return { settled: true, duplicate: false, receipt_id: receiptId, consistency_ok: !mismatch };
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId) ?? null;
  }
}

function cancellationFor(channel) {
  if (channel.group === CHANNEL_GROUP.CREDIT) {
    return {
      can_cancel_before_confirm: true,
      text: "确认前可自由取消且不产生费用；一旦确认并提交借款申请，借款合同成立，取消将按提前还款规则处理，可能产生已产生的利息。",
    };
  }
  if (channel.group === CHANNEL_GROUP.WEALTH) {
    return {
      can_cancel_before_confirm: true,
      text: "确认前可自由取消；确认后赎回申请已提交基金公司，撤单受理时间与结果以基金公司规则为准。",
    };
  }
  return { can_cancel_before_confirm: true, text: "确认前可自由取消，不扣款、不产生任何费用。" };
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
