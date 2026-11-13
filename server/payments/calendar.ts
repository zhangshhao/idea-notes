/** Advance from the original Shanghai calendar anchor, never from a clamped date. */
export function subscriptionBoundary(anchor: string, months: number): string {
  const local = new Date(new Date(anchor).getTime() + 8 * 3600000);
  if (
    !Number.isFinite(local.getTime()) ||
    !Number.isInteger(months) ||
    months < 0
  )
    throw new Error("Invalid subscription anchor");
  const targetMonth = local.getUTCMonth() + months;
  const day = Math.min(
    local.getUTCDate(),
    new Date(Date.UTC(local.getUTCFullYear(), targetMonth + 1, 0)).getUTCDate(),
  );
  return new Date(
    Date.UTC(
      local.getUTCFullYear(),
      targetMonth,
      day,
      local.getUTCHours(),
      local.getUTCMinutes(),
      local.getUTCSeconds(),
      local.getUTCMilliseconds(),
    ) -
      8 * 3600000,
  ).toISOString();
}
