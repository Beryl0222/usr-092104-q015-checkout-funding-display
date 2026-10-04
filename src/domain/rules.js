/**
 * 合规规则引擎：只决定渠道“可展示方式”，不伪造余额、不批准授信。
 * 规则在策略发布时与会话组装时各执行一次：发布期拦截非法策略，组装期留证。
 */
import { CHANNEL_GROUP, RULE_CODES } from "./enums.js";

/**
 * 诱导性文案黑名单（语义片段，大小写不敏感、忽略空格变体）。
 * 依据：任何贷款、理财或分期都不得以“低门槛”“秒到账”等诱导文案进入支付流程。
 */
const SOLICITING_PATTERNS = [
  "低门槛",
  "零门槛",
  "无门槛",
  "秒到账",
  "秒下款",
  "极速到账",
  "即时到账",
  "零利息",
  "零利率",
  "免息借钱",
  "免费借钱",
  "白拿钱",
  "不用还",
  "人人可借",
  "有额度就能借",
  "一键借款",
  "轻松借",
  "随借随还无压力",
  "稳赚",
  "保本保息",
  "零风险",
  "收益翻倍",
];

const NORMALIZE_RE = /[\s，。、！!,.~～]+/g;

export function findSolicitingPhrases(text) {
  if (!text) return [];
  const flat = String(text).replace(NORMALIZE_RE, "");
  return SOLICITING_PATTERNS.filter((p) => flat.includes(p));
}

/**
 * 校验一份展示策略草稿。
 * @returns {Array<{code:string, message:string}>} 错误清单，空数组表示可发布
 */
export function validatePolicyDraft(policy, { channelCatalog }) {
  const errors = [];
  const push = (code, message) => errors.push({ code, message });

  if (!policy || typeof policy !== "object") {
    push(RULE_CODES.GROUP_SEPARATION, "策略不能为空");
    return errors;
  }
  // 版本号若随草稿提供则必须为正整数；正常发布时版本由发布器分配
  if (policy.version !== undefined && (!Number.isInteger(policy.version) || policy.version < 1)) {
    push(RULE_CODES.GROUP_SEPARATION, "策略版本号必须为正整数");
  }

  const groupOrder = policy.group_order ?? [];
  const knownGroups = new Set(Object.values(CHANNEL_GROUP));
  if (!Array.isArray(groupOrder) || groupOrder.length === 0) {
    push(RULE_CODES.GROUP_SEPARATION, "group_order 必须显式给出分组展示顺序");
  } else {
    const seen = new Set();
    for (const g of groupOrder) {
      if (!knownGroups.has(g)) push(RULE_CODES.GROUP_SEPARATION, `未知资金分组：${g}`);
      if (seen.has(g)) push(RULE_CODES.GROUP_SEPARATION, `分组重复出现：${g}`);
      seen.add(g);
    }
    // 结构区隔：借贷分组不得排在支付工具之前被置顶
    const payIdx = groupOrder.indexOf(CHANNEL_GROUP.PAYMENT_TOOL);
    const creditIdx = groupOrder.indexOf(CHANNEL_GROUP.CREDIT);
    if (payIdx !== -1 && creditIdx !== -1 && creditIdx < payIdx) {
      push(RULE_CODES.GROUP_SEPARATION, "借贷分组不得排在支付工具（自有资金）分组之前");
    }
  }

  // 分组内排序配置：信贷/理财渠道永远不得配置为默认渠道
  const entries = policy.channel_rules ?? {};
  for (const [channelCode, rule] of Object.entries(entries)) {
    const def = channelCatalog[channelCode];
    if (!def) {
      push(RULE_CODES.GROUP_SEPARATION, `策略引用了未登记的渠道：${channelCode}`);
      continue;
    }
    if (rule?.default_selected && def.group !== CHANNEL_GROUP.PAYMENT_TOOL) {
      push(
        RULE_CODES.NO_CREDIT_DEFAULT,
        `${def.name}（${def.group}）不得配置为默认选中：贷款、理财与分期必须由用户主动选择`,
      );
    }
    if (rule?.prechecked && def.group === CHANNEL_GROUP.CREDIT) {
      push(RULE_CODES.NO_CREDIT_DEFAULT, `${def.name}不得预置勾选`);
    }
    // 文案扫描：名称、副标题、营销语
    for (const field of ["label", "subtitle", "marketing_text", "tag"]) {
      const hits = findSolicitingPhrases(rule?.[field]);
      if (hits.length) {
        push(
          RULE_CODES.NO_SOLICITING_COPY,
          `${def.name}的${field}含诱导性文案：${hits.join("、")}（禁止进入支付流程）`,
        );
      }
    }
  }

  // 默认渠道至多一个，且必须是支付工具
  const defaults = Object.entries(entries).filter(([, r]) => r?.default_selected);
  if (defaults.length > 1) {
    push(RULE_CODES.NO_CREDIT_DEFAULT, "默认选中渠道至多一个");
  }

  return errors;
}

/**
 * 组装期合规判定：在已知渠道定义、用户资格、订单可用性前提下产出展示清单。
 * 纯函数，便于测试与回放。
 *
 * @param {object} input
 * @param {object} input.policy 已发布策略（含 version / group_order / channel_rules）
 * @param {Array}  input.channels 渠道主数据
 * @param {Record<string, {eligible:boolean, reason?:string}>} input.eligibility 用户资格（后端权威事实）
 * @param {Record<string, {available:boolean, reason?:string, balance?:import('./types.js').MoneyAmount}>} input.availability 订单维度可用性与真实余额
 * @param {Array<{channel_code:string, score:number}>} [input.recommendations] 推荐分（仅允许影响支付工具组内次序）
 * @returns {{groups: Array, default_channel_code: string|null, applied_rules: string[], suppressed: Array}}
 */
export function composeCheckout({ policy, channels, eligibility = {}, availability = {}, recommendations = [] }) {
  const applied = new Set([RULE_CODES.GROUP_SEPARATION, RULE_CODES.NO_CREDIT_DEFAULT, RULE_CODES.COST_TRANSPARENCY]);
  const suppressed = [];

  const visible = channels.filter((ch) => {
    const elig = eligibility[ch.code];
    const av = availability[ch.code];
    if (elig && !elig.eligible) {
      suppressed.push({ channel_code: ch.code, reason: "NOT_ELIGIBLE", detail: elig.reason ?? "用户不具备使用资格" });
      return false;
    }
    if (av && !av.available) {
      suppressed.push({ channel_code: ch.code, reason: "NOT_AVAILABLE", detail: av.reason ?? "当前订单不可用" });
      return false;
    }
    return true;
  });

  // 推荐分：只在支付工具组内生效；信贷/理财的推荐分被结构性忽略
  const scoreOf = new Map(recommendations.map((r) => [r.channel_code, r.score]));
  if (recommendations.length) applied.add(RULE_CODES.RECOMMEND_PAYMENT_ONLY);

  const byGroup = new Map();
  for (const ch of visible) {
    const rule = policy.channel_rules?.[ch.code] ?? {};
    const sortKey = ch.group === CHANNEL_GROUP.PAYMENT_TOOL ? scoreOf.get(ch.code) ?? rule.rank ?? 0 : rule.rank ?? 0;
    const item = {
      channel_code: ch.code,
      name: ch.name,
      group: ch.group,
      fund_nature: ch.fund_nature,
      pricing_type: ch.pricing_type,
      label: rule.label ?? ch.name,
      subtitle: rule.subtitle ?? null,
      /** 真实余额/可用份额，来源为资格与账务系统；本字段只读透传，编排层不得生成 */
      balance: availability[ch.code]?.balance ?? null,
      requires_explicit_ack: ch.group === CHANNEL_GROUP.CREDIT,
      risk_notice: rule.risk_notice ?? defaultRiskNotice(ch.group),
      sort_key: sortKey,
    };
    if (!byGroup.has(ch.group)) byGroup.set(ch.group, []);
    byGroup.get(ch.group).push(item);
  }

  const groups = (policy.group_order ?? [])
    .filter((g) => byGroup.has(g))
    .map((group) => ({
      group,
      channels: byGroup
        .get(group)
        .sort((a, b) => b.sort_key - a.sort_key || a.channel_code.localeCompare(b.channel_code))
        .map(({ sort_key, ...rest }) => rest),
    }));

  // 默认渠道：仅支付工具可默认；无显式配置则默认支付工具组内第一名，信贷/理财永不默认
  const configuredDefault = Object.entries(policy.channel_rules ?? {}).find(([, r]) => r?.default_selected)?.[0];
  let defaultChannel = null;
  if (configuredDefault && visible.some((c) => c.code === configuredDefault)) {
    const def = channels.find((c) => c.code === configuredDefault);
    if (def.group === CHANNEL_GROUP.PAYMENT_TOOL) defaultChannel = configuredDefault;
  }
  if (!defaultChannel) {
    const firstPay = groups.find((g) => g.group === CHANNEL_GROUP.PAYMENT_TOOL)?.channels[0];
    if (firstPay) defaultChannel = firstPay.channel_code;
    applied.add(RULE_CODES.NO_CREDIT_DEFAULT);
  }

  return {
    groups,
    default_channel_code: defaultChannel,
    applied_rules: [...applied],
    suppressed,
  };
}

function defaultRiskNotice(group) {
  if (group === CHANNEL_GROUP.CREDIT) {
    return "该渠道为借款：资金由资金方发放并形成您的负债，可能产生利息等费用，最终审批结果以资金方为准。";
  }
  if (group === CHANNEL_GROUP.WEALTH) {
    return "该渠道为理财赎回：货币基金不是银行存款，不保证基金一定盈利，赎回金额与到账时间以基金公司确认为准。";
  }
  return null;
}

/** 费用计算：支付渠道展示渠道手续费；借贷渠道必须展示利息与还款总额，禁止只展示月供。 */
export function quoteCost({ channel, orderAmount, pricing }) {
  const components = [];
  if (channel.group === CHANNEL_GROUP.CREDIT) {
    const annualRate = pricing.annual_rate; // 年利率，如 0.072
    const periods = pricing.periods ?? 1;
    if (typeof annualRate !== "number" || annualRate < 0) {
      throw new Error("借贷渠道费用报价缺少年利率");
    }
    const interest = Math.round(orderAmount * annualRate * (pricing.years ?? periods / 12));
    components.push({ type: "PRINCIPAL", label: "借款本金", amount: orderAmount });
    components.push({ type: "INTEREST", label: `利息（年化 ${(annualRate * 100).toFixed(2)}%）`, amount: interest });
    if (pricing.fee) components.push({ type: "FEE", label: "手续费", amount: pricing.fee });
  } else {
    const fee = pricing?.fee ?? 0;
    components.push({ type: "PAYMENT", label: "支付金额", amount: orderAmount });
    if (fee) components.push({ type: "FEE", label: "渠道手续费", amount: fee });
  }
  const total = components.reduce((s, c) => s + c.amount, 0);
  return { currency: pricing?.currency ?? "CNY", components, total };
}
