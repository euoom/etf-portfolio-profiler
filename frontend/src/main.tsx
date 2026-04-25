import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useMutation, useQuery } from "@tanstack/react-query";
import ReactECharts from "echarts-for-react";
import { Bot, Columns3, Database, Filter, Moon, RefreshCw, Rows3, Send, Sigma, Sun } from "lucide-react";
import "./styles.css";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";
const queryClient = new QueryClient();

type Etf = {
  ksd_fund: string;
  ticker: string | null;
  name: string;
  brand: string;
  category: string | null;
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
  const [chatMessages, setChatMessages] = useState<string[]>([
    "최근 3일간 비중 변화 큰 종목 찾아줘",
  ]);

  useEffect(() => {
    localStorage.setItem("theme", theme);
  }, [theme]);

  const etfs = useQuery({
    queryKey: ["etfs"],
    queryFn: () => api<Etf[]>("/api/etfs"),
  });

  const pivot = useQuery({
    queryKey: ["holdings-pivot", selectedFund],
    queryFn: () => api<PivotResponse>(`/api/analysis/holdings-pivot?ksd_fund=${selectedFund}&days=3`),
  });

  const collectProducts = useMutation({
    mutationFn: () => api<{ collected: number }>("/api/collect/tiger/products", { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["etfs"] }),
  });

  const collectHoldings = useMutation({
    mutationFn: () => api(`/api/collect/tiger/holdings/${selectedFund}`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["holdings-pivot", selectedFund] });
    },
  });

  const collectRecentHoldings = useMutation({
    mutationFn: () => api(`/api/collect/tiger/holdings/${selectedFund}/recent?days=3`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["holdings-pivot", selectedFund] });
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
      const dates = pivot.data?.dates ?? [];
      const rows = (pivot.data?.rows ?? []).slice(0, 6);
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
          axisLabel: { color: theme === "dark" ? "#9aa4b2" : "#64748b", formatter: "{value}%" },
          splitLine: { lineStyle: { color: theme === "dark" ? "#272b32" : "#e2e8f0" } },
        },
        series: rows.map((item) => ({
          name: item.asset_name,
          type: "line",
          smooth: true,
          symbolSize: 7,
          data: dates.map((date) => item.weights[date] ?? null),
          connectNulls: false,
          emphasis: { focus: "series" },
        })),
      };
    },
    [pivot.data, theme],
  );

  function submitChat(message: string) {
    if (!message.trim()) return;
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
          <select value={selectedFund} onChange={(event) => setSelectedFund(event.target.value)}>
            <option value="KR70183J0002">KR70183J0002</option>
            {(etfs.data ?? []).map((etf) => (
              <option key={etf.ksd_fund} value={etf.ksd_fund}>
                {etf.name}
              </option>
            ))}
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

        <section className="analysis-canvas">
          <div className="canvas-toolbar">
            <div className="canvas-title">분석 캔버스</div>
            <div className="canvas-actions">
              <span>자동 저장</span>
              <span>공유</span>
              <span>내보내기</span>
            </div>
          </div>
          <section className="pivot-panel canvas-section">
            <div className="section-heading">
              <h2>OLAP 피벗 캔버스</h2>
              <span>행/열/값/필터 축으로 구성종목 시계열을 재배치합니다</span>
            </div>
            <div className="pivot-builder">
              <div className="field-zone">
                <Rows3 size={15} />
                <span>행</span>
                <button>종목명</button>
                <button>종목코드</button>
              </div>
              <div className="field-zone">
                <Columns3 size={15} />
                <span>열</span>
                <button>기준일</button>
              </div>
              <div className="field-zone">
                <Sigma size={15} />
                <span>값</span>
                <button>비중</button>
                <button>비중 변화량</button>
              </div>
              <div className="field-zone">
                <Filter size={15} />
                <span>필터</span>
                <button>선택 ETF</button>
                <button>최근 3영업일</button>
              </div>
            </div>
            <div className="pivot-grid-wrap">
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
            </div>
          </section>

          <section className="chart-panel canvas-section">
            <div className="section-heading">
              <h2>차트</h2>
              <span>행의 종목들이 날짜 열을 따라 보인 비중 추이</span>
            </div>
            <ReactECharts option={chartOption} style={{ height: 320 }} />
          </section>
        </section>
      </main>
    </div>
  );
}

function formatNumber(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";
  return value.toFixed(2);
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
