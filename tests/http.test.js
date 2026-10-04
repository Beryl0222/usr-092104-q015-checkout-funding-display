import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createApp } from "../src/server.js";

async function listen() {
  const seed = JSON.parse(await readFile(new URL("../data/seed.json", import.meta.url), "utf8"));
  const app = createApp(seed);
  await new Promise((resolve) => app.listen(0, resolve));
  const port = app.address().port;
  return { app, base: `http://127.0.0.1:${port}` };
}

async function call(base, method, url, body) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, json };
}

test("静态页面与前端资源可访问", async () => {
  const { app, base } = await listen();
  try {
    const html = await fetch(`${base}/`);
    assert.equal(html.status, 200);
    const text = await html.text();
    assert.match(text, /参考收银台/);
    assert.match(text, /跳到主内容/); // 跳过链接

    const js = await fetch(`${base}/app.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type"), /javascript/);
  } finally {
    app.close();
  }
});

test("端到端：灰度会话 → 显式选择分期 → 确认 → 单次结算 → 审计通过", async () => {
  const { app, base } = await listen();
  try {
    const composed = await call(base, "POST", "/api/sessions", {
      user_id: "u_credit",
      order_id: "ord_demo_001",
      app_version: "2.1.0",
    });
    assert.equal(composed.status, 200);
    const sid = composed.json.data.session_id;
    assert.equal(composed.json.data.policy.version, 2);

    // 未带显式证据选择分期 → 422
    const denied = await call(base, "POST", `/api/sessions/${sid}/select`, { channel_id: "installment_3" });
    assert.equal(denied.status, 422);

    const selected = await call(base, "POST", `/api/sessions/${sid}/select`, {
      channel_id: "installment_3",
      explicit_selection: true,
      risk_acknowledged: true,
      action_source: "user_manual",
      client_event_id: "k-1",
    });
    assert.equal(selected.status, 200);
    assert.equal(selected.json.data.explicit_selection, true);

    const preview = await call(base, "GET", `/api/sessions/${sid}/preview`);
    assert.equal(preview.json.data.total_repay_cents, 10120);

    const confirmed = await call(base, "POST", `/api/sessions/${sid}/confirm`);
    const receiptId = confirmed.json.data.receipt_id;
    assert.equal(confirmed.json.data.policy_version_frozen, 2);

    const cb1 = await call(base, "POST", `/api/sessions/${sid}/callback`, { callback_id: "h-cb-1", gateway: "gw" });
    assert.equal(cb1.json.data.duplicate, false);
    const cb2 = await call(base, "POST", `/api/sessions/${sid}/callback`, { callback_id: "h-cb-2", gateway: "gw" });
    assert.equal(cb2.json.data.duplicate, true);
    assert.equal(cb2.json.data.settlement.callback_id, "h-cb-1");

    const audit = await call(base, "GET", `/api/sessions/${sid}/audit`);
    assert.equal(audit.json.data.overall_passed, true);
    assert.ok(audit.json.data.events.some((e) => e.event_type === "SETTLEMENT_RECORDED"));
    assert.ok(audit.json.data.chain_tip);

    // 回滚后审计仍证明冻结版本
    await call(base, "POST", "/api/policies/rollback", { target_version: 1, reason: "http 回滚验证" });
    const audit2 = await call(base, "GET", `/api/sessions/${sid}/audit`);
    assert.equal(audit2.json.data.receipt.policy_version_frozen, 2);
    assert.equal(audit2.json.data.overall_passed, true);
    assert.ok(receiptId);
  } finally {
    app.close();
  }
});

test("端到端：诱导文案规则发布被拒（422 且返回错误清单）", async () => {
  const { app, base } = await listen();
  try {
    const v2 = await call(base, "GET", "/api/policies/2");
    const draft = v2.json.data;
    delete draft.version; delete draft.status; delete draft.published_at; delete draft.parent_version;
    draft.channel_copy.credit_pay.tagline = "借款秒到账，低门槛";
    const res = await call(base, "POST", "/api/policies/publish", draft);
    assert.equal(res.status, 422);
    assert.ok(Array.isArray(res.json.errors));
    assert.ok(res.json.errors.some((e) => e.includes("秒到账")));
  } finally {
    app.close();
  }
});

test("端到端：旧客户端解析到 v1，默认储蓄卡", async () => {
  const { app, base } = await listen();
  try {
    const res = await call(base, "POST", "/api/sessions", {
      user_id: "u_credit",
      order_id: "ord_demo_001",
      app_version: "1.0.0",
    });
    assert.equal(res.json.data.policy.version, 1);
    assert.equal(res.json.data.default_channel_id, "card_debit_6228");
  } finally {
    app.close();
  }
});

test("端到端：重置后规则与事件恢复初始状态", async () => {
  const { app, base } = await listen();
  try {
    await call(base, "POST", "/api/policies/rollback", { target_version: 1 });
    const reset = await call(base, "POST", "/api/demo/reset");
    assert.equal(reset.json.data.reset, true);
    const policies = await call(base, "GET", "/api/policies");
    assert.deepEqual(policies.json.data.policies.map((p) => p.version), [1, 2]);
    assert.ok(policies.json.data.policies.every((p) => p.status === "active"));
  } finally {
    app.close();
  }
});
