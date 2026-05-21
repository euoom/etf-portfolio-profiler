import { expect, test } from "@playwright/test";

const backendUrl = process.env.E2E_BACKEND_URL ?? "http://127.0.0.1:8000";

test("renders dashboard shell and streams a chat response without action cards", async ({ page }) => {
  const health = await page.request.get(`${backendUrl}/health`);
  expect(health.ok()).toBeTruthy();

  await page.goto("./");

  await expect(page.getByText("ETF Portfolio Profiler")).toBeVisible();
  await expect(page.getByRole("button", { name: "최근 5영업일간 변동이 큰 ETF 5개만 요약해줘" })).toBeVisible();

  await page.getByRole("button", { name: "최근 5영업일간 변동이 큰 ETF 5개만 요약해줘" }).click();

  await expect(page.getByText("데모 응답입니다.")).toBeVisible();
  await expect(page.locator(".chat-actions")).toHaveCount(0);
});

test("can abort an in-flight chat request", async ({ page }) => {
  await page.route("**/api/chat/stream", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await route.fulfill({
      status: 200,
      contentType: "text/plain; charset=utf-8",
      body: "늦게 도착한 응답",
    }).catch(() => undefined);
  });

  await page.goto("./");
  await page.getByPlaceholder("분석 요청 입력").fill("중단 동작 확인");
  await page.getByPlaceholder("분석 요청 입력").press("Enter");

  const stopButton = page.getByRole("button", { name: "응답 생성 중단" });
  await expect(stopButton).toBeVisible();
  await stopButton.click();

  await expect(page.getByText("응답 생성을 중단했습니다.")).toBeVisible();
});

test("opens command palette and separates search from update commands", async ({ page }) => {
  await page.goto("./");
  await page.keyboard.press("Control+Shift+P");

  const palette = page.getByRole("dialog", { name: "명령 팔레트" });
  await expect(palette).toBeVisible();

  const input = page.getByPlaceholder("ETF/종목 검색, 명령은 > 입력");
  await input.fill(">");

  await expect(page.getByText("데이터 업데이트").first()).toBeVisible();
  await expect(page.getByRole("option", { name: /TIGER ETF 상품 목록 업데이트/ })).toBeVisible();
  await expect(page.getByText("ETF 검색")).toHaveCount(0);
  await expect(page.getByText("종목 검색")).toHaveCount(0);
});

test("mobile menu, custom period inputs, and AI bottom sheet are usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("./");

  await page.getByRole("button", { name: "메뉴 토글" }).click();
  await page.getByLabel("기간").selectOption("custom");

  await expect(page.locator(".date-range-inputs input")).toHaveCount(2);
  await expect(page.locator(".date-range-inputs")).toBeVisible();

  await page.getByRole("button", { name: "AI 분석 상담" }).click();
  await expect(page.getByRole("button", { name: "AI 패널 닫기" })).toBeVisible();
  await expect(page.locator(".ai-panel")).toBeVisible();

  await page.getByRole("button", { name: "AI 패널 닫기" }).click();
  await expect(page.locator(".ai-panel")).toBeHidden();
});
