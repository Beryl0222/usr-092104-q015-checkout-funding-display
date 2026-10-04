/**
 * 稳定领域枚举：资金渠道分组与资金性质。
 * 分组是结构性区隔：支付工具 / 理财 / 借贷三类在收银台不得混排为同一组选项。
 */

export const CHANNEL_GROUP = Object.freeze({
  /** 支付工具：花用户自己的钱（银行卡存款、账户余额） */
  PAYMENT_TOOL: "PAYMENT_TOOL",
  /** 理财：赎回用户持有的金融资产（货币基金份额） */
  WEALTH: "WEALTH",
  /** 借贷：向资金方借钱形成负债（消费信贷、分期） */
  CREDIT: "CREDIT",
});

export const GROUP_META = Object.freeze({
  PAYMENT_TOOL: {
    code: "PAYMENT_TOOL",
    title: "支付工具 · 您的自有资金",
    hint: "以下渠道使用您本人已有的资金，不形成负债。",
  },
  WEALTH: {
    code: "WEALTH",
    title: "理财 · 赎回资产支付",
    hint: "以下渠道需要赎回您持有的理财产品，理财非存款，赎回可能存在到账时间与净值波动。",
  },
  CREDIT: {
    code: "CREDIT",
    title: "借贷 · 借款支付，需按时偿还",
    hint: "以下渠道将向资金方申请借款，是否获批以提交申请后的审批结果为准；借款需支付利息并按期偿还。",
  },
});

/** 渠道主数据（不包含任何余额、额度字段——本系统不伪造余额，也不替资金方批准授信） */
export const CHANNEL_CATALOG = Object.freeze({
  BANK_CARD: {
    code: "BANK_CARD",
    name: "银行卡",
    group: CHANNEL_GROUP.PAYMENT_TOOL,
    fund_nature: "银行储蓄存款",
    pricing_type: "FEE",
  },
  ACCOUNT_BALANCE: {
    code: "ACCOUNT_BALANCE",
    name: "账户余额",
    group: CHANNEL_GROUP.PAYMENT_TOOL,
    fund_nature: "支付账户自有余额",
    pricing_type: "FEE",
  },
  MONEY_FUND: {
    code: "MONEY_FUND",
    name: "货币基金",
    group: CHANNEL_GROUP.WEALTH,
    fund_nature: "货币基金份额（理财赎回，非存款）",
    pricing_type: "REDEMPTION",
  },
  CONSUMER_CREDIT: {
    code: "CONSUMER_CREDIT",
    name: "消费信贷",
    group: CHANNEL_GROUP.CREDIT,
    fund_nature: "消费贷款本金（借款，需偿还）",
    pricing_type: "LOAN",
  },
  INSTALLMENT: {
    code: "INSTALLMENT",
    name: "分期付款",
    group: CHANNEL_GROUP.CREDIT,
    fund_nature: "分期贷款本金（借款，需偿还）",
    pricing_type: "LOAN",
  },
});

export const EVENT_TYPE = Object.freeze({
  CHANNEL_REGISTERED: "CHANNEL_REGISTERED",
  POLICY_PUBLISHED: "POLICY_PUBLISHED",
  POLICY_ROLLED_BACK: "POLICY_ROLLED_BACK",
  SESSION_COMPOSED: "SESSION_COMPOSED",
  CHANNEL_SELECTED: "CHANNEL_SELECTED",
  PAYMENT_CONFIRMED: "PAYMENT_CONFIRMED",
  SESSION_CANCELLED: "SESSION_CANCELLED",
  CALLBACK_RECEIVED: "CALLBACK_RECEIVED",
  PAYMENT_SETTLED: "PAYMENT_SETTLED",
});

export const AGGREGATE_TYPE = Object.freeze({
  FUNDING_CHANNEL: "funding_channel",
  DISPLAY_POLICY: "display_policy",
  CHECKOUT_SESSION: "checkout_session",
  PAYMENT_RECEIPT: "payment_receipt",
});

/** 合规规则码：客服与审计凭此解释“一次排序与提示来自哪版规则的哪一条”。 */
export const RULE_CODES = Object.freeze({
  GROUP_SEPARATION: "R-PAY-001",
  NO_CREDIT_DEFAULT: "R-PAY-002",
  RECOMMEND_PAYMENT_ONLY: "R-PAY-003",
  NO_SOLICITING_COPY: "R-PAY-004",
  COST_TRANSPARENCY: "R-PAY-005",
  CREDIT_EXPLICIT_ACK: "R-PAY-006",
  GRAY_ROLLOUT_EVIDENCE: "R-PAY-007",
  ROLLBACK_PRESERVES_CHOICE: "R-PAY-008",
  IDEMPOTENT_SETTLEMENT: "R-PAY-009",
});
