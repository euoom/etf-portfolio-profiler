import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { chromium } from "@playwright/test";

const backendUrl = process.env.E2E_BACKEND_URL ?? "http://127.0.0.1:8010";
const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:4174/etf-portfolio-profiler/";
const cdpEndpoint = process.env.PLAYWRIGHT_CDP_ENDPOINT ?? "http://172.22.128.1:9223";
const e2eTheme = process.env.E2E_THEME ?? "dark";
const logPath = resolve(process.env.CHAT_QUALITY_LOG ?? "../.chat-quality-cdp.log");
const jsonPath = process.env.CHAT_QUALITY_JSON ? resolve(process.env.CHAT_QUALITY_JSON) : "";

const questions = [
  "최근 5영업일간 변동이 큰 ETF 5개만 요약해줘",
  "TIGER 미국나스닥100 구성종목에서 뭐가 크게 바뀌었어?",
  "최근 5영업일간 비중 변화 큰 종목 찾아줘",
  "SK하이닉스는 어떤 ETF에서 비중 변화가 컸어?",
  "이 화면에서 눈에 띄는 변화만 3개 알려줘",
  "안녕",
];

async function waitForStreamingDone(page) {
  await page.locator('button[aria-label="응답 생성 중단"]').waitFor({ state: "visible", timeout: 15_000 }).catch(() => undefined);
  await page.locator('button[aria-label="응답 생성 중단"]').waitFor({ state: "hidden", timeout: 240_000 });
}

async function answerQuestion(page, question) {
  const resetButton = page.locator('button[aria-label="새 채팅"]');
  if (await resetButton.count()) {
    await resetButton.click();
  }
  await page.waitForTimeout(500);

  const beforeCount = await page.locator(".chat.assistant").count();
  const input = page.getByPlaceholder("분석 요청 입력");
  await input.fill(question);
  await input.press("Enter");
  await waitForStreamingDone(page);

  const assistant = page.locator(".chat.assistant").nth(beforeCount);
  await assistant.waitFor({ timeout: 10_000 });
  return (await assistant.innerText()).trim();
}

function assessAnswer(answer) {
  const issues = [];
  if (/^데이터를 확인하는 중입니다|분석 중입니다/.test(answer)) {
    issues.push("로딩 문구가 답변 본문에 남음");
  }
  if (/\$|USD|달러/i.test(answer)) {
    issues.push("금액 단위에 달러/USD가 섞임");
  }
  if (/[最大幅度迹象関連相反非常]| фон드|inúmer|合成|変わった|同一|走了进来|紧缩/.test(answer)) {
    issues.push("비한국어 조각이 섞임");
  }
  if (/원화예금[\s\S]{0,120}수량|현금[\s\S]{0,120}수량 변화율/.test(answer)) {
    issues.push("현금성 항목에 수량 변화율/수량 설명이 노출됨");
  }
  if (/한미반도체[^\n]{0,40}수량[^\n]{0,40}-32\.20%/.test(answer)) {
    issues.push("원익IPS 수량 감소를 한미반도체 수량 감소로 섞음");
  }
  if (/증가\/감소 방향 확정 불가/.test(answer)) {
    issues.push("수량 부호가 있는데 방향 확정 불가라고 표현함");
  }
  if (/시장 분위기|순매수 우위|자금 이탈|가격 영향/.test(answer)) {
    issues.push("근거 없는 원인/매매 판단 표현");
  }
  if (/get_etf|get_asset|api\/|tool/i.test(answer)) {
    issues.push("내부 도구/API 표현 노출");
  }
  if (/응답을 가져오지 못했습니다|스트림이 중단|데모 응답/.test(answer)) {
    issues.push("오류/데모 응답");
  }
  return issues;
}

function buildMarkdownLog(results) {
  const createdAt = new Date().toISOString();
  const failed = results.filter((item) => item.issues.length);
  const lines = [
    "# AI 채팅 품질 점검 로그",
    "",
    `- 생성시각: ${createdAt}`,
    `- Frontend: ${baseUrl}`,
    `- Backend: ${backendUrl}`,
    `- CDP: ${cdpEndpoint}`,
    `- Theme: ${e2eTheme}`,
    `- 질문 수: ${results.length}`,
    `- 이슈 감지: ${failed.length}`,
    "",
    "## 요약",
    "",
    "| # | 질문 | 이슈 |",
    "| --- | --- | --- |",
    ...results.map((item, index) => `| ${index + 1} | ${escapeTable(item.question)} | ${escapeTable(item.issues.join(", ") || "없음")} |`),
    "",
    "## 상세",
    "",
  ];

  for (const [index, item] of results.entries()) {
    lines.push(`### ${index + 1}. ${item.question}`);
    lines.push("");
    lines.push(`- 이슈: ${item.issues.join(", ") || "없음"}`);
    lines.push("");
    lines.push("```text");
    lines.push(item.answer);
    lines.push("```");
    lines.push("");
  }

  return lines.join("\n");
}

function escapeTable(value) {
  return String(value).replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

async function main() {
  console.log(`CDP endpoint: ${cdpEndpoint}`);
  console.log(`Frontend:     ${baseUrl}`);
  console.log(`Backend:      ${backendUrl}`);
  console.log(`Log:          ${logPath}`);

  const browser = await chromium.connectOverCDP(cdpEndpoint);
  const context = browser.contexts()[0] ?? await browser.newContext();
  const page = await context.newPage();
  const results = [];

  try {
    await page.addInitScript((theme) => {
      window.localStorage.setItem("theme", theme);
    }, e2eTheme);
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.getByText("ETF Portfolio Profiler").waitFor({ timeout: 20_000 });
    await page.locator(`.app-shell[data-theme="${e2eTheme}"]`).waitFor({ timeout: 20_000 });
    await page.locator(".pivot-grid tbody tr").first().waitFor({ timeout: 20_000 });

    for (const question of questions) {
      const answer = await answerQuestion(page, question);
      const issues = assessAnswer(answer);
      results.push({ question, answer, issues });
      console.log(`[${issues.length ? "WARN" : "OK"}] ${question}`);
      if (issues.length) {
        console.log(`  - ${issues.join("\n  - ")}`);
      }
    }
  } finally {
    await page.close().catch(() => undefined);
  }

  await mkdir(dirname(logPath), { recursive: true });
  await writeFile(logPath, buildMarkdownLog(results), "utf8");
  if (jsonPath) {
    await mkdir(dirname(jsonPath), { recursive: true });
    await writeFile(jsonPath, JSON.stringify(results, null, 2), "utf8");
  }

  const issueCount = results.reduce((sum, item) => sum + item.issues.length, 0);
  console.log(`Chat quality log written: ${logPath}`);
  if (issueCount) {
    console.log(`Detected ${issueCount} issue(s). Review the log before refining prompts.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
