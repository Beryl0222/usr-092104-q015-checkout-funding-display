/**
 * HTTP 入口：收银台 API + 管理端（发布/灰度/回滚）+ 审计导出 + 参考收银台静态页。
 * 启动：node src/server/http-server.js [--file data/events.jsonl] [--port 8080]
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { randomUUID } from "node:crypto";

import { CHANNEL_CATALOG } from "../domain/enums.js";
import { EventStore } from "./store.js";
import { PolicyService } from "./policy-service.js";
import { CheckoutService } from "./checkout-service.js";
import { buildAuditReport } from "./audit.js";
import { availabilityProvider, baselinePolicy, eligibilityProvider, pricingProvider } from "./seed.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../..");

export function createApp({ file = null } = {}) {
  const store = new EventStore(file);
  const policies = new PolicyService(store, { channelCatalog: CHANNEL_CATALOG });
  const checkout = new CheckoutService(store, {
    policies,
    channelCatalog: CHANNEL_CATALOG,
    eligibilityProvider,
    availabilityProvider,
    pricingProvider,
  });

  // 全新存储时自动发布合规基线 v1
  if (!policies.listVersions().length) {
    policies.publish({ policy: baselinePolicy(), scope: {}, published_by: "system-bootstrap" });
  }

  return { store, policies, checkout, handler: makeHandler({ store, policies, checkout }) };
}

function makeHandler({ store, policies, checkout }) {
  return async function handler(req, res) {
    try {
      const url = new URL(req.url, "http://localhost");
      const route = `${req.method} ${url.pathname}`;

      if (req.method === "GET" && url.pathname === "/api/health") return json(res, 200, { ok: true });

      // ---- 管理端：规则发布 / 列表 / 回滚 ----
      if (req.method === "POST" && url.pathname === "/admin/policies") {
        const body = await readJson(req);
        const result = policies.publish({
          policy: body.policy,
          scope: body.scope ?? {},
          published_by: body.published_by ?? "compliance",
        });
        return json(res, result.errors.length ? 422 : 200, result);
      }
      if (req.method === "GET" && url.pathname === "/admin/policies") {
        return json(res, 200, { versions: policies.listVersions(), current: policies.currentVersion });
      }
      if (req.method === "POST" && url.pathname === "/admin/policies/rollback") {
        const body = await readJson(req);
        return json(res, 200, policies.rollback({ to_version: body.to_version, reason: body.reason, operator: body.operator }));
      }

      // ---- 收银台流程 ----
      if (req.method === "POST" && url.pathname === "/api/checkout/compose") {
        const body = await readJson(req);
        for (const k of ["order_id", "merchant_id", "user_id", "client_version", "amount"]) {
          if (body[k] === undefined) return json(res, 400, { error: `缺少字段：${k}` });
        }
        const sessionId = body.session_id || `sess-${randomUUID()}`;
        const snapshot = checkout.compose({
          session_id: sessionId,
          order_id: String(body.order_id),
          merchant_id: body.merchant_id,
          user_id: body.user_id,
          client_version: body.client_version,
          amount: Math.round(Number(body.amount)),
          currency: body.currency ?? "CNY",
          recommendations: body.recommendations ?? [],
        });
        return json(res, 200, { session_id: sessionId, snapshot });
      }

      const sessionAction = url.pathname.match(/^\/api\/sessions\/([^/]+)\/(select|confirm|cancel)$/);
      if (sessionAction) {
        const [, sessionId, action] = sessionAction;
        const body = req.method === "POST" ? await readJson(req) : {};
        if (action === "select") {
          return json(res, 200, checkout.select(sessionId, body));
        }
        if (action === "confirm") return json(res, 200, checkout.confirm(sessionId));
        if (action === "cancel") return json(res, 200, checkout.cancel(sessionId, body));
      }
      if (req.method === "GET" && url.pathname.startsWith("/api/sessions/")) {
        const s = checkout.getSession(url.pathname.split("/").pop());
        return s ? json(res, 200, projectSession(s)) : json(res, 404, { error: "会话不存在" });
      }

      // ---- 支付回调（幂等） ----
      if (req.method === "POST" && url.pathname === "/api/callbacks") {
        const body = await readJson(req);
        return json(res, 200, checkout.onCallback(body));
      }

      // ---- 审计导出 ----
      if (req.method === "GET" && url.pathname === "/api/audit") {
        return json(res, 200, buildAuditReport(store));
      }
      if (req.method === "GET" && url.pathname === "/api/events") {
        return json(res, 200, { events: store.all() });
      }

      // ---- 静态页 ----
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        return staticFile(res, join(ROOT, "public/index.html"), "text/html; charset=utf-8");
      }
      if (req.method === "GET" && url.pathname.startsWith("/public/")) {
        const safe = url.pathname.replace(/\.\./g, "");
        return staticFile(res, join(ROOT, safe), mime(extname(safe)));
      }

      return json(res, 404, { error: "not found", route });
    } catch (err) {
      return json(res, err.status ?? 500, { error: err.message });
    }
  };
}

function projectSession(s) {
  return {
    session_id: s.session_id,
    order_id: s.order_id,
    state: s.state,
    policy_version: s.policy_version,
    snapshot: s.snapshot,
    selection: s.selection ?? null,
    confirmation: s.confirmation ?? null,
  };
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function json(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

async function staticFile(res, path, type) {
  try {
    const content = await readFile(path);
    res.writeHead(200, { "content-type": type });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}

function mime(ext) {
  return { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css" }[ext] ?? "application/octet-stream";
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const args = process.argv.slice(2);
  const port = Number(args[args.indexOf("--port") + 1]) || 8080;
  const fileIdx = args.indexOf("--file");
  const file = fileIdx >= 0 ? args[fileIdx + 1] : "data/events.jsonl";
  const { handler } = createApp({ file });
  createServer(handler).listen(port, () => {
    console.log(`收银台渠道编排与审计系统：http://localhost:${port}`);
    console.log(`事件存储：${file}`);
  });
}
