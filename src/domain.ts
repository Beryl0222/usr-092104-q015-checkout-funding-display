/**
 * 收银台渠道解释领域。
 *
 * 资金渠道按资金性质分为两类，二者在结构、文案与交互上必须区隔：
 * - own_funds 支付工具：银行卡、账户余额、货币基金（赎回自己的钱）；
 *   可以拥有默认选中，但默认项只能是规则明确指定的自有资金渠道。
 * - credit_product 金融产品：消费信贷、分期（借款）；
 *   任何规则都不得默认选中，确认前必须取得用户逐次显式选择与风险知悉。
 */

export type ChannelNature = "own_funds" | "credit_product";

export type ChannelKind =
  | "bank_card"
  | "account_balance"
  | "money_fund"
  | "consumer_credit"
  | "installment";

/** 领域事件信封。 */
export interface DomainEvent {
  event_id: string;
  event_type:
    | "POLICY_PUBLISHED"
    | "POLICY_ROLLED_BACK"
    | "SESSION_COMPOSED"
    | "CHANNEL_SELECTED"
    | "PAYMENT_CONFIRMED"
    | "SETTLEMENT_RECORDED";
  aggregate_type: "funding_channel" | "display_policy" | "checkout_session" | "payment_receipt";
  aggregate_id: string;
  occurred_at: string;
  version: number;
  summary: string;
  /** 防篡改哈希链：sha256(前一事件 hash | 规范 JSON 载荷)。 */
  hash?: string;
  prev_hash?: string | null;
}
