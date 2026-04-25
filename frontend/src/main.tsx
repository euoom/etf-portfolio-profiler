import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useMutation, useQuery } from "@tanstack/react-query";
import ReactECharts from "echarts-for-react";
import { Bot, Columns3, Database, Filter, Moon, RefreshCw, Rows3, Send, Sigma, Sun } from "lucide-react";
import "./styles.css";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";
const queryClient = new QueryClient();

type PivotRow = {
  asset_code: string;
  asset_name: string;
  weights: Record<string, number | null>;
  quantities: Record<string, number | null>;
  valuation_amounts: Record<string, number | null>;
  weight_delta: number;
};

type PivotResponse = {
  dates: string[];
  rows: PivotRow[];
};

type CrossEtfRow = {
  asset_code: string;
  asset_name: string;
  weights: Record<string, number>;
  etf_counts: Record<string, number>;
  start_weight: number;
  end_weight: number;
  weight_delta: number;
  latest_etf_count: number;
  latest_exposures: { etf_name: string; weight: number | null }[];
};

type CrossEtfResponse = {
  dates: string[];
  rows: CrossEtfRow[];
};

type ExtremeChange = {
  asset_code: string;
  asset_name: string;
  value: number;
  start_value: number | null;
  end_value: number | null;
};

type EtfChangeSummaryRow = {
  ksd_fund: string;
  etf_name: string;
  max_quantity_increase: ExtremeChange | null;
  max_quantity_decrease: ExtremeChange | null;
  max_weight_increase: ExtremeChange | null;
  max_weight_decrease: ExtremeChange | null;
};

type EtfChangeSummaryResponse = {
  dates: string[];
  rows: EtfChangeSummaryRow[];
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, init);
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json();
}

function App() {
  const [selectedFund, setSelectedFund] = useState("KR70183J0002");
  const [chatInput, setChatInput] = useState("");
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const saved = localStorage.getItem("theme");
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  const [analysisMode, setAnalysisMode] = useState<"list" | "single" | "cross">("list");
  const [periodDays, setPeriodDays] = useState(3);
  const [chatMessages, setChatMessages] = useState<string[]>([
    "최근 3일간 비중 변화 큰 종목 찾아줘",
  ]);

  useEffect(() => {
    localStorage.setItem("theme", theme);
  }, [theme]);

  const pivot = useQuery({
    queryKey: ["holdings-pivot", selectedFund, periodDays],
    queryFn: () => api<PivotResponse>(`/api/analysis/holdings-pivot?ksd_fund=${selectedFund}&days=${periodDays}`),
  });

  const crossEtfChanges = useQuery({
    queryKey: ["cross-etf-weight-changes", periodDays],
    queryFn: () => api<CrossEtfResponse>(`/api/analysis/cross-etf-weight-changes?days=${periodDays}&limit=40`),
  });

  const etfChangeSummary = useQuery({
    queryKey: ["etf-change-summary", periodDays],
    queryFn: () => api<EtfChangeSummaryResponse>(`/api/analysis/etf-change-summary?days=${periodDays}&limit=100`),
  });

  const collectProducts = useMutation({
    mutationFn: () => api<{ collected: number }>("/api/collect/tiger/products", { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["etf-change-summary"] }),
  });

  const collectHoldings = useMutation({
    mutationFn: () => api(`/api/collect/tiger/holdings/${selectedFund}`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["holdings-pivot"] });
      queryClient.invalidateQueries({ queryKey: ["etf-change-summary"] });
    },
  });

  const collectRecentHoldings = useMutation({
    mutationFn: () => api(`/api/collect/tiger/holdings/${selectedFund}/recent?days=${periodDays}`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["holdings-pivot"] });
      queryClient.invalidateQueries({ queryKey: ["etf-change-summary"] });
    },
  });

  const collectRecentWatchlist = useMutation({
    mutationFn: () => api(`/api/collect/tiger/recent-watchlist?days=${periodDays}&limit=5`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["holdings-pivot"] });
      queryClient.invalidateQueries({ queryKey: ["cross-etf-weight-changes"] });
      queryClient.invalidateQueries({ queryKey: ["etf-change-summary"] });
    },
  });

  const chat = useMutation({
    mutationFn: (message: string) =>
      api<{ message: string }>("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, ksd_fund: selectedFund }),
      }),
    onSuccess: (data) => setChatMessages((prev) => [...prev, data.message]),
  });

  const chartOption = useMemo(
    () => {
      if (analysisMode === "list") {
        const rows = (etfChangeSummary.data?.rows ?? []).slice(0, 12).reverse();
        return {
          backgroundColor: "transparent",
          color: theme === "dark" ? ["#f87171", "#60a5fa"] : ["#dc2626", "#2563eb"],
          textStyle: { color: theme === "dark" ? "#d7dde8" : "#334155" },
          legend: { top: 0, textStyle: { color: theme === "dark" ? "#d7dde8" : "#334155" } },
          tooltip: {
            trigger: "axis",
            axisPointer: { type: "shadow" },
            backgroundColor: theme === "dark" ? "#181b20" : "#ffffff",
            borderColor: theme === "dark" ? "#343a43" : "#d9dee7",
            textStyle: { color: theme === "dark" ? "#f8fafc" : "#0f172a" },
            valueFormatter: (value: number) => `${Number(value).toFixed(2)}`,
          },
          grid: { top: 54, right: 24, bottom: 32, left: 180 },
          xAxis: {
            type: "value",
            axisLabel: { color: theme === "dark" ? "#9aa4b2" : "#64748b" },
            splitLine: { lineStyle: { color: theme === "dark" ? "#272b32" : "#e2e8f0" } },
          },
          yAxis: {
            type: "category",
            data: rows.map((item) => item.etf_name),
            axisLabel: { color: theme === "dark" ? "#9aa4b2" : "#64748b" },
            axisLine: { lineStyle: { color: theme === "dark" ? "#343a43" : "#cbd5e1" } },
          },
          series: [
            {
              name: "최대 비중 증가",
              type: "bar",
              data: rows.map((item) => item.max_weight_increase?.value ?? 0),
            },
            {
              name: "최대 비중 감소",
              type: "bar",
              data: rows.map((item) => item.max_weight_decrease?.value ?? 0),
            },
          ],
        };
      }

      if (analysisMode === "cross") {
        const rows = (crossEtfChanges.data?.rows ?? []).slice(0, 14).reverse();
        return {
          backgroundColor: "transparent",
          color: [theme === "dark" ? "#63a7ff" : "#2563eb"],
          textStyle: { color: theme === "dark" ? "#d7dde8" : "#334155" },
          tooltip: {
            trigger: "axis",
            axisPointer: { type: "shadow" },
            backgroundColor: theme === "dark" ? "#181b20" : "#ffffff",
            borderColor: theme === "dark" ? "#343a43" : "#d9dee7",
            textStyle: { color: theme === "dark" ? "#f8fafc" : "#0f172a" },
            valueFormatter: (value: number) => `${Number(value).toFixed(2)}%p`,
          },
          grid: { top: 24, right: 28, bottom: 32, left: 140 },
          xAxis: {
            type: "value",
            name: "합산 비중 변화",
            axisLabel: { color: theme === "dark" ? "#9aa4b2" : "#64748b", formatter: "{value}%p" },
            splitLine: { lineStyle: { color: theme === "dark" ? "#272b32" : "#e2e8f0" } },
          },
          yAxis: {
            type: "category",
            data: rows.map((item) => item.asset_name),
            axisLabel: { color: theme === "dark" ? "#9aa4b2" : "#64748b" },
            axisLine: { lineStyle: { color: theme === "dark" ? "#343a43" : "#cbd5e1" } },
          },
          series: [
            {
              name: "합산 비중 변화",
              type: "bar",
              data: rows.map((item) => item.weight_delta),
              itemStyle: {
                color: (params: { value: number }) =>
                  params.value >= 0 ? (theme === "dark" ? "#f87171" : "#dc2626") : theme === "dark" ? "#60a5fa" : "#2563eb",
              },
            },
          ],
        };
      }

      const dates = pivot.data?.dates ?? [];
      const visibleRows = (pivot.data?.rows ?? []).slice(0, 8);
      const otherSeries = {
        asset_name: "기타",
        weights: Object.fromEntries(
          dates.map((date) => {
            const visibleSum = visibleRows.reduce((sum, item) => sum + (item.weights[date] ?? 0), 0);
            return [date, Math.max(0, 100 - visibleSum)];
          }),
        ) as Record<string, number>,
      };
      const rows = visibleRows.length > 0 ? [...visibleRows, otherSeries] : [];
      return {
        backgroundColor: "transparent",
        color:
          theme === "dark"
            ? ["#63a7ff", "#f97316", "#22c55e", "#e879f9", "#facc15", "#38bdf8"]
            : ["#2563eb", "#ea580c", "#16a34a", "#c026d3", "#ca8a04", "#0891b2"],
        textStyle: { color: theme === "dark" ? "#d7dde8" : "#334155" },
        legend: {
          type: "scroll",
          top: 0,
          right: 0,
          textStyle: { color: theme === "dark" ? "#d7dde8" : "#334155" },
        },
        tooltip: {
          trigger: "axis",
          backgroundColor: theme === "dark" ? "#181b20" : "#ffffff",
          borderColor: theme === "dark" ? "#343a43" : "#d9dee7",
          textStyle: { color: theme === "dark" ? "#f8fafc" : "#0f172a" },
          valueFormatter: (value: number) => `${Number(value).toFixed(2)}%`,
        },
        grid: { top: 56, right: 24, bottom: 32, left: 56 },
        xAxis: {
          type: "category",
          data: dates,
          boundaryGap: false,
          axisLabel: { color: theme === "dark" ? "#9aa4b2" : "#64748b" },
          axisLine: { lineStyle: { color: theme === "dark" ? "#343a43" : "#cbd5e1" } },
        },
        yAxis: {
          type: "value",
          name: "비중(%)",
          min: 0,
          max: 100,
          axisLabel: { color: theme === "dark" ? "#9aa4b2" : "#64748b", formatter: "{value}%" },
          splitLine: { lineStyle: { color: theme === "dark" ? "#272b32" : "#e2e8f0" } },
        },
        series: rows.map((item) => ({
          name: item.asset_name,
          type: "line",
          stack: "holdings-weight",
          areaStyle: { opacity: 0.35 },
          smooth: true,
          symbolSize: 7,
          data: dates.map((date) => item.weights[date] ?? 0),
          connectNulls: true,
          emphasis: { focus: "series" },
        })),
      };
    },
    [analysisMode, crossEtfChanges.data, etfChangeSummary.data, pivot.data, theme],
  );

  function submitChat(message: string) {
    if (!message.trim()) return;
    if (message.includes("최근 3일") && message.includes("비중 변화")) {
      setAnalysisMode("list");
      queryClient.invalidateQueries({ queryKey: ["cross-etf-weight-changes"] });
      queryClient.invalidateQueries({ queryKey: ["etf-change-summary"] });
    }
    setChatMessages((prev) => [...prev, message]);
    chat.mutate(message);
    setChatInput("");
  }

  return (
    <div className="app-shell" data-theme={theme}>
      <header className="topbar">
        <div>
          <h1>ETF Portfolio Profiler</h1>
        </div>
        <div className="toolbar">
          <select value={periodDays} onChange={(event) => setPeriodDays(Number(event.target.value))}>
            <option value={3}>최근 3영업일</option>
            <option value={5}>최근 5영업일</option>
            <option value={10}>최근 10영업일</option>
          </select>
          <button onClick={() => collectProducts.mutate()}>
            <Database size={16} />
            ETF 목록 수집
          </button>
          <button onClick={() => collectHoldings.mutate()}>
            <RefreshCw size={16} />
            구성종목 수집
          </button>
          <button onClick={() => collectRecentHoldings.mutate()}>
            <RefreshCw size={16} />
            최근 3영업일 수집
          </button>
          <button onClick={() => collectRecentWatchlist.mutate()}>
            <RefreshCw size={16} />
            대표 ETF 3영업일
          </button>
          <button
            className="icon-button"
            aria-label={theme === "dark" ? "라이트 테마로 전환" : "다크 테마로 전환"}
            title={theme === "dark" ? "라이트 테마" : "다크 테마"}
            onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
          >
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </div>
      </header>

      <main className="workspace">
        <section className="analysis-canvas">
          <div className="canvas-toolbar">
            <div>
              <div className="canvas-title">{analysisMode === "list" ? "ETF 변동 목록" : "OLAP 피벗 캔버스"}</div>
              <div className="canvas-subtitle">
                {analysisMode === "list" ? "기간 내 ETF별 최대 변동 항목을 비교합니다" : "행/열/값/필터 축으로 구성종목 시계열을 재배치합니다"}
              </div>
            </div>
            <div className="canvas-actions">
              <button className={analysisMode === "list" ? "mode-active" : ""} onClick={() => setAnalysisMode("list")}>
                목록
              </button>
              <button className={analysisMode === "cross" ? "mode-active" : ""} onClick={() => setAnalysisMode("cross")}>
                종목 합산
              </button>
              <span>자동 저장</span>
              <span>공유</span>
              <span>내보내기</span>
            </div>
          </div>
          <section className="pivot-panel canvas-section">
            <div className="pivot-builder">
              <div className="field-zone">
                <Rows3 size={15} />
                <span>행</span>
                <button>{analysisMode === "list" ? "ETF 이름" : "종목명"}</button>
                {analysisMode !== "list" && <button>종목코드</button>}
              </div>
              <div className="field-zone">
                <Columns3 size={15} />
                <span>열</span>
                <button>{analysisMode === "list" ? "변동 기준" : "기준일"}</button>
              </div>
              <div className="field-zone">
                <Sigma size={15} />
                <span>값</span>
                <button>{analysisMode === "list" ? "최대 변동" : "비중"}</button>
                <button>{analysisMode === "list" ? "수량 변화율" : "비중 변화량"}</button>
              </div>
              <div className="field-zone">
                <Filter size={15} />
                <span>필터</span>
                <button>{periodDays}영업일</button>
                <button>{analysisMode === "single" ? "선택 ETF" : "수집된 ETF"}</button>
              </div>
            </div>
            <div className="pivot-grid-wrap">
              {analysisMode === "list" ? (
                <table className="pivot-grid summary-grid">
                  <thead>
                    <tr>
                      <th>ETF 이름</th>
                      <th>최대 수량비율 증가</th>
                      <th>최대 수량비율 감소</th>
                      <th>최대 비중 증가</th>
                      <th>최대 비중 감소</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(etfChangeSummary.data?.rows ?? []).map((item) => (
                      <tr key={item.ksd_fund}>
                        <td>
                          <button
                            className="text-link"
                            onClick={() => {
                              setSelectedFund(item.ksd_fund);
                              setAnalysisMode("single");
                            }}
                          >
                            {item.etf_name}
                          </button>
                        </td>
                        <td>{formatExtreme(item.max_quantity_increase, "%")}</td>
                        <td>{formatExtreme(item.max_quantity_decrease, "%")}</td>
                        <td>{formatExtreme(item.max_weight_increase, "%p")}</td>
                        <td>{formatExtreme(item.max_weight_decrease, "%p")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : analysisMode === "single" ? (
                <table className="pivot-grid">
                  <thead>
                    <tr>
                      <th rowSpan={2}>종목명</th>
                      <th rowSpan={2}>종목코드</th>
                      <th colSpan={pivot.data?.dates.length || 1}>기준일별 비중</th>
                      <th rowSpan={2}>변화량</th>
                    </tr>
                    <tr>
                      {(pivot.data?.dates.length ? pivot.data.dates : ["데이터 없음"]).map((date) => (
                        <th key={date}>{date}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(pivot.data?.rows ?? []).map((item) => (
                      <tr key={`${item.asset_code}-${item.asset_name}`}>
                        <td>{item.asset_name}</td>
                        <td>{item.asset_code}</td>
                        {(pivot.data?.dates ?? []).map((date) => (
                          <td key={date}>{formatNumber(item.weights[date])}</td>
                        ))}
                        <td className={item.weight_delta >= 0 ? "positive" : "negative"}>{item.weight_delta.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <table className="pivot-grid cross-grid">
                  <thead>
                    <tr>
                      <th rowSpan={2}>종목명</th>
                      <th rowSpan={2}>종목코드</th>
                      <th rowSpan={2}>편입 ETF</th>
                      <th colSpan={crossEtfChanges.data?.dates.length || 1}>여러 ETF 합산 비중</th>
                      <th rowSpan={2}>변화량</th>
                      <th rowSpan={2}>최근 노출</th>
                    </tr>
                    <tr>
                      {(crossEtfChanges.data?.dates.length ? crossEtfChanges.data.dates : ["데이터 없음"]).map((date) => (
                        <th key={date}>{date}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(crossEtfChanges.data?.rows ?? []).map((item) => (
                      <tr key={`${item.asset_code}-${item.asset_name}`}>
                        <td>{item.asset_name}</td>
                        <td>{item.asset_code}</td>
                        <td>{item.latest_etf_count}</td>
                        {(crossEtfChanges.data?.dates ?? []).map((date) => (
                          <td key={date}>{formatNumber(item.weights[date])}</td>
                        ))}
                        <td className={item.weight_delta >= 0 ? "positive" : "negative"}>{item.weight_delta.toFixed(2)}</td>
                        <td>{formatExposures(item.latest_exposures)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>

          <section className="chart-panel canvas-section">
            <div className="section-heading">
              <h2>차트</h2>
              <span>
                {analysisMode === "list"
                  ? "ETF별 최대 비중 증가/감소 비교"
                  : analysisMode === "single"
                    ? "날짜별 구성 비중을 0~100% 축에 쌓아 보는 누적 그래프"
                    : "여러 ETF에 걸친 종목별 합산 비중 변화"}
              </span>
            </div>
            <ReactECharts option={chartOption} style={{ height: "100%", minHeight: 420 }} />
          </section>
        </section>

        <aside className="ai-panel">
          <div className="panel-title">
            <Bot size={18} />
            AI 분석 패널
          </div>
          <button className="suggestion" onClick={() => submitChat("최근 3일간 비중 변화 큰 종목 찾아줘")}>
            최근 3일간 비중 변화 큰 종목 찾아줘
          </button>
          <div className="chat-log">
            {chatMessages.map((message, index) => (
              <div className={index % 2 === 0 ? "chat user" : "chat assistant"} key={`${message}-${index}`}>
                {message}
              </div>
            ))}
          </div>
          <form
            className="chat-input"
            onSubmit={(event) => {
              event.preventDefault();
              submitChat(chatInput);
            }}
          >
            <input value={chatInput} onChange={(event) => setChatInput(event.target.value)} placeholder="분석 요청 입력" />
            <button>
              <Send size={16} />
            </button>
          </form>
        </aside>
      </main>
    </div>
  );
}

function formatNumber(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";
  return value.toFixed(2);
}

function formatExposures(exposures: { etf_name: string; weight: number | null }[]) {
  if (!exposures.length) return "-";
  return exposures.map((item) => `${item.etf_name} ${formatNumber(item.weight)}%`).join(", ");
}

function formatExtreme(change: ExtremeChange | null, suffix: string) {
  if (!change) return "-";
  return `${change.asset_name} ${change.value.toFixed(2)}${suffix}`;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
