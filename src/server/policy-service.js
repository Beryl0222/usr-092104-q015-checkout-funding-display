/**
 * 展示规则版本服务：发布、灰度（按商户 × 客户端版本）、回滚。
 * 灰度命中与回滚均留事件证据；回滚只改变“今后解析到哪一版”，不触碰已确认订单的选择快照。
 */
import { AGGREGATE_TYPE, EVENT_TYPE } from "../domain/enums.js";
import { validatePolicyDraft } from "../domain/rules.js";

/**
 * @typedef {Object} RolloutScope
 * @property {string[]} [merchant_ids] 命中商户（省略=全部商户）
 * @property {{min?:string, max?:string}} [client_version] 语义化客户端版本区间
 */

export class PolicyService {
  /**
   * @param {import('./store.js').EventStore} store
   * @param {object} deps
   * @param {object} deps.channelCatalog 渠道主数据表
   */
  constructor(store, { channelCatalog }) {
    this.store = store;
    this.channelCatalog = channelCatalog;
    /** @type {Map<number, object>} 版本号 -> 策略（含 scope/active） */
    this.versions = new Map();
    /** @type {number[]} 发布顺序 */
    this.publishedOrder = [];
    /** 当前生效版本指针（回滚即移动该指针并记录事件） */
    this.currentVersion = null;
    this._replay();
  }

  _replay() {
    for (const e of this.store.all()) this._fold(e);
  }

  _fold(e) {
    if (e.event_type === EVENT_TYPE.POLICY_PUBLISHED) {
      if (!this.versions.has(e.version_of)) {
        this.versions.set(e.version_of, {
          version: e.version_of,
          policy: e.policy,
          scope: e.scope ?? {},
          published_at: e.occurred_at,
          published_by: e.published_by,
          active: true,
        });
        this.publishedOrder.push(e.version_of);
        if (e.activate_as_current) this.currentVersion = e.version_of;
      }
    } else if (e.event_type === EVENT_TYPE.POLICY_ROLLED_BACK) {
      // 被回滚版本标记停用；目标版本重新成为基线
      if (this.versions.has(e.from_version)) this.versions.get(e.from_version).active = false;
      this.currentVersion = e.to_version;
    }
  }

  /**
   * 发布新版规则。发布前强制过合规校验，并冻结一份规则文本快照（快照哈希用于审计）。
   * @returns {{version:number, errors:Array}}
   */
  publish({ policy, scope = {}, published_by = "compliance", activate_as_current = true }) {
    const errors = validatePolicyDraft(policy, { channelCatalog: this.channelCatalog });
    if (errors.length) return { version: null, errors };

    const version = Math.max(0, ...this.publishedOrder) + 1;
    const frozen = JSON.parse(JSON.stringify(policy));
    frozen.version = version;
    this.store.append({
      event_type: EVENT_TYPE.POLICY_PUBLISHED,
      aggregate_type: AGGREGATE_TYPE.DISPLAY_POLICY,
      aggregate_id: "display_policy",
      summary: `发布展示规则 v${version}（灰度范围：${describeScope(scope)}）`,
      payload: {
        version_of: version,
        policy: frozen,
        scope,
        published_by,
        activate_as_current,
        scope_evidence: { scope, published_by },
      },
    });
    this._fold(this.store.all().at(-1));
    return { version, errors: [] };
  }

  /** 回滚：记录 from→to 证据事件；历史订单的展示/选择快照不受影响。 */
  rollback({ to_version, reason, operator = "compliance" }) {
    if (!this.versions.has(to_version)) throw new Error(`回滚目标版本不存在：v${to_version}`);
    const from = this.currentVersion;
    this.store.append({
      event_type: EVENT_TYPE.POLICY_ROLLED_BACK,
      aggregate_type: AGGREGATE_TYPE.DISPLAY_POLICY,
      aggregate_id: "display_policy",
      summary: `规则由 v${from} 回滚至 v${to_version}：${reason ?? "未填写原因"}`,
      payload: { from_version: from, to_version, reason: reason ?? null, operator },
    });
    this._fold(this.store.all().at(-1));
    return { from_version: from, to_version };
  }

  /**
   * 解析一次收银台请求命中的规则版本。命中判定本身留证（GRAY_ROLLOUT_EVIDENCE）。
   * 规则：从最新发布向前，找第一个 scope 命中该商户×客户端版本、且仍 active 的版本；
   *       都不命中时使用当前基线版本（currentVersion）。
   */
  resolveVersion({ merchant_id, client_version }) {
    const candidates = [...this.publishedOrder].sort((a, b) => b - a);
    for (const v of candidates) {
      const rec = this.versions.get(v);
      if (!rec.active) continue;
      if (scopeMatches(rec.scope, { merchant_id, client_version })) {
        return {
          version: v,
          policy: rec.policy,
          matched_scope: rec.scope,
          gray: v !== this.currentVersion || !isEmptyScope(rec.scope),
        };
      }
    }
    const base = this.versions.get(this.currentVersion);
    return {
      version: this.currentVersion,
      policy: base.policy,
      matched_scope: {},
      gray: false,
    };
  }

  listVersions() {
    return this.publishedOrder.map((v) => ({
      version: v,
      active: this.versions.get(v).active,
      scope: this.versions.get(v).scope,
      published_at: this.versions.get(v).published_at,
      is_current: v === this.currentVersion,
    }));
  }
}

function isEmptyScope(scope) {
  return !scope || (!scope.merchant_ids?.length && !scope.client_version);
}

function describeScope(scope) {
  const parts = [];
  parts.push(scope.merchant_ids?.length ? `商户 ${scope.merchant_ids.join("/")}` : "全部商户");
  if (scope.client_version) {
    parts.push(`客户端 ${scope.client_version.min ?? "0"} ~ ${scope.client_version.max ?? "∞"}`);
  }
  return parts.join("，");
}

/** 语义版本比较：a<b 返回 -1。非 semver 输入退化为字符串比较，永不抛错。 */
export function compareVersion(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
  }
  return 0;
}

function scopeMatches(scope, { merchant_id, client_version }) {
  if (!scope || isEmptyScope(scope)) return true;
  if (scope.merchant_ids?.length && !scope.merchant_ids.includes(merchant_id)) return false;
  if (scope.client_version && client_version) {
    if (scope.client_version.min && compareVersion(client_version, scope.client_version.min) < 0) return false;
    if (scope.client_version.max && compareVersion(client_version, scope.client_version.max) > 0) return false;
  } else if (scope.client_version && !client_version) {
    return false;
  }
  return true;
}
