import hashlib
import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta

import httpx
from bs4 import BeautifulSoup

from app.core.config import TIGER_BASE_URL


LIST_URL = f"{TIGER_BASE_URL}/tigeretf/ko/product/search/list.ajax"
PDF_CONTAINER_URL = f"{TIGER_BASE_URL}/tigeretf/ko/product/search/detail/pdf.ajax"
PDF_LIST_URL = f"{TIGER_BASE_URL}/tigeretf/ko/product/search/detail/pdfListAjax.ajax"


def _clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def _to_float(value: str) -> float | None:
    cleaned = _clean_text(value).replace(",", "").replace("%", "").replace("원", "")
    if not cleaned or cleaned == "-":
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None


@dataclass(frozen=True)
class TigerProduct:
    ksd_fund: str
    name: str
    ticker: str | None
    asset_class: str | None
    category: str | None
    net_assets_krw_100m: float | None
    nav_price: float | None
    listed_on: str | None


@dataclass(frozen=True)
class TigerHolding:
    asset_code: str
    asset_name: str
    quantity: float | None
    valuation_amount: float | None
    weight: float | None
    period_return: float | None


@dataclass(frozen=True)
class TigerHoldingsSnapshot:
    ksd_fund: str
    base_date: str
    content_hash: str
    raw_html: str
    holdings: list[TigerHolding]


class TigerCollector:
    def __init__(self, timeout: float = 30.0) -> None:
        self._client = httpx.Client(
            timeout=timeout,
            headers={
                "User-Agent": "Mozilla/5.0 ETF Portfolio Profiler POC",
                "Content-Type": "application/x-www-form-urlencoded",
            },
        )

    def close(self) -> None:
        self._client.close()

    def fetch_products(self, list_count: int = 2000) -> list[TigerProduct]:
        payload = {
            "pdfNameYn": "N",
            "pageIndex": "1",
            "firstIndex": "0",
            "listCnt": str(list_count),
            "periodType": "short",
            "listType": "table",
            "etfTemaCode": "",
            "cateNameYn": "N",
            "inCateNationNot": "",
            "inCateFundNot": "",
            "q": "",
            "prfPrd": "1w",
            "orderA": "Month03",
            "orderB": "descending",
        }
        response = self._client.post(LIST_URL, data=payload)
        response.raise_for_status()
        soup = BeautifulSoup(response.text, "html.parser")
        products: list[TigerProduct] = []

        for row in soup.select(".c-data-row[data-ksd-fund]"):
            summary = row.select_one(".product-summary")
            if summary is None:
                continue
            name_el = summary.select_one(".title")
            code_el = summary.select_one(".code")
            categories = [_clean_text(x.get_text(" ")) for x in summary.select(".category .each")]
            pairs = summary.select(".c-pair")
            pair_values = {
                _clean_text(pair.select_one(".key").get_text(" ")): _clean_text(pair.select_one(".value").get_text(" "))
                for pair in pairs
                if pair.select_one(".key") and pair.select_one(".value")
            }
            ticker_match = re.search(r"\(([^)]+)\)", _clean_text(code_el.get_text(" ")) if code_el else "")
            products.append(
                TigerProduct(
                    ksd_fund=row["data-ksd-fund"],
                    name=_clean_text(name_el.get_text(" ")) if name_el else "",
                    ticker=ticker_match.group(1) if ticker_match else None,
                    asset_class=categories[0] if categories else None,
                    category=categories[1] if len(categories) > 1 else None,
                    net_assets_krw_100m=_to_float(pair_values.get("순자산 (억원)", "")),
                    nav_price=_to_float(pair_values.get("기준가 (원)", "")),
                    listed_on=pair_values.get("상장일"),
                )
            )
        return products

    def fetch_holdings_snapshot(
        self,
        ksd_fund: str,
        fix_date: str | None = None,
        prf_prd: str = "Week01",
        order: str = "SRD",
    ) -> TigerHoldingsSnapshot:
        base_date = fix_date or self._fetch_default_fix_date(ksd_fund)
        first_page = self._fetch_holdings_page(ksd_fund, base_date, prf_prd, order, page_index=1, first_index=0)
        total_count = self._extract_total_count(first_page)
        rows_html = [first_page]
        list_count = 100

        for first_index in range(10, total_count, list_count):
            page_index = (first_index // list_count) + 1
            rows_html.append(
                self._fetch_holdings_page(
                    ksd_fund,
                    base_date,
                    prf_prd,
                    order,
                    page_index=page_index,
                    first_index=first_index,
                    list_count=list_count,
                )
            )

        raw_html = "\n".join(rows_html)
        holdings = self._parse_holdings(raw_html)
        content_hash = hashlib.sha256(raw_html.encode("utf-8")).hexdigest()
        return TigerHoldingsSnapshot(
            ksd_fund=ksd_fund,
            base_date=base_date.replace(".", "-"),
            content_hash=content_hash,
            raw_html=raw_html,
            holdings=holdings,
        )

    def fetch_recent_holdings_snapshots(
        self,
        ksd_fund: str,
        days: int = 3,
        prf_prd: str = "Week01",
        order: str = "SRD",
    ) -> list[TigerHoldingsSnapshot]:
        latest_fix_date = self._fetch_default_fix_date(ksd_fund)
        fix_dates = recent_weekdays(latest_fix_date, days)
        snapshots: list[TigerHoldingsSnapshot] = []
        for fix_date in fix_dates:
            snapshot = self.fetch_holdings_snapshot(
                ksd_fund=ksd_fund,
                fix_date=fix_date,
                prf_prd=prf_prd,
                order=order,
            )
            if snapshot.holdings:
                snapshots.append(snapshot)
        return snapshots

    def _fetch_default_fix_date(self, ksd_fund: str) -> str:
        response = self._client.post(PDF_CONTAINER_URL, data={"ksdFund": ksd_fund, "fixDate": "", "prfPrd": "", "order": ""})
        response.raise_for_status()
        soup = BeautifulSoup(response.text, "html.parser")
        date_input = soup.select_one('input[name="fixDate"]')
        if date_input and date_input.get("value"):
            return str(date_input["value"])
        return date.today().strftime("%Y.%m.%d")

    def _fetch_holdings_page(
        self,
        ksd_fund: str,
        fix_date: str,
        prf_prd: str,
        order: str,
        page_index: int,
        first_index: int,
        list_count: int = 10,
    ) -> str:
        response = self._client.post(
            PDF_LIST_URL,
            data={
                "ksdFund": ksd_fund,
                "pageIndex": str(page_index),
                "firstIndex": str(first_index),
                "listCnt": str(list_count),
                "fixDate": fix_date,
                "prfPrd": prf_prd,
                "order": order,
            },
        )
        response.raise_for_status()
        return response.text

    def _extract_total_count(self, html: str) -> int:
        soup = BeautifulSoup(html, "html.parser")
        row = soup.select_one("tr[data-tot-cnt]")
        if row is None:
            return 0
        return int(row.get("data-tot-cnt", "0"))

    def _parse_holdings(self, html: str) -> list[TigerHolding]:
        soup = BeautifulSoup(html, "html.parser")
        holdings: list[TigerHolding] = []
        for row in soup.select("tr[data-tot-cnt]"):
            cells = [_clean_text(cell.get_text(" ")) for cell in row.select("td")]
            if len(cells) < 6:
                continue
            holdings.append(
                TigerHolding(
                    asset_code=cells[0],
                    asset_name=cells[1],
                    quantity=_to_float(cells[2]),
                    valuation_amount=_to_float(cells[3]),
                    weight=_to_float(cells[4]),
                    period_return=_to_float(cells[5]),
                )
            )
        return holdings


def recent_weekdays(latest_fix_date: str, days: int) -> list[str]:
    current = datetime.strptime(latest_fix_date.replace("-", "."), "%Y.%m.%d").date()
    dates: list[str] = []
    while len(dates) < days:
        if current.weekday() < 5:
            dates.append(current.strftime("%Y.%m.%d"))
        current -= timedelta(days=1)
    return list(reversed(dates))
