/* 参考收银台前端：原生 JS、零依赖，键盘（Tab/方向键/空格/回车）与读屏可完整操作。 */

const $ = (id) => document.getElementById(id);
const state = {
  state: null,
  session: null,
  receipt: null,
  auditUrl: null,
};

const yuan = (cents) => `¥${(cents / 100).toFixed(2)}`;

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok || json.ok === false) {
    const err = new Error(json.error || `请求失败：${res.status}`);
    err.errors = json.errors;
    throw err;
  }
  return json.data;
}

function banner(message, kind = "error") {
  const el = $("banner");
  el.hidden = false;
  el.className = `banner ${kind}`;
  el.textContent = message;
}
function clearBanner() { $("banner").hidden = true; }

function setError(msg) {
  const el = $("form-error");
  if (!msg) { el.hidden = true; el.textContent = ""; }
  else { el.hidden = false; el.textContent = msg; }
}

// ─────────────── 初始化场景选择 ───────────────

async function loadState() {
  state.state = await api("GET", "/api/state");
  const users = $("user-select");
  users.innerHTML = "";
  for (const u of state.state.users) {
    const opt = document.createElement("option");
    opt.value = u.user_id;
    opt.textContent = `${u.name}（${u.user_id}${u.has_credit_grant ? "，已获授信" : "，未获授信"}）`;
    users.appendChild(opt);
  }
  users.value = "u_credit";

  const orders = $("order-select");
  orders.innerHTML = "";
  for (const o of state.state.orders) {
    const opt = document.createElement("option");
    opt.value = o.order_id;
    opt.textContent = `${o.subject}（${o.merchant_id}）`;
    orders.appendChild(opt);
  }
}

// ─────────────── 组装收银台 ───────────────

async function compose() {
  clearBanner(); setError(null);
  try {
    state.session = await api("POST", "/api/sessions", {
      user_id: $("user-select").value,
      order_id: $("order-select").value,
      app_version: $("version-select").value,
      device: "web",
    });
    state.receipt = null;
    renderSession();
  } catch (err) { banner(err.message); }
}

function renderSession() {
  const s = state.session;
  $("checkout-panel").hidden = false;
  $("receipt-panel").hidden = true;
  $("audit-output").innerHTML = "";
  $("audit-download").hidden = true;
  $("audit-btn").disabled = false;
  $("callback-btn").disabled = true;
  $("duplicate-callback-btn").disabled = true;

  renderGrayEvidence(s);
  renderGroups(s);
  const selectedId = s.selected_channel_id;
  if (selectedId) {
    const radio = document.querySelector(`input[name="funding-channel"][value="${selectedId}"]`);
    if (radio) radio.checked = true;
  }
  renderDetail();
  updateConfirmEnabled();
  $("checkout-panel").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderGrayEvidence(s) {
  const considered = s.resolution.considered
    .map((c) => {
      const scope = c.scope || {};
      const merchants = (scope.merchant_ids || []).join(",");
      return `<li>规则 v${c.version}：商户命中=${c.merchant_hit ? "是" : "否"}（适用商户 ${merchants}），版本命中=${c.version_hit ? "是" : `否（需 ≥ ${scope.min_app_version || "1.0.0"}）`} → ${c.matched ? "<strong>适用</strong>" : "不适用"}</li>`;
    })
    .join("");
  $("gray-evidence").innerHTML = `
    <strong>本次展示依据：规则 v${s.policy.version}</strong>（${s.policy.change_note}）
    <br />发布者：${s.policy.published_by}；发布时间：${s.policy.published_at}；会话冻结该版本，后续发布/回滚不影响本单。
    <ul>${considered}</ul>`;
}

function renderGroups(s) {
  const own = s.groups.find((g) => g.nature === "own_funds");
  const credit = s.groups.find((g) => g.nature === "credit_product");

  $("own-legend").textContent = own.title;
  $("own-desc").textContent = own.description;
  $("credit-legend").textContent = credit.title;
  $("credit-desc").textContent = credit.description;
  $("own-channels").innerHTML = "";
  $("credit-channels").innerHTML = "";

  for (const ch of own.channels) $("own-channels").appendChild(channelOption(ch));
  for (const ch of credit.channels) $("credit-channels").appendChild(channelOption(ch));

  for (const input of document.querySelectorAll('input[name="funding-channel"]')) {
    input.addEventListener("change", onChannelChange);
  }
}

function channelOption(ch) {
  const wrap = document.createElement("label");
  wrap.className = `channel-option${ch.enabled ? "" : " disabled"}${ch.selected ? " selected" : ""}`;
  wrap.id = `option-${ch.channel_id}`;

  const radio = document.createElement("input");
  radio.type = "radio";
  radio.name = "funding-channel";
  radio.value = ch.channel_id;
  radio.checked = false;
  if (!ch.enabled) { radio.disabled = true; }
  radio.setAttribute("aria-describedby", `desc-${ch.channel_id}`);

  const body = document.createElement("span");
  const name = document.createElement("span");
  name.className = "channel-name";
  name.textContent = ch.name;
  const tagline = document.createElement("div");
  tagline.className = "channel-tagline";
  tagline.textContent = ch.tagline;
  const desc = document.createElement("span");
  desc.className = "visually-hidden";
  desc.id = `desc-${ch.channel_id}`;
  desc.textContent = ch.nature === "credit_product"
    ? `金融产品，资金性质为借款，不会被默认选中。${ch.tagline}`
    : `支付工具，资金性质为自有资金。${ch.tagline}`;
  body.append(name, tagline, desc);

  const badge = document.createElement("span");
  badge.className = `channel-nature-badge ${ch.nature === "own_funds" ? "badge-own" : "badge-credit"}`;
  badge.textContent = ch.nature === "own_funds" ? "自有资金" : "借款";

  wrap.append(radio, body, badge);

  if (!ch.enabled) {
    const why = document.createElement("div");
    why.className = "unavailable";
    why.textContent = `不可用：${ch.unavailable_reason || "—"}（该渠道仅置灰展示，不可选择）`;
    wrap.appendChild(why);
  }
  return wrap;
}

function currentChannel() {
  const id = document.querySelector('input[name="funding-channel"]:checked')?.value;
  if (!id) return null;
  return state.session.groups.flatMap((g) => g.channels).find((c) => c.channel_id === id);
}

function onChannelChange() {
  for (const lbl of document.querySelectorAll(".channel-option")) lbl.classList.remove("selected");
  const ch = currentChannel();
  if (ch) $(`option-${ch.channel_id}`).classList.add("selected");

  // 金融产品：每次选中都重置知悉勾选，强制逐次确认
  const ackBlock = $("ack-block");
  if (ch && ch.nature === "credit_product") {
    ackBlock.hidden = false;
    $("risk-ack").checked = false;
  } else {
    ackBlock.hidden = true;
  }
  setError(null);
  renderDetail();
  updateConfirmEnabled();
}

function updateConfirmEnabled() {
  const ch = currentChannel();
  let enabled = !!ch;
  if (ch && ch.nature === "credit_product") enabled = enabled && $("risk-ack").checked;
  $("confirm-btn").disabled = !enabled || !!state.receipt;
}

// ─────────────── 明细：资金性质 / 费用 / 取消后果 ───────────────

function renderDetail() {
  const ch = currentChannel();
  const box = $("channel-detail");
  if (!ch) {
    box.innerHTML = '<p class="hint">请选择一个资金渠道。</p>';
    return;
  }
  const s = state.session;
  const rows = [];
  rows.push(["资金性质", ch.nature === "own_funds" ? "自有资金（花您自己的钱，不产生借款）" : "借款（由授信方垫付，需按约还款）"]);
  rows.push(["渠道说明", ch.description]);
  if (ch.funds_info) rows.push([ch.funds_info.label, `${yuan(ch.funds_info.amount_cents)}（数据来源：${ch.funds_info.source}${ch.funds_info.grant_id ? `，授信编号 ${ch.funds_info.grant_id}` : ""}；展示层只读，不能修改或授信）`]);
  if (ch.redemption_note) rows.push(["赎回说明", ch.redemption_note]);
  rows.push(["订单金额", yuan(s.order.amount_cents)]);

  let feeHtml = "";
  const fee = ch.fee;
  if (fee.fee_type === "none" || fee.fee_type === "credit_bill") {
    rows.push(["渠道费用", fee.fee_type === "credit_bill" ? "按时全额还款本笔无额外费用" : "无额外费用"]);
    if (fee.note) rows.push(["费用说明", fee.note]);
    rows.push(["本笔应还总额", yuan(s.order.amount_cents)]);
  } else if (fee.fee_type === "installment_interest") {
    rows.push(["利率口径", fee.rate_description]);
    rows.push(["分期期数", `${fee.months} 期（等额本息）`]);
    rows.push(["每期金额", `前 ${fee.months - 1} 期 ${yuan(fee.per_installment_cents)}，末期 ${yuan(fee.last_installment_cents)}`]);
    rows.push(["分期总费用（利息）", yuan(fee.total_fee_cents)]);
    rows.push(["应还总额", yuan(fee.total_repay_cents)]);
    feeHtml = `
      <table class="fee-table">
        <caption class="visually-hidden">分期还款计划</caption>
        <thead><tr><th scope="col">期次</th><th scope="col">本期应还</th></tr></thead>
        <tbody>${fee.schedule_cents.map((v, i) => `<tr><td>第 ${i + 1} 期</td><td>${yuan(v)}</td></tr>`).join("")}</tbody>
        <tfoot><tr class="fee-total"><td>合计</td><td>${yuan(fee.total_repay_cents)}（含费用 ${yuan(fee.total_fee_cents)}）</td></tr></tfoot>
      </table>`;
  }

  box.innerHTML = `
    <dl class="detail-grid">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
    ${feeHtml}
    ${ch.risk_warning ? `<div class="risk-box" role="note"><strong>风险提示：</strong>${ch.risk_warning}</div>` : ""}
    <div><strong>取消后果：</strong>${ch.cancel_consequence}</div>`;
}

// ─────────────── 确认 / 回调 ───────────────

$("checkout-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  clearBanner(); setError(null);
  const ch = currentChannel();
  if (!ch) { setError("请先选择资金渠道"); return; }
  if (ch.nature === "credit_product" && !$("risk-ack").checked) {
    setError("金融产品必须勾选知悉确认后才能提交");
    return;
  }
  try {
    // 选择与确认在用户主动提交时一并留证；选择事件携带显式证据。
    await api("POST", `/api/sessions/${state.session.session_id}/select`, {
      channel_id: ch.channel_id,
      explicit_selection: ch.nature === "credit_product" ? true : undefined,
      risk_acknowledged: ch.nature === "credit_product" ? true : undefined,
      action_source: "user_manual",
      client_event_id: crypto.randomUUID(),
    });
    const receipt = await api("POST", `/api/sessions/${state.session.session_id}/confirm`);
    state.receipt = receipt;
    $("receipt-panel").hidden = false;
    $("receipt-output").textContent = JSON.stringify(receipt, null, 2);
    $("confirm-btn").disabled = true;
    $("callback-btn").disabled = false;
    $("duplicate-callback-btn").disabled = false;
    for (const r of document.querySelectorAll('input[name="funding-channel"]')) r.disabled = true;
    $("risk-ack").disabled = true;
    banner("支付已确认：所选渠道、费用与规则版本已冻结；等待渠道扣款回执。", "ok");
    $("receipt-panel").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    setError(`${err.message}${err.errors ? `：${err.errors.join("；")}` : ""}`);
  }
});

$("risk-ack").addEventListener("change", updateConfirmEnabled);

async function sendCallback(label) {
  try {
    const result = await api("POST", `/api/sessions/${state.session.session_id}/callback`, {
      callback_id: `cb-${label}-${Date.now()}`,
      gateway: "演示支付网关",
      status: "success",
    });
    const line = document.createElement("div");
    line.className = "lab-entry ok";
    line.textContent = result.duplicate
      ? `【${label}】重复回调被幂等拦截：duplicate=true，沿用首次结算 ${result.settlement.callback_id}，未二次入账。`
      : `【${label}】首次回调入账成功：settlement=${JSON.stringify(result.settlement)}`;
    $("lab-output").prepend(line);
    if (!result.duplicate && state.receipt) {
      state.receipt.settlement = result.settlement;
      $("receipt-output").textContent = JSON.stringify(state.receipt, null, 2);
    }
  } catch (err) {
    const line = document.createElement("div");
    line.className = "lab-entry bad";
    line.textContent = `【${label}】回调被拒绝：${err.message}`;
    $("lab-output").prepend(line);
  }
}

$("callback-btn").addEventListener("click", () => sendCallback("首次"));
$("duplicate-callback-btn").addEventListener("click", () => sendCallback("重复"));

// ─────────────── 审计 ───────────────

$("audit-btn").addEventListener("click", async () => {
  if (!state.session) return;
  try {
    const report = await api("GET", `/api/sessions/${state.session.session_id}/audit`);
    renderAudit(report);
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const dl = $("audit-download");
    dl.href = URL.createObjectURL(blob);
    dl.hidden = false;
  } catch (err) { banner(err.message); }
});

function renderAudit(r) {
  const checks = r.checks
    .map((c) => `<li><span class="${c.passed ? "audit-pass" : "audit-fail"}">${c.passed ? "✔ 通过" : "✘ 未通过"}</span>
      <span><strong>${c.id} ${c.title}</strong><br /><span class="audit-detail">${c.detail}</span></span></li>`)
    .join("");
  const rollbackInfo = r.policy_rollbacks.length
    ? r.policy_rollbacks.map((x) => `v${x.from_version} → v${x.to_version}（${x.reason}，${x.occurred_at}）`).join("；")
    : "无回滚";
  $("audit-output").innerHTML = `
    <p><span class="audit-summary ${r.overall_passed ? "passed" : "failed"}">${r.overall_passed ? "全部检查通过：展示、选择与实际扣款一致" : "存在未通过项"}</span></p>
    <p class="hint">证据包含灰度解析、冻结版本（v${r.frozen_snapshot.policy_version}）、选择证据、回执与 ${r.events.length} 条事件哈希；回滚记录：${rollbackInfo}；链尖哈希 <code>${(r.chain_tip || "").slice(0, 16)}…</code>，可离线重算验证。</p>
    <ul class="audit-checks">${checks}</ul>`;
}

// ─────────────── 规则实验室 ───────────────

function labLine(text, ok) {
  const div = document.createElement("div");
  div.className = `lab-entry ${ok ? "ok" : "bad"}`;
  div.textContent = text;
  $("lab-output").prepend(div);
}

async function highestPolicy() {
  const list = (await api("GET", "/api/policies")).policies.filter((p) => p.status === "active");
  list.sort((a, b) => b.version - a.version);
  return api("GET", `/api/policies/${list[0].version}`);
}

$("bad-publish-btn").addEventListener("click", async () => {
  try {
    const base = await highestPolicy();
    const draft = stripVersion(base);
    draft.channel_copy.credit_pay.tagline = "借款秒到账，低门槛随借随还";
    draft.change_note = "违规尝试：诱导文案（发布校验应拒绝）";
    await api("POST", "/api/policies/publish", draft);
    labLine("含诱导文案的规则竟发布成功——校验失效（不应发生）", false);
  } catch (err) {
    labLine(`发布已被拒绝：${err.errors ? err.errors.join("；") : err.message}`, true);
  }
});

$("good-publish-btn").addEventListener("click", async () => {
  try {
    const base = await highestPolicy();
    const draft = stripVersion(base);
    draft.channel_order = ["acct_balance", "card_debit_6228", "money_fund_01", "credit_pay", "installment_3"];
    draft.change_note = "v3 合规改版：余额优先、储蓄卡次之，金融产品维持不默认选中。";
    const p = await api("POST", "/api/policies/publish", draft);
    labLine(`合规 v${p.version} 发布成功，灰度范围：商户 ${p.scope.merchant_ids.join(",")}，客户端 ≥ ${p.scope.min_app_version || "1.0.0"}。重新组装收银台即可看到新排序。`, true);
  } catch (err) {
    labLine(`发布失败：${err.errors ? err.errors.join("；") : err.message}`, false);
  }
});

$("rollback-btn").addEventListener("click", async () => {
  try {
    const r = await api("POST", "/api/policies/rollback", { target_version: 1, reason: "演示回滚：暂停灰度" });
    labLine(`规则已回滚至 v${r.to_version}（事件 ${r.event_id.slice(0, 8)}…）。已确认订单不受影响；新会话将解析到 v1。`, true);
  } catch (err) {
    labLine(`回滚失败：${err.message}`, false);
  }
});

function stripVersion(p) {
  const clone = JSON.parse(JSON.stringify(p));
  delete clone.version;
  delete clone.status;
  delete clone.published_at;
  delete clone.parent_version;
  return clone;
}

$("reset-btn").addEventListener("click", async () => {
  await api("POST", "/api/demo/reset");
  $("checkout-panel").hidden = true;
  $("receipt-panel").hidden = true;
  $("lab-output").innerHTML = "";
  $("audit-output").innerHTML = "";
  $("audit-download").hidden = true;
  state.session = null; state.receipt = null;
  await loadState();
  banner("演示数据已重置：规则版本恢复为 v1（基线）+ v2（灰度）。", "ok");
});

// ─────────────── 启动 ───────────────
$("compose-btn").addEventListener("click", compose);
await loadState();
