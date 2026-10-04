/**
 * 金额与分期费用计算。
 * 对外展示一律使用「分」整数运算边界，避免浮点误差；分期采用等额本息。
 */

/** 分 -> 元字符串（保留两位小数）。 */
export function formatYuan(cents) {
  if (!Number.isInteger(cents)) throw new Error("金额必须为整数分");
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const s = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
  return neg ? `-${s}` : s;
}

/**
 * 等额本息：r 为月利率，n 为期数。
 * 每期还款 = P * r * (1+r)^n / ((1+r)^n - 1)。
 * 返回整数分报价：各期四舍五入，尾差并入末期，保证各期之和精确等于总还款额。
 */
export function equalMonthlyPayment(principalCents, annualRateBp, months) {
  if (!Number.isInteger(principalCents) || principalCents <= 0) throw new Error("本金必须为正整数分");
  if (!Number.isInteger(months) || months < 1) throw new Error("期数必须为正整数");
  if (!Number.isInteger(annualRateBp) || annualRateBp < 0) throw new Error("年化利率基点必须为非负整数");

  const monthlyRate = annualRateBp / 10000 / 12;
  let exactPerInstallment;
  if (monthlyRate === 0) {
    exactPerInstallment = principalCents / months;
  } else {
    const factor = (1 + monthlyRate) ** months;
    exactPerInstallment = (principalCents * monthlyRate * factor) / (factor - 1);
  }
  const totalRepay = Math.round(exactPerInstallment * months);
  const rounded = months === 1 ? totalRepay : Math.round(exactPerInstallment);
  const schedule = Array.from({ length: months }, () => rounded);
  schedule[months - 1] = totalRepay - rounded * (months - 1);
  return {
    method: "equal_monthly_payment",
    months,
    per_installment_cents: months === 1 ? totalRepay : rounded,
    last_installment_cents: schedule[months - 1],
    schedule_cents: schedule,
    total_repay_cents: totalRepay,
    total_fee_cents: totalRepay - principalCents,
  };
}
