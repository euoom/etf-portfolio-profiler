import React, { forwardRef, startTransition, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useMutation, useQuery } from "@tanstack/react-query";
import ReactECharts from "echarts-for-react";
import type { CellValue, Worksheet } from "exceljs";
import JSZip from "jszip";
import { Bot, Command, Download, Menu, Moon, PanelRightClose, PanelRightOpen, RotateCcw, Search, Send, Square, Sun, X } from "lucide-react";
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
  asset_class?: string;
  category?: string;
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

type AssetRouteTarget = {
  asset_code: string;
  asset_name?: string;
};

type EtfRouteTarget = {
  ksd_fund: string;
  etf_name: string;
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

type AssetExposureRow = {
  ksd_fund: string;
  etf_name: string;
  start_quantity: number;
  end_quantity: number;
  quantity_delta: number;
  start_valuation_amount: number;
  end_valuation_amount: number;
  valuation_amount_delta: number;
  start_weight: number;
  end_weight: number;
  weight_delta: number;
  history?: Record<string, { quantity: number; valuation_amount: number; weight: number }>;
};

type AssetExposuresResponse = {
  dates: string[];
  rows: AssetExposureRow[];
};

type ChatRole = "user" | "assistant";

type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  actions?: ChatAction[];
};

type ChatAction = {
  label: string;
  kind: "asset" | "etf";
  target: AssetRouteTarget | { ksd_fund: string };
};

type ChatContextSection = {
  title: string;
  rows: Record<string, unknown>[];
};

type ChatViewContext = {
  mode: AnalysisMode;
  period: string;
  selected_fund?: string;
  selected_fund_name?: string;
  selected_asset?: AssetRouteTarget;
  chart_metric: string;
  filters: Record<string, string>;
  sections: ChatContextSection[];
  action_candidates?: {
    etfs: EtfRouteTarget[];
    assets: AssetRouteTarget[];
  };
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

async function streamChat(
  payload: { message: string; ksd_fund: string; view_context: ChatViewContext; history: { role: ChatRole; content: string }[] },
  onChunk: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`${apiBaseUrl}/api/chat/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "ngrok-skip-browser-warning": "true",
    },
    body: JSON.stringify(payload),
    signal,
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  if (!response.body) {
    throw new Error("스트리밍 응답을 읽을 수 없습니다.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pendingText = "";
  let flushTimer: number | undefined;

  const flush = () => {
    if (!pendingText) return;
    onChunk(pendingText);
    pendingText = "";
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pendingText += decoder.decode(value, { stream: true });
      if (flushTimer === undefined) {
        flushTimer = window.setTimeout(() => {
          flushTimer = undefined;
          flush();
        }, 500);
      }
    }
    const tail = decoder.decode();
    if (tail) pendingText += tail;
  } finally {
    if (flushTimer !== undefined) {
      window.clearTimeout(flushTimer);
    }
    flush();
  }
}

function newChatId(): string {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

function App() {
  const chatPanelRef = useRef<ChatPanelHandle>(null);
  const listChartRowsRef = useRef<EtfChangeSummaryRow[]>([]);
  const crossChartRowsRef = useRef<CrossEtfRow[]>([]);
  const analysisModeRef = useRef<AnalysisMode>("list");
  const chartInstanceRef = useRef<ChartInstance | null>(null);
  const chartRowClickHandlerRef = useRef<((event: ChartClickEvent) => void) | null>(null);
  const [selectedFund, setSelectedFund] = useState("KR70183J0002");
  const [selectedAssetCode, setSelectedAssetCode] = useState("");
  const [selectedAssetName, setSelectedAssetName] = useState("");
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const saved = localStorage.getItem("theme");
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>("list");
  const [aiPanelOpen, setAiPanelOpen] = useState(() => typeof window === "undefined" || window.innerWidth > 980);
  const [aiPanelWidth, setAiPanelWidth] = useState(420);
  const [etfChartMetric, setEtfChartMetric] = useState<EtfChartMetric>("change_score");
  const [etfTypeFilter, setEtfTypeFilter] = useState<EtfTypeFilter>("all");
  const [crossChartMetric, setCrossChartMetric] = useState<CrossChartMetric>("change_score");
  const [assetChartMetric, setAssetChartMetric] = useState<AssetChartMetric>("max_weight_delta");
  const [assetTypeFilter, setAssetTypeFilter] = useState<AssetTypeFilter>("stock");
  const [detailChartMetric, setDetailChartMetric] = useState<DetailChartMetric>("weight_delta");
  const [listDownloadMode, setListDownloadMode] = useState(false);
  const [selectedDownloadFunds, setSelectedDownloadFunds] = useState<string[]>([]);
  const [isDownloadingList, setIsDownloadingList] = useState(false);
  const [crossDownloadMode, setCrossDownloadMode] = useState(false);
  const [selectedDownloadAssets, setSelectedDownloadAssets] = useState<string[]>([]);
  const [isDownloadingCrossList, setIsDownloadingCrossList] = useState(false);
  const [periodMode, setPeriodMode] = useState<PeriodMode>("5");
  const [customStartDate, setCustomStartDate] = useState("");
  const [customEndDate, setCustomEndDate] = useState("");
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [mobileActiveTab, setMobileActiveTab] = useState<"table" | "chart">("table");
  const [isAiClosing, setIsAiClosing] = useState(false);

  useEffect(() => {
    localStorage.setItem("theme", theme);
  }, [theme]);

  useEffect(() => {
    setMobileMenuOpen(false);
  }, [selectedFund, selectedAssetCode]);

  useEffect(() => {
    function stopResize() {
      document.body.classList.remove("resizing-ai-panel");
    }

    window.addEventListener("mouseup", stopResize);
    return () => window.removeEventListener("mouseup", stopResize);
  }, []);

  useEffect(() => {
    function syncRoute() {
      const route = parseRoute();
      setAnalysisMode(route.mode);
      if (route.ksdFund) {
        setSelectedFund(route.ksdFund);
      }
      if (route.assetCode) {
        setSelectedAssetCode(route.assetCode);
        setSelectedAssetName(route.assetName ?? "");
      } else if (route.mode !== "asset") {
        setSelectedAssetCode("");
        setSelectedAssetName("");
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

  const assetExposures = useQuery({
    queryKey: ["asset-exposures", selectedAssetCode, selectedAssetName, analysisPeriodQuery],
    queryFn: () => api<AssetExposuresResponse>(`/api/analysis/asset-exposures?${getAssetExposureQuery(selectedAssetCode, selectedAssetName, analysisPeriodQuery)}`),
    enabled: analysisMode === "asset" && Boolean(selectedAssetCode),
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

  const rawSummaryRows = etfChangeSummary.data?.rows ?? [];
  const summaryRows = useMemo(() => filterSummaryRowsByEtfType(rawSummaryRows, etfTypeFilter), [etfTypeFilter, rawSummaryRows]);
  const pivotRows = pivot.data?.rows ?? [];
  const crossRows = crossEtfChanges.data?.rows ?? [];
  const pivotDates = pivot.data?.dates ?? [];
  const actionCandidateEtfs = useMemo(
    () => uniqueEtfCandidates(rawSummaryRows.map((item) => ({ ksd_fund: item.ksd_fund, etf_name: item.etf_name }))),
    [rawSummaryRows],
  );
  const actionCandidateAssets = useMemo(
    () =>
      uniqueAssetCandidates([
        ...crossRows.map((item) => ({ asset_code: item.asset_code, asset_name: item.asset_name })),
        ...pivotRows.map((item) => ({ asset_code: item.asset_code, asset_name: item.asset_name })),
        ...rawSummaryRows.flatMap((item) => [
          item.max_quantity_increase,
          item.max_quantity_decrease,
          item.max_weight_increase,
          item.max_weight_decrease,
          item.max_valuation_increase,
          item.max_valuation_decrease,
        ].filter(Boolean).map((change) => ({ asset_code: change!.asset_code, asset_name: change!.asset_name }))),
      ]),
    [crossRows, pivotRows, rawSummaryRows],
  );
  const selectedAsset = crossRows.find(
    (item) => item.asset_code === selectedAssetCode && (!selectedAssetName || item.asset_name === selectedAssetName),
  );
  const selectedAssetForExport: CrossEtfRow = selectedAsset ?? {
    asset_code: selectedAssetCode,
    asset_name: selectedAssetName || selectedAssetCode,
    weights: {},
    quantities: {},
    valuation_amounts: {},
    etf_counts: {},
    start_weight: 0,
    end_weight: 0,
    weight_delta: 0,
    start_quantity: 0,
    end_quantity: 0,
    quantity_delta: 0,
    start_valuation_amount: 0,
    end_valuation_amount: 0,
    valuation_amount_delta: 0,
    latest_etf_count: 0,
    latest_exposures: [],
  };
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
        : analysisMode === "asset"
          ? assetExposures.isLoading || (assetExposures.isFetching && !assetExposures.data)
          : crossEtfChanges.isLoading;
  const isCurrentChartLoading =
    analysisMode === "list"
      ? etfChangeSummary.isLoading
      : analysisMode === "single"
        ? pivot.isLoading || (pivot.isFetching && pivotRows.length === 0)
        : analysisMode === "asset"
          ? assetExposures.isLoading || (assetExposures.isFetching && !assetExposures.data)
          : crossEtfChanges.isLoading;
  const hasChartData =
    analysisMode === "list"
      ? summaryRows.length > 0
      : analysisMode === "single"
        ? pivotRows.length > 0
        : analysisMode === "asset"
          ? Boolean(assetExposures.data?.rows.length)
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
    if (analysisMode !== "cross") {
      setCrossDownloadMode(false);
      setSelectedDownloadAssets([]);
    }
    if (analysisMode === "asset") {
      if (assetChartMetric === "max_weight") {
        setAssetChartMetric("avg_weight");
      } else if (assetChartMetric === "max_weight_delta") {
        setAssetChartMetric("avg_weight_delta");
      }
    }
  }, [analysisMode, assetChartMetric]);

  useEffect(() => {
    const currentFunds = new Set(summaryRows.map((item) => item.ksd_fund));
    setSelectedDownloadFunds((current) => current.filter((ksdFund) => currentFunds.has(ksdFund)));
  }, [summaryRows]);

  const selectedDownloadSet = useMemo(() => new Set(selectedDownloadFunds), [selectedDownloadFunds]);
  const allListRowsSelected = summaryRows.length > 0 && summaryRows.every((item) => selectedDownloadSet.has(item.ksd_fund));
  const partiallyListRowsSelected = selectedDownloadFunds.length > 0 && !allListRowsSelected;

  useEffect(() => {
    const currentAssets = new Set(crossDisplayRows.map(getAssetRowKey));
    setSelectedDownloadAssets((current) => current.filter((assetCode) => currentAssets.has(assetCode)));
  }, [crossDisplayRows]);

  const selectedCrossDownloadSet = useMemo(() => new Set(selectedDownloadAssets), [selectedDownloadAssets]);
  const allCrossRowsSelected = crossDisplayRows.length > 0 && crossDisplayRows.every((item) => selectedCrossDownloadSet.has(getAssetRowKey(item)));
  const partiallyCrossRowsSelected = selectedDownloadAssets.length > 0 && !allCrossRowsSelected;

  const chartOption = useMemo(
    () => {
      if (analysisMode === "list") {
        const rows = summaryRows.slice(0, 12).reverse();
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
        const dates = assetExposures.data?.dates ?? [];
        const exposuresList = assetExposures.data?.rows ?? [];
        const metric = getAssetChartMetric(assetChartMetric);

        const series = exposuresList.map((row) => {
          return {
            name: row.etf_name,
            type: "line",
            smooth: true,
            symbolSize: 6,
            data: dates.map((date) => {
              const hist = row.history?.[date];
              if (!hist) return 0;
              if (assetChartMetric === "quantity") return hist.quantity;
              if (assetChartMetric === "quantity_delta") return hist.quantity - (row.history?.[dates[0]]?.quantity ?? 0);
              if (assetChartMetric === "quantity_delta_ratio") {
                const startVal = row.history?.[dates[0]]?.quantity ?? 0;
                return startVal ? ((hist.quantity - startVal) / Math.abs(startVal)) * 100 : 0;
              }
              if (assetChartMetric === "valuation_amount") return hist.valuation_amount;
              if (assetChartMetric === "valuation_delta") return hist.valuation_amount - (row.history?.[dates[0]]?.valuation_amount ?? 0);
              if (assetChartMetric === "valuation_delta_ratio") {
                const startVal = row.history?.[dates[0]]?.valuation_amount ?? 0;
                return startVal ? ((hist.valuation_amount - startVal) / Math.abs(startVal)) * 100 : 0;
              }
              if (assetChartMetric === "avg_weight" || assetChartMetric === "max_weight") {
                return hist.weight;
              }
              if (assetChartMetric === "avg_weight_delta" || assetChartMetric === "max_weight_delta") {
                return hist.weight - (row.history?.[dates[0]]?.weight ?? 0);
              }
              return hist.weight;
            }),
            connectNulls: true,
          };
        });

        return {
          backgroundColor: "transparent",
          textStyle: { color: theme === "dark" ? "#d7dde8" : "#334155" },
          legend: { 
            top: 0, 
            type: "scroll",
            textStyle: { color: theme === "dark" ? "#d7dde8" : "#334155" } 
          },
          tooltip: {
            trigger: "axis",
            backgroundColor: theme === "dark" ? "#181b20" : "#ffffff",
            borderColor: theme === "dark" ? "#343a43" : "#d9dee7",
            textStyle: { color: theme === "dark" ? "#f8fafc" : "#0f172a" },
            valueFormatter: (value: number) => metric.format(Number(value)),
          },
          grid: { top: 56, right: 24, bottom: 32, left: 64 },
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
          series: series,
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
    [analysisMode, assetChartMetric, assetExposures.data, crossChartMetric, crossChartRows, detailChartMetric, etfChartMetric, pivot.data, selectedAsset, summaryRows, theme],
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
            navigateAsset(target);
          }
          return;
        }
        if (analysisMode === "single") {
          const target = pivotRows.find((item) => item.asset_name === params.name);
          if (target) {
            navigateAsset(target);
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
        navigateAsset(target);
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

  async function downloadCrossWorkbook() {
    if (analysisMode !== "cross" || !crossDisplayRows.length) return;

    const ExcelJS = await import("exceljs");
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "ETF Portfolio Profiler";
    workbook.created = new Date();

    const sheet = workbook.addWorksheet("종목별 요약");

    const headers = [
      "종목명",
      "자산코드",
      "자산군",
      "카테고리",
      "최근 평균 비중(%)",
      "평균 비중 변화(%p)",
      "최근 최대 비중(%)",
      "최대 비중 변화(%p)",
      "최근 합산 비중(%)",
      "합산 비중 변화(%p)",
      "최근 편입 ETF 수"
    ];

    sheet.addRow(headers);

    const getAssetClassLabel = (val: string | null | undefined) => {
      if (!val) return "-";
      const mapping: Record<string, string> = {
        stock: "주식",
        listed_product: "상장상품",
        fixed_income: "채권/단기상품",
        derivative: "선물/파생",
        cash: "현금성",
      };
      return mapping[val] || val;
    };

    crossDisplayRows.forEach((row) => {
      sheet.addRow([
        row.asset_name,
        row.asset_code,
        getAssetClassLabel(row.asset_class),
        row.category || "-",
        row.end_avg_weight ?? null,
        row.avg_weight_delta ?? null,
        row.end_max_weight ?? null,
        row.max_weight_delta ?? null,
        row.end_weight ?? null,
        row.weight_delta ?? null,
        row.latest_etf_count ?? 0,
      ]);
    });

    sheet.columns.forEach((column) => {
      column.width = 16;
    });
    sheet.getColumn(1).width = 30;

    const workbookBuffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([workbookBuffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `종목별_자산분석_요약_${periodLabel}.xlsx`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function exportAssetWorkbook({
    asset,
    dates,
    exposuresList,
  }: {
    asset: CrossEtfRow;
    dates: string[];
    exposuresList: AssetExposureRow[];
  }) {
    const ExcelJS = await import("exceljs");
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "ETF Portfolio Profiler";
    workbook.created = new Date();

    // 1시트: "차트"
    const chartSheet = workbook.addWorksheet("차트");
    chartSheet.addRow([asset?.asset_name || "종목"]);
    chartSheet.addRow([
      `기간: ${periodLabel}`,
      `차트: ${assetChartMetric === "avg_weight" ? "편입 비중(%)" : "비중 변화량(%p)"}`,
      `자산코드: ${asset?.asset_code}`
    ]);

    const dataStartRow = 25;
    
    // 차트 데이터 행 구축 (각 ETF별 시계열 데이터)
    const chartRows = exposuresList.map((row) => {
      const values: Record<string, number> = {};
      const startWeight = row.history?.[dates[0]]?.weight ?? 0;
      
      dates.forEach((date) => {
        const hist = row.history?.[date];
        if (!hist) {
          values[date] = 0;
          return;
        }
        
        if (assetChartMetric === "avg_weight" || assetChartMetric === "max_weight") {
          values[date] = hist.weight;
        } else if (assetChartMetric === "avg_weight_delta" || assetChartMetric === "max_weight_delta") {
          values[date] = hist.weight - startWeight;
        } else {
          values[date] = hist.weight;
        }
      });
      
      return {
        etf_name: row.etf_name,
        values,
      };
    });

    addRowsWithHeader(
      chartSheet,
      dataStartRow,
      ["ETF 이름", ...dates],
      chartRows.map((item) => [
        item.etf_name,
        ...dates.map((date) => item.values[date] ?? 0),
      ])
    );

    // 2시트: "요약 표"
    const summarySheet = workbook.addWorksheet("요약 표");
    const summaryHeaders = [
      "ETF 이름",
      "최근 수량",
      "수량 변화",
      "최근 금액(원)",
      "금액 변화(원)",
      "최근 비중(%)",
      "비중 변화(%p)"
    ];
    addRowsWithHeader(
      summarySheet,
      1,
      summaryHeaders,
      exposuresList.map((row) => {
        const isCashLike = isCashLikeHolding(selectedAssetCode, selectedAssetName);
        return [
          row.etf_name,
          isCashLike ? null : row.end_quantity ?? null,
          isCashLike ? null : row.quantity_delta ?? null,
          isCashLike ? null : row.end_valuation_amount ?? null,
          row.valuation_amount_delta ?? null,
          row.end_weight ?? null,
          row.weight_delta ?? null,
        ];
      })
    );

    // 3시트부터: 날짜순 개별 시트들
    [...dates].reverse().forEach((date) => {
      const dailySheet = workbook.addWorksheet(sanitizeSheetName(date));
      addRowsWithHeader(
        dailySheet,
        1,
        ["ETF 이름", "수량", "평가금액", "비중"],
        exposuresList.map((row) => [
          row.etf_name,
          row.history?.[date]?.quantity ?? null,
          row.history?.[date]?.valuation_amount ?? null,
          row.history?.[date]?.weight ?? null,
        ])
      );
    });

    workbook.eachSheet((sheet) => {
      sheet.columns.forEach((column) => {
        column.width = 16;
      });
      sheet.getColumn(1).width = 30;
    });

    let workbookBuffer = await workbook.xlsx.writeBuffer();
    
    // 네이티브 차트 추가!
    try {
      workbookBuffer = await addNativeChartToWorkbook(workbookBuffer, {
        chartTitle: `${asset?.asset_name || "종목"} 편입 비중 추이 (${assetChartMetric === "avg_weight" ? "편입 비중" : "비중 변화량"})`,
        dates,
        metric: (assetChartMetric === "avg_weight" ? "weight" : "weight_delta") as unknown as DetailChartMetric,
        seriesCount: exposuresList.length,
        seriesNames: exposuresList.map((row) => row.etf_name),
        dataStartRow,
      });
    } catch (err) {
      console.error("자산 네이티브 차트 생성 에러:", err);
    }

    const blob = new Blob([workbookBuffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${sanitizeFileName(asset?.asset_name || "종목")}_상세_분석_${periodLabel}.xlsx`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function downloadAssetWorkbook() {
    if (analysisMode !== "asset" || !assetExposures.data?.rows.length) return;
    await exportAssetWorkbook({
      asset: selectedAssetForExport,
      dates: assetExposures.data.dates,
      exposuresList: assetExposures.data.rows,
    });
  }

  async function handleCrossListDownloadButton() {
    if (analysisMode !== "cross") return;
    if (!crossDownloadMode) {
      setCrossDownloadMode(true);
      return;
    }
    if (!selectedDownloadAssets.length || isDownloadingCrossList) return;

    const selectedRows = crossDisplayRows.filter((item) => selectedCrossDownloadSet.has(getAssetRowKey(item)));
    setIsDownloadingCrossList(true);
    try {
      for (const item of selectedRows) {
        const data = await api<AssetExposuresResponse>(
          `/api/analysis/asset-exposures?${getAssetExposureQuery(item.asset_code, item.asset_name, analysisPeriodQuery)}`
        );
        if (!data.rows.length || !data.dates.length) continue;
        await exportAssetWorkbook({
          asset: item,
          dates: data.dates,
          exposuresList: data.rows,
        });
        await delay(150);
      }
    } finally {
      setIsDownloadingCrossList(false);
      setCrossDownloadMode(false);
      setSelectedDownloadAssets([]);
    }
  }

  function toggleCrossDownloadAsset(assetKey: string) {
    setSelectedDownloadAssets((current) =>
      current.includes(assetKey) ? current.filter((item) => item !== assetKey) : [...current, assetKey],
    );
  }

  function toggleAllCrossDownloadAssets(checked: boolean) {
    setSelectedDownloadAssets(checked ? crossDisplayRows.map(getAssetRowKey) : []);
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

  function handleChatBeforeSubmit(message: string) {
    if (message.includes("최근") && message.includes("비중 변화")) {
      navigateHome();
      queryClient.invalidateQueries({ queryKey: ["cross-etf-weight-changes"] });
      queryClient.invalidateQueries({ queryKey: ["etf-change-summary"] });
    }
  }

  function buildChatContext(): ChatViewContext {
    const filters: Record<string, string> = {
      period_mode: periodMode,
    };
    if (analysisMode === "list") filters.etf_type = etfTypeFilter;
    if (analysisMode === "cross") filters.asset_type = assetTypeFilter;

    const context: ChatViewContext = {
      mode: analysisMode,
      period: periodLabel,
      selected_fund: selectedFund,
      selected_fund_name: selectedEtfName,
      selected_asset: selectedAssetCode ? { asset_code: selectedAssetCode, asset_name: selectedAssetName || selectedAsset?.asset_name } : undefined,
      chart_metric: getCurrentChartMetricLabel(analysisMode, etfChartMetric, detailChartMetric, crossChartMetric, assetChartMetric),
      filters,
      sections: [],
      action_candidates: {
        etfs: actionCandidateEtfs,
        assets: actionCandidateAssets,
      },
    };

    if (analysisMode === "list") {
      context.sections.push({
        title: "ETF별 변동 상위",
        rows: summaryRows.slice(0, 10).map((row) => ({
          ETF: row.etf_name,
          KSD: row.ksd_fund,
          변동점수: metricValue(row.change_score, row.change_score.toFixed(2)),
          수량증가: row.max_quantity_increase ? `${row.max_quantity_increase.asset_name} ${formatSignedPercent(row.max_quantity_increase.value)}` : "-",
          수량감소: row.max_quantity_decrease ? `${row.max_quantity_decrease.asset_name} ${formatSignedPercent(row.max_quantity_decrease.value)}` : "-",
          비중증가: row.max_weight_increase ? `${row.max_weight_increase.asset_name} ${formatSignedPercentPoint(row.max_weight_increase.value)}` : "-",
          비중감소: row.max_weight_decrease ? `${row.max_weight_decrease.asset_name} ${formatSignedPercentPoint(row.max_weight_decrease.value)}` : "-",
        })),
      });
    } else if (analysisMode === "single") {
      context.sections.push({
        title: "선택 ETF 구성종목 변화",
        rows: topByAbs(pivotRows, (row) => row.weight_delta, 10).map((row) => {
          const startQuantity = detailStartDate ? row.quantities[detailStartDate] : null;
          const endQuantity = detailEndDate ? row.quantities[detailEndDate] : null;
          const startAmount = detailStartDate ? row.valuation_amounts[detailStartDate] : null;
          const endAmount = detailEndDate ? row.valuation_amounts[detailEndDate] : null;
          return {
            종목명: row.asset_name,
            자산코드: row.asset_code,
            수량변화율: metricValue(
              getInterpretableDeltaPct(startQuantity, endQuantity, row.asset_code, row.asset_name),
              formatSignedPercent(getInterpretableDeltaPct(startQuantity, endQuantity, row.asset_code, row.asset_name)),
            ),
            금액변화율: metricValue(
              getInterpretableDeltaPct(startAmount, endAmount, row.asset_code, row.asset_name),
              formatSignedPercent(getInterpretableDeltaPct(startAmount, endAmount, row.asset_code, row.asset_name)),
            ),
            비중변화: metricValue(row.weight_delta, formatSignedPercentPoint(row.weight_delta)),
          };
        }),
      });
    } else if (analysisMode === "cross") {
      context.sections.push({
        title: "종목별 비중 변화 절대값 상위",
        rows: crossDisplayRows.slice(0, 10).map((row) => ({
          종목명: row.asset_name,
          자산코드: row.asset_code,
          절대비중변화순위: crossDisplayRows.findIndex((item) => item.asset_code === row.asset_code && item.asset_name === row.asset_name) + 1,
          변동점수: metricValue(getCrossChangeScore(row, crossScoreMaxes), getCrossChangeScore(row, crossScoreMaxes).toFixed(2)),
          ETF수: row.latest_etf_count,
          수량변화율: metricValue(
            getInterpretableDeltaPct(row.start_quantity, row.end_quantity, row.asset_code, row.asset_name),
            formatSignedPercent(getInterpretableDeltaPct(row.start_quantity, row.end_quantity, row.asset_code, row.asset_name)),
          ),
          비중변화: metricValue(row.weight_delta, formatSignedPercentPoint(row.weight_delta)),
          최근노출: row.latest_exposures.map((item) => `${item.etf_name} ${formatPercent(item.weight)}`).join(", ") || "-",
        })),
      });
    } else if (analysisMode === "asset") {
      context.sections.push({
        title: "자산 상세 ETF별 노출",
        rows: (assetExposures.data?.rows ?? []).slice(0, 10).map((row) => ({
          ETF: row.etf_name,
          KSD: row.ksd_fund,
          수량변화율: metricValue(
            getInterpretableDeltaPct(row.start_quantity, row.end_quantity, selectedAssetCode, selectedAssetName),
            formatSignedPercent(getInterpretableDeltaPct(row.start_quantity, row.end_quantity, selectedAssetCode, selectedAssetName)),
          ),
          금액변화율: metricValue(
            getInterpretableDeltaPct(row.start_valuation_amount, row.end_valuation_amount, selectedAssetCode, selectedAssetName),
            formatSignedPercent(getInterpretableDeltaPct(row.start_valuation_amount, row.end_valuation_amount, selectedAssetCode, selectedAssetName)),
          ),
          최근비중: metricValue(row.end_weight, formatPercent(row.end_weight)),
          비중변화: metricValue(row.weight_delta, formatSignedPercentPoint(row.weight_delta)),
        })),
      });
    }

    return context;
  }

  function runChatAction(action: ChatAction) {
    if (action.kind === "asset") {
      navigateAsset(action.target as AssetRouteTarget);
      return;
    }
    const target = action.target as { ksd_fund: string };
    navigateEtf(target.ksd_fund);
  }

  const commandActionItems = useMemo<CommandPaletteItem[]>(() => {
    return [
      {
        id: "collect-products",
        group: "데이터 업데이트",
        title: "TIGER ETF 상품 목록 업데이트",
        subtitle: collectProducts.isPending ? "업데이트 중" : "전체 ETF 기본 목록을 다시 수집합니다.",
        keywords: ["수집", "업데이트", "ETF목록", "상품"],
        disabled: collectProducts.isPending,
        run: () => collectProducts.mutate(),
      },
      {
        id: "collect-recent-watchlist",
        group: "데이터 업데이트",
        title: `현재 기간 대표 ETF 상세 데이터 업데이트`,
        subtitle: collectRecentWatchlist.isPending ? "업데이트 중" : `${periodLabel} 기준 대표 ETF 구성종목을 갱신합니다.`,
        keywords: ["수집", "업데이트", "대표", "ETF상세", "기간"],
        disabled: collectRecentWatchlist.isPending,
        run: () => collectRecentWatchlist.mutate(),
      },
      {
        id: "collect-selected-recent",
        group: "데이터 업데이트",
        title: "현재 ETF 상세 데이터 업데이트",
        subtitle: collectRecentHoldings.isPending ? "업데이트 중" : `${selectedEtfName}의 ${periodLabel} 구성종목을 갱신합니다.`,
        keywords: ["수집", "업데이트", "선택", "ETF상세", selectedEtfName],
        disabled: collectRecentHoldings.isPending,
        run: () => collectRecentHoldings.mutate(),
      },
      {
        id: "collect-selected-latest",
        group: "데이터 업데이트",
        title: "현재 ETF 최신 구성종목 업데이트",
        subtitle: collectHoldings.isPending ? "업데이트 중" : `${selectedEtfName}의 최신 구성종목 스냅샷을 갱신합니다.`,
        keywords: ["수집", "업데이트", "선택", "최신", "구성종목", selectedEtfName],
        disabled: collectHoldings.isPending,
        run: () => collectHoldings.mutate(),
      },
      {
        id: "refresh-current-view",
        group: "데이터 업데이트",
        title: "현재 화면 데이터 새로고침",
        subtitle: "분석 API 캐시를 비우고 화면 데이터를 다시 가져옵니다.",
        keywords: ["새로고침", "refresh", "reload", "캐시"],
        run: () => {
          queryClient.invalidateQueries({ queryKey: ["holdings-pivot"] });
          queryClient.invalidateQueries({ queryKey: ["cross-etf-weight-changes"] });
          queryClient.invalidateQueries({ queryKey: ["etf-change-summary"] });
          queryClient.invalidateQueries({ queryKey: ["asset-exposures"] });
        },
      },
    ];
  }, [
    collectProducts,
    collectHoldings,
    collectRecentHoldings,
    collectRecentWatchlist,
    periodLabel,
    selectedEtfName,
  ]);

  const commandSearchItems = useMemo<CommandPaletteItem[]>(() => {
    const etfSearchItems = uniqueEtfCandidates(rawSummaryRows.map((row) => ({ ksd_fund: row.ksd_fund, etf_name: row.etf_name })))
      .slice(0, 80)
      .map<CommandPaletteItem>((row) => ({
        id: `etf:${row.ksd_fund}`,
        group: "ETF 검색",
        title: row.etf_name,
        subtitle: "ETF 상세로 이동",
        keywords: ["ETF", "검색", row.ksd_fund],
        run: () => navigateEtf(row.ksd_fund),
      }));

    const assetSearchItems = uniqueAssetCandidates([
      ...crossRows.map((row) => ({ asset_code: row.asset_code, asset_name: row.asset_name })),
      ...pivotRows.map((row) => ({ asset_code: row.asset_code, asset_name: row.asset_name })),
    ])
      .filter((row) => Boolean(row.asset_name))
      .slice(0, 120)
      .map<CommandPaletteItem>((row) => ({
        id: `asset:${row.asset_code}:${row.asset_name}`,
        group: "종목 검색",
        title: row.asset_name ?? row.asset_code,
        subtitle: "종목 상세로 이동",
        keywords: ["종목", "검색", row.asset_code],
        run: () => navigateAsset(row),
      }));

    return [...etfSearchItems, ...assetSearchItems];
  }, [
    crossRows,
    pivotRows,
    rawSummaryRows,
  ]);

  const filteredCommandItems = useMemo(() => {
    const isActionMode = commandQuery.trimStart().startsWith(">");
    const rawQuery = isActionMode ? commandQuery.trimStart().slice(1) : commandQuery;
    const query = normalizeCommandText(rawQuery);
    const sourceItems = isActionMode ? commandActionItems : commandSearchItems;
    const filtered = query
      ? sourceItems.filter((item) =>
          normalizeCommandText([item.title, item.subtitle, ...(item.keywords ?? [])].filter(Boolean).join(" ")).includes(query),
        )
      : sourceItems;
    return filtered.slice(0, 40);
  }, [commandActionItems, commandQuery, commandSearchItems]);

  function closeCommandPalette() {
    setCommandPaletteOpen(false);
    setCommandQuery("");
    setSelectedCommandIndex(0);
  }

  function runCommandItem(item: CommandPaletteItem) {
    if (item.disabled) return;
    item.run();
    closeCommandPalette();
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setCommandPaletteOpen(true);
        setSelectedCommandIndex(0);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  function handleAiPanelClose() {
    if (isAiClosing) {
      return;
    }
    if (window.innerWidth <= 980) {
      setIsAiClosing(true);
      setTimeout(() => {
        setAiPanelOpen(false);
        setIsAiClosing(false);
      }, 280);
    } else {
      setAiPanelOpen(false);
    }
  }

  function navigateCurrentRoot() {
    if (analysisMode === "cross" || analysisMode === "asset") {
      setCrossChartMetric("change_score");
      setSelectedAssetCode("");
      setSelectedAssetName("");
      navigateCross();
      return;
    }
    navigateHome();
  }

  function startAiPanelResize(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = aiPanelWidth;
    document.body.classList.add("resizing-ai-panel");

    function handleMove(moveEvent: PointerEvent) {
      const nextWidth = startWidth + (startX - moveEvent.clientX);
      setAiPanelWidth(clamp(nextWidth, 300, 680));
    }

    function handleUp() {
      document.body.classList.remove("resizing-ai-panel");
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    }

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp, { once: true });
  }

  return (
    <div className="app-shell" data-theme={theme}>
      <header className="topbar">
        <div className="brand-area">
          <button className="brand-link" onClick={navigateCurrentRoot}>
            ETF Portfolio Profiler
          </button>
          <span className="brand-separator">|</span>
          <span className="current-view">{currentViewTitle(analysisMode, selectedEtfName, selectedAsset?.asset_name || selectedAssetName)}</span>
        </div>
        <button
          className="mobile-hamburger"
          onClick={() => setMobileMenuOpen((prev) => !prev)}
          aria-label="메뉴 토글"
          title="메뉴 토글"
        >
          {mobileMenuOpen ? <X size={20} /> : <Menu size={20} />}
        </button>
        <div className={`toolbar toolbar-primary${mobileMenuOpen ? " mobile-open" : ""}`}>
          <div className={`toolbar-group period-toolbar-group${periodMode === "custom" ? " has-custom-range" : ""}`}>
            <span className="toolbar-label">기간:</span>
            <select aria-label="기간" value={periodMode} onChange={(event) => setPeriodMode(event.target.value as PeriodMode)}>
              <option value="5">최근 5영업일</option>
              <option value="10">최근 10영업일</option>
              <option value="20">최근 20영업일</option>
              <option value="custom">직접 선택</option>
            </select>
            {periodMode === "custom" && (
              <div className="date-range-inputs">
                <input type="date" value={customStartDate} onChange={(event) => setCustomStartDate(event.target.value)} />
                <input type="date" value={customEndDate} onChange={(event) => setCustomEndDate(event.target.value)} />
              </div>
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
        <div className={`toolbar toolbar-secondary${mobileMenuOpen ? " mobile-open" : ""}`}>
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
          <div className="toolbar-actions">
            {analysisMode === "single" && (
              <button disabled={isCurrentTableLoading || !pivotRows.length} title="현재 ETF 상세 데이터를 엑셀로 다운로드" onClick={downloadDetailWorkbook}>
                <Download size={16} />
                <span>다운로드</span>
              </button>
            )}
            {analysisMode === "cross" && (
              <>
                <button
                  disabled={isCurrentTableLoading || !crossDisplayRows.length || isDownloadingCrossList || (crossDownloadMode && !selectedDownloadAssets.length)}
                  title={crossDownloadMode ? "선택한 종목의 상세 분석 데이터를 각각 엑셀로 다운로드" : "다운로드할 종목을 선택합니다"}
                  onClick={handleCrossListDownloadButton}
                >
                  <Download size={16} />
                  <span>
                    {isDownloadingCrossList
                      ? "다운로드 중"
                      : crossDownloadMode
                        ? `선택 (${selectedDownloadAssets.length})`
                        : "다운로드"}
                  </span>
                </button>
                {crossDownloadMode && (
                  <button
                    title="종목 다운로드 선택을 취소합니다"
                    onClick={() => {
                      setCrossDownloadMode(false);
                      setSelectedDownloadAssets([]);
                    }}
                  >
                    취소
                  </button>
                )}
              </>
            )}
            {analysisMode === "asset" && (
              <button
                disabled={isCurrentTableLoading || !assetExposures.data?.rows.length}
                title="현재 자산 상세 데이터를 엑셀로 다운로드"
                onClick={downloadAssetWorkbook}
              >
                <Download size={16} />
                <span>다운로드</span>
              </button>
            )}
            {analysisMode === "list" && (
              <>
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
                        ? `선택 (${selectedDownloadFunds.length})`
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
              <button className="ai-topbar-toggle" onClick={() => setAiPanelOpen(true)}>
                <PanelRightOpen size={16} />
                <span>AI 패널</span>
              </button>
            )}
            <span className="toolbar-divider" aria-hidden="true" />
            <button
              className="icon-button"
              aria-label="명령 팔레트 열기"
              title="명령 팔레트 (Ctrl+Shift+P)"
              onClick={() => {
                setCommandPaletteOpen(true);
                setSelectedCommandIndex(0);
              }}
            >
              <Command size={16} />
              <span className="button-text">명령어</span>
            </button>
            <span className="toolbar-divider" aria-hidden="true" />
            <button
              className="icon-button"
              aria-label={theme === "dark" ? "라이트 테마로 전환" : "다크 테마로 전환"}
              title={theme === "dark" ? "라이트 테마" : "다크 테마"}
              onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
            >
              {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
              <span className="button-text">{theme === "dark" ? "라이트" : "다크"}</span>
            </button>
          </div>
        </div>
      </header>

      <main
        className={aiPanelOpen ? "workspace" : "workspace ai-collapsed"}
        style={aiPanelOpen ? ({ "--ai-panel-width": `${aiPanelWidth}px` } as React.CSSProperties) : undefined}
      >
        <section className="analysis-canvas">
          <div className="mobile-tab-selector">
            <button
              className={mobileActiveTab === "table" ? "active" : ""}
              onClick={() => setMobileActiveTab("table")}
            >
              데이터 표
            </button>
            <button
              className={mobileActiveTab === "chart" ? "active" : ""}
              onClick={() => setMobileActiveTab("chart")}
            >
              분석 차트
            </button>
          </div>
          <section className={`pivot-panel canvas-section${mobileActiveTab === "table" ? "" : " mobile-hidden"}`}>
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
                        const quantityDeltaPct = getInterpretableDeltaPct(startQuantity, endQuantity, item.asset_code, item.asset_name);
                        const startAmount = detailStartDate ? item.valuation_amounts[detailStartDate] : null;
                        const endAmount = detailEndDate ? item.valuation_amounts[detailEndDate] : null;
                        const amountDelta = getDelta(startAmount, endAmount);
                        const amountDeltaPct = getInterpretableDeltaPct(startAmount, endAmount, item.asset_code, item.asset_name);
                        const endWeight = detailEndDate ? item.weights[detailEndDate] : null;
                        const isCashLike = isCashLikeHolding(item.asset_code, item.asset_name);

                        return (
                          <tr key={`${item.asset_code}-${item.asset_name}`}>
                            <td>
                              <button className="text-link" onClick={() => navigateAsset(item)}>
                                {item.asset_name}
                              </button>
                            </td>
                            <td>{isCashLike ? "-" : formatQuantityNumber(endQuantity)}</td>
                            <td className={isCashLike ? "" : getDeltaClass(quantityDelta)}>{isCashLike ? "-" : formatSignedQuantityNumber(quantityDelta)}</td>
                            <td className={getDeltaClass(quantityDeltaPct)}>{formatSignedPercent(quantityDeltaPct)}</td>
                            <td>{isCashLike ? "-" : formatKrw(endAmount)}</td>
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
                  <table className={`pivot-grid cross-grid${crossDownloadMode ? " with-selection" : ""}`}>
                    <thead>
                      <tr>
                        {crossDownloadMode && (
                          <th className="select-cell">
                            <input
                              type="checkbox"
                              checked={allCrossRowsSelected}
                              ref={(el) => {
                                if (el) {
                                  el.indeterminate = partiallyCrossRowsSelected;
                                }
                              }}
                              onChange={(event) => toggleAllCrossDownloadAssets(event.target.checked)}
                            />
                          </th>
                        )}
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
                        const quantityDeltaPct = getInterpretableDeltaPct(item.start_quantity, item.end_quantity, item.asset_code, item.asset_name);
                        const changeScore = getCrossChangeScore(item, crossScoreMaxes);

                        return (
                          <tr key={`${item.asset_code}-${item.asset_name}`}>
                            {crossDownloadMode && (
                              <td className="select-cell">
                                <input
                                  type="checkbox"
                                  checked={selectedCrossDownloadSet.has(getAssetRowKey(item))}
                                  onChange={() => toggleCrossDownloadAsset(getAssetRowKey(item))}
                                />
                              </td>
                            )}
                            <td>
                              <button className="text-link" onClick={() => navigateAsset(item)}>
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
              ) : selectedAssetCode ? (
                assetExposures.isLoading ? (
                  <LoadingState title="데이터를 불러오는 중입니다" body="종목별 ETF 편입 상세 데이터를 불러오고 있습니다." />
                ) : assetExposures.data?.rows.length ? (
                  <table className="pivot-grid">
                    <thead>
                      <tr>
                        <th>ETF 이름</th>
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
                      {assetExposures.data.rows.map((row) => {
                        const quantityDeltaPct = getInterpretableDeltaPct(row.start_quantity, row.end_quantity, selectedAssetCode, selectedAssetName);
                        const amountDeltaPct = getInterpretableDeltaPct(row.start_valuation_amount, row.end_valuation_amount, selectedAssetCode, selectedAssetName);
                        const isCashLike = isCashLikeHolding(selectedAssetCode, selectedAssetName);

                        return (
                          <tr key={row.ksd_fund}>
                            <td>
                              <button className="text-link" onClick={() => navigateEtf(row.ksd_fund)}>
                                {row.etf_name}
                              </button>
                            </td>
                            <td>{isCashLike ? "-" : formatQuantityNumber(row.end_quantity)}</td>
                            <td className={isCashLike ? "" : getDeltaClass(row.quantity_delta)}>{isCashLike ? "-" : formatSignedQuantityNumber(row.quantity_delta)}</td>
                            <td className={getDeltaClass(quantityDeltaPct)}>{formatSignedPercent(quantityDeltaPct)}</td>
                            <td>{isCashLike ? "-" : formatKrw(row.end_valuation_amount)}</td>
                            <td className={getDeltaClass(row.valuation_amount_delta)}>{formatSignedKrw(row.valuation_amount_delta)}</td>
                            <td className={getDeltaClass(amountDeltaPct)}>{formatSignedPercent(amountDeltaPct)}</td>
                            <td>{formatPercent(row.end_weight)}</td>
                            <td className={getDeltaClass(row.weight_delta)}>{formatSignedPercentPoint(row.weight_delta)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                ) : (
                  <EmptyState title="편입된 ETF 데이터가 없습니다" body="해당 기간 동안 이 종목을 편입하고 있는 ETF 정보가 없습니다." />
                )
              ) : (
                <EmptyState title="선택한 종목 데이터를 찾을 수 없습니다" body="종목별 화면에서 종목명을 다시 선택하거나 분석 기간을 조정하세요." />
              )}
            </div>
          </section>

          <section className={`chart-panel canvas-section${mobileActiveTab === "chart" ? "" : " mobile-hidden"}`}>
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
                  {analysisMode === "asset" ? (
                    <optgroup label="비중 기준">
                      <option value="avg_weight">편입 비중</option>
                      <option value="avg_weight_delta">비중 변화량</option>
                    </optgroup>
                  ) : (
                    <optgroup label="ETF 내 비중 기준">
                      <option value="avg_weight">평균 비중</option>
                      <option value="avg_weight_delta">평균 비중 변화량</option>
                      <option value="max_weight">최대 비중</option>
                      <option value="max_weight_delta">최대 비중 변화량</option>
                    </optgroup>
                  )}
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

        {(aiPanelOpen || isAiClosing) ? (
          <>
            <button
              type="button"
              className={"ai-panel-backdrop" + (isAiClosing ? " is-closing" : "")}
              aria-label="AI 패널 닫기"
              onClick={handleAiPanelClose}
            />
            <div
              className="ai-panel-resizer"
              role="separator"
              aria-label="AI 패널 너비 조절"
              aria-orientation="vertical"
              title="드래그해서 AI 패널 너비 조절"
              onPointerDown={startAiPanelResize}
              onDoubleClick={() => setAiPanelWidth(420)}
            />
            <aside className={"ai-panel" + (isAiClosing ? " is-closing" : "")}>
              <ChatPanel
                ref={chatPanelRef}
                selectedFund={selectedFund}
                periodLabel={periodLabel}
                summaryCount={summaryRows.length}
                currentModeLabel={analysisMode === "list" ? "ETF별" : analysisMode === "single" ? "단일 ETF" : analysisMode === "asset" ? "종목 상세" : "종목별"}
                showDebugMeta={showDevTools}
                buildContext={buildChatContext}
                onAction={runChatAction}
                onBeforeSubmit={handleChatBeforeSubmit}
                onClose={handleAiPanelClose}
              />
            </aside>
          </>
        ) : null}
      </main>

      {!aiPanelOpen && (
        <button
          className="mobile-ai-fab"
          onClick={() => setAiPanelOpen(true)}
          aria-label="AI 분석 상담"
          title="AI 분석 상담"
        >
          <Bot size={24} />
        </button>
      )}

      <CommandPalette
        open={commandPaletteOpen}
        query={commandQuery}
        items={filteredCommandItems}
        selectedIndex={selectedCommandIndex}
        onQueryChange={setCommandQuery}
        onSelectedIndexChange={setSelectedCommandIndex}
        onClose={closeCommandPalette}
        onRun={runCommandItem}
      />
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

function getInterpretableDeltaPct(
  startValue: number | null | undefined,
  endValue: number | null | undefined,
  assetCode: string | null | undefined,
  assetName: string | null | undefined,
) {
  if (isCashLikeHolding(assetCode, assetName)) return null;
  return getDeltaPct(startValue, endValue);
}

function getDeltaClass(value: number | null | undefined) {
  if (isZeroLike(value)) return "";
  return value > 0 ? "positive" : "negative";
}

function formatCompactNumber(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";
  return new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 }).format(value);
}

function formatSignedCompactNumber(value: number | null | undefined) {
  if (isZeroLike(value)) return "-";
  const formatted = formatCompactNumber(Math.abs(value));
  return `${value > 0 ? "+" : "-"}${formatted}`;
}

function formatQuantityNumber(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";
  if (Math.abs(value) > 0 && Math.abs(value) < 10) {
    return value.toLocaleString("ko-KR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  }
  return formatCompactNumber(value);
}

function formatSignedQuantityNumber(value: number | null | undefined) {
  if (isZeroLike(value)) return "-";
  const formatted = formatQuantityNumber(Math.abs(value));
  return `${value > 0 ? "+" : "-"}${formatted}`;
}

function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";
  return `${value.toFixed(2)}%`;
}

function formatSignedPercent(value: number | null | undefined) {
  if (isZeroLike(value)) return "-";
  return `${value > 0 ? "+" : "-"}${Math.abs(value).toFixed(2)}%`;
}

function formatSignedPercentOrDash(value: number | null | undefined) {
  if (isZeroLike(value)) return "-";
  return formatSignedPercent(value);
}

function formatSignedPercentPoint(value: number | null | undefined) {
  if (isZeroLike(value)) return "-";
  return `${value > 0 ? "+" : "-"}${Math.abs(value).toFixed(2)}%p`;
}

function formatSignedPercentPointOrDash(value: number | null | undefined) {
  if (isZeroLike(value)) return "-";
  return formatSignedPercentPoint(value);
}

function isZeroLike(value: number | null | undefined, epsilon = 1e-9): value is null | undefined {
  return value === null || value === undefined || Math.abs(value) <= epsilon;
}

function metricValue(raw: number | null | undefined, label: string) {
  return {
    raw: raw ?? null,
    label,
  };
}

function topByAbs<T>(rows: T[], value: (row: T) => number | null | undefined, limit: number) {
  return rows
    .filter((row) => {
      const metric = value(row);
      return metric !== null && metric !== undefined && metric !== 0;
    })
    .slice()
    .sort((a, b) => Math.abs(value(b) ?? 0) - Math.abs(value(a) ?? 0))
    .slice(0, limit);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function getCurrentChartMetricLabel(
  mode: AnalysisMode,
  etfMetric: EtfChartMetric,
  detailMetric: DetailChartMetric,
  crossMetric: CrossChartMetric,
  assetMetric: AssetChartMetric,
) {
  if (mode === "list") return getEtfChartMetric(etfMetric).axisName;
  if (mode === "single") return getDetailChartLabel(detailMetric);
  if (mode === "cross") return getCrossChartMetric(crossMetric).label;
  return getAssetChartMetric(assetMetric).label;
}

type ChatPanelProps = {
  selectedFund: string;
  periodLabel: string;
  summaryCount: number;
  currentModeLabel: string;
  showDebugMeta: boolean;
  buildContext: () => ChatViewContext;
  onAction: (action: ChatAction) => void;
  onBeforeSubmit: (message: string) => void;
  onClose: () => void;
};

type ChatPanelHandle = {
  resetChat: () => void;
  focusInput: () => void;
  downloadChat: () => void;
  hasMessages: () => boolean;
};

type CommandPaletteItem = {
  id: string;
  group: string;
  title: string;
  subtitle?: string;
  keywords?: string[];
  disabled?: boolean;
  run: () => void;
};

const ChatPanel = forwardRef<ChatPanelHandle, ChatPanelProps>(function ChatPanel({
  selectedFund,
  periodLabel,
  summaryCount,
  currentModeLabel,
  showDebugMeta,
  buildContext,
  onAction,
  onBeforeSubmit,
  onClose,
}: ChatPanelProps, ref) {
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [isChatStreaming, setIsChatStreaming] = useState(false);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const chatAbortRef = useRef<AbortController | null>(null);
  const exampleQuestions = [
    "최근 5영업일간 변동이 큰 ETF 5개만 요약해줘",
    "TIGER 미국나스닥100 구성종목에서 뭐가 크게 바뀌었어?",
    "최근 5영업일간 비중 변화 큰 종목 찾아줘",
    "SK하이닉스는 어떤 ETF에서 비중 변화가 컸어?",
    "이 화면에서 눈에 띄는 변화만 3개 알려줘",
  ];

  async function submitChat(message: string) {
    if (isChatStreaming) return;
    if (!message.trim()) return;
    onBeforeSubmit(message);
    const trimmed = message.trim();
    const viewContext = buildContext();
    const history = buildChatHistory(chatMessages);
    const assistantId = newChatId();
    let assistantContent = "";
    const abortController = new AbortController();
    chatAbortRef.current = abortController;
    setChatMessages((prev) => [
      ...prev,
      { id: newChatId(), role: "user", content: trimmed },
      { id: assistantId, role: "assistant", content: "데이터를 확인하는 중입니다...", actions: [] },
    ]);
    clearChatInput();
    setIsChatStreaming(true);
    try {
      await streamChat(
        { message: trimmed, ksd_fund: selectedFund, view_context: viewContext, history },
        (chunk) => {
          assistantContent += chunk;
          startTransition(() => {
            setChatMessages((prev) =>
              prev.map((item) =>
                item.id === assistantId
                  ? { ...item, content: assistantContent || "분석 중입니다..." }
                  : item,
              ),
            );
          });
        },
        abortController.signal,
      );
      setChatMessages((prev) =>
        prev.map((item) =>
          item.id === assistantId
            ? { ...item, content: assistantContent.trim() || "응답 내용이 비어 있습니다.", actions: [] }
            : item,
        ),
      );
    } catch (error) {
      if (abortController.signal.aborted) {
        const stoppedMessage = `${assistantContent.trim() || "응답 생성이 시작되기 전에 중단되었습니다."}\n\n응답 생성을 중단했습니다.`;
        setChatMessages((prev) =>
          prev.map((item) => (item.id === assistantId ? { ...item, content: stoppedMessage, actions: [] } : item)),
        );
        return;
      }
      const errorMessage = `응답을 가져오지 못했습니다. ${error instanceof Error ? error.message : ""}`.trim();
      setChatMessages((prev) => prev.map((item) => (item.id === assistantId ? { ...item, content: errorMessage } : item)));
    } finally {
      if (chatAbortRef.current === abortController) {
        chatAbortRef.current = null;
      }
      setIsChatStreaming(false);
    }
  }

  function buildChatHistory(messages: ChatMessage[]): { role: ChatRole; content: string }[] {
    return messages
      .filter((message) => message.content.trim())
      .slice(-8)
      .map((message) => ({
        role: message.role,
        content: message.content.trim().slice(0, 1200),
      }));
  }

  function resetChat() {
    chatAbortRef.current?.abort();
    chatAbortRef.current = null;
    setChatMessages([]);
    clearChatInput();
    setIsChatStreaming(false);
    chatInputRef.current?.focus();
  }

  function stopChat() {
    chatAbortRef.current?.abort();
  }

  function focusInput() {
    chatInputRef.current?.focus();
  }

  function resizeChatInput() {
    const input = chatInputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  }

  function clearChatInput() {
    setChatInput("");
    if (chatInputRef.current) {
      chatInputRef.current.style.height = "auto";
    }
  }

  function downloadChat() {
    if (!chatMessages.length) {
      focusInput();
      return;
    }
    const createdAt = new Date();
    const lines = [
      "# AI 채팅 기록",
      "",
      `- 생성일시: ${formatDateTime(createdAt)}`,
      `- 화면: ${currentModeLabel}`,
      `- 기간: ${periodLabel}`,
      "",
      ...chatMessages.flatMap((message) => [
        `## ${message.role === "user" ? "사용자" : "AI"}`,
        "",
        message.content.trim(),
        "",
      ]),
    ];
    downloadTextFile(`ai_chat_${formatFileTimestamp(createdAt)}.md`, lines.join("\n"));
  }

  useImperativeHandle(
    ref,
    () => ({
      resetChat,
      focusInput,
      downloadChat,
      hasMessages: () => chatMessages.length > 0,
    }),
    [chatMessages, currentModeLabel, periodLabel],
  );

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const key = event.key.toLowerCase();
      if (event.ctrlKey && event.shiftKey && key === "o") {
        event.preventDefault();
        resetChat();
        return;
      }
      if (event.ctrlKey && (key === "l" || (event.shiftKey && key === "l"))) {
        event.preventDefault();
        focusInput();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    return () => {
      chatAbortRef.current?.abort();
    };
  }, []);

  return (
    <>
      <div className="panel-title">
        <span>
          <Bot size={18} />
          AI 분석 패널
        </span>
        <div className="panel-actions">
          <button className="panel-toggle" aria-label="새 채팅" title="새 채팅 (Ctrl+Shift+O)" onClick={resetChat}>
            <RotateCcw size={16} />
          </button>
          <button className="panel-toggle" aria-label="AI 분석 패널 접기" title="패널 접기" onClick={onClose}>
            <PanelRightClose size={16} />
          </button>
        </div>
      </div>
      {!chatMessages.length ? (
        <div className="example-prompts" aria-label="예시 질문">
          {exampleQuestions.map((example) => (
            <button key={example} disabled={isChatStreaming} onClick={() => void submitChat(example)}>
              {example}
            </button>
          ))}
        </div>
      ) : null}
      {showDebugMeta ? (
        <div className="insight-strip">
          <div>
            <span>분석 범위</span>
            <strong>{periodLabel}</strong>
          </div>
          <div>
            <span>랭킹 ETF</span>
            <strong>{summaryCount}</strong>
          </div>
          <div>
            <span>현재 모드</span>
            <strong>{currentModeLabel}</strong>
          </div>
        </div>
      ) : null}
      <div className="chat-log">
        {chatMessages.map((message) => (
          <div className={`chat ${message.role}`} key={message.id}>
            {message.role === "assistant" ? <MarkdownText content={message.content} /> : message.content}
            {message.actions?.length ? (
              <div className="chat-actions">
                {message.actions.map((action) => (
                  <button key={`${action.kind}-${action.label}`} onClick={() => onAction(action)}>
                    {action.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>
      <ul className="ai-disclaimer">
        <li>AI 답변은 부정확할 수 있으니 원본 데이터를 함께 확인하세요.</li>
        <li>이 서비스는 채팅 내용을 별도로 수집하지 않지만, AI 제공자 정책에 따라 수집·처리될 수 있으니 민감정보 입력은 피하세요.</li>
        <li>투자 판단과 책임은 사용자에게 있으며, AI는 매수·매도 결정을 대신하지 않습니다.</li>
      </ul>
      <form
        className="chat-input"
        onSubmit={(event) => {
          event.preventDefault();
          void submitChat(chatInput);
        }}
      >
        <textarea
          ref={chatInputRef}
          rows={1}
          value={chatInput}
          onChange={(event) => {
            setChatInput(event.target.value);
            resizeChatInput();
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            void submitChat(chatInput);
          }}
          placeholder="분석 요청 입력"
          title="Enter 전송, Shift+Enter 줄바꿈"
        />
        <button
          type={isChatStreaming ? "button" : "submit"}
          className={isChatStreaming ? "stop-button" : undefined}
          aria-label={isChatStreaming ? "응답 생성 중단" : "전송"}
          disabled={!isChatStreaming && !chatInput.trim()}
          title={isChatStreaming ? "응답 생성 중단" : "전송"}
          onClick={isChatStreaming ? stopChat : undefined}
        >
          {isChatStreaming ? <Square size={14} fill="currentColor" /> : <Send size={16} />}
        </button>
      </form>
    </>
  );
});

function CommandPalette({
  open,
  query,
  items,
  selectedIndex,
  onQueryChange,
  onSelectedIndexChange,
  onClose,
  onRun,
}: {
  open: boolean;
  query: string;
  items: CommandPaletteItem[];
  selectedIndex: number;
  onQueryChange: (value: string) => void;
  onSelectedIndexChange: (value: number) => void;
  onClose: () => void;
  onRun: (item: CommandPaletteItem) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const activeIndex = items.length ? clamp(selectedIndex, 0, items.length - 1) : 0;

  useEffect(() => {
    if (!open) return;
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(".command-item.active")?.scrollIntoView({
      block: "nearest",
    });
  }, [activeIndex, items, open]);

  if (!open) return null;

  return (
    <div className="command-palette-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="명령 팔레트"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="command-input-row">
          <Search size={18} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              onQueryChange(event.target.value);
              onSelectedIndexChange(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
                return;
              }
              if (event.key === "ArrowDown") {
                event.preventDefault();
                onSelectedIndexChange(items.length ? (activeIndex + 1) % items.length : 0);
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                onSelectedIndexChange(items.length ? (activeIndex - 1 + items.length) % items.length : 0);
                return;
              }
              if (event.key === "Enter" && items[activeIndex]) {
                event.preventDefault();
                onRun(items[activeIndex]);
              }
            }}
            placeholder="ETF/종목 검색, 명령은 > 입력"
          />
          <span className="command-kbd">Ctrl Shift P</span>
        </div>
        <div className="command-list" role="listbox" ref={listRef}>
          {items.length ? (
            items.map((item, index) => {
              const showGroup = index === 0 || items[index - 1]?.group !== item.group;
              return (
                <React.Fragment key={item.id}>
                  {showGroup ? <div className="command-group">{item.group}</div> : null}
                  <button
                    className={index === activeIndex ? "command-item active" : "command-item"}
                    disabled={item.disabled}
                    role="option"
                    aria-selected={index === activeIndex}
                    onMouseEnter={() => onSelectedIndexChange(index)}
                    onClick={() => onRun(item)}
                  >
                    <span>{item.title}</span>
                    {item.subtitle ? <small>{item.subtitle}</small> : null}
                  </button>
                </React.Fragment>
              );
            })
          ) : (
            <div className="command-empty">일치하는 명령이나 검색 결과가 없습니다.</div>
          )}
        </div>
      </section>
    </div>
  );
}

function buildChatActions(content: string, viewContext: ChatViewContext, userMessage = "") {
  const actions: ChatAction[] = [];
  const seen = new Set<string>();
  const preferEtfActions = isEtfListQuestion(userMessage);
  const preferTargetEtfFirst = preferEtfActions || isEtfDetailQuestion(userMessage);

  function addEtfAction(etf: { ksd_fund: string; etf_name: string }) {
    const key = `etf:${etf.ksd_fund}`;
    if (seen.has(key) || isCurrentEtfAction(etf, viewContext)) return;
    seen.add(key);
    actions.push({
      kind: "etf",
      label: `${etf.etf_name} 보기`,
      target: { ksd_fund: etf.ksd_fund },
    });
  }

  if (preferTargetEtfFirst) {
    for (const section of viewContext.sections) {
      for (const row of section.rows) {
        const etfName = typeof row["ETF"] === "string" ? row["ETF"] : undefined;
        const ksdFund = typeof row["KSD"] === "string" ? row["KSD"] : undefined;
        if (etfName && ksdFund && content.includes(etfName)) {
          addEtfAction({ ksd_fund: ksdFund, etf_name: etfName });
          if (actions.length >= 3) return actions;
        }
      }
    }

    const matchedEtfNames = new Set<string>();
    for (const etf of viewContext.action_candidates?.etfs ?? []) {
      if (!content.includes(etf.etf_name)) continue;
      if ([...matchedEtfNames].some((matchedName) => matchedName.includes(etf.etf_name))) continue;
      matchedEtfNames.add(etf.etf_name);
      addEtfAction(etf);
      if (actions.length >= 3) return actions;
    }
    if (preferEtfActions) return actions;
  }

  for (const asset of viewContext.action_candidates?.assets ?? []) {
    if (!asset.asset_name || !content.includes(asset.asset_name) || isBlockedAssetAction(asset, viewContext)) continue;
    const key = `asset:${asset.asset_code}:${asset.asset_name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    actions.push({
      kind: "asset",
      label: `${asset.asset_name} 상세`,
      target: asset,
    });
    if (actions.length >= 3) return actions;
  }

  const matchedEtfNames = new Set<string>();
  for (const etf of viewContext.action_candidates?.etfs ?? []) {
    if (!content.includes(etf.etf_name)) continue;
    if ([...matchedEtfNames].some((matchedName) => matchedName.includes(etf.etf_name))) continue;
    matchedEtfNames.add(etf.etf_name);
    addEtfAction(etf);
    if (actions.length >= 3) return actions;
  }

  for (const section of viewContext.sections) {
    for (const row of section.rows) {
      const assetName = typeof row["종목명"] === "string" ? row["종목명"] : undefined;
      const assetCode = typeof row["자산코드"] === "string" ? row["자산코드"] : undefined;
      if (assetName && assetCode && content.includes(assetName) && !isBlockedAssetAction({ asset_code: assetCode, asset_name: assetName }, viewContext)) {
        const key = `asset:${assetCode}:${assetName}`;
        if (!seen.has(key)) {
          seen.add(key);
          actions.push({
            kind: "asset",
            label: `${assetName} 상세`,
            target: { asset_code: assetCode, asset_name: assetName },
          });
        }
      }

      const etfName = typeof row["ETF"] === "string" ? row["ETF"] : undefined;
      const ksdFund = typeof row["KSD"] === "string" ? row["KSD"] : undefined;
      if (etfName && ksdFund && content.includes(etfName)) {
        addEtfAction({ ksd_fund: ksdFund, etf_name: etfName });
      }

      if (actions.length >= 3) return actions;
    }
  }
  return actions;
}

function isCurrentEtfAction(etf: { ksd_fund: string; etf_name: string }, viewContext: ChatViewContext) {
  return Boolean(
    viewContext.mode === "single" &&
      viewContext.selected_fund &&
      (etf.ksd_fund === viewContext.selected_fund || etf.etf_name === viewContext.selected_fund_name),
  );
}

function isBlockedAssetAction(asset: AssetRouteTarget, viewContext: ChatViewContext) {
  if (isCashLikeHolding(asset.asset_code, asset.asset_name)) return true;
  return Boolean(
    viewContext.mode === "asset" &&
      viewContext.selected_asset &&
      asset.asset_code === viewContext.selected_asset.asset_code &&
      (!viewContext.selected_asset.asset_name || asset.asset_name === viewContext.selected_asset.asset_name),
  );
}

function isEtfListQuestion(message: string) {
  const normalized = message.replace(/\s+/g, "").toLowerCase();
  const hasEtf = normalized.includes("etf");
  const hasListIntent = ["목록", "랭킹", "순위", "상위", "큰", "요약", "변동"].some((token) => normalized.includes(token));
  const hasDetailIntent = ["구성종목", "상세", "종목"].some((token) => normalized.includes(token));
  return hasEtf && hasListIntent && !hasDetailIntent;
}

function isEtfDetailQuestion(message: string) {
  const normalized = message.replace(/\s+/g, "").toLowerCase();
  return normalized.includes("etf") && ["구성종목", "상세", "뭐가", "바뀌"].some((token) => normalized.includes(token));
}

function uniqueEtfCandidates(items: EtfRouteTarget[]) {
  const byFund = new Map<string, EtfRouteTarget>();
  for (const item of items) {
    if (!item.ksd_fund || !item.etf_name || byFund.has(item.ksd_fund)) continue;
    byFund.set(item.ksd_fund, item);
  }
  return [...byFund.values()].sort((a, b) => b.etf_name.length - a.etf_name.length);
}

function uniqueAssetCandidates(items: AssetRouteTarget[]) {
  const byAsset = new Map<string, AssetRouteTarget>();
  for (const item of items) {
    if (!item.asset_code || !item.asset_name) continue;
    const key = `${item.asset_code}:${item.asset_name}`;
    if (byAsset.has(key)) continue;
    byAsset.set(key, item);
  }
  return [...byAsset.values()];
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
  if (isZeroLike(value)) return "-";
  const formatted = formatKrw(Math.abs(value));
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

function formatDateTime(value: Date) {
  return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())} ${pad2(value.getHours())}:${pad2(value.getMinutes())}:${pad2(value.getSeconds())}`;
}

function formatFileTimestamp(value: Date) {
  return `${value.getFullYear()}${pad2(value.getMonth() + 1)}${pad2(value.getDate())}_${pad2(value.getHours())}${pad2(value.getMinutes())}${pad2(value.getSeconds())}`;
}

function pad2(value: number) {
  return value.toString().padStart(2, "0");
}

function downloadTextFile(fileName: string, content: string) {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function normalizeCommandText(value: string) {
  return value.toLowerCase().replace(/\s+/g, "");
}

function parseRoute(): { mode: AnalysisMode; ksdFund?: string; assetCode?: string; assetName?: string } {
  const hash = window.location.hash.replace(/^#/, "");
  const etfMatch = hash.match(/^\/etf\/([^/]+)$/);
  if (etfMatch) {
    return { mode: "single", ksdFund: decodeURIComponent(etfMatch[1]) };
  }
  const assetMatch = hash.match(/^\/asset\/([^/]+)(?:\/([^/]+))?$/);
  if (assetMatch) {
    return {
      mode: "asset",
      assetCode: decodeURIComponent(assetMatch[1]),
      assetName: assetMatch[2] ? decodeURIComponent(assetMatch[2]) : undefined,
    };
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

function navigateAsset(target: AssetRouteTarget) {
  const nextHash = target.asset_name
    ? `#/asset/${encodeURIComponent(target.asset_code)}/${encodeURIComponent(target.asset_name)}`
    : `#/asset/${encodeURIComponent(target.asset_code)}`;
  if (window.location.hash === nextHash) {
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    return;
  }
  window.location.hash = nextHash;
}

function getAssetRowKey(target: AssetRouteTarget) {
  return `${target.asset_code}\u001f${target.asset_name ?? ""}`;
}

function getAssetExposureQuery(assetCode: string, assetName: string | undefined, analysisPeriodQuery: string) {
  const params = new URLSearchParams(analysisPeriodQuery);
  params.set("asset_code", assetCode);
  if (assetName) {
    params.set("asset_name", assetName);
  }
  return params.toString();
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
    const isCashLike = isCashLikeHolding(item.asset_code, item.asset_name);
    return {
      종목명: item.asset_name,
      최근수량: isCashLike ? null : endQuantity,
      수량변화: isCashLike ? null : getDelta(startQuantity, endQuantity),
      수량변화율: getInterpretableDeltaPct(startQuantity, endQuantity, item.asset_code, item.asset_name),
      최근금액: isCashLike ? null : endAmount,
      금액변화: getDelta(startAmount, endAmount),
      금액변화율: getInterpretableDeltaPct(startAmount, endAmount, item.asset_code, item.asset_name),
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
  onAssetClick: (target: AssetRouteTarget) => void;
}) {
  if (!change) {
    return <td className="empty-cell">-</td>;
  }

  return (
    <td>
      <span className="change-cell">
        <span className={getDeltaClass(change.value)}>{formatExtremeValue(change.value, suffix)}</span>
        <span className="change-cell-divider" aria-hidden="true" />
        <button className="asset-link" title={change.asset_code} onClick={() => onAssetClick(change)}>
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

function MarkdownText({ content }: { content: string }) {
  const blocks = parseMarkdownBlocks(content);
  return (
    <div className="markdown-content">
      {blocks.map((block, index) => {
        if (block.type === "heading") {
          return <strong className="markdown-heading" key={index}>{renderInlineMarkdown(block.text)}</strong>;
        }
        if (block.type === "divider") {
          return <hr className="markdown-divider" key={index} />;
        }
        if (block.type === "blockquote") {
          return <blockquote key={index}>{renderInlineMarkdown(block.text)}</blockquote>;
        }
        if (block.type === "list") {
          return (
            <ul key={index}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{renderInlineMarkdown(item)}</li>
              ))}
            </ul>
          );
        }
        if (block.type === "table") {
          return (
            <div className="markdown-table-wrap" key={index}>
              <table>
                <thead>
                  <tr>
                    {block.headers.map((header, headerIndex) => (
                      <th key={headerIndex}>{renderInlineMarkdown(header)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {block.headers.map((_, cellIndex) => (
                        <td key={cellIndex}>{renderInlineMarkdown(row[cellIndex] ?? "")}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        return <p key={index}>{renderInlineMarkdown(block.text)}</p>;
      })}
    </div>
  );
}

type MarkdownBlock =
  | { type: "heading"; text: string }
  | { type: "divider" }
  | { type: "blockquote"; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; items: string[] }
  | { type: "table"; headers: string[]; rows: string[][] };

function parseMarkdownBlocks(content: string): MarkdownBlock[] {
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      blocks.push({ type: "divider" });
      index += 1;
      continue;
    }
    if (line.startsWith("|") && lines[index + 1]?.replace(/\s/g, "").match(/^\|?:?-{3,}:?\|/)) {
      const headers = splitMarkdownRow(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].startsWith("|")) {
        rows.push(splitMarkdownRow(lines[index]));
        index += 1;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }
    if (/^#{1,4}\s+/.test(line)) {
      blocks.push({ type: "heading", text: line.replace(/^#{1,4}\s+/, "") });
      index += 1;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push({ type: "blockquote", text: quoteLines.join(" ") });
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^[-*]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^[-*]\s+/, ""));
        index += 1;
      }
      blocks.push({ type: "list", items });
      continue;
    }
    blocks.push({ type: "paragraph", text: line });
    index += 1;
  }

  return blocks;
}

function splitMarkdownRow(line: string) {
  return line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function renderInlineMarkdown(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    return <React.Fragment key={index}>{part}</React.Fragment>;
  });
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
