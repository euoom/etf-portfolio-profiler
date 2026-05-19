# Data Classification

이 문서는 ETF Portfolio Profiler에서 원천 데이터와 앱 내부 추론 데이터를 구분합니다.

This document separates source fields from application-inferred classification fields.

## Source Fields

원천 필드는 TIGER 상품 목록과 보유 종목 페이지에서 수집한 값을 가능한 그대로 저장합니다.

Source fields are collected from TIGER product and holding pages and stored as close to the source as possible.

### ETF Source Fields

| Field | Source | Notes |
| --- | --- | --- |
| `ksd_fund` | TIGER product list | ETF 식별자 |
| `ticker` | TIGER product list | 거래소 종목 코드 |
| `name` | TIGER product list | ETF 이름 |
| `asset_class` | TIGER product list | 원천 대분류. 예: `주식`, `채권`, `커버드콜` |
| `category` | TIGER product list | 원천 카테고리. 예: `테마`, `대표지수`, `단기채권` |
| `net_assets_krw_100m` | TIGER product list | 순자산, 억원 단위 |
| `nav_price` | TIGER product list | 기준가 |
| `listed_on` | TIGER product list | 상장일 |

### Holding Source Fields

| Field | Source | Notes |
| --- | --- | --- |
| `base_date` | TIGER holding page | 보유 종목 기준일 |
| `asset_code` | TIGER holding page | 편입 자산 코드. 없으면 `-`일 수 있음 |
| `asset_name` | TIGER holding page | 편입 자산 이름 |
| `quantity` | TIGER holding page | 보유 수량 |
| `valuation_amount` | TIGER holding page | 평가금액 |
| `weight` | TIGER holding page | ETF 내 비중 |
| `period_return` | TIGER holding page | 기간 수익률, 제공되는 경우만 저장 |

## Inferred Fields

추론 필드는 원천 필드를 바탕으로 화면 필터와 분석 UX를 위해 앱 내부에서 계산합니다. 원천 데이터가 아니므로 오분류가 있을 수 있고, JSON override가 자동 추론보다 우선합니다.

Inferred fields are computed inside the app for filters and analysis UX. They are not source data, can be misclassified, and JSON overrides take precedence over automatic inference.

## `asset_type`

`asset_type`은 종목별 화면의 자산군 필터에 사용합니다.

`asset_type` powers the asset group filter in the cross-ETF asset view.

| Value | UI Label | Main Inputs | Rule Summary |
| --- | --- | --- | --- |
| `stock` | 주식 | `asset_code`, `asset_name` | 다른 규칙에 걸리지 않는 일반 개별 주식 |
| `listed_product` | 상장상품 | `asset_code`, `asset_name` | QQQ/SPY/IVV/VOO/IWM/DIA, 또는 ETF/iShares/SPDR/Vanguard/Invesco QQQ Trust 패턴 |
| `fixed_income` | 채권/단기상품 | `asset_code`, `asset_name` | `KR3...`, `-`, 채권/통안/기업어음/전자단기사채/`(단)`/제...차 패턴 |
| `derivative` | 선물/파생 | `asset_code`, `asset_name` | `KR4...`, Future/E-mini/선물/Swap, 옵션형 `C 202605`/`P 202605` 패턴 |
| `cash` | 현금성 | `asset_code`, `asset_name` | `KRD...`, 원화예금/예금/현금/CASH 패턴 |

Override file:

```text
data/asset_classification_overrides.json
```

```json
{
  "by_asset_code": {
    "QQQ US EQUITY": {
      "asset_type": "listed_product",
      "note": "Invesco QQQ Trust Series 1 is an ETF-like listed product."
    }
  },
  "by_asset_name": {
    "예시 종목명": "stock"
  }
}
```

## `etf_type`

`etf_type`은 ETF별 목록의 ETF 유형 필터에 사용합니다.

`etf_type` powers the ETF type filter in the ETF list view.

| Value | UI Label | Main Inputs | Rule Summary |
| --- | --- | --- | --- |
| `equity` | 주식형 | `asset_class`, `category`, `name` | 원천 `asset_class`가 `주식`이고 다른 전략 규칙에 걸리지 않는 ETF |
| `income` | 인컴/커버드콜 | `asset_class`, `category`, `name` | 커버드콜/Covered/인컴/배당 패턴 |
| `leveraged_inverse` | 레버리지/인버스 | `asset_class`, `category`, `name` | 레버리지/인버스/2X/합성 패턴 |
| `fixed_income` | 채권형 | `asset_class`, `category`, `name` | 원천 `asset_class`/`category`/이름에 채권 패턴 |
| `money_market` | 머니마켓 | `asset_class`, `category`, `name` | 머니마켓/MMF/CD금리/CD1년/KOFR/단기채권/금리 패턴 |
| `other` | 기타 | `asset_class`, `category`, `name` | 위 규칙에 걸리지 않는 ETF |

Override file:

```text
data/etf_classification_overrides.json
```

```json
{
  "by_ksd_fund": {
    "KR70183J0002": {
      "etf_type": "equity",
      "note": "Manual correction example."
    }
  },
  "by_etf_name": {
    "TIGER 예시 ETF": "other"
  }
}
```

## Operational Notes

- 원천 필드는 수집 데이터 정합성을 위해 최대한 그대로 보존합니다.
- 추론 필드는 분석과 화면 필터를 위한 앱 내부 view model입니다.
- 오분류를 발견하면 override JSON에 먼저 기록하고, 반복되는 패턴이면 자동 분류 규칙으로 승격합니다.
- override 파일의 `note`는 선택 사항이지만, 분류 이유를 남기면 후속 검토가 쉬워집니다.
