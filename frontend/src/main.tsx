import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useMutation, useQuery } from "@tanstack/react-query";
import ReactECharts from "echarts-for-react";
import type { CellValue, Worksheet } from "exceljs";
import JSZip from "jszip";
import { Bot, Database, Download, Moon, PanelRightClose, PanelRightOpen, RefreshCw, Send, Sun } from "lucide-react";
import "./styles.css";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000";
const showDevTools = import.meta.env.VITE_SHOW_DEV_TOOLS === "true";
const queryClient = new QueryClient();

type AnalysisMode = "list" | "single" | "cross" | "asset";
type AssetTypeFilter = "stock" | "listed_product" | "fixed_income" | "derivative" | "cash" | "all";
type EtfTypeFilter = "equity" | "income" | "leveraged_inverse" | "fixed_income" | "money_market" | "other" | "all";
type EtfChartMetric = "change_score" | "quantity" | "valuation" | "weight";
type CrossChartMetric =
  | "change_score"
  | "weight_delta"
  | "quantity"
  | "quantity_delta"
  | "quantity_delta_ratio"
  | "valuation_amount"
  | "valuation_delta"
  | "valuation_delta_ratio"
  | "avg_weight"
  | "avg_weight_delta"
  | "max_weight"
  | "max_weight_delta";
type AssetChartMetric = Exclude<CrossChartMetric, "change_score" | "weight_delta">;
type PeriodMode = "5" | "10" | "20" | "custom";
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
  asset_type?: AssetTypeFilter;
  weights: Record<string, number>;
  avg_weights?: Record<string, number>;
  max_weights?: Record<string, number>;
  quantities: Record<string, number>;
  valuation_amounts: Record<string, number>;
  etf_counts: Record<string, number>;
  start_weight: number;
  end_weight: number;
  weight_delta: number;
  start_avg_weight?: number;
  end_avg_weight?: number;
  avg_weight_delta?: number;
  start_max_weight?: number;
  end_max_weight?: number;
  max_weight_delta?: number;
  start_quantity: number;
  end_quantity: number;
  quantity_delta: number;
  start_valuation_amount: number;
  end_valuation_amount: number;
  valuation_amount_delta: number;
  latest_etf_count: number;
  latest_exposures: { ksd_fund?: string; etf_name: string; weight: number | null }[];
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
  etf_type?: EtfTypeFilter;
  change_score: number;
  max_quantity_increase: ExtremeChange | null;
  max_quantity_decrease: ExtremeChange | null;
  max_valuation_amount: ExtremeChange | null;
  max_valuation_increase: ExtremeChange | null;
  max_valuation_decrease: ExtremeChange | null;
  max_valuation_pct_increase: ExtremeChange | null;
  max_valuation_pct_decrease: ExtremeChange | null;
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
  const crossChartRowsRef = useRef<CrossEtfRow[]>([]);
  const analysisModeRef = useRef<AnalysisMode>("list");
  const chartInstanceRef = useRef<ChartInstance | null>(null);
  const chartRowClickHandlerRef = useRef<((event: ChartClickEvent) => void) | null>(null);
  const [selectedFund, setSelectedFund] = useState("KR70183J0002");
  const [selectedAssetCode, setSelectedAssetCode] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const saved = localStorage.getItem("theme");
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>("list");
  const [aiPanelOpen, setAiPanelOpen] = useState(true);
  const [etfChartMetric, setEtfChartMetric] = useState<EtfChartMetric>("change_score");
  const [etfTypeFilter, setEtfTypeFilter] = useState<EtfTypeFilter>("all");
  const [crossChartMetric, setCrossChartMetric] = useState<CrossChartMetric>("change_score");
  const [assetChartMetric, setAssetChartMetric] = useState<AssetChartMetric>("max_weight_delta");
  const [assetTypeFilter, setAssetTypeFilter] = useState<AssetTypeFilter>("stock");
  const [detailChartMetric, setDetailChartMetric] = useState<DetailChartMetric>("weight_delta");
  const [listDownloadMode, setListDownloadMode] = useState(false);
  const [selectedDownloadFunds, setSelectedDownloadFunds] = useState<string[]>([]);
  const [isDownloadingList, setIsDownloadingList] = useState(false);
  const [periodMode, setPeriodMode] = useState<PeriodMode>("5");
  const [customStartDate, setCustomStartDate] = useState("");
  const [customEndDate, setCustomEndDate] = useState("");
  const [chatMessages, setChatMessages] = useState<string[]>([
    "최근 5영업일간 비중 변화 큰 종목 찾아줘",
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
      if (route.assetCode) {
        setSelectedAssetCode(route.assetCode);
      } else if (route.mode !== "asset") {
        setSelectedAssetCode("");
      }
    }

    syncRoute();
    window.addEventListener("hashchange", syncRoute);
    return () => window.removeEventListener("hashchange", syncRoute);
  }, []);

  const periodDays = periodMode === "custom" ? 5 : Number(periodMode);
  const analysisPeriodQuery = getAnalysisPeriodQuery(periodMode, periodDays, customStartDate, customEndDate);
  const periodLabel = periodMode === "custom" && customStartDate && customEndDate ? `${customStartDate}~${customEndDate}` : `${periodDays}영업일`;

  const pivot = useQuery({
    queryKey: ["holdings-pivot", selectedFund, analysisPeriodQuery],
    queryFn: () => api<PivotResponse>(`/api/analysis/holdings-pivot?ksd_fund=${selectedFund}&${analysisPeriodQuery}`),
  });

  const crossEtfChanges = useQuery({
    queryKey: ["cross-etf-weight-changes", analysisPeriodQuery],
    queryFn: () => api<CrossEtfResponse>(`/api/analysis/cross-etf-weight-changes?${analysisPeriodQuery}&limit=100`),
  });

  const etfChangeSummary = useQuery({
    queryKey: ["etf-change-summary", analysisPeriodQuery],
    queryFn: () => api<EtfChangeSummaryResponse>(`/api/analysis/etf-change-summary?${analysisPeriodQuery}&limit=100`),
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
    mutationFn: () => api(`/api/collect/tiger/recent-watchlist?days=${periodDays}&limit=20`, { method: "POST" }),
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

  const rawSummaryRows = etfChangeSummary.data?.rows ?? [];
  const summaryRows = useMemo(() => filterSummaryRowsByEtfType(rawSummaryRows, etfTypeFilter), [etfTypeFilter, rawSummaryRows]);
  const pivotRows = pivot.data?.rows ?? [];
  const crossRows = crossEtfChanges.data?.rows ?? [];
  const pivotDates = pivot.data?.dates ?? [];
  const selectedAsset = crossRows.find((item) => item.asset_code === selectedAssetCode);
  const crossFilteredRows = useMemo(() => filterCrossRowsByAssetType(crossRows, assetTypeFilter), [assetTypeFilter, crossRows]);
  const crossScoreRows = crossFilteredRows;
  const crossScoreMaxes = useMemo(() => getCrossScoreMaxes(crossScoreRows), [crossScoreRows]);
  const crossDisplayRows = useMemo(
    () =>
      crossScoreRows
        .slice()
        .sort((a, b) => getCrossChangeScore(b, crossScoreMaxes) - getCrossChangeScore(a, crossScoreMaxes)),
    [crossScoreMaxes, crossScoreRows],
  );
  const crossChartRows = useMemo(
    () => getCrossChartRows(crossFilteredRows, crossChartMetric, crossDisplayRows),
    [crossChartMetric, crossDisplayRows, crossFilteredRows],
  );
  const etfFundByName = useMemo(
    () => new Map(summaryRows.map((item) => [item.etf_name, item.ksd_fund])),
    [summaryRows],
  );
  const selectedEtfName = rawSummaryRows.find((item) => item.ksd_fund === selectedFund)?.etf_name ?? selectedFund;
  const detailStartDate = pivotDates[0];
  const detailEndDate = pivotDates[pivotDates.length - 1];
  const isCurrentTableLoading =
    analysisMode === "list"
      ? etfChangeSummary.isLoading
      : analysisMode === "single"
        ? pivot.isLoading || (pivot.isFetching && pivotRows.length === 0)
        : crossEtfChanges.isLoading || (analysisMode === "asset" && crossEtfChanges.isFetching && !selectedAsset);
  const isCurrentChartLoading =
    analysisMode === "list"
      ? etfChangeSummary.isLoading
      : analysisMode === "single"
        ? pivot.isLoading || (pivot.isFetching && pivotRows.length === 0)
        : crossEtfChanges.isLoading || (analysisMode === "asset" && crossEtfChanges.isFetching && !selectedAsset);
  const hasChartData =
    analysisMode === "list"
      ? summaryRows.length > 0
      : analysisMode === "single"
        ? pivotRows.length > 0
        : analysisMode === "asset"
          ? Boolean(selectedAsset)
          : crossDisplayRows.length > 0;

  useEffect(() => {
    analysisModeRef.current = analysisMode;
    listChartRowsRef.current = summaryRows.slice(0, 12).reverse();
    crossChartRowsRef.current = crossChartRows.slice(0, 14).reverse();
  }, [analysisMode, crossChartRows, summaryRows]);

  useEffect(() => {
    if (analysisMode !== "list") {
      setListDownloadMode(false);
      setSelectedDownloadFunds([]);
    }
  }, [analysisMode]);

  useEffect(() => {
    const currentFunds = new Set(summaryRows.map((item) => item.ksd_fund));
    setSelectedDownloadFunds((current) => current.filter((ksdFund) => currentFunds.has(ksdFund)));
  }, [summaryRows]);

  const selectedDownloadSet = useMemo(() => new Set(selectedDownloadFunds), [selectedDownloadFunds]);
  const allListRowsSelected = summaryRows.length > 0 && summaryRows.every((item) => selectedDownloadSet.has(item.ksd_fund));
  const partiallyListRowsSelected = selectedDownloadFunds.length > 0 && !allListRowsSelected;

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
        const metric = getCrossChartMetric(crossChartMetric, crossScoreMaxes);
        const isDirectionalMetric = crossChartMetric.endsWith("_delta") || crossChartMetric.endsWith("_delta_ratio");
        const rows = crossChartRows
          .slice(0, 14)
          .reverse();
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
            valueFormatter: (value: number) => metric.format(Number(value)),
          },
          grid: { top: 54, right: 28, bottom: 32, left: 140 },
          xAxis: {
            type: "value",
            name: metric.axisName,
            axisLabel: { color: theme === "dark" ? "#9aa4b2" : "#64748b", formatter: metric.axisFormatter },
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
              name: metric.label,
              type: "bar",
              data: rows.map((item) => metric.value(item) || 0),
              itemStyle: {
                color: (params: { value: number }) =>
                  isDirectionalMetric && params.value < 0
                    ? theme === "dark"
                      ? "#60a5fa"
                      : "#2563eb"
                    : metric.colors(theme)[0],
              },
            },
          ],
        };
      }

      if (analysisMode === "asset") {
        const dates = crossEtfChanges.data?.dates ?? [];
        const item = selectedAsset;
        const metric = getAssetChartMetric(assetChartMetric);
        return {
          backgroundColor: "transparent",
          color: metric.colors(theme),
          textStyle: { color: theme === "dark" ? "#d7dde8" : "#334155" },
          legend: { top: 0, textStyle: { color: theme === "dark" ? "#d7dde8" : "#334155" } },
          tooltip: {
            trigger: "axis",
            backgroundColor: theme === "dark" ? "#181b20" : "#ffffff",
            borderColor: theme === "dark" ? "#343a43" : "#d9dee7",
            textStyle: { color: theme === "dark" ? "#f8fafc" : "#0f172a" },
            valueFormatter: (value: number) => metric.format(Number(value)),
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
            name: metric.axisName,
            min: metric.allowNegative ? undefined : 0,
            axisLabel: { color: theme === "dark" ? "#9aa4b2" : "#64748b", formatter: metric.axisFormatter },
            splitLine: { lineStyle: { color: theme === "dark" ? "#272b32" : "#e2e8f0" } },
          },
          series: [
            {
              name: metric.label,
              type: "line",
              smooth: true,
              symbolSize: 7,
              data: dates.map((date) => metric.value(item, date, dates[0])),
              connectNulls: true,
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
      const isQuantityMetric = isQuantityChart || isQuantityDeltaChart || isQuantityDeltaRatioChart;
      const chartSourceRows = isQuantityMetric ? allPivotRows.filter((item) => !isCashLikeHolding(item.asset_code, item.asset_name)) : allPivotRows;
      const chartVisibleRows = chartSourceRows.slice(0, 8);
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
          chartSourceRows.reduce((sum, item) => sum + (item.valuation_amounts[date] ?? 0), 0),
        ]),
      ) as Record<string, number>;
      const otherSeries = {
        asset_name: "기타",
        values: Object.fromEntries(
          dates.map((date) => {
            if (!isRatioChart) return [date, 0];
            const visibleSum = chartVisibleRows.reduce((sum, item) => {
              const total = valuationTotals[date] || 0;
              const value = item.valuation_amounts[date] ?? 0;
              return sum + (total ? (value / total) * 100 : 0);
            }, 0);
            return [date, Math.max(0, 100 - visibleSum)];
          }),
        ) as Record<string, number>,
      };
      const rows = chartVisibleRows.map((item) => ({
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
    [analysisMode, assetChartMetric, crossChartMetric, crossChartRows, crossEtfChanges.data, detailChartMetric, etfChangeSummary.data, etfChartMetric, pivot.data, selectedAsset, theme],
  );
  const chartEvents = useMemo(
    () => ({
      click: (params: { name?: string }) => {
        if (!params.name) return;
        if (analysisMode === "list") {
          const target = summaryRows.find((item) => item.etf_name === params.name);
          if (target) {
            navigateEtf(target.ksd_fund);
          }
          return;
        }
        if (analysisMode === "cross") {
          const target = crossChartRows.find((item) => item.asset_name === params.name);
          if (target) {
            navigateAsset(target.asset_code);
          }
          return;
        }
        if (analysisMode === "single") {
          const target = pivotRows.find((item) => item.asset_name === params.name);
          if (target) {
            navigateAsset(target.asset_code);
          }
        }
      },
    }),
    [analysisMode, crossChartRows, pivotRows, summaryRows],
  );

  function handleChartReady(chart: ChartInstance) {
    chartInstanceRef.current = chart;
    const zr = chart.getZr();
    if (chartRowClickHandlerRef.current) {
      zr.off("click", chartRowClickHandlerRef.current);
    }

    const handler = (event: ChartClickEvent) => {
      if (analysisModeRef.current !== "list" && analysisModeRef.current !== "cross") return;

      const point: [number, number] = [event.offsetX, event.offsetY];
      if (!chart.containPixel({ gridIndex: 0 }, point)) return;

      const converted = chart.convertFromPixel({ gridIndex: 0 }, point);
      if (!Array.isArray(converted)) return;

      const rowIndex = Math.round(Number(converted[1]));
      if (analysisModeRef.current === "list") {
        const target = listChartRowsRef.current[rowIndex];
        if (target) {
          navigateEtf(target.ksd_fund);
        }
        return;
      }

      const target = crossChartRowsRef.current[rowIndex];
      if (target) {
        navigateAsset(target.asset_code);
      }
    };

    chartRowClickHandlerRef.current = handler;
    zr.on("click", handler);
  }

  async function downloadDetailWorkbook() {
    if (analysisMode !== "single" || !pivotRows.length || !pivotDates.length) return;

    await exportDetailWorkbook({
      detailChartMetric,
      etfName: selectedEtfName,
      ksdFund: selectedFund,
      periodLabel,
      rows: pivotRows,
      dates: pivotDates,
    });
  }

  async function handleListDownloadButton() {
    if (analysisMode !== "list") return;
    if (!listDownloadMode) {
      setListDownloadMode(true);
      return;
    }
    if (!selectedDownloadFunds.length || isDownloadingList) return;

    const selectedRows = summaryRows.filter((item) => selectedDownloadSet.has(item.ksd_fund));
    const exportMetric = getListDownloadDetailMetric(etfChartMetric);
    setIsDownloadingList(true);
    try {
      for (const item of selectedRows) {
        const data = await api<PivotResponse>(`/api/analysis/holdings-pivot?ksd_fund=${item.ksd_fund}&${analysisPeriodQuery}`);
        if (!data.rows.length || !data.dates.length) continue;
        await exportDetailWorkbook({
          detailChartMetric: exportMetric,
          etfName: item.etf_name,
          ksdFund: item.ksd_fund,
          periodLabel,
          rows: data.rows,
          dates: data.dates,
        });
        await delay(150);
      }
    } finally {
      setIsDownloadingList(false);
      setListDownloadMode(false);
      setSelectedDownloadFunds([]);
    }
  }

  function toggleListDownloadFund(ksdFund: string) {
    setSelectedDownloadFunds((current) =>
      current.includes(ksdFund) ? current.filter((item) => item !== ksdFund) : [...current, ksdFund],
    );
  }

  function toggleAllListDownloadFunds(checked: boolean) {
    setSelectedDownloadFunds(checked ? summaryRows.map((item) => item.ksd_fund) : []);
  }

  function submitChat(message: string) {
    if (!message.trim()) return;
    if (message.includes("최근") && message.includes("비중 변화")) {
      navigateHome();
      queryClient.invalidateQueries({ queryKey: ["cross-etf-weight-changes"] });
      queryClient.invalidateQueries({ queryKey: ["etf-change-summary"] });
    }
    setChatMessages((prev) => [...prev, message]);
    chat.mutate(message);
    setChatInput("");
  }

  function navigateCurrentRoot() {
    if (analysisMode === "cross" || analysisMode === "asset") {
      setCrossChartMetric("change_score");
      setSelectedAssetCode("");
      navigateCross();
      return;
    }
    navigateHome();
  }

  return (
    <div className="app-shell" data-theme={theme}>
      <header className="topbar">
        <div className="brand-area">
          <button className="brand-link" onClick={navigateCurrentRoot}>
            ETF Portfolio Profiler
          </button>
          <span className="brand-separator">|</span>
          <span className="current-view">{currentViewTitle(analysisMode, selectedEtfName, selectedAsset?.asset_name)}</span>
        </div>
        <div className="toolbar toolbar-primary">
          <div className="toolbar-group">
            <span className="toolbar-label">기간:</span>
            <select value={periodMode} onChange={(event) => setPeriodMode(event.target.value as PeriodMode)}>
              <option value="5">최근 5영업일</option>
              <option value="10">최근 10영업일</option>
              <option value="20">최근 20영업일</option>
              <option value="custom">직접 선택</option>
            </select>
            {periodMode === "custom" && (
              <>
                <input type="date" value={customStartDate} onChange={(event) => setCustomStartDate(event.target.value)} />
                <input type="date" value={customEndDate} onChange={(event) => setCustomEndDate(event.target.value)} />
              </>
            )}
          </div>
          <span className="toolbar-divider" aria-hidden="true" />
          <div className="toolbar-group">
            <span className="toolbar-label">분석 타겟:</span>
            <button className={analysisMode === "list" || analysisMode === "single" ? "mode-active" : ""} onClick={navigateHome}>
              ETF별
            </button>
            <button className={analysisMode === "cross" || analysisMode === "asset" ? "mode-active" : ""} onClick={navigateCross}>
              종목별
            </button>
          </div>
        </div>
        <div className="toolbar toolbar-secondary">
          {analysisMode === "list" && (
            <>
              <div className="toolbar-group">
                <span className="toolbar-label">ETF 유형:</span>
                <select value={etfTypeFilter} onChange={(event) => setEtfTypeFilter(event.target.value as EtfTypeFilter)}>
                  <option value="all">전체</option>
                  <option value="equity">주식형</option>
                  <option value="income">인컴/커버드콜</option>
                  <option value="leveraged_inverse">레버리지/인버스</option>
                  <option value="fixed_income">채권형</option>
                  <option value="money_market">머니마켓</option>
                  <option value="other">기타</option>
                </select>
              </div>
            </>
          )}
          {analysisMode === "cross" && (
            <>
              <div className="toolbar-group">
                <span className="toolbar-label">자산군:</span>
                <select value={assetTypeFilter} onChange={(event) => setAssetTypeFilter(event.target.value as AssetTypeFilter)}>
                  <option value="stock">주식</option>
                  <option value="listed_product">상장상품</option>
                  <option value="fixed_income">채권/단기상품</option>
                  <option value="derivative">선물/파생</option>
                  <option value="cash">현금성</option>
                  <option value="all">전체</option>
                </select>
              </div>
            </>
          )}
          {showDevTools && (
            <>
              <span className="toolbar-divider" aria-hidden="true" />
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
          {analysisMode === "single" && (
            <>
              <span className="toolbar-divider" aria-hidden="true" />
              <button disabled={isCurrentTableLoading || !pivotRows.length} title="현재 ETF 상세 데이터를 엑셀로 다운로드" onClick={downloadDetailWorkbook}>
                <Download size={16} />
                <span>다운로드</span>
              </button>
            </>
          )}
          {(analysisMode === "cross" || analysisMode === "asset") && (
            <>
              <span className="toolbar-divider" aria-hidden="true" />
              <button disabled title="종목별 다운로드는 추후 제공 예정입니다">
                <Download size={16} />
                <span>다운로드</span>
              </button>
            </>
          )}
          {analysisMode === "list" && (
            <>
              <span className="toolbar-divider" aria-hidden="true" />
              <button
                disabled={isCurrentTableLoading || !summaryRows.length || isDownloadingList || (listDownloadMode && !selectedDownloadFunds.length)}
                title={listDownloadMode ? "선택한 ETF 상세 데이터를 각각 엑셀로 다운로드" : "다운로드할 ETF를 선택합니다"}
                onClick={handleListDownloadButton}
              >
                <Download size={16} />
                <span>
                  {isDownloadingList
                    ? "다운로드 중"
                    : listDownloadMode
                      ? `선택 다운로드 (${selectedDownloadFunds.length})`
                      : "다운로드"}
                </span>
              </button>
              {listDownloadMode && (
                <button
                  title="ETF 다운로드 선택을 취소합니다"
                  onClick={() => {
                    setListDownloadMode(false);
                    setSelectedDownloadFunds([]);
                  }}
                >
                  취소
                </button>
              )}
            </>
          )}
          {!aiPanelOpen && (
            <>
              <span className="toolbar-divider" aria-hidden="true" />
              <button className="ai-topbar-toggle" onClick={() => setAiPanelOpen(true)}>
                <PanelRightOpen size={16} />
                <span>AI 패널</span>
              </button>
            </>
          )}
          <span className="toolbar-divider" aria-hidden="true" />
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
              {isCurrentTableLoading ? (
                <LoadingState title="데이터를 불러오는 중입니다" body={getLoadingMessage(analysisMode)} />
              ) : analysisMode === "list" ? (
                summaryRows.length ? (
                  <table className={`pivot-grid summary-grid${listDownloadMode ? " with-selection" : ""}`}>
                    <thead>
                      <tr>
                        {listDownloadMode && (
                          <th className="select-column">
                            <input
                              type="checkbox"
                              aria-label="ETF 전체 선택"
                              checked={allListRowsSelected}
                              ref={(element) => {
                                if (element) element.indeterminate = partiallyListRowsSelected;
                              }}
                              onChange={(event) => toggleAllListDownloadFunds(event.target.checked)}
                            />
                          </th>
                        )}
                        <th>ETF 이름</th>
                        <th className="score-cell">변동점수</th>
                        <th>수량 증가율</th>
                        <th>수량 감소율</th>
                        <th>비중 증가</th>
                        <th>비중 감소</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summaryRows.map((item) => (
                        <tr key={item.ksd_fund}>
                          {listDownloadMode && (
                            <td className="select-column">
                              <input
                                type="checkbox"
                                aria-label={`${item.etf_name} 다운로드 선택`}
                                checked={selectedDownloadSet.has(item.ksd_fund)}
                                onChange={() => toggleListDownloadFund(item.ksd_fund)}
                              />
                            </td>
                          )}
                          <td>
                            <button
                              className="text-link"
                              onClick={() => navigateEtf(item.ksd_fund)}
                            >
                              {item.etf_name}
                            </button>
                          </td>
                          <td className="score-cell">{item.change_score.toFixed(2)}</td>
                          <ExtremeCell change={item.max_quantity_increase} suffix="%" onAssetClick={navigateAsset} />
                          <ExtremeCell change={item.max_quantity_decrease} suffix="%" onAssetClick={navigateAsset} />
                          <ExtremeCell change={item.max_weight_increase} suffix="%p" onAssetClick={navigateAsset} />
                          <ExtremeCell change={item.max_weight_decrease} suffix="%p" onAssetClick={navigateAsset} />
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
                        <th>종목명</th>
                        <th>최근 수량</th>
                        <th>수량 변화</th>
                        <th>수량 변화율</th>
                        <th>최근 금액</th>
                        <th>금액 변화</th>
                        <th>금액 변화율</th>
                        <th>최근 비중</th>
                        <th>비중 변화</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pivotRows.map((item) => {
                        const startQuantity = detailStartDate ? item.quantities[detailStartDate] : null;
                        const endQuantity = detailEndDate ? item.quantities[detailEndDate] : null;
                        const quantityDelta = getDelta(startQuantity, endQuantity);
                        const quantityDeltaPct = getDeltaPct(startQuantity, endQuantity);
                        const startAmount = detailStartDate ? item.valuation_amounts[detailStartDate] : null;
                        const endAmount = detailEndDate ? item.valuation_amounts[detailEndDate] : null;
                        const amountDelta = getDelta(startAmount, endAmount);
                        const amountDeltaPct = getDeltaPct(startAmount, endAmount);
                        const endWeight = detailEndDate ? item.weights[detailEndDate] : null;

                        return (
                          <tr key={`${item.asset_code}-${item.asset_name}`}>
                            <td>
                              <button className="text-link" onClick={() => navigateAsset(item.asset_code)}>
                                {item.asset_name}
                              </button>
                            </td>
                            <td>{formatCompactNumber(endQuantity)}</td>
                            <td className={getDeltaClass(quantityDelta)}>{formatSignedCompactNumber(quantityDelta)}</td>
                            <td className={getDeltaClass(quantityDeltaPct)}>{formatSignedPercent(quantityDeltaPct)}</td>
                            <td>{formatKrw(endAmount)}</td>
                            <td className={getDeltaClass(amountDelta)}>{formatSignedKrw(amountDelta)}</td>
                            <td className={getDeltaClass(amountDeltaPct)}>{formatSignedPercent(amountDeltaPct)}</td>
                            <td>{formatPercent(endWeight)}</td>
                            <td className={getDeltaClass(item.weight_delta)}>{formatSignedPercentPoint(item.weight_delta)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                ) : (
                  <EmptyState title="선택 ETF의 구성종목 데이터가 없습니다" body="선택 ETF 최근 영업일 수집을 실행한 뒤 다시 확인하세요." />
                )
              ) : analysisMode === "cross" ? (
                crossDisplayRows.length ? (
                  <table className="pivot-grid cross-grid">
                    <thead>
                      <tr>
                        <th>종목명</th>
                        <th className="score-cell">변동점수</th>
                        <th>ETF수</th>
                        <th>수량 변화율</th>
                        <th>비중 변화율</th>
                        <th>최근 노출</th>
                      </tr>
                    </thead>
                    <tbody>
                      {crossDisplayRows.map((item) => {
                        const quantityDeltaPct = getDeltaPct(item.start_quantity, item.end_quantity);
                        const changeScore = getCrossChangeScore(item, crossScoreMaxes);

                        return (
                          <tr key={`${item.asset_code}-${item.asset_name}`}>
                            <td>
                              <button className="text-link" onClick={() => navigateAsset(item.asset_code)}>
                                {item.asset_name}
                              </button>
                            </td>
                            <td className="score-cell">{changeScore.toFixed(2)}</td>
                            <td>{item.latest_etf_count}</td>
                            <td className={getDeltaClass(quantityDeltaPct)}>{formatSignedPercentOrDash(quantityDeltaPct)}</td>
                            <td className={getDeltaClass(item.weight_delta)}>{formatSignedPercentPointOrDash(item.weight_delta)}</td>
                            <td><ExposureLinks exposures={item.latest_exposures} etfFundByName={etfFundByName} onEtfClick={navigateEtf} /></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                ) : (
                  <EmptyState title="종목 합산 분석 데이터가 없습니다" body="대표 ETF 수집 후 여러 ETF에 걸친 종목별 합산 비중 변화를 볼 수 있습니다." />
                )
              ) : selectedAsset ? (
                <table className="pivot-grid cross-grid">
                  <thead>
                    <tr>
                      <th>기준</th>
                      <th>최근 총 수량</th>
                      <th>수량 변화</th>
                      <th>수량 변화율</th>
                      <th>최근 총 금액</th>
                      <th>금액 변화</th>
                      <th>금액 변화율</th>
                      <th>합산 비중</th>
                      <th>합산 비중 변화</th>
                      <th>평균 비중</th>
                      <th>평균 비중 변화</th>
                      <th>최대 비중</th>
                      <th>최대 비중 변화</th>
                      <th>편입 ETF</th>
                      <th>최근 노출</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      const quantityDeltaPct = getDeltaPct(selectedAsset.start_quantity, selectedAsset.end_quantity);
                      const amountDeltaPct = getDeltaPct(selectedAsset.start_valuation_amount, selectedAsset.end_valuation_amount);
                      const avgWeight = getCrossAvgWeight(selectedAsset);
                      const avgWeightDelta = getCrossAvgWeightDelta(selectedAsset);
                      const maxWeight = getCrossMaxWeight(selectedAsset);
                      const maxWeightDelta = getCrossMaxWeightDelta(selectedAsset);

                      return (
                        <tr>
                          <td>{selectedAsset.asset_name}</td>
                          <td>{formatCompactNumber(selectedAsset.end_quantity)}</td>
                          <td className={getDeltaClass(selectedAsset.quantity_delta)}>{formatSignedCompactNumber(selectedAsset.quantity_delta)}</td>
                          <td className={getDeltaClass(quantityDeltaPct)}>{formatSignedPercent(quantityDeltaPct)}</td>
                          <td>{formatKrw(selectedAsset.end_valuation_amount)}</td>
                          <td className={getDeltaClass(selectedAsset.valuation_amount_delta)}>{formatSignedKrw(selectedAsset.valuation_amount_delta)}</td>
                          <td className={getDeltaClass(amountDeltaPct)}>{formatSignedPercent(amountDeltaPct)}</td>
                          <td>{formatPercent(selectedAsset.end_weight)}</td>
                          <td className={getDeltaClass(selectedAsset.weight_delta)}>{formatSignedPercentPoint(selectedAsset.weight_delta)}</td>
                          <td>{formatPercent(avgWeight)}</td>
                          <td className={getDeltaClass(avgWeightDelta)}>{formatSignedPercentPoint(avgWeightDelta)}</td>
                          <td>{formatPercent(maxWeight)}</td>
                          <td className={getDeltaClass(maxWeightDelta)}>{formatSignedPercentPoint(maxWeightDelta)}</td>
                          <td>{selectedAsset.latest_etf_count}</td>
                          <td><ExposureLinks exposures={selectedAsset.latest_exposures} etfFundByName={etfFundByName} onEtfClick={navigateEtf} /></td>
                        </tr>
                      );
                    })()}
                  </tbody>
                </table>
              ) : (
                <EmptyState title="선택한 종목 데이터를 찾을 수 없습니다" body="종목별 화면에서 종목명을 다시 선택하거나 분석 기간을 조정하세요." />
              )}
            </div>
          </section>

          <section className="chart-panel canvas-section">
            <div className="section-heading">
              <h2>차트</h2>
              {analysisMode === "list" ? (
                <select value={etfChartMetric} onChange={(event) => setEtfChartMetric(event.target.value as EtfChartMetric)}>
                  <option value="change_score">종합점수</option>
                  <option value="quantity">수량 변화</option>
                  <option value="valuation">금액</option>
                  <option value="weight">ETF 내 비중</option>
                </select>
              ) : analysisMode === "single" ? (
                <select value={detailChartMetric} onChange={(event) => setDetailChartMetric(event.target.value as DetailChartMetric)}>
                  <optgroup label="주식 수량 기준">
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
              ) : analysisMode === "cross" ? (
                <select value={crossChartMetric} onChange={(event) => setCrossChartMetric(event.target.value as CrossChartMetric)}>
                  <option value="change_score">변동점수</option>
                  <option value="quantity_delta_ratio">수량 변화율</option>
                  <option value="valuation_delta_ratio">금액 변화율</option>
                  <option value="weight_delta">합산 비중 변화</option>
                </select>
              ) : (
                <select value={assetChartMetric} onChange={(event) => setAssetChartMetric(event.target.value as AssetChartMetric)}>
                  <optgroup label="수량 기준">
                    <option value="quantity">총 수량</option>
                    <option value="quantity_delta">수량 변화량</option>
                    <option value="quantity_delta_ratio">수량 변화율</option>
                  </optgroup>
                  <optgroup label="금액 기준">
                    <option value="valuation_amount">총 금액</option>
                    <option value="valuation_delta">금액 변화량</option>
                    <option value="valuation_delta_ratio">금액 변화율</option>
                  </optgroup>
                  <optgroup label="ETF 내 비중 기준">
                    <option value="avg_weight">평균 비중</option>
                    <option value="avg_weight_delta">평균 비중 변화량</option>
                    <option value="max_weight">최대 비중</option>
                    <option value="max_weight_delta">최대 비중 변화량</option>
                  </optgroup>
                </select>
              )}
            </div>
            {isCurrentChartLoading ? (
              <LoadingState title="차트 데이터를 준비하는 중입니다" body={getLoadingMessage(analysisMode)} />
            ) : hasChartData ? (
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
            <button className="suggestion" onClick={() => submitChat("최근 5영업일간 비중 변화 큰 종목 찾아줘")}>
              최근 5영업일간 비중 변화 큰 종목 찾아줘
            </button>
            <div className="insight-strip">
              <div>
                <span>분석 범위</span>
                <strong>{periodLabel}</strong>
              </div>
              <div>
                <span>랭킹 ETF</span>
                <strong>{summaryRows.length}</strong>
              </div>
              <div>
                <span>현재 모드</span>
                <strong>{analysisMode === "list" ? "ETF별" : analysisMode === "single" ? "단일 ETF" : analysisMode === "asset" ? "종목 상세" : "종목별"}</strong>
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

function getDelta(startValue: number | null | undefined, endValue: number | null | undefined) {
  if (startValue === null || startValue === undefined || endValue === null || endValue === undefined) return null;
  return endValue - startValue;
}

function getDeltaPct(startValue: number | null | undefined, endValue: number | null | undefined) {
  if (startValue === null || startValue === undefined || endValue === null || endValue === undefined || startValue === 0) return null;
  return ((endValue - startValue) / Math.abs(startValue)) * 100;
}

function getDeltaClass(value: number | null | undefined) {
  if (value === null || value === undefined || value === 0) return "";
  return value > 0 ? "positive" : "negative";
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

function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";
  return `${value.toFixed(2)}%`;
}

function formatSignedPercent(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";
  if (value === 0) return "0.00%";
  return `${value > 0 ? "+" : "-"}${Math.abs(value).toFixed(2)}%`;
}

function formatSignedPercentOrDash(value: number | null | undefined) {
  if (value === null || value === undefined || value === 0) return "-";
  return formatSignedPercent(value);
}

function formatSignedPercentPoint(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";
  if (value === 0) return "0.00%p";
  return `${value > 0 ? "+" : "-"}${Math.abs(value).toFixed(2)}%p`;
}

function formatSignedPercentPointOrDash(value: number | null | undefined) {
  if (value === null || value === undefined || value === 0) return "-";
  return formatSignedPercentPoint(value);
}

function formatExtremeValue(value: number, suffix: string) {
  return `${value.toFixed(2)}${suffix}`;
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

function getCrossAvgWeight(row: CrossEtfRow | undefined) {
  if (!row) return 0;
  return row.end_avg_weight ?? (row.latest_etf_count ? row.end_weight / row.latest_etf_count : 0);
}

function getCrossAvgWeightDelta(row: CrossEtfRow | undefined) {
  if (!row) return 0;
  return row.avg_weight_delta ?? (row.latest_etf_count ? row.weight_delta / row.latest_etf_count : 0);
}

function getCrossMaxWeight(row: CrossEtfRow | undefined) {
  if (!row) return 0;
  return row.end_max_weight ?? row.latest_exposures[0]?.weight ?? row.end_weight;
}

function getCrossMaxWeightDelta(row: CrossEtfRow | undefined) {
  if (!row) return 0;
  return row.max_weight_delta ?? row.weight_delta;
}

function getCrossChartRows(rows: CrossEtfRow[], metricKey: CrossChartMetric, scoreRows: CrossEtfRow[]) {
  if (metricKey === "change_score") return scoreRows;
  const metric = getCrossChartMetric(metricKey);
  const isQuantityMetric = metricKey === "quantity" || metricKey === "quantity_delta" || metricKey === "quantity_delta_ratio";
  const isRatioMetric = metricKey === "quantity_delta_ratio" || metricKey === "valuation_delta_ratio";
  const sourceRows = isQuantityMetric ? rows.filter((item) => !isCashLikeHolding(item.asset_code, item.asset_name)) : rows;
  const filteredRows = isRatioMetric ? sourceRows.filter((item) => !isCompleteExitForRatio(item, metricKey)) : sourceRows;
  const displayRows = filteredRows.length ? filteredRows : sourceRows;
  return displayRows.slice().sort((a, b) => Math.abs(metric.value(b)) - Math.abs(metric.value(a)));
}

function filterCrossRowsByAssetType(rows: CrossEtfRow[], filter: AssetTypeFilter) {
  if (filter === "all") return rows;
  return rows.filter((item) => getAssetType(item) === filter);
}

function getAssetType(row: CrossEtfRow): AssetTypeFilter {
  if (row.asset_type && row.asset_type !== "all") return row.asset_type;

  const code = row.asset_code?.toUpperCase() ?? "";
  const name = row.asset_name ?? "";
  const upperName = name.toUpperCase();
  if (isCashLikeHolding(code, name)) return "cash";
  if (isListedProductHolding(code, upperName)) return "listed_product";
  if (
    code.startsWith("KR4") ||
    ["FUTURE", "FUTURES", "E-MINI", "선물", "SWAP", "스왑"].some((token) => upperName.includes(token)) ||
    /\b[CP]\s+\d{6}\b/.test(upperName)
  ) {
    return "derivative";
  }
  if (
    code === "-" ||
    code.startsWith("KR3") ||
    ["채권", "통안", "기업어음", "전자단기사채", "(단)"].some((token) => name.includes(token)) ||
    (name.includes("제") && name.includes("차") && /\d/.test(name))
  ) {
    return "fixed_income";
  }
  return "stock";
}

function isListedProductHolding(assetCode: string, upperAssetName: string) {
  const listedProductCodes = new Set(["DIA US EQUITY", "IVV US EQUITY", "IWM US EQUITY", "QQQ US EQUITY", "SPY US EQUITY", "VOO US EQUITY"]);
  if (listedProductCodes.has(assetCode)) return true;
  return [" ETF", " ETF ", " ETF TRUST", "ISHARES ", "SPDR ", "VANGUARD ", "INVESCO QQQ TRUST"].some((token) => upperAssetName.includes(token));
}

function getCrossScoreMaxes(rows: CrossEtfRow[]) {
  return rows.reduce(
    (maxes, row) => {
      const quantityDeltaPct = getDeltaPct(row.start_quantity, row.end_quantity) ?? 0;
      return {
        quantityDeltaPct: Math.max(maxes.quantityDeltaPct, Math.abs(quantityDeltaPct)),
        weightDelta: Math.max(maxes.weightDelta, Math.abs(row.weight_delta)),
      };
    },
    { quantityDeltaPct: 0, weightDelta: 0 },
  );
}

function filterSummaryRowsByEtfType(rows: EtfChangeSummaryRow[], filter: EtfTypeFilter) {
  if (filter === "all") return rows;
  return rows.filter((item) => getEtfType(item) === filter);
}

function getEtfType(row: EtfChangeSummaryRow): EtfTypeFilter {
  if (row.etf_type && row.etf_type !== "all") return row.etf_type;
  const name = row.etf_name.toUpperCase();
  if (["커버드콜", "COVERED", "인컴", "배당"].some((token) => name.includes(token))) return "income";
  if (["레버리지", "인버스", "2X", "합성"].some((token) => name.includes(token))) return "leveraged_inverse";
  if (["머니마켓", "MMF", "CD금리", "CD1년", "KOFR", "단기채권", "금리"].some((token) => name.includes(token))) return "money_market";
  if (name.includes("채권")) return "fixed_income";
  return "equity";
}

function getCrossChangeScore(row: CrossEtfRow, maxes: { quantityDeltaPct: number; weightDelta: number }) {
  const quantityDeltaPct = Math.abs(getDeltaPct(row.start_quantity, row.end_quantity) ?? 0);
  const weightDelta = Math.abs(row.weight_delta);
  let score = 0;
  let weightSum = 0;
  if (maxes.quantityDeltaPct) {
    score += (quantityDeltaPct / maxes.quantityDeltaPct) * 0.6;
    weightSum += 0.6;
  }
  if (maxes.weightDelta) {
    score += (weightDelta / maxes.weightDelta) * 0.4;
    weightSum += 0.4;
  }
  return weightSum ? (score / weightSum) * 100 : 0;
}

function isCompleteExitForRatio(row: CrossEtfRow, metricKey: CrossChartMetric) {
  if (metricKey === "quantity_delta_ratio") {
    return Boolean(row.start_quantity) && !row.end_quantity;
  }
  if (metricKey === "valuation_delta_ratio") {
    return Boolean(row.start_valuation_amount) && !row.end_valuation_amount;
  }
  return false;
}

function isCashLikeHolding(assetCode: string | null | undefined, assetName: string | null | undefined) {
  const code = (assetCode ?? "").toUpperCase();
  const name = assetName ?? "";
  return code.startsWith("KRD") || /원화예금|예금|현금|CASH/i.test(name);
}

function getAnalysisPeriodQuery(periodMode: PeriodMode, periodDays: number, customStartDate: string, customEndDate: string) {
  const params = new URLSearchParams();
  if (periodMode === "custom" && customStartDate) {
    params.set("start_date", customStartDate);
  }
  if (periodMode === "custom" && customEndDate) {
    params.set("end_date", customEndDate);
  }
  if (!params.has("start_date") && !params.has("end_date")) {
    params.set("days", String(periodDays));
  }
  return params.toString();
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
  if (metric === "quantity") {
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

  if (metric === "valuation") {
    return {
      axisName: "금액 변화율",
      axisFormatter: "{value}%",
      colors: (theme: "light" | "dark") => theme === "dark" ? ["#f87171", "#60a5fa"] : ["#dc2626", "#2563eb"],
      format: (value: number) => `${Number(value).toFixed(2)}%`,
      series: (rows: EtfChangeSummaryRow[]) => [
        {
          name: "최대 금액 증가율",
          type: "bar",
          data: rows.map((item) => item.max_valuation_pct_increase?.value ?? 0),
        },
        {
          name: "최대 금액 감소율",
          type: "bar",
          data: rows.map((item) => item.max_valuation_pct_decrease?.value ?? 0),
        },
      ],
    };
  }

  if (metric === "weight") {
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

function getCrossChartMetric(metric: CrossChartMetric, scoreMaxes: { quantityDeltaPct: number; weightDelta: number } = { quantityDeltaPct: 0, weightDelta: 0 }) {
  const deltaColors = (theme: "light" | "dark") => theme === "dark" ? ["#f87171", "#60a5fa"] : ["#dc2626", "#2563eb"];
  const valueColors = (theme: "light" | "dark") => [theme === "dark" ? "#f87171" : "#dc2626"];
  const ratio = (start: number, end: number) => start ? ((end - start) / Math.abs(start)) * 100 : 0;

  if (metric === "change_score") {
    return {
      label: "변동점수",
      axisName: "변동점수",
      axisFormatter: "{value}",
      colors: valueColors,
      format: (value: number) => `${Number(value).toFixed(2)}`,
      value: (row: CrossEtfRow) => getCrossChangeScore(row, scoreMaxes),
    };
  }

  if (metric === "weight_delta") {
    return {
      label: "합산 비중 변화",
      axisName: "합산 비중 변화",
      axisFormatter: "{value}%p",
      colors: deltaColors,
      format: (value: number) => formatSignedPercentPoint(value),
      value: (row: CrossEtfRow) => row.weight_delta,
    };
  }

  if (metric === "quantity") {
    return {
      label: "총 수량",
      axisName: "총 수량",
      axisFormatter: (value: number) => formatCompactNumber(value),
      colors: valueColors,
      format: (value: number) => formatCompactNumber(value),
      value: (row: CrossEtfRow) => row.end_quantity,
    };
  }

  if (metric === "quantity_delta") {
    return {
      label: "수량 변화량",
      axisName: "수량 변화",
      axisFormatter: (value: number) => formatCompactNumber(value),
      colors: deltaColors,
      format: (value: number) => formatSignedCompactNumber(value),
      value: (row: CrossEtfRow) => row.quantity_delta,
    };
  }

  if (metric === "quantity_delta_ratio") {
    return {
      label: "수량 변화율",
      axisName: "수량 변화율",
      axisFormatter: "{value}%",
      colors: deltaColors,
      format: (value: number) => formatSignedPercent(value),
      value: (row: CrossEtfRow) => ratio(row.start_quantity, row.end_quantity),
    };
  }

  if (metric === "valuation_amount") {
    return {
      label: "총 금액",
      axisName: "총 금액",
      axisFormatter: (value: number) => formatKrw(value),
      colors: valueColors,
      format: (value: number) => formatKrw(value),
      value: (row: CrossEtfRow) => row.end_valuation_amount,
    };
  }

  if (metric === "valuation_delta") {
    return {
      label: "금액 변화량",
      axisName: "금액 변화",
      axisFormatter: (value: number) => formatKrw(value),
      colors: deltaColors,
      format: (value: number) => formatSignedKrw(value),
      value: (row: CrossEtfRow) => row.valuation_amount_delta,
    };
  }

  if (metric === "valuation_delta_ratio") {
    return {
      label: "금액 변화율",
      axisName: "금액 변화율",
      axisFormatter: "{value}%",
      colors: deltaColors,
      format: (value: number) => formatSignedPercent(value),
      value: (row: CrossEtfRow) => ratio(row.start_valuation_amount, row.end_valuation_amount),
    };
  }

  if (metric === "avg_weight") {
    return {
      label: "평균 비중",
      axisName: "평균 비중",
      axisFormatter: "{value}%",
      colors: valueColors,
      format: (value: number) => formatPercent(value),
      value: getCrossAvgWeight,
    };
  }

  if (metric === "avg_weight_delta") {
    return {
      label: "평균 비중 변화량",
      axisName: "평균 비중 변화",
      axisFormatter: "{value}%p",
      colors: deltaColors,
      format: (value: number) => formatSignedPercentPoint(value),
      value: getCrossAvgWeightDelta,
    };
  }

  if (metric === "max_weight") {
    return {
      label: "최대 비중",
      axisName: "최대 비중",
      axisFormatter: "{value}%",
      colors: valueColors,
      format: (value: number) => formatPercent(value),
      value: getCrossMaxWeight,
    };
  }

  return {
    label: "최대 비중 변화량",
    axisName: "최대 비중 변화",
    axisFormatter: "{value}%p",
    colors: deltaColors,
    format: (value: number) => formatSignedPercentPoint(value),
    value: getCrossMaxWeightDelta,
  };
}

function getListDownloadDetailMetric(metric: EtfChartMetric): DetailChartMetric {
  if (metric === "quantity") return "quantity_delta_ratio";
  if (metric === "valuation") return "valuation_delta_ratio";
  return "weight_delta";
}

function getAssetChartMetric(metric: AssetChartMetric) {
  const valueColors = (theme: "light" | "dark") => [theme === "dark" ? "#f87171" : "#dc2626"];
  const deltaColors = (theme: "light" | "dark") => [theme === "dark" ? "#63a7ff" : "#2563eb"];
  const ratio = (start: number, current: number) => start ? ((current - start) / Math.abs(start)) * 100 : 0;
  const valueAt = (values: Record<string, number> | undefined, date: string) => values?.[date] ?? 0;

  if (metric === "quantity") {
    return {
      label: "총 수량",
      axisName: "총 수량",
      axisFormatter: (value: number) => formatCompactNumber(value),
      colors: valueColors,
      format: (value: number) => formatCompactNumber(value),
      allowNegative: false,
      value: (row: CrossEtfRow | undefined, date: string) => valueAt(row?.quantities, date),
    };
  }
  if (metric === "quantity_delta") {
    return {
      label: "수량 변화량",
      axisName: "수량 변화",
      axisFormatter: (value: number) => formatCompactNumber(value),
      colors: deltaColors,
      format: (value: number) => formatSignedCompactNumber(value),
      allowNegative: true,
      value: (row: CrossEtfRow | undefined, date: string, startDate: string) => valueAt(row?.quantities, date) - valueAt(row?.quantities, startDate),
    };
  }
  if (metric === "quantity_delta_ratio") {
    return {
      label: "수량 변화율",
      axisName: "수량 변화율",
      axisFormatter: "{value}%",
      colors: deltaColors,
      format: (value: number) => formatSignedPercent(value),
      allowNegative: true,
      value: (row: CrossEtfRow | undefined, date: string, startDate: string) => ratio(valueAt(row?.quantities, startDate), valueAt(row?.quantities, date)),
    };
  }
  if (metric === "valuation_amount") {
    return {
      label: "총 금액",
      axisName: "총 금액",
      axisFormatter: (value: number) => formatKrw(value),
      colors: valueColors,
      format: (value: number) => formatKrw(value),
      allowNegative: false,
      value: (row: CrossEtfRow | undefined, date: string) => valueAt(row?.valuation_amounts, date),
    };
  }
  if (metric === "valuation_delta") {
    return {
      label: "금액 변화량",
      axisName: "금액 변화",
      axisFormatter: (value: number) => formatKrw(value),
      colors: deltaColors,
      format: (value: number) => formatSignedKrw(value),
      allowNegative: true,
      value: (row: CrossEtfRow | undefined, date: string, startDate: string) =>
        valueAt(row?.valuation_amounts, date) - valueAt(row?.valuation_amounts, startDate),
    };
  }
  if (metric === "valuation_delta_ratio") {
    return {
      label: "금액 변화율",
      axisName: "금액 변화율",
      axisFormatter: "{value}%",
      colors: deltaColors,
      format: (value: number) => formatSignedPercent(value),
      allowNegative: true,
      value: (row: CrossEtfRow | undefined, date: string, startDate: string) =>
        ratio(valueAt(row?.valuation_amounts, startDate), valueAt(row?.valuation_amounts, date)),
    };
  }
  if (metric === "avg_weight") {
    return {
      label: "평균 비중",
      axisName: "평균 비중",
      axisFormatter: "{value}%",
      colors: valueColors,
      format: (value: number) => formatPercent(value),
      allowNegative: false,
      value: (row: CrossEtfRow | undefined, date: string) => valueAt(row?.avg_weights, date) || (valueAt(row?.weights, date) / (valueAt(row?.etf_counts, date) || 1)),
    };
  }
  if (metric === "avg_weight_delta") {
    return {
      label: "평균 비중 변화량",
      axisName: "평균 비중 변화",
      axisFormatter: "{value}%p",
      colors: deltaColors,
      format: (value: number) => formatSignedPercentPoint(value),
      allowNegative: true,
      value: (row: CrossEtfRow | undefined, date: string, startDate: string) =>
        (valueAt(row?.avg_weights, date) || (valueAt(row?.weights, date) / (valueAt(row?.etf_counts, date) || 1))) -
        (valueAt(row?.avg_weights, startDate) || (valueAt(row?.weights, startDate) / (valueAt(row?.etf_counts, startDate) || 1))),
    };
  }
  if (metric === "max_weight") {
    return {
      label: "최대 비중",
      axisName: "최대 비중",
      axisFormatter: "{value}%",
      colors: valueColors,
      format: (value: number) => formatPercent(value),
      allowNegative: false,
      value: (row: CrossEtfRow | undefined, date: string) => valueAt(row?.max_weights, date),
    };
  }
  return {
    label: "최대 비중 변화량",
    axisName: "최대 비중 변화",
    axisFormatter: "{value}%p",
    colors: deltaColors,
    format: (value: number) => formatSignedPercentPoint(value),
    allowNegative: true,
    value: (row: CrossEtfRow | undefined, date: string, startDate: string) => valueAt(row?.max_weights, date) - valueAt(row?.max_weights, startDate),
  };
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function parseRoute(): { mode: AnalysisMode; ksdFund?: string; assetCode?: string } {
  const hash = window.location.hash.replace(/^#/, "");
  const etfMatch = hash.match(/^\/etf\/([^/]+)$/);
  if (etfMatch) {
    return { mode: "single", ksdFund: decodeURIComponent(etfMatch[1]) };
  }
  const assetMatch = hash.match(/^\/asset\/([^/]+)$/);
  if (assetMatch) {
    return { mode: "asset", assetCode: decodeURIComponent(assetMatch[1]) };
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

function navigateAsset(assetCode: string) {
  const nextHash = `#/asset/${encodeURIComponent(assetCode)}`;
  if (window.location.hash === nextHash) {
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    return;
  }
  window.location.hash = nextHash;
}

function currentViewTitle(mode: AnalysisMode, selectedEtfName: string, selectedAssetName?: string) {
  if (mode === "list") return "ETF 변동 목록";
  if (mode === "cross") return "종목별 변동 목록";
  if (mode === "asset") return selectedAssetName ?? "종목 상세";
  return selectedEtfName;
}

function getLoadingMessage(mode: AnalysisMode) {
  if (mode === "single") return "국내 영업일 기준 누락 데이터를 확인하고 있습니다.";
  if (mode === "cross" || mode === "asset") return "종목별 합산 분석 데이터를 불러오고 있습니다.";
  return "ETF별 변동 요약 데이터를 불러오고 있습니다.";
}

async function exportDetailWorkbook({
  detailChartMetric,
  etfName,
  ksdFund,
  periodLabel,
  rows,
  dates,
}: {
  detailChartMetric: DetailChartMetric;
  etfName: string;
  ksdFund: string;
  periodLabel: string;
  rows: PivotRow[];
  dates: string[];
}) {
  const ExcelJS = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "ETF Portfolio Profiler";
  workbook.created = new Date();

  const chartRows = buildDetailChartExportRows(rows, dates, detailChartMetric);
  const chartSheet = workbook.addWorksheet("차트");
  chartSheet.addRow([etfName]);
  chartSheet.addRow([`기간: ${periodLabel}`, `차트: ${getDetailChartLabel(detailChartMetric)}`, `ETF: ${ksdFund}`]);

  const dataStartRow = 25;
  addRowsWithHeader(chartSheet, dataStartRow, ["종목명", ...dates], chartRows.map((item) => [item.asset_name, ...dates.map((date) => item.values[date] ?? 0)]));

  const summarySheet = workbook.addWorksheet("요약 표");
  const summaryRows = buildDetailSummaryExportRows(rows, dates);
  addRowsWithHeader(summarySheet, 1, Object.keys(summaryRows[0] ?? {}), summaryRows.map((item) => Object.values(item)));

  [...dates].reverse().forEach((date) => {
    const dailySheet = workbook.addWorksheet(sanitizeSheetName(date));
    addRowsWithHeader(
      dailySheet,
      1,
      ["종목명", "수량", "평가금액", "비중"],
      rows.map((item) => [
        item.asset_name,
        item.quantities[date] ?? null,
        item.valuation_amounts[date] ?? null,
        item.weights[date] ?? null,
      ]),
    );
  });

  workbook.eachSheet((sheet) => {
    sheet.columns.forEach((column) => {
      column.width = 16;
    });
    sheet.getColumn(1).width = 30;
  });

  const workbookBuffer = await workbook.xlsx.writeBuffer();
  const buffer = await addNativeChartToWorkbook(workbookBuffer, {
    chartTitle: `${etfName} ${getDetailChartLabel(detailChartMetric)}`,
    dates,
    metric: detailChartMetric,
    seriesCount: chartRows.length,
    seriesNames: chartRows.map((r) => r.asset_name),
    dataStartRow,
  });
  const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${sanitizeFileName(etfName)}_${periodLabel}_상세.xlsx`;
  link.click();
  URL.revokeObjectURL(url);
}

async function addNativeChartToWorkbook(
  workbookBuffer: ArrayBuffer,
  {
    chartTitle,
    dates,
    metric,
    seriesCount,
    seriesNames,
    dataStartRow,
  }: {
    chartTitle: string;
    dates: string[];
    metric: DetailChartMetric;
    seriesCount: number;
    seriesNames: string[];
    dataStartRow: number;
  },
) {
  if (!dates.length || !seriesCount) return workbookBuffer;

  const zip = await JSZip.loadAsync(workbookBuffer);
  const sheetPath = "xl/worksheets/sheet1.xml";
  const sheetRelsPath = "xl/worksheets/_rels/sheet1.xml.rels";
  const drawingPath = "xl/drawings/drawing1.xml";
  const drawingRelsPath = "xl/drawings/_rels/drawing1.xml.rels";
  const chartPath = "xl/charts/chart1.xml";

  const sheetXml = await zip.file(sheetPath)?.async("string");
  if (!sheetXml) return workbookBuffer;

  zip.file(sheetPath, addWorksheetDrawing(sheetXml, "rIdChartDrawing1"));

  // 기존 sheet1.xml.rels에 drawing 관계를 추가 (완전 덮어쓰기 금지)
  const existingSheetRels = await zip.file(sheetRelsPath)?.async("string");
  zip.file(sheetRelsPath, mergeWorksheetRels(existingSheetRels));

  zip.file(drawingPath, buildDrawingXml());
  zip.file(drawingRelsPath, buildDrawingRelsXml());
  zip.file(chartPath, buildChartXml({ chartTitle, dates, metric, seriesCount, dataStartRow, seriesNames }));
  await upsertContentTypes(zip);

  return zip.generateAsync({ type: "arraybuffer" });
}

function addWorksheetDrawing(sheetXml: string, relationshipId: string) {
  const drawingTag = `<drawing r:id="${relationshipId}"/>`;
  const xmlWithNamespace = sheetXml.includes("xmlns:r=")
    ? sheetXml
    : sheetXml.replace("<worksheet ", '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ');
  // 이미 drawing 태그가 있으면 그대로 반환
  if (xmlWithNamespace.includes("<drawing ") || xmlWithNamespace.includes("<drawing r:")) return xmlWithNamespace;
  // OOXML 스키마: drawing은 pageMargins/pageSetup 등 인쇄 설정 뒤, </worksheet> 바로 앞에 와야 함
  return xmlWithNamespace.replace("</worksheet>", `${drawingTag}</worksheet>`);
}

function mergeWorksheetRels(existingXml: string | undefined) {
  const drawingRel = `<Relationship Id="rIdChartDrawing1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>`;

  if (!existingXml) {
    // sheet1.xml.rels 자체가 없는 경우 새로 생성
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${drawingRel}</Relationships>`;
  }

  // 이미 drawing 관계가 있으면 그대로 반환
  if (existingXml.includes('relationships/drawing')) return existingXml;

  // 기존 내용에 drawing 관계를 추가
  return existingXml.replace('</Relationships>', `${drawingRel}</Relationships>`);
}

function buildDrawingXml() {
  // xmlns:r을 루트에 선언해야 c:chart의 r:id가 올바르게 파싱됨
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><xdr:twoCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>3</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>12</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>23</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="ETF detail chart"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rIdChart1"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>`;
}

function buildDrawingRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdChart1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/></Relationships>`;
}

function buildChartXml({
  chartTitle,
  dates,
  metric,
  seriesCount,
  dataStartRow,
  seriesNames,
}: {
  chartTitle: string;
  dates: string[];
  metric: DetailChartMetric;
  seriesCount: number;
  dataStartRow: number;
  seriesNames: string[];
}) {
  const seriesXml = Array.from({ length: seriesCount }, (_, index) =>
    buildChartSeriesXml(index, dates, dataStartRow, seriesNames[index] ?? `Series${index + 1}`)
  ).join("");
  const axisFormat = metric === "valuation_amount" || metric === "valuation_delta" || metric === "quantity" || metric === "quantity_delta" ? "#,##0" : "0.00";

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:date1904 val="0"/><c:lang val="ko-KR"/><c:roundedCorners val="0"/><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="ko-KR" sz="1200"/><a:t>${escapeXml(chartTitle)}</a:t></a:r></a:p></c:rich></c:tx><c:layout/></c:title><c:autoTitleDeleted val="0"/><c:plotArea><c:layout/><c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${seriesXml}<c:axId val="10"/><c:axId val="20"/></c:lineChart><c:catAx><c:axId val="10"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="20"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/></c:catAx><c:valAx><c:axId val="20"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines/><c:numFmt formatCode="${axisFormat}" sourceLinked="0"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="10"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx></c:plotArea><c:legend><c:legendPos val="r"/><c:layout/></c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/><c:showDLblsOverMax val="0"/></c:chart><c:printSettings><c:headerFooter/><c:pageMargins b="0.75" l="0.7" r="0.7" t="0.75" header="0.3" footer="0.3"/><c:pageSetup/></c:printSettings></c:chartSpace>`;
}

function buildChartSeriesXml(index: number, dates: string[], dataStartRow: number, seriesName: string) {
  const rowNumber = dataStartRow + index + 1;
  const endColumn = getExcelColumnName(dates.length + 1);
  const valuesRef = `'차트'!$B$${rowNumber}:$${endColumn}$${rowNumber}`;
  const categoriesRef = `'차트'!$B$${dataStartRow}:$${endColumn}$${dataStartRow}`;

  // 카테고리(날짜) 캐시: sharedString 참조 없이 직접 값을 넣어야 Excel이 정확히 렌더링함
  const strCacheXml = `<c:strCache><c:ptCount val="${dates.length}"/>${dates.map((d, i) => `<c:pt idx="${i}"><c:v>${escapeXml(d)}</c:v></c:pt>`).join("")}</c:strCache>`;
  // 시리즈 이름 캐시
  const txCacheXml = `<c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${escapeXml(seriesName)}</c:v></c:pt></c:strCache>`;

  return `<c:ser><c:idx val="${index}"/><c:order val="${index}"/><c:tx><c:strRef><c:f>'차트'!$A$${rowNumber}</c:f>${txCacheXml}</c:strRef></c:tx><c:marker><c:symbol val="circle"/><c:size val="5"/></c:marker><c:cat><c:strRef><c:f>${categoriesRef}</c:f>${strCacheXml}</c:strRef></c:cat><c:val><c:numRef><c:f>${valuesRef}</c:f></c:numRef></c:val><c:smooth val="0"/></c:ser>`;
}

async function upsertContentTypes(zip: JSZip) {
  const path = "[Content_Types].xml";
  const file = zip.file(path);
  if (!file) return;
  let nextContent = await file.async("string");

  // chart ContentType
  if (!nextContent.includes('PartName="/xl/charts/chart1.xml"')) {
    nextContent = nextContent.replace("</Types>", '<Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>');
  }
  // drawing ContentType
  if (!nextContent.includes('PartName="/xl/drawings/drawing1.xml"')) {
    nextContent = nextContent.replace("</Types>", '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>');
  }
  // .rels 확장자 Default ContentType (없으면 추가)
  if (!nextContent.includes('Extension="rels"')) {
    nextContent = nextContent.replace("</Types>", '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>');
  }
  // .xml 확장자 Default ContentType (없으면 추가)
  if (!nextContent.includes('Extension="xml"')) {
    nextContent = nextContent.replace("</Types>", '<Default Extension="xml" ContentType="application/xml"/></Types>');
  }
  zip.file(path, nextContent);
}

function getExcelColumnName(columnNumber: number) {
  let name = "";
  let value = columnNumber;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function escapeXml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function addRowsWithHeader(sheet: Worksheet, startRow: number, headers: string[], rows: CellValue[][]) {
  const headerRow = sheet.getRow(startRow);
  headerRow.values = headers;
  headerRow.font = { bold: true };
  headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EEF7" } };

  rows.forEach((row, index) => {
    sheet.getRow(startRow + index + 1).values = row;
  });
}

function buildDetailChartExportRows(rows: PivotRow[], dates: string[], metric: DetailChartMetric) {
  const isQuantityMetric = metric === "quantity" || metric === "quantity_delta" || metric === "quantity_delta_ratio";
  const sourceRows = isQuantityMetric ? rows.filter((item) => !isCashLikeHolding(item.asset_code, item.asset_name)) : rows;
  const visibleRows = sourceRows.slice(0, 8);
  const valuationTotals = Object.fromEntries(
    dates.map((date) => [date, sourceRows.reduce((sum, item) => sum + (item.valuation_amounts[date] ?? 0), 0)]),
  ) as Record<string, number>;
  const chartRows = visibleRows.map((item) => ({
    asset_name: item.asset_name,
    values: Object.fromEntries(
      dates.map((date) => [date, getDetailMetricValue(item, date, dates[0], valuationTotals[date] ?? 0, metric)]),
    ) as Record<string, number>,
  }));

  if (metric !== "valuation_weight" || !chartRows.length) return chartRows;

  return [
    ...chartRows,
    {
      asset_name: "기타",
      values: Object.fromEntries(
        dates.map((date) => {
          const visibleSum = chartRows.reduce((sum, item) => sum + (item.values[date] ?? 0), 0);
          return [date, Math.max(0, 100 - visibleSum)];
        }),
      ) as Record<string, number>,
    },
  ];
}

function getDetailMetricValue(item: PivotRow, date: string, startDate: string, valuationTotal: number, metric: DetailChartMetric) {
  if (metric === "quantity") return item.quantities[date] ?? 0;
  if (metric === "quantity_delta") return (item.quantities[date] ?? 0) - (item.quantities[startDate] ?? 0);
  if (metric === "quantity_delta_ratio") {
    const startValue = item.quantities[startDate] ?? 0;
    return startValue ? (((item.quantities[date] ?? 0) - startValue) / Math.abs(startValue)) * 100 : 0;
  }
  if (metric === "valuation_amount") return item.valuation_amounts[date] ?? 0;
  if (metric === "valuation_delta") return (item.valuation_amounts[date] ?? 0) - (item.valuation_amounts[startDate] ?? 0);
  if (metric === "valuation_delta_ratio") {
    const startValue = item.valuation_amounts[startDate] ?? 0;
    return startValue ? (((item.valuation_amounts[date] ?? 0) - startValue) / Math.abs(startValue)) * 100 : 0;
  }
  if (metric === "weight_delta") return (item.weights[date] ?? 0) - (item.weights[startDate] ?? 0);
  return valuationTotal ? ((item.valuation_amounts[date] ?? 0) / valuationTotal) * 100 : 0;
}

function buildDetailSummaryExportRows(rows: PivotRow[], dates: string[]) {
  const startDate = dates[0];
  const endDate = dates[dates.length - 1];
  return rows.map((item) => {
    const startQuantity = item.quantities[startDate] ?? null;
    const endQuantity = item.quantities[endDate] ?? null;
    const startAmount = item.valuation_amounts[startDate] ?? null;
    const endAmount = item.valuation_amounts[endDate] ?? null;
    return {
      종목명: item.asset_name,
      최근수량: endQuantity,
      수량변화: getDelta(startQuantity, endQuantity),
      수량변화율: getDeltaPct(startQuantity, endQuantity),
      최근금액: endAmount,
      금액변화: getDelta(startAmount, endAmount),
      금액변화율: getDeltaPct(startAmount, endAmount),
      최근비중: item.weights[endDate] ?? null,
      비중변화: item.weight_delta,
    };
  });
}

function getDetailChartLabel(metric: DetailChartMetric) {
  const labels: Record<DetailChartMetric, string> = {
    quantity: "수량별",
    quantity_delta: "수량 변화량",
    quantity_delta_ratio: "수량 변화율",
    valuation_amount: "금액별",
    valuation_weight: "비중별",
    valuation_delta: "금액 변화량",
    valuation_delta_ratio: "금액 변화율",
    weight_delta: "비중 변화량",
  };
  return labels[metric];
}

function sanitizeSheetName(value: string) {
  return value.replace(/[\\/?*[\]:]/g, "-").slice(0, 31);
}

function sanitizeFileName(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, "_");
}

function ExtremeCell({
  change,
  suffix,
  onAssetClick,
}: {
  change: ExtremeChange | null;
  suffix: string;
  onAssetClick: (assetCode: string) => void;
}) {
  if (!change) {
    return <td className="empty-cell">-</td>;
  }

  return (
    <td>
      <span className="change-cell">
        <span className={getDeltaClass(change.value)}>{formatExtremeValue(change.value, suffix)}</span>
        <span className="change-cell-divider" aria-hidden="true" />
        <button className="asset-link" title={change.asset_code} onClick={() => onAssetClick(change.asset_code)}>
          {change.asset_name}
        </button>
      </span>
    </td>
  );
}

function LoadingState({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty-state loading-state">
      <span className="loading-spinner" aria-hidden="true" />
      <strong>{title}</strong>
      <span>{body}</span>
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      <span>{body}</span>
    </div>
  );
}

function ExposureLinks({
  exposures,
  etfFundByName,
  onEtfClick,
}: {
  exposures: { ksd_fund?: string; etf_name: string; weight: number | null }[];
  etfFundByName: Map<string, string>;
  onEtfClick: (ksdFund: string) => void;
}) {
  if (!exposures.length) return <span className="empty-cell">-</span>;

  return (
    <span className="exposure-list">
      {exposures.slice(0, 3).map((item, index) => {
        const ksdFund = item.ksd_fund ?? etfFundByName.get(item.etf_name);
        return (
          <span className="exposure-item" key={`${ksdFund ?? item.etf_name}-${index}`}>
            {ksdFund ? (
              <button className="asset-link exposure-link" title={ksdFund} onClick={() => onEtfClick(ksdFund)}>
                {item.etf_name}
              </button>
            ) : (
              <span>{item.etf_name}</span>
            )}
            <span>{formatNumber(item.weight)}%</span>
          </span>
        );
      })}
    </span>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
