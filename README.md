# 收银台渠道编排与审计系统

新规改造后的参考实现：后端维护**资金渠道类别、用户资格、订单可用性、展示规则版本、风险提示、费用明细、用户主动选择、最终扣款回执**，并提供一页可用**键盘和读屏**操作的参考收银台验证真实展示行为。

## 合规红线如何落地

| 合规要求 | 实现位置 |
| --- | --- |
| 支付工具与金融产品在结构、文案、交互上区隔 | 渠道主数据 `nature: own_funds / credit_product`；会话快照分为两个 `<fieldset>` 分组，分别使用绿色「自有资金」/橙色「借款」视觉与文案 |
| 任何贷款、理财相关产品不得默认选中 | `validatePolicy()` 发布校验拒绝 `default_channel_id` 为金融产品的规则；会话组装时默认项只在自有资金组内产生（规则默认项不可用时回退到首个可用自有资金渠道，而非信贷） |
| 不得使用「低门槛」「秒到账」等诱导文案 | `src/copy-guard.js` 在**规则发布时**递归扫描全部用户可见文案，命中即拒绝发布（含零利息、稳赚、保本保息等 22 个词条） |
| 合规规则只决定可展示方式 | 展示规则只有排序/分组/文案/风险提示/费用口径；余额、授信额度来自账户/授信核心只读数据，服务不提供任何修改余额或批准授信的路径 |
| 金融产品需逐次显式选择 + 风险知悉 | `selectChannel()` 对 `credit_product` 强制 `explicit_selection=true`、`risk_acknowledged=true`、`action_source=user_manual`；前端每次切换到借款渠道都重置勾选；推荐服务来源（非 `user_manual`）一律拒绝 |
| 确认前看清资金性质、总费用、取消后果 | 明细面板展示资金性质、费用说明、分期还款计划（等额本息、年化利率、每期金额）、风险提示、取消后果；`GET /api/sessions/:id/preview` 服务端同口径汇总 |
| 灰度按商户 × 客户端版本留证 | 规则 `scope.merchant_ids + min_app_version`；会话事件记录每个版本命中/未命中的判定明细（`resolution.considered`） |
| 规则回滚不改变已确认订单 | 会话在**组装时冻结**规则版本，回执记录 `policy_version_frozen`；回滚只把高版本置 `rolled_back`，影响之后的新会话；已确认会话拒绝再次选择 |
| 重复支付回调只形成一次结算 | 回执维度幂等：同一 `order_id` 仅接受一次结算，重复回调（即使 `callback_id` 不同）返回 `duplicate=true` 且不产生第二条事件；回调金额不符直接拒绝 |
| 客服能解释排序与提示来自哪版规则 | 页面展示规则版本、变更说明、发布者、发布时间与灰度判定；审计包给出完整解析证据 |
| 审计可证明展示、选择、扣款一致 | `src/audit.js` 重放事件做 11 项检查（A 展示-选择一致、B 显式选择/默认项、C 渠道-金额-版本一致、D 单次结算、E 版本冻结、F 哈希链），可导出 JSON |
| 证据防篡改 | 全部事件组成 sha256 哈希链（`hash_n = sha256(hash_{n-1} | 规范化JSON)`），任何事后篡改都会让链校验与审计 F1 失败 |

## 运行

```bash
npm start          # http://localhost:8080（PORT 环境变量可改端口）
npm test           # 47 项测试：领域规则、编排、审计、HTTP 端到端
```

页面操作路径：
1. 选择用户（已获授信 / 未获授信 / 余额不足）、订单（灰度商户 / 旧商户）、客户端版本 → **组装收银台**；
2. 用 Tab/方向键在两个分组间选择；选「信用支付/分期」后必须阅读风险提示并勾选借款确认，**确认支付**才可用；
3. **模拟渠道扣款回调**后再点**重复发送回调**，观察幂等拦截；
4. 规则实验室：尝试发布含「秒到账」的规则（被拒绝）、发布合规 v3、回滚至 v1；
5. **生成审计报告**并导出 JSON 证据包。

## HTTP API

| 方法 路径 | 说明 |
| --- | --- |
| `POST /api/sessions` | 组装会话（body: `user_id, order_id, app_version`），返回冻结的展示快照与灰度证据 |
| `POST /api/sessions/:id/select` | 用户主动选择；金融产品必须带 `explicit_selection/risk_acknowledged/action_source` |
| `GET  /api/sessions/:id/preview` | 确认前总费用、风险提示、取消后果 |
| `POST /api/sessions/:id/confirm` | 确认支付，生成冻结规则版本的回执（重复确认幂等） |
| `POST /api/sessions/:id/callback` | 渠道扣款回调；重复回调只结算一次 |
| `GET  /api/sessions/:id/audit` | 审计证据包（11 项检查 + 事件哈希链） |
| `POST /api/policies/publish` | 发布新规则版本（自动 +1，先过发布校验与文案守卫） |
| `POST /api/policies/rollback` | 回滚 `{target_version, reason}`，只影响新会话 |
| `POST /api/demo/reset` | 重置内存演示数据 |

## 目录

- `contracts/domain.schema.json`：领域事件信封与稳定枚举（新增 `SETTLEMENT_RECORDED`）。
- `data/seed.json`：5 个渠道（储蓄卡/余额/货币基金/消费信贷/分期）、3 类用户、授信数据、2 个商户、v1 基线 + v2 灰度规则。
- `src/policy.js`：规则发布校验、灰度解析、回滚。
- `src/copy-guard.js`：诱导文案守卫。
- `src/money.js`：整数分金额与等额本息费用计算。
- `src/event-store.js`：追加式事件存储与哈希链。
- `src/checkout-service.js`：渠道编排应用服务（资格/可用性/选择/确认/结算）。
- `src/audit.js`：一致性审计与证据导出。
- `src/server.js`：零依赖 node:http 服务。
- `public/`：参考收银台（原生 HTML/CSS/JS，语义化控件、跳转链接、aria 关联、键盘可达）。
- `tests/`：47 项 node:test 测试。

## 边界说明

- 内存态事件存储用于演示与验证；生产接入持久化事件库时保持 `EventStore` 的哈希校验与追加语义即可。
- 授信、账户余额为外部核心数据，本系统只读展示；`data/seed.json` 中的授信记录标注了来源，任何路径都不能替用户申请或批准授信。
