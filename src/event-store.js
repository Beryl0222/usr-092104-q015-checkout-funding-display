/**
 * 追加式事件存储 + 哈希链。
 *
 * 每条事件载荷经规范化 JSON 后计算 sha256，hash_n = sha256(hash_{n-1} | canonical(payload))。
 * 任何对已写入事件的篡改都会让链校验失败；导出审计时同时导出链与逐事件哈希，
 * 第三方可独立重算验证展示/选择/扣款三类证据未被事后修改。
 */

import { createHash } from "node:crypto";

export function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys(value[k])])
    );
  }
  return value;
}

export function hashPayload(payload, prevHash) {
  return createHash("sha256").update(prevHash || "").update(canonicalJson(payload)).digest("hex");
}

export class EventStore {
  /** @param {Array} initial 可选的已存在事件（含 hash/prev_hash，用于装载快照）。 */
  constructor(initial = []) {
    this.events = [];
    this.byId = new Map();
    for (const e of initial) this._ingest(e);
  }

  _ingest(event) {
    if (this.byId.has(event.event_id)) throw new Error(`事件已存在：${event.event_id}`);
    const expectedPrev = this.events.length ? this.events[this.events.length - 1].hash : null;
    if (event.prev_hash !== expectedPrev) throw new Error(`哈希链断裂于事件：${event.event_id}`);
    const { hash, prev_hash, ...payload } = event;
    if (hashPayload(payload, prev_hash) !== hash) throw new Error(`事件哈希校验失败：${event.event_id}`);
    this.events.push(event);
    this.byId.set(event.event_id, event);
  }

  /** 追加事件；event_id 幂等（相同 event_id 重复写入返回原事件，用于回调去重场景的上游保护）。 */
  append(event) {
    if (this.byId.has(event.event_id)) return this.byId.get(event.event_id);
    const prevHash = this.events.length ? this.events[this.events.length - 1].hash : null;
    const stored = { ...event, prev_hash: prevHash, hash: hashPayload(event, prevHash) };
    this.events.push(stored);
    this.byId.set(stored.event_id, stored);
    return stored;
  }

  list(filter = {}) {
    return this.events.filter((e) => {
      for (const [k, v] of Object.entries(filter)) if (e[k] !== v) return false;
      return true;
    });
  }

  /** 重算全链哈希。@returns {{ok:boolean, broken_at?:string}} */
  verifyChain() {
    let prev = null;
    for (const e of this.events) {
      const { hash, prev_hash, ...payload } = e;
      if (prev_hash !== prev) return { ok: false, broken_at: e.event_id, reason: "prev_hash 不衔接" };
      if (hashPayload(payload, prev_hash) !== hash) return { ok: false, broken_at: e.event_id, reason: "哈希不匹配" };
      prev = hash;
    }
    return { ok: true, length: this.events.length };
  }
}
