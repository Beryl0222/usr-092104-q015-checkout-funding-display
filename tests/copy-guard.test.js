import assert from "node:assert/strict";
import test from "node:test";

import { findInducements, BANNED_PHRASES } from "../src/copy-guard.js";

test("干净文案通过守卫", () => {
  assert.deepEqual(
    findInducements({
      tagline: "授信方垫付，下月按账单还款",
      risk_warning: "这是消费贷款，逾期按合同计收利息并影响征信。",
    }),
    []
  );
});

test("递归扫描嵌套对象与数组，命中多种诱导表述", () => {
  const hits = findInducements({
    sections: { credit_product: { title: "借款" } },
    channel_copy: {
      credit_pay: { tagline: "低门槛借款，秒到账", risk_warning: ["零利息放心借"] },
    },
  });
  const phrases = hits.map((h) => h.phrase);
  assert.ok(phrases.includes("低门槛"));
  assert.ok(phrases.includes("秒到账"));
  assert.ok(phrases.includes("零利息"));
  assert.ok(phrases.includes("放心借"));
});

test("理财类诱导表述（稳赚/保本保息）同样被拦截", () => {
  const hits = findInducements("货币基金稳赚不赔，保本保息");
  assert.deepEqual(hits.map((h) => h.phrase).sort(), ["保本保息", "稳赚"]);
});

test("禁用词表覆盖题目明示红线", () => {
  for (const phrase of ["低门槛", "秒到账"]) assert.ok(BANNED_PHRASES.includes(phrase));
});
