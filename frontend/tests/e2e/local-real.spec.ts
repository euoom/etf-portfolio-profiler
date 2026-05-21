import { expect, test } from "@playwright/test";

const backendUrl = process.env.E2E_BACKEND_URL ?? "http://127.0.0.1:8010";
const e2eTheme = process.env.E2E_THEME ?? "dark";

test.describe("local real stack", () => {
  test.setTimeout(180_000);

  test.beforeEach(async ({ page }) => {
    await page.addInitScript((theme) => {
      window.localStorage.setItem("theme", theme);
    }, e2eTheme);
  });

  test("loads the dashboard from the real local database", async ({ page }) => {
    const health = await page.request.get(`${backendUrl}/health`);
    expect(health.ok()).toBeTruthy();

    const summary = await page.request.get(`${backendUrl}/api/analysis/etf-change-summary?days=5&limit=5`);
    expect(summary.ok()).toBeTruthy();

    const payload = await summary.json();
    expect(Array.isArray(payload.rows)).toBeTruthy();
    expect(payload.rows.length).toBeGreaterThan(0);

    await page.goto("./");

    await expect(page.getByText("ETF Portfolio Profiler")).toBeVisible();
    await expect(page.locator(`.app-shell[data-theme="${e2eTheme}"]`)).toBeVisible();
    await expect(page.locator(".pivot-grid tbody tr").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".pivot-grid tbody tr").first()).toContainText(/TIGER|ETF|[가-힣A-Za-z]/);
  });

  test("gets a real LLM response for the current screen context", async ({ page }) => {
    await page.goto("./");

    const input = page.getByPlaceholder("분석 요청 입력");
    await input.fill("이 화면에서 눈에 띄는 변화만 3개 알려줘");
    await input.press("Enter");

    await expect(page.getByText("데이터를 확인하는 중입니다...")).toBeVisible({ timeout: 10_000 });

    const assistant = page.locator(".chat.assistant").last();
    await expect
      .poll(
        async () => {
          const text = await assistant.innerText().catch(() => "");
          return text.trim();
        },
        { timeout: 150_000, intervals: [1_000, 2_000, 5_000] },
      )
      .toMatch(/(ETF|종목|비중|수량|변화|데이터)/);

    const answer = await assistant.innerText();
    expect(answer).not.toContain("데모 응답입니다.");
    expect(answer).not.toContain("응답을 가져오지 못했습니다.");
    expect(answer).not.toContain("응답 스트림이 중단되었습니다.");
  });

  test("can call the real TIGER product collector", async ({ page }) => {
    test.skip(process.env.RUN_REAL_COLLECTOR_E2E !== "1", "Set RUN_REAL_COLLECTOR_E2E=1 to call the real TIGER server.");

    const response = await page.request.post(`${backendUrl}/api/collect/tiger/products`, {
      params: { list_count: 20 },
      timeout: 120_000,
    });

    expect(response.ok()).toBeTruthy();
    const payload = await response.json();
    expect(payload.collected).toBeGreaterThan(0);
  });
});
