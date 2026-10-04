/**
 * 零依赖 HTTP 服务（node:http）。
 * 提供渠道编排 API 与参考收银台静态页；内存态事件存储，/api/demo/reset 可重建演示数据。
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { CheckoutService } from "./checkout-service.js";
import { buildAuditReport } from "./audit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const SEED_PATH = path.join(__dirname, "..", "data", "seed.json");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

export async function loadSeed() {
  return JSON.parse(await readFile(SEED_PATH, "utf8"));
}

export function createApp(seed) {
  let service = new CheckoutService(seed);

  function resetService() {
    service = new CheckoutService(seed);
    return service;
  }

  async function readJson(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw) return {};
    return JSON.parse(raw);
  }

  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": MIME[".json"] });
    res.end(JSON.stringify(body));
  };

  // ── 查询 ──
  route("GET", /^\/api\/state$/, () => ({
    users: [...service.users.values()].map((u) => ({
      user_id: u.user_id,
      name: u.name,
      balance_cents: u.balance_cents,
      money_fund_shares_cents: u.money_fund_shares_cents,
      bank_cards: u.bank_cards,
      has_credit_grant: service.grants.some((g) => g.user_ids.includes(u.user_id)),
    })),
    merchants: [...service.merchants.values()],
    orders: [...service.orders.values()],
    policies: service.listPolicies(),
    server_time: new Date().toISOString(),
  }));

  route("GET", /^\/api\/policies$/, () => ({ policies: service.listPolicies() }));

  route("GET", /^\/api\/policies\/(\d+)$/, (req, urlPath, match) => {
    const v = Number(match[1]);
    const p = service.policies.get(v);
    if (!p) throw new Error(`规则版本不存在：v${v}`);
    return p;
  });

  // ── 规则管理 ──
  route("POST", /^\/api\/policies\/publish$/, async (req) => {
    const input = await readJson(req);
    const published = service.publishPolicy(input);
    return { published: { version: published.version, status: published.status, scope: published.scope } };
  });

  route("POST", /^\/api\/policies\/rollback$/, async (req) => {
    const body = await readJson(req);
    return service.rollbackPolicy(body.target_version, body.reason);
  });

  // ── 会话 ──
  route("POST", /^\/api\/sessions$/, async (req) => {
    const body = await readJson(req);
    return service.composeSession({
      user_id: body.user_id,
      order_id: body.order_id,
      app_version: body.app_version || "1.0.0",
      client: { device: body.device || "web" },
    });
  });

  const sessionId = (p) => p.match(/^\/api\/sessions\/([^/]+)(?:\/(select|confirm|callback|preview|audit))?$/);

  route("POST", /^\/api\/sessions\/[^/]+\/select$/, async (req, urlPath) => {
    const id = sessionId(urlPath)[1];
    const body = await readJson(req);
    return service.selectChannel(id, body.channel_id, {
      explicit_selection: body.explicit_selection,
      risk_acknowledged: body.risk_acknowledged,
      action_source: body.action_source || "user_manual",
      client_event_id: body.client_event_id,
    });
  });

  route("GET", /^\/api\/sessions\/[^/]+$/, (req, urlPath) => service.getSession(sessionId(urlPath)[1]));

  route("GET", /^\/api\/sessions\/[^/]+\/preview$/, (req, urlPath) =>
    service.previewConfirmation(sessionId(urlPath)[1])
  );

  route("POST", /^\/api\/sessions\/[^/]+\/confirm$/, async (req, urlPath) =>
    service.confirmPayment(sessionId(urlPath)[1])
  );

  // 模拟支付渠道异步回调；同参数/不同 callback_id 重放都应被幂等拒绝二次入账。
  route("POST", /^\/api\/sessions\/[^/]+\/callback$/, async (req, urlPath) => {
    const id = sessionId(urlPath)[1];
    const sess = service.getSession(id);
    const receipt = service.getReceiptByOrder(sess.order_id);
    if (!receipt) throw new Error("订单尚未确认，不能接收扣款回调");
    const body = await readJson(req);
    return service.recordSettlementCallback({
      order_id: sess.order_id,
      callback_id: body.callback_id,
      gateway: body.gateway,
      status: body.status || "success",
      amount_cents: body.amount_cents ?? receipt.amount_cents,
      settled_at: body.settled_at,
    });
  });

  route("GET", /^\/api\/sessions\/[^/]+\/audit$/, (req, urlPath) =>
    buildAuditReport(service, { session_id: sessionId(urlPath)[1] })
  );

  route("POST", /^\/api\/demo\/reset$/, () => {
    resetService();
    return { reset: true, server_time: new Date().toISOString() };
  });

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const urlPath = url.pathname;

      if (!urlPath.startsWith("/api/")) return await serveStatic(urlPath, res);

      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = urlPath.match(r.pattern);
        if (!m) continue;
        const result = await r.handler(req, urlPath, m);
        return json(res, 200, { ok: true, data: result });
      }
      return json(res, 404, { ok: false, error: `未找到路由：${req.method} ${urlPath}` });
    } catch (err) {
      const status = /不存在|尚未|校验|不得|不能|必须|需用户|不可用|没有适用|拒绝/.test(err.message) ? 422 : 400;
      return json(res, status, {
        ok: false,
        error: err.message,
        errors: err.errors || undefined,
      });
    }
  });

  async function serveStatic(urlPath, res) {
    const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
    const file = path.join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      return res.end("forbidden");
    }
    try {
      const content = await readFile(file);
      res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
      res.end(content);
    } catch {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("未找到页面");
    }
  }

  server.checkoutService = () => service;
  server.reset = resetService;
  return server;
}

export async function start(port = Number(process.env.PORT) || 8080) {
  const seed = await loadSeed();
  const server = await new Promise((resolve) => {
    const app = createApp(seed);
    app.listen(port, () => resolve(app));
  });
  return server;
}

import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT) || 8080;
  const server = await start(port);
  console.log(`参考收银台已启动：http://localhost:${port}/`);
  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
