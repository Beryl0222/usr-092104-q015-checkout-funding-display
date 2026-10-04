/**
 * 演示用种子数据：模拟“资格系统 / 账务系统 / 定价系统”三个后端权威事实源。
 * 余额与额度只来自这些提供者并只读透传——编排层自身绝不生成或伪造余额，也不替资金方授信。
 */
import { CHANNEL_CATALOG } from "../domain/enums.js";

/** 用户资格：eligible=false 表示用户当前不具备该渠道资格（如信贷未开户/未通过授信）。 */
const ELIGIBILITY = {
  "user-001": {
    BANK_CARD: { eligible: true },
    ACCOUNT_BALANCE: { eligible: true },
    MONEY_FUND: { eligible: true },
    CONSUMER_CREDIT: { eligible: true },
    INSTALLMENT: { eligible: true },
  },
  // 无信贷资格用户：授信审批未通过，收银台不得展示借贷渠道
  "user-002": {
    BANK_CARD: { eligible: true },
    ACCOUNT_BALANCE: { eligible: true },
    MONEY_FUND: { eligible: false, reason: "尚未开通理财账户" },
    CONSUMER_CREDIT: { eligible: false, reason: "授信审批未通过（最终资质以资金方审批为准）" },
    INSTALLMENT: { eligible: false, reason: "授信审批未通过" },
  },
};

/**
 * 订单维度可用性 + 真实余额/份额（单位：分）。
 * 余额不足时渠道仍展示但不可用，并给出真实原因——不得用虚假余额诱导。
 */
const AVAILABILITY = {
  "user-001": (order) => ({
    BANK_CARD: { available: true, balance: { amount: 520000, currency: "CNY", source: "bank_core", as_of_real: true } },
    ACCOUNT_BALANCE: { available: true, balance: { amount: 38050, currency: "CNY", source: "wallet_ledger", as_of_real: true } },
    MONEY_FUND: {
      available: true,
      balance: { amount: 1200000, currency: "CNY", source: "fund_transfer_agent", note: "货币基金最新可用份额对应估算金额，非保证金额", as_of_real: true },
    },
    CONSUMER_CREDIT: { available: true },
    INSTALLMENT: order.amount >= 10000
      ? { available: true }
      : { available: false, reason: "分期仅支持 100 元及以上订单" },
  }),
  "user-002": () => ({
    BANK_CARD: { available: true, balance: { amount: 8600, currency: "CNY", source: "bank_core", as_of_real: true } },
    ACCOUNT_BALANCE: { available: true, balance: { amount: 12000, currency: "CNY", source: "wallet_ledger", as_of_real: true } },
  }),
};

/** 定价：支付渠道手续费；借贷年利率与期数。均为资金方真实报价。 */
const PRICING = {
  BANK_CARD: { fee: 0 },
  ACCOUNT_BALANCE: { fee: 0 },
  MONEY_FUND: { fee: 0 },
  CONSUMER_CREDIT: { annual_rate: 0.072, periods: 12, years: 1, fee: 0 },
  INSTALLMENT: { annual_rate: 0.0864, periods: 12, years: 1, fee: 0 },
};

export const eligibilityProvider = {
  lookup(userId) {
    return ELIGIBILITY[userId] ?? Object.fromEntries(Object.keys(CHANNEL_CATALOG).map((c) => [c, { eligible: false, reason: "用户不存在" }]));
  },
};

export const availabilityProvider = {
  lookup(userId, order) {
    const fn = AVAILABILITY[userId];
    return fn ? fn(order) : {};
  },
};

export const pricingProvider = {
  quote(_userId, channelCode, _amount) {
    const p = PRICING[channelCode];
    if (!p) throw new Error(`无定价：${channelCode}`);
    return { ...p, currency: "CNY" };
  },
};

/**
 * 合规基线策略 v1：支付工具在前、借贷在后；银行卡为唯一默认项；
 * 文案只做中性说明，不含任何诱导词。
 */
export function baselinePolicy() {
  return {
    group_order: ["PAYMENT_TOOL", "WEALTH", "CREDIT"],
    channel_rules: {
      BANK_CARD: { rank: 100, default_selected: true, label: "银行卡（储蓄卡）", subtitle: "使用银行存款支付" },
      ACCOUNT_BALANCE: { rank: 90, label: "账户余额", subtitle: "使用支付账户余额支付" },
      MONEY_FUND: {
        rank: 80,
        label: "货币基金（赎回支付）",
        subtitle: "赎回持有的货币基金份额完成支付",
        risk_notice: "货币基金不是银行存款，不保证盈利；赎回金额与到账时间以基金公司确认为准。",
      },
      CONSUMER_CREDIT: {
        rank: 70,
        label: "消费信贷（借款支付）",
        subtitle: "申请消费贷款支付，按约定期限偿还本金与利息",
        risk_notice: "该渠道为借款：将形成您的负债，年化利率 7.20%，是否获批以资金方审批结果为准。",
      },
      INSTALLMENT: {
        rank: 60,
        label: "分期付款（借款支付）",
        subtitle: "申请分期贷款支付，分 12 期偿还本金与利息",
        risk_notice: "该渠道为借款：将形成您的负债，年化利率 8.64%，仅支持 100 元及以上订单。",
      },
    },
    compliance_rules: ["R-PAY-001", "R-PAY-002", "R-PAY-003", "R-PAY-004", "R-PAY-005", "R-PAY-006"],
  };
}
