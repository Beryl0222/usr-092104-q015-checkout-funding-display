/**
 * 审计导出。
 *
 * 对一次收银台会话生成证据包，独立重放事件并交叉核对，证明：
 * A. 展示与选择一致：所选渠道确实在当次展示清单内、当时可用；
 * B. 金融产品显式选择：信贷/分期具备用户逐次主动选择 + 风险知悉证据，无默认选中；
 * C. 展示、选择与实际扣款一致：渠道一致、金额一致、规则版本一致；
 * D. 单次结算：SETTLEMENT_RECORDED 对同一回执恰好一条，重复回调未二次入账；
 * E. 规则版本冻结：确认后即使规则被回滚，回执仍指向冻结版本；
 * F. 事件哈希链完整，证据未被事后篡改。
 */

export function buildAuditReport(service, { session_id, order_id }) {
  const events = service.store.list();
  const chain = service.store.verifyChain();

  const session = session_id
    ? service.getSession(session_id)
    : [...service.sessions.values()].find((s) => s.order_id === order_id);
  if (!session) throw new Error("审计目标会话不存在");
  const sid = session.session_id;
  const receipt = service.getReceiptByOrder(session.order_id);

  const sessionEvents = events.filter(
    (e) =>
      (e.event_type === "SESSION_COMPOSED" || e.event_type === "CHANNEL_SELECTED") &&
      e.data && e.data.session_id === sid
  );
  const composed = sessionEvents.find((e) => e.event_type === "SESSION_COMPOSED");
  const selected = sessionEvents.find((e) => e.event_type === "CHANNEL_SELECTED");
  const confirmed = events.find(
    (e) => e.event_type === "PAYMENT_CONFIRMED" && e.data && e.data.session_id === sid
  );
  const settlements = events.filter(
    (e) => e.event_type === "SETTLEMENT_RECORDED" && e.data && e.data.session_id === sid
  );

  const checks = [];
  const add = (id, title, passed, detail) => checks.push({ id, title, passed: !!passed, detail });

  // A. 展示与选择一致
  const displayed = composed
    ? composed.data.displayed_channels.flatMap((g) =>
        g.channels.map((c) => ({ ...c, nature: g.nature }))
      )
    : [];
  const displayedEntry = displayed.find((c) => c.channel_id === (selected && selected.data.channel_id));
  add(
    "A1_displayed",
    "所选渠道在当次展示清单内",
    !selected || !!displayedEntry,
    selected
      ? displayedEntry
        ? `渠道 ${selected.data.channel_id} 出现于 SESSION_COMPOSED 展示快照（规则 v${composed.data.policy_version}）`
        : `渠道 ${selected.data.channel_id} 不在展示清单`
      : "尚未选择"
  );
  add(
    "A2_enabled",
    "选择时渠道处于可用、未被资格排除状态",
    !selected || (displayedEntry && displayedEntry.enabled && !displayedEntry.excluded),
    selected ? (displayedEntry ? `enabled=${displayedEntry.enabled}, excluded=${displayedEntry.excluded}` : "—") : "尚未选择"
  );

  // B. 金融产品显式选择 + 默认项
  const defaultEntry = displayed.find((c) => c.channel_id === composed.data.default_channel_id);
  add(
    "B1_default_is_own_funds",
    "默认选中项是自有资金支付工具（或无默认项）",
    !composed.data.default_channel_id || (defaultEntry && defaultEntry.nature === "own_funds"),
    composed.data.default_channel_id
      ? `默认渠道 ${composed.data.default_channel_id}，性质 ${defaultEntry ? defaultEntry.nature : "未知"}`
      : "无默认渠道（默认项不可用时不预选）"
  );

  const selectedIsCredit = selected && displayedEntry && displayedEntry.nature === "credit_product";
  add(
    "B2_credit_explicit",
    "金融产品具备显式主动选择与风险知悉证据",
    !selectedIsCredit ||
      (selected.data.explicit_selection === true &&
        selected.data.risk_acknowledged === true &&
        selected.data.action_source === "user_manual"),
    selectedIsCredit
      ? `explicit_selection=${selected.data.explicit_selection}, risk_acknowledged=${selected.data.risk_acknowledged}, action_source=${selected.data.action_source}`
      : "未选择金融产品或尚未选择"
  );
  add(
    "B3_credit_not_default",
    "金融产品从未通过默认项选中",
    !selectedIsCredit || composed.data.default_channel_id !== selected.data.channel_id,
    selectedIsCredit ? `默认项=${composed.data.default_channel_id}，选择项=${selected.data.channel_id}` : "不适用"
  );

  // C. 展示-选择-扣款一致
  add(
    "C1_channel_consistent",
    "选择渠道与扣款回执渠道一致",
    !confirmed || (selected && confirmed.data.channel_id === selected.data.channel_id),
    confirmed ? `选择=${selected.data.channel_id}，回执=${confirmed.data.channel_id}` : "尚未确认"
  );
  add(
    "C2_amount_consistent",
    "订单金额、确认金额、扣款金额一致（费用单独列示）",
    !confirmed ||
      (confirmed.data.amount_cents === session.order.amount_cents &&
        (!receipt || !receipt.settlement || receipt.settlement.amount_cents === receipt.amount_cents)),
    confirmed
      ? `订单=${session.order.amount_cents}，确认=${confirmed.data.amount_cents}，费用=${confirmed.data.fee_cents}，扣款=${receipt && receipt.settlement ? receipt.settlement.amount_cents : "未回调"}`
      : "尚未确认"
  );
  add(
    "C3_policy_consistent",
    "展示、选择、确认使用同一规则版本",
    !confirmed ||
      (composed.data.policy_version === selected.data.policy_version &&
        selected.data.policy_version === confirmed.data.policy_version_frozen),
    confirmed
      ? `组装=${composed.data.policy_version}，选择=${selected.data.policy_version}，确认冻结=${confirmed.data.policy_version_frozen}`
      : "尚未确认"
  );

  // D. 单次结算
  add(
    "D1_single_settlement",
    "同一回执仅一条结算事件（重复回调幂等）",
    settlements.length <= 1,
    `SETTLEMENT_RECORDED 条数=${settlements.length}`
  );

  // E. 规则版本冻结 + 回滚证据
  const rollbacks = events.filter((e) => e.event_type === "POLICY_ROLLED_BACK");
  const frozenVersion = confirmed ? confirmed.data.policy_version_frozen : null;
  const currentPolicy = [...service.policies.values()]
    .filter((p) => p.status === "active")
    .sort((a, b) => b.version - a.version)[0];
  add(
    "E1_freeze_after_rollback",
    "规则回滚不改变已确认订单的冻结版本",
    !confirmed || (frozenVersion !== null && receipt.policy_version_frozen === frozenVersion),
    confirmed
      ? `冻结版本=v${frozenVersion}，当前最高有效版本=v${currentPolicy ? currentPolicy.version : "无"}，回滚事件=${rollbacks.length} 次`
      : "尚未确认"
  );

  // F. 哈希链
  add("F1_hash_chain", "事件哈希链完整可独立重算", chain.ok, chain.ok ? `链上事件 ${chain.length} 条` : `断裂于 ${chain.broken_at}：${chain.reason}`);

  const passed = checks.every((c) => c.passed);

  return {
    report_id: `${sid}-audit`,
    generated_at: new Date().toISOString(),
    target: { session_id: sid, order_id: session.order_id, merchant_id: session.merchant_id, user_id: session.user_id },
    overall_passed: passed,
    checks,
    frozen_snapshot: {
      policy_version: session.policy.version,
      policy_change_note: session.policy.change_note,
      gray_release_evidence: session.resolution,
      displayed: displayed.map((d) => ({
        channel_id: d.channel_id,
        nature: d.nature,
        enabled: d.enabled,
        excluded: d.excluded,
        requires_explicit_ack: d.requires_explicit_ack,
      })),
      default_channel_id: composed.data.default_channel_id,
    },
    selection_evidence: selected
      ? {
          channel_id: selected.data.channel_id,
          channel_nature: selected.data.channel_nature,
          explicit_selection: selected.data.explicit_selection,
          risk_acknowledged: selected.data.risk_acknowledged,
          action_source: selected.data.action_source,
          selected_at: selected.data.selected_at,
          client_event_id: selected.data.client_event_id,
          fee_snapshot: selected.data.fee_snapshot,
        }
      : null,
    receipt: confirmed
      ? {
          receipt_id: confirmed.data.receipt_id,
          channel_id: confirmed.data.channel_id,
          channel_nature: confirmed.data.channel_nature,
          amount_cents: confirmed.data.amount_cents,
          fee_cents: confirmed.data.fee_cents,
          total_repay_cents: confirmed.data.total_repay_cents,
          policy_version_frozen: confirmed.data.policy_version_frozen,
          confirmed_at: confirmed.data.confirmed_at,
          settlement: receipt ? receipt.settlement : null,
          settlement_event_count: settlements.length,
        }
      : null,
    policy_rollbacks: rollbacks.map((e) => ({
      event_id: e.event_id,
      from_version: e.data.from_version,
      to_version: e.data.to_version,
      reason: e.data.reason,
      occurred_at: e.occurred_at,
    })),
    events: events
      .filter((e) => {
        if (e.event_type.startsWith("POLICY_")) return true;
        const d = e.data || {};
        if (d.session_id === sid || d.order_id === session.order_id) return true;
        if (receipt && (e.aggregate_id === receipt.receipt_id || d.receipt_id === receipt.receipt_id)) return true;
        return false;
      })
      .map((e) => ({
        event_id: e.event_id,
        event_type: e.event_type,
        aggregate_type: e.aggregate_type,
        aggregate_id: e.aggregate_id,
        occurred_at: e.occurred_at,
        version: e.version,
        summary: e.summary,
        hash: e.hash,
        prev_hash: e.prev_hash,
      })),
    chain_tip: events.length ? events[events.length - 1].hash : null,
  };
}
