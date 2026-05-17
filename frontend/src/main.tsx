import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useMutation, useQuery } from "@tanstack/react-query";
import ReactECharts from "echarts-for-react";
import { Bot, Database, Moon, PanelRightClose, PanelRightOpen, RefreshCw, Send, Sun } from "lucide-react";
import "./styles.css";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000";
const showDevTools = import.meta.env.VITE_SHOW_DEV_TOOLS === "true";
const queryClient = new QueryClient();

type AnalysisMode = "list" | "single" | "cross";
type EtfChartMetric = "change_score" | "quantity_delta" | "weight_delta";
type DetailChartMetric =
  | "quantity"
  | "quantity_delta"
  | "quantity_delta_ratio"
  | "valuation_amount"
  | "valuation_weight"
  | "valuation_delta"
  | "valuation_delta_ratio"
  | "weight_delta";

type ChartClickEvent = {
  offsetX: number;
  offsetY: number;
};

type ChartInstance = {
  containPixel: (finder: { gridIndex: number }, value: [number, number]) => boolean;
  convertFromPixel: (finder: { gridIndex: number }, value: [number, number]) => unknown;
  getZr: () => {
    on: (eventName: "click", handler: (event: ChartClickEvent) => void) => void;
    off: (eventName: "click", handler?: (event: ChartClickEvent) => void) => void;
  };
};

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
  quantities: Record<string, number>;
  valuation_amounts: Record<string, number>;
  etf_counts: Record<string, number>;
  start_weight: number;
  end_weight: number;
  weight_delta: number;
  start_quantity: number;
  end_quantity: number;
  quantity_delta: number;
  start_valuation_amount: number;
  end_valuation_amount: number;
  valuation_amount_delta: number;
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
  change_score: number;
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
  const headers = new Headers(init?.headers);
  headers.set("ngrok-skip-browser-warning", "true");

  const response = await fetch(`${apiBaseUrl}${path}`, { ...init, headers });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json();
}

function App() {
  const listChartRowsRef = useRef<EtfChangeSummaryRow[]>([]);
  const analysisModeRef = useRef<AnalysisMode>("list");
  const chartRowClickHandlerRef = useRef<((event: ChartClickEvent) => void) | null>(null);
  const [selectedFund, setSelectedFund] = useState("KR70183J0002");
  const [chatInput, setChatInput] = useState("");
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const saved = localStorage.getItem("theme");
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>("list");
  const [aiPanelOpen, setAiPanelOpen] = useState(true);
  const [etfChartMetric, setEtfChartMetric] = useState<EtfChartMetric>("change_score");
  const [detailChartMetric, setDetailChartMetric] = useState<DetailChartMetric>("weight_delta");
  const [periodDays, setPeriodDays] = useState(3);
  const [chatMessages, setChatMessages] = useState<string[]>([
    "최근 3일간 비중 변화 큰 종목 찾아줘",
  ]);

  useEffect(() => {
    localStorage.setItem("theme", theme);
  }, [theme]);

  useEffect(() => {
    function syncRoute() {
      const route = parseRoute();
      setAnalysisMode(route.mode);
      if (route.ksdFund) {
        setSelectedFund(route.ksdFund);
      }
    }

    syncRoute();
    window.addEventListener("hashchange", syncRoute);
    return () => window.removeEventListener("hashchange", syncRoute);
  }, []);

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

  const summaryRows = etfChangeSummary.data?.rows ?? [];
  const pivotRows = pivot.data?.rows ?? [];
  const crossRows = crossEtfChanges.data?.rows ?? [];
  const hasChartData =
    analysisMode === "list"
      ? summaryRows.length > 0
      : analysisMode === "single"
        ? pivotRows.length > 0
        : crossRows.length > 0;

  useEffect(() => {
    analysisModeRef.current = analysisMode;
    listChartRowsRef.current = summaryRows.slice(0, 12).reverse();
  }, [analysisMode, summaryRows]);

  const chartOption = useMemo(
    () => {
      if (analysisMode === "list") {
        const rows = (etfChangeSummary.data?.rows ?? []).slice(0, 12).reverse();
        const metric = getEtfChartMetric(etfChartMetric);
        return {
          backgroundColor: "transparent",
          color: metric.colors(theme),
          textStyle: { color: theme === "dark" ? "#d7dde8" : "#334155" },
          legend: { top: 0, textStyle: { color: theme === "dark" ? "#d7dde8" : "#334155" } },
          tooltip: {
            trigger: "axis",
            axisPointer: { type: "shadow" },
            backgroundColor: theme === "dark" ? "#181b20" : "#ffffff",
            borderColor: theme === "dark" ? "#343a43" : "#d9dee7",
            textStyle: { color: theme === "dark" ? "#f8fafc" : "#0f172a" },
            valueFormatter: (value: number) => metric.format(value),
          },
          grid: { top: 54, right: 24, bottom: 32, left: 180 },
          xAxis: {
            type: "value",
            name: metric.axisName,
            axisLabel: { color: theme === "dark" ? "#9aa4b2" : "#64748b", formatter: metric.axisFormatter },
            splitLine: { lineStyle: { color: theme === "dark" ? "#272b32" : "#e2e8f0" } },
          },
          yAxis: {
            type: "category",
            data: rows.map((item) => item.etf_name),
            axisLabel: { color: theme === "dark" ? "#9aa4b2" : "#64748b" },
            axisLine: { lineStyle: { color: theme === "dark" ? "#343a43" : "#cbd5e1" } },
          },
          series: metric.series(rows),
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
      const allPivotRows = pivot.data?.rows ?? [];
      const visibleRows = allPivotRows.slice(0, 8);
      const isQuantityChart = detailChartMetric === "quantity";
      const isQuantityDeltaChart = detailChartMetric === "quantity_delta";
      const isQuantityDeltaRatioChart = detailChartMetric === "quantity_delta_ratio";
      const isValuationAmountChart = detailChartMetric === "valuation_amount";
      const isValuationDeltaChart = detailChartMetric === "valuation_delta";
      const isValuationDeltaRatioChart = detailChartMetric === "valuation_delta_ratio";
      const isWeightDeltaChart = detailChartMetric === "weight_delta";
      const isRatioChart = detailChartMetric === "valuation_weight";
      const isValueChart = isQuantityChart || isQuantityDeltaChart || isValuationAmountChart || isValuationDeltaChart;
      const isPercentChangeChart = isQuantityDeltaRatioChart || isValuationDeltaRatioChart || isWeightDeltaChart;
      const valuationTotals = Object.fromEntries(
        dates.map((date) => [
          date,
          allPivotRows.reduce((sum, item) => sum + (item.valuation_amounts[date] ?? 0), 0),
        ]),
      ) as Record<string, number>;
      const otherSeries = {
        asset_name: "기타",
        values: Object.fromEntries(
          dates.map((date) => {
            if (!isRatioChart) return [date, 0];
            const visibleSum = visibleRows.reduce((sum, item) => {
              const total = valuationTotals[date] || 0;
              const value = item.valuation_amounts[date] ?? 0;
              return sum + (total ? (value / total) * 100 : 0);
            }, 0);
            return [date, Math.max(0, 100 - visibleSum)];
          }),
        ) as Record<string, number>,
      };
      const rows = visibleRows.map((item) => ({
        asset_name: item.asset_name,
        values: Object.fromEntries(
          dates.map((date) => {
            if (isQuantityChart) {
              return [date, item.quantities[date] ?? 0];
            }
            if (isQuantityDeltaChart) {
              const startDate = dates[0];
              const startQuantity = item.quantities[startDate] ?? 0;
              return [date, (item.quantities[date] ?? 0) - startQuantity];
            }
            if (isQuantityDeltaRatioChart) {
              const startDate = dates[0];
              const startQuantity = item.quantities[startDate] ?? 0;
              const currentQuantity = item.quantities[date] ?? 0;
              return [date, startQuantity ? ((currentQuantity - startQuantity) / Math.abs(startQuantity)) * 100 : 0];
            }
            if (isValuationAmountChart) {
              return [date, item.valuation_amounts[date] ?? 0];
            }
            if (isValuationDeltaChart) {
              const startDate = dates[0];
              const startAmount = item.valuation_amounts[startDate] ?? 0;
              return [date, (item.valuation_amounts[date] ?? 0) - startAmount];
            }
            if (isValuationDeltaRatioChart) {
              const startDate = dates[0];
              const startAmount = item.valuation_amounts[startDate] ?? 0;
              const currentAmount = item.valuation_amounts[date] ?? 0;
              return [date, startAmount ? ((currentAmount - startAmount) / Math.abs(startAmount)) * 100 : 0];
            }
            if (isWeightDeltaChart) {
              const startDate = dates[0];
              const startWeight = item.weights[startDate] ?? 0;
              return [date, (item.weights[date] ?? 0) - startWeight];
            }
            const total = valuationTotals[date] || 0;
            return [date, total ? ((item.valuation_amounts[date] ?? 0) / total) * 100 : 0];
          }),
        ) as Record<string, number>,
      }));
      const seriesRows = rows.length > 0 ? (isRatioChart ? [...rows, otherSeries] : rows) : [];
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
          valueFormatter: (value: number) =>
            isValueChart
              ? detailChartMetric === "valuation_amount" || detailChartMetric === "valuation_delta"
                ? formatKrw(Number(value))
                : formatCompactNumber(Number(value))
              : `${Number(value).toFixed(2)}${isPercentChangeChart ? "%p" : "%"}`,
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
          name: getDetailChartAxisName(detailChartMetric),
          min: isQuantityDeltaChart || isPercentChangeChart ? undefined : 0,
          max: isRatioChart ? 100 : undefined,
          axisLabel: {
            color: theme === "dark" ? "#9aa4b2" : "#64748b",
            formatter:
              isValueChart
                ? (value: number) => detailChartMetric === "valuation_amount" || detailChartMetric === "valuation_delta" ? formatKrw(value) : formatCompactNumber(value)
                : isPercentChangeChart
                  ? "{value}%p"
                  : "{value}%",
          },
          splitLine: { lineStyle: { color: theme === "dark" ? "#272b32" : "#e2e8f0" } },
        },
        series: seriesRows.map((item) => ({
          name: item.asset_name,
          type: "line",
          stack: isRatioChart ? "holdings-ratio" : undefined,
          areaStyle: isRatioChart ? { opacity: 0.35 } : undefined,
          smooth: true,
          symbolSize: 7,
          data: dates.map((date) => item.values[date] ?? 0),
          connectNulls: true,
          emphasis: { focus: "series" },
        })),
      };
    },
    [analysisMode, crossEtfChanges.data, detailChartMetric, etfChangeSummary.data, etfChartMetric, pivot.data, theme],
  );
  const chartEvents = useMemo(
    () => ({
      click: (params: { name?: string }) => {
        if (analysisMode !== "list" || !params.name) return;
        const target = summaryRows.find((item) => item.etf_name === params.name);
        if (target) {
          navigateEtf(target.ksd_fund);
        }
      },
    }),
    [analysisMode, summaryRows],
  );

  function handleChartReady(chart: ChartInstance) {
    const zr = chart.getZr();
    if (chartRowClickHandlerRef.current) {
      zr.off("click", chartRowClickHandlerRef.current);
    }

    const handler = (event: ChartClickEvent) => {
      if (analysisModeRef.current !== "list") return;

      const point: [number, number] = [event.offsetX, event.offsetY];
      if (!chart.containPixel({ gridIndex: 0 }, point)) return;

      const converted = chart.convertFromPixel({ gridIndex: 0 }, point);
      if (!Array.isArray(converted)) return;

      const rowIndex = Math.round(Number(converted[1]));
      const target = listChartRowsRef.current[rowIndex];
      if (target) {
        navigateEtf(target.ksd_fund);
      }
    };

    chartRowClickHandlerRef.current = handler;
    zr.on("click", handler);
  }

  function submitChat(message: string) {
    if (!message.trim()) return;
    if (message.includes("최근 3일") && message.includes("비중 변화")) {
      navigateHome();
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
        <div className="brand-area">
          <button className="brand-link" onClick={navigateHome}>
            ETF Portfolio Profiler
          </button>
          <span className="brand-separator">|</span>
          <span className="current-view">{currentViewTitle(analysisMode)}</span>
        </div>
        <div className="toolbar">
          <select value={periodDays} onChange={(event) => setPeriodDays(Number(event.target.value))}>
            <option value={3}>최근 3영업일</option>
            <option value={5}>최근 5영업일</option>
            <option value={10}>최근 10영업일</option>
          </select>
          <button className={analysisMode === "list" || analysisMode === "single" ? "mode-active" : ""} onClick={navigateHome}>
            ETF별
          </button>
          <button className={analysisMode === "cross" ? "mode-active" : ""} onClick={navigateCross}>
            종목별
          </button>
          {showDevTools && (
            <>
              <button disabled={collectProducts.isPending} title="TIGER ETF 상품 목록 수집" onClick={() => collectProducts.mutate()}>
                <Database size={16} />
                <span>{collectProducts.isPending ? "수집 중" : "ETF 목록"}</span>
              </button>
              <button disabled={collectHoldings.isPending} title="선택 ETF의 최신 구성종목 수집" onClick={() => collectHoldings.mutate()}>
                <RefreshCw size={16} />
                <span>{collectHoldings.isPending ? "수집 중" : "구성종목"}</span>
              </button>
              <button disabled={collectRecentHoldings.isPending} title={`선택 ETF 최근 ${periodDays}영업일 구성종목 수집`} onClick={() => collectRecentHoldings.mutate()}>
                <RefreshCw size={16} />
                <span>{collectRecentHoldings.isPending ? "수집 중" : `선택 ETF ${periodDays}일`}</span>
              </button>
              <button disabled={collectRecentWatchlist.isPending} title={`대표 ETF 최근 ${periodDays}영업일 구성종목 수집`} onClick={() => collectRecentWatchlist.mutate()}>
                <RefreshCw size={16} />
                <span>{collectRecentWatchlist.isPending ? "수집 중" : `대표 ETF ${periodDays}일`}</span>
              </button>
            </>
          )}
          {!aiPanelOpen && (
            <button className="ai-topbar-toggle" onClick={() => setAiPanelOpen(true)}>
              <PanelRightOpen size={16} />
              <span>AI 패널</span>
            </button>
          )}
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

      <main className={aiPanelOpen ? "workspace" : "workspace ai-collapsed"}>
        <section className="analysis-canvas">
          <section className="pivot-panel canvas-section">
            <div className="pivot-grid-wrap">
              {analysisMode === "list" ? (
                summaryRows.length ? (
                  <table className="pivot-grid summary-grid">
                    <thead>
                      <tr>
                        <th>ETF 이름</th>
                        <th>변동 점수</th>
                        <th>최대 수량비율 증가</th>
                        <th>최대 수량비율 감소</th>
                        <th>최대 비중 증가</th>
                        <th>최대 비중 감소</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summaryRows.map((item) => (
                        <tr key={item.ksd_fund}>
                          <td>
                            <button
                              className="text-link"
                              onClick={() => navigateEtf(item.ksd_fund)}
                            >
                              {item.etf_name}
                            </button>
                          </td>
                          <td>{item.change_score.toFixed(2)}</td>
                          <td>{formatExtreme(item.max_quantity_increase, "%")}</td>
                          <td>{formatExtreme(item.max_quantity_decrease, "%")}</td>
                          <td>{formatExtreme(item.max_weight_increase, "%p")}</td>
                          <td>{formatExtreme(item.max_weight_decrease, "%p")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <EmptyState title="수집된 ETF 변동 데이터가 없습니다" body="상단의 ETF 목록과 대표 ETF 수집을 실행하면 변동 랭킹이 표시됩니다." />
                )
              ) : analysisMode === "single" ? (
                pivotRows.length ? (
                  <table className="pivot-grid">
                    <thead>
                      <tr>
                        <th rowSpan={2}>종목명</th>
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
                      {pivotRows.map((item) => (
                        <tr key={`${item.asset_code}-${item.asset_name}`}>
                          <td>{item.asset_name}</td>
                          {(pivot.data?.dates ?? []).map((date) => (
                            <td key={date}>{formatNumber(item.weights[date])}</td>
                          ))}
                          <td className={item.weight_delta >= 0 ? "positive" : "negative"}>{item.weight_delta.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <EmptyState title="선택 ETF의 구성종목 데이터가 없습니다" body="선택 ETF 최근 영업일 수집을 실행한 뒤 다시 확인하세요." />
                )
              ) : (
                crossRows.length ? (
                  <table className="pivot-grid cross-grid">
                    <thead>
                      <tr>
                        <th rowSpan={2}>종목명</th>
                        <th rowSpan={2}>편입 ETF</th>
                        <th rowSpan={2}>최근 총 수량</th>
                        <th rowSpan={2}>수량 변화</th>
                        <th rowSpan={2}>최근 총 금액</th>
                        <th rowSpan={2}>금액 변화</th>
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
                      {crossRows.map((item) => (
                        <tr key={`${item.asset_code}-${item.asset_name}`}>
                          <td>{item.asset_name}</td>
                          <td>{item.latest_etf_count}</td>
                          <td>{formatCompactNumber(item.end_quantity)}</td>
                          <td className={item.quantity_delta >= 0 ? "positive" : "negative"}>{formatSignedCompactNumber(item.quantity_delta)}</td>
                          <td>{formatKrw(item.end_valuation_amount)}</td>
                          <td className={item.valuation_amount_delta >= 0 ? "positive" : "negative"}>{formatSignedKrw(item.valuation_amount_delta)}</td>
                          {(crossEtfChanges.data?.dates ?? []).map((date) => (
                            <td key={date}>{formatNumber(item.weights[date])}</td>
                          ))}
                          <td className={item.weight_delta >= 0 ? "positive" : "negative"}>{item.weight_delta.toFixed(2)}</td>
                          <td>{formatExposures(item.latest_exposures)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <EmptyState title="종목 합산 분석 데이터가 없습니다" body="대표 ETF 수집 후 여러 ETF에 걸친 종목별 합산 비중 변화를 볼 수 있습니다." />
                )
              )}
            </div>
          </section>

          <section className="chart-panel canvas-section">
            <div className="section-heading">
              <h2>차트</h2>
              {analysisMode === "list" ? (
                <select value={etfChartMetric} onChange={(event) => setEtfChartMetric(event.target.value as EtfChartMetric)}>
                  <option value="change_score">변동점수 기준</option>
                  <option value="quantity_delta">수량 변동 기준</option>
                  <option value="weight_delta">비중 변동 기준</option>
                </select>
              ) : analysisMode === "single" ? (
                <select value={detailChartMetric} onChange={(event) => setDetailChartMetric(event.target.value as DetailChartMetric)}>
                  <optgroup label="종목 수량 기준">
                    <option value="quantity">수량별</option>
                    <option value="quantity_delta">수량 변화량</option>
                    <option value="quantity_delta_ratio">수량 변화율</option>
                  </optgroup>
                  <optgroup label="금액 기준">
                    <option value="valuation_amount">금액별</option>
                    <option value="valuation_delta">금액 변화량</option>
                    <option value="valuation_delta_ratio">금액 변화율</option>
                  </optgroup>
                  <optgroup label="ETF 내 비중 기준">
                    <option value="valuation_weight">비중별</option>
                    <option value="weight_delta">비중 변화량</option>
                  </optgroup>
                </select>
              ) : (
                <span>
                  여러 ETF에 걸친 종목별 합산 비중 변화
                </span>
              )}
            </div>
            {hasChartData ? (
              <ReactECharts
                key={analysisMode}
                notMerge
                option={chartOption}
                onChartReady={handleChartReady}
                onEvents={chartEvents}
                style={{ height: "100%", minHeight: 300 }}
              />
            ) : (
              <EmptyState title="차트로 표시할 데이터가 없습니다" body="상단 수집 버튼으로 최신 데이터를 불러오면 이 영역이 갱신됩니다." />
            )}
          </section>
        </section>

        {aiPanelOpen ? (
          <aside className="ai-panel">
            <div className="panel-title">
              <span>
                <Bot size={18} />
                AI 분석 패널
              </span>
              <button className="panel-toggle" aria-label="AI 분석 패널 접기" title="패널 접기" onClick={() => setAiPanelOpen(false)}>
                <PanelRightClose size={16} />
              </button>
            </div>
            <button className="suggestion" onClick={() => submitChat("최근 3일간 비중 변화 큰 종목 찾아줘")}>
              최근 3일간 비중 변화 큰 종목 찾아줘
            </button>
            <div className="insight-strip">
              <div>
                <span>분석 범위</span>
                <strong>{periodDays}영업일</strong>
              </div>
              <div>
                <span>랭킹 ETF</span>
                <strong>{summaryRows.length}</strong>
              </div>
              <div>
                <span>현재 모드</span>
              <strong>{analysisMode === "list" ? "ETF별" : analysisMode === "single" ? "단일 ETF" : "종목별"}</strong>
              </div>
            </div>
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
        ) : null}
      </main>
    </div>
  );
}

function formatNumber(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";
  return value.toFixed(2);
}

function formatCompactNumber(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";
  return new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 }).format(value);
}

function formatSignedCompactNumber(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";
  const formatted = formatCompactNumber(Math.abs(value));
  if (value === 0) return formatted;
  return `${value > 0 ? "+" : "-"}${formatted}`;
}

function formatKrw(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";
  if (Math.abs(value) >= 100_000_000) {
    return `${(value / 100_000_000).toFixed(1)}억`;
  }
  if (Math.abs(value) >= 10_000) {
    return `${(value / 10_000).toFixed(0)}만`;
  }
  return formatCompactNumber(value);
}

function formatSignedKrw(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";
  const formatted = formatKrw(Math.abs(value));
  if (value === 0) return formatted;
  return `${value > 0 ? "+" : "-"}${formatted}`;
}

function formatExposures(exposures: { etf_name: string; weight: number | null }[]) {
  if (!exposures.length) return "-";
  return exposures.map((item) => `${item.etf_name} ${formatNumber(item.weight)}%`).join(", ");
}

function formatExtreme(change: ExtremeChange | null, suffix: string) {
  if (!change) return "-";
  return `${change.asset_name} ${change.value.toFixed(2)}${suffix}`;
}

function getDetailChartAxisName(metric: DetailChartMetric) {
  if (metric === "quantity") return "수량";
  if (metric === "quantity_delta") return "수량 변화";
  if (metric === "quantity_delta_ratio") return "수량 변화율(%p)";
  if (metric === "valuation_amount") return "금액";
  if (metric === "valuation_delta") return "금액 변화";
  if (metric === "valuation_delta_ratio") return "금액 변화율(%p)";
  if (metric === "weight_delta") return "비중 변화(%p)";
  return "금액비중(%)";
}

function getEtfChartMetric(metric: EtfChartMetric) {
  if (metric === "quantity_delta") {
    return {
      axisName: "수량 변화율",
      axisFormatter: "{value}%",
      colors: (theme: "light" | "dark") => theme === "dark" ? ["#f87171", "#60a5fa"] : ["#dc2626", "#2563eb"],
      format: (value: number) => `${Number(value).toFixed(2)}%`,
      series: (rows: EtfChangeSummaryRow[]) => [
        {
          name: "최대 수량 증가율",
          type: "bar",
          data: rows.map((item) => item.max_quantity_increase?.value ?? 0),
        },
        {
          name: "최대 수량 감소율",
          type: "bar",
          data: rows.map((item) => item.max_quantity_decrease?.value ?? 0),
        },
      ],
    };
  }

  if (metric === "weight_delta") {
    return {
      axisName: "비중 변화",
      axisFormatter: "{value}%p",
      colors: (theme: "light" | "dark") => theme === "dark" ? ["#f87171", "#60a5fa"] : ["#dc2626", "#2563eb"],
      format: (value: number) => `${Number(value).toFixed(2)}%p`,
      series: (rows: EtfChangeSummaryRow[]) => [
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

  return {
    axisName: "변동점수",
    axisFormatter: "{value}",
    colors: (theme: "light" | "dark") => [theme === "dark" ? "#f87171" : "#dc2626"],
    format: (value: number) => `${Number(value).toFixed(2)}`,
    series: (rows: EtfChangeSummaryRow[]) => [
      {
        name: "변동점수",
        type: "bar",
        data: rows.map((item) => item.change_score),
      },
    ],
  };
}

function parseRoute(): { mode: AnalysisMode; ksdFund?: string } {
  const hash = window.location.hash.replace(/^#/, "");
  const etfMatch = hash.match(/^\/etf\/([^/]+)$/);
  if (etfMatch) {
    return { mode: "single", ksdFund: decodeURIComponent(etfMatch[1]) };
  }
  if (hash === "/cross") {
    return { mode: "cross" };
  }
  return { mode: "list" };
}

function navigateHome() {
  if (window.location.hash === "#/") {
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    return;
  }
  window.location.hash = "/";
}

function navigateEtf(ksdFund: string) {
  const nextHash = `#/etf/${encodeURIComponent(ksdFund)}`;
  if (window.location.hash === nextHash) {
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    return;
  }
  window.location.hash = nextHash;
}

function navigateCross() {
  if (window.location.hash === "#/cross") {
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    return;
  }
  window.location.hash = "/cross";
}

function currentViewTitle(mode: AnalysisMode) {
  if (mode === "list") return "ETF 변동 목록";
  if (mode === "cross") return "종목별 변화";
  return "ETF 상세";
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      <span>{body}</span>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
