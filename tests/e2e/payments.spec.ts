import { test, expect, type Page } from "@playwright/test";
const standard = {
  id: "standard",
  name: "标准版",
  version: "a".repeat(24),
  priceFen: 1234,
  points: 2000,
};
const pro = {
  id: "pro",
  name: "专业版",
  version: "b".repeat(24),
  priceFen: 3456,
  points: 6000,
};
async function login(page: Page) {
  const email = `pay-ui-${Date.now()}@example.com`;
  const headers = { "X-Idea-Client": "1" };
  const code = await (
    await page.request.post("/api/auth/code", { headers, data: { email } })
  ).json();
  await page.request.post("/api/auth/login", {
    headers,
    data: { email, code: code.developmentCode, accepted: true },
  });
}
test("without a merchant, subscription clearly stays disabled and exposes no fake checkout", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "订阅与额度", exact: false })
    .first()
    .click();
  await expect(page.getByText("微信支付准备中", { exact: true })).toBeVisible();
  const buttons = page.getByRole("button", { name: "等待微信支付开通" });
  await expect(buttons).toHaveCount(2);
  await expect(buttons.first()).toBeDisabled();
  await page.screenshot({
    path: "work/payment-not-configured.png",
    fullPage: true,
  });
});
test("checkout requires explicit confirmation, shows QR, and updates rights only after server query", async ({
  page,
}) => {
  await login(page);
  let paid = false;
  let sent: any;
  let order: any = null;
  await page.route("**/api/billing", (route) =>
    route.fulfill({
      json: {
        enabled: true,
        configured: true,
        h5Enabled: true,
        plans: [standard, pro],
        supportEmail: "support@example.com",
        refundPolicyUrl: "https://example.com/refunds",
        missing: [],
        activationRequired: false,
      },
    }),
  );
  await page.route("**/api/quota", (route) =>
    route.fulfill({
      json: {
        total: paid ? 2000 : 60,
        available: paid ? 2000 : 60,
        used: 0,
        reserved: 0,
        plan: paid ? "standard" : "free",
        resetAt: new Date(Date.now() + 30 * 86400000).toISOString(),
        nextPeriod: null,
      },
    }),
  );
  await page.route(
    /\/api\/orders(?:\/[a-f0-9]+(?:\/refresh)?)?$/,
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === "POST" && url.pathname === "/api/orders") {
        sent = request.postDataJSON();
        order = {
          id: "a".repeat(32),
          plan: standard,
          amount: 1234,
          currency: "CNY",
          channel: "native",
          status: "pending",
          entitlement: "pending",
          paymentUrl: "weixin://wxpay/bizpayurl?pr=LOCAL_UI_FIXTURE",
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 1800000).toISOString(),
          renewal: false,
        };
        return route.fulfill({ json: order });
      }
      if (url.pathname.endsWith("/refresh")) {
        paid = true;
        order = {
          ...order,
          status: "paid",
          entitlement: "granted",
          paymentUrl: null,
          startsAt: new Date().toISOString(),
          endsAt: new Date(Date.now() + 30 * 86400000).toISOString(),
        };
        return route.fulfill({ json: order });
      }
      return route.fulfill({
        json:
          url.pathname === "/api/orders"
            ? { items: order ? [order] : [], enabled: true }
            : order,
      });
    },
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "订阅与额度", exact: false })
    .first()
    .click();
  await page
    .getByRole("button", { name: "按月购买", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("¥12.34");
  const checkout = dialog.getByRole("button", { name: "确认下单" });
  await expect(checkout).toBeDisabled();
  await dialog.getByRole("checkbox").check();
  await checkout.click();
  await expect(
    page.getByRole("img", { name: "使用微信扫一扫完成付款的支付二维码" }),
  ).toBeVisible();
  expect(sent.planVersion).toBe(standard.version);
  expect(sent.amount).toBeUndefined();
  expect(sent.accepted).toBe(true);
  expect(sent.channel).toBe("native");
  await expect(dialog.getByRole("status")).toContainText("待支付");
  await expect(page.locator(".quota-ring strong")).toHaveText("60");
  await page.screenshot({ path: "work/payment-native-ui.png", fullPage: true });
  await page.getByRole("button", { name: "我已支付，查询结果" }).click();
  await expect(dialog.getByRole("status")).toContainText("支付成功");
  await expect(page.locator(".quota-ring strong")).toHaveText("2000");
  await dialog.getByRole("button", { name: "关闭弹窗" }).click();
  await page.getByRole("button", { name: "我的订单", exact: true }).click();
  await expect(page.locator("table")).toContainText("支付成功");
  await page.getByRole("button", { name: "查看订单", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("服务周期");
});
test("mobile H5 entry and payment return query are independent of success URL parameters", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  let checks = 0;
  const order = {
    id: "c".repeat(32),
    plan: standard,
    amount: 1234,
    channel: "h5",
    status: "pending",
    entitlement: "pending",
    paymentUrl:
      "https://wx.tenpay.com/cgi-bin/mmpayweb-bin/checkmweb?prepay_id=LOCAL_UI_FIXTURE",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 1800000).toISOString(),
    renewal: false,
  };
  await page.route("**/api/billing", (route) =>
    route.fulfill({
      json: {
        enabled: true,
        configured: true,
        h5Enabled: true,
        plans: [standard, pro],
        supportEmail: "support@example.com",
        refundPolicyUrl: "https://example.com/refunds",
        missing: [],
        activationRequired: false,
      },
    }),
  );
  await page.route("**/api/orders/**", (route) => {
    if (route.request().url().endsWith("/refresh")) checks++;
    return route.fulfill({ json: order });
  });
  await page.goto(`/?payment_order=${order.id}&success=true`);
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("status")).toContainText(
    "待支付",
  );
  await expect(
    page.getByRole("link", { name: "打开微信付款" }),
  ).toHaveAttribute("href", order.paymentUrl);
  await expect(
    page.getByRole("link", { name: "打开微信付款" }),
  ).toHaveAttribute("referrerpolicy", "origin");
  expect(checks).toBeGreaterThan(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "work/payment-h5-ui.png", fullPage: true });
});
