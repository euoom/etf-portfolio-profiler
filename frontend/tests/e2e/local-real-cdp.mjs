import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const backendUrl = process.env.E2E_BACKEND_URL ?? "http://127.0.0.1:8010";
const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:4174/etf-portfolio-profiler/";
const cdpEndpoint = process.env.PLAYWRIGHT_CDP_ENDPOINT ?? "http://172.22.128.1:9223";
const runRealCollector = process.env.RUN_REAL_COLLECTOR_E2E === "1";
const e2eTheme = process.env.E2E_THEME ?? "dark";

async function fetchJson(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(init.timeout ?? 30_000),
  });
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function waitForText(locator, pattern, timeout = 150_000) {
  const startedAt = Date.now();
  let lastText = "";
  while (Date.now() - startedAt < timeout) {
    lastText = (await locator.innerText().catch(() => "")).trim();
    if (pattern.test(lastText)) {
      return lastText;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Timed out waiting for ${pattern}. Last text: ${lastText}`);
}

async function waitForFinalAssistantAnswer(locator, timeout = 180_000) {
  return waitForText(
    locator,
    /^(?!.*데이터를 확인하는 중입니다)(?!.*분석 중입니다)(?=.*(ETF|종목|비중|수량|변화|데이터))[\s\S]{30,}$/,
    timeout,
  );
}

async function main() {
  console.log(`CDP endpoint: ${cdpEndpoint}`);
  console.log(`Frontend:     ${baseUrl}`);
  console.log(`Backend:      ${backendUrl}`);

  const version = await fetchJson(`${cdpEndpoint}/json/version`);
  assert.match(version.webSocketDebuggerUrl ?? "", /^ws:\/\//);

  const health = await fetchJson(`${backendUrl}/health`);
  assert.equal(health.status, "ok");

  const summary = await fetchJson(`${backendUrl}/api/analysis/etf-change-summary?days=5&limit=5`);
  assert.ok(Array.isArray(summary.rows), "summary.rows must be an array");
  assert.ok(summary.rows.length > 0, "real local DB should have ETF summary rows");

  const browser = await chromium.connectOverCDP(cdpEndpoint);
  const context = browser.contexts()[0] ?? await browser.newContext();
  const page = await context.newPage();

  try {
    await page.addInitScript((theme) => {
      window.localStorage.setItem("theme", theme);
    }, e2eTheme);
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.getByText("ETF Portfolio Profiler").waitFor({ timeout: 20_000 });
    await page.locator(`.app-shell[data-theme="${e2eTheme}"]`).waitFor({ timeout: 20_000 });
    await page.locator(".pivot-grid tbody tr").first().waitFor({ timeout: 20_000 });

    const input = page.getByPlaceholder("분석 요청 입력");
    await input.fill("이 화면에서 눈에 띄는 변화만 3개 알려줘");
    await input.press("Enter");
    await page.getByText("데이터를 확인하는 중입니다...").waitFor({ timeout: 10_000 });

    const answer = await waitForFinalAssistantAnswer(page.locator(".chat.assistant").last());
    assert.ok(!answer.includes("데모 응답입니다."), "local real E2E should not use mock response");
    assert.ok(!answer.includes("응답을 가져오지 못했습니다."), "LLM request failed");
    assert.ok(!answer.includes("응답 스트림이 중단되었습니다."), "LLM stream failed");

    if (runRealCollector) {
      const collectorResult = await fetchJson(`${backendUrl}/api/collect/tiger/products?list_count=20`, {
        method: "POST",
        timeout: 120_000,
      });
      assert.ok(collectorResult.collected > 0, "real TIGER collector should collect at least one product");
    }

    console.log("Local real CDP E2E passed.");
  } finally {
    await page.close().catch(() => undefined);
  }
}

main()
  .then(() => {
    // Playwright's CDP transport can keep the Node event loop alive even after
    // the test page is closed. This runner is intentionally single-shot.
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
