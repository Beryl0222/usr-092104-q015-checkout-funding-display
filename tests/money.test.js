import assert from "node:assert/strict";
import test from "node:test";

import { equalMonthlyPayment, formatYuan } from "../src/money.js";

test("formatYuan 整数分转两位小数字符串", () => {
  assert.equal(formatYuan(0), "0.00");
  assert.equal(formatYuan(5), "0.05");
  assert.equal(formatYuan(10000), "100.00");
  assert.equal(formatYuan(10120), "101.20");
  assert.equal(formatYuan(-150), "-1.50");
  assert.throws(() => formatYuan(1.5), /整数分/);
});

test("等额本息：7.20% 年化分 3 期，还款计划合计精确自洽", () => {
  const q = equalMonthlyPayment(10000, 720, 3);
  assert.equal(q.months, 3);
  assert.equal(q.schedule_cents.length, 3);
  assert.equal(q.per_installment_cents, 3373);
  assert.equal(q.last_installment_cents, 3374);
  assert.equal(q.schedule_cents.reduce((a, b) => a + b, 0), q.total_repay_cents);
  assert.equal(q.total_repay_cents, 10120);
  assert.equal(q.total_fee_cents, 120);
});

test("零利率分期：总费用为 0，总额等于本金", () => {
  const q = equalMonthlyPayment(30000, 0, 3);
  assert.equal(q.total_fee_cents, 0);
  assert.equal(q.total_repay_cents, 30000);
  assert.equal(q.schedule_cents.reduce((a, b) => a + b, 0), 30000);
});

test("非法入参被拒绝（金额必须为正整数、期数为正整数）", () => {
  assert.throws(() => equalMonthlyPayment(0, 720, 3), /本金/);
  assert.throws(() => equalMonthlyPayment(-1, 720, 3), /本金/);
  assert.throws(() => equalMonthlyPayment(100, 720, 0), /期数/);
  assert.throws(() => equalMonthlyPayment(100, -1, 3), /基点/);
});
