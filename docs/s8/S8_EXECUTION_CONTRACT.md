# S8 Execution Contract — PR-A Search, Filters, and Alert Core

## Authority and branch boundary

This contract governs **S8 PR-A only** for Issue #7 in `khaledassag2016-hash/private-work-management-app`. The authorized base is `ad482ec0dc78ba5796797d40223beb6d6fed0f5b`. PR-A implements only bounded authenticated search/filter reads and alert configuration/read models. It excludes analytics, Excel/export, analytics/export UI, S9/S10/S11 work, Cloud writes, deployment, and any new S6/S7 financial or approval rule.

## Authoritative inherited sources

| Subject | Locked source | PR-A treatment |
|---|---|---|
| Immutable Work identity and current title | `works.id`, `works.title` | Return one result per immutable `id`; use literal/substring matching only. |
| Historical titles | `work_title_history.old_title`, `work_title_history.new_title` | Search through an `EXISTS` predicate; never duplicate a Work for multiple matches. |
| Customer and classifications | `works.customer_id`, `customers`, `works.country`, `works.university`, `works.specialty_key`, `works.work_type_key` | Filter only stored authoritative fields; no inferred taxonomy. |
| Archive truth | `works.archived_at`, `work_archive_history` | Historical search may include archived Works and exposes `is_archived`; archive never becomes active. |
| Current price | Approved S6 `price_movements` aggregate | Price is an S6 read projection only, never an S8 classifier. |
| Approved paid / remaining / collection | S7 `client_payments` minus approved `payment_reversals`, with S7 collection taxonomy | Search filters using the existing S7 read semantics; no local ledger or execution-status inference. |
| Work-period dimensions | Stored `works.created_at` or nullable `works.confirmed_at` | Caller must send the explicit `period_basis` selected from `CREATED_AT` or `CONFIRMED_AT`; month/year without one fails closed. |

## Search and filter contract

`GET /api/search/works` is authenticated and uses the existing `{ok:true,data,requestId}` / `{ok:false,code,requestId}` envelope. It accepts a deterministic literal/substring `q`, individual authoritative filters (`customer_id`, `status`, `country`, `university`, `specialty_key`, `work_type_key`, `collection_status`), `include_archived`, `period_basis`, `month`, `year`, `page`, and `page_size`.

The result ordering is `created_at ASC, id ASC`. `page` starts at 1. The default page size is 50 and the maximum is 100. The response exposes `items`, `page`, `page_size`, and `has_more`. A caller can walk all pages without silent omission. `month` requires an explicit `period_basis`; `year` likewise requires an explicit `period_basis`; invalid or mixed date input returns an explicit S8 validation code. `CONFIRMED_AT` excludes null confirmations. `include_archived=false` is the explicit active-only search; the default retains historical visibility and returns archive state.

Search uses prepared parameters only. It does not provide fuzzy, semantic, AI, stemming, or automatic Arabic-normalization behavior. Quote, wildcard, and special text are treated as literal user data through bound parameters and escaped `LIKE` patterns.

## Alert configuration and fail-closed behavior

S8 alert thresholds are persisted as integer positive durations in `s8_alert_settings`, scoped by `alert_type` (`NO_PRICE`, `NO_REPLY`, `NO_PAYMENT`). Reads return `NOT_CONFIGURED` when a type lacks a setting. The two existing active accounts are authorized through the existing Worker boundary; changes are audited and use the existing response envelope. No paid scheduler, notification provider, email, SMS, push, background write, or production default is introduced.

D-017 now defines the FR-029 clock anchors. `NO_PRICE` starts at `created_at` while the S6 authoritative approved-price aggregate remains unset. `NO_REPLY` starts at the latest `work_status_history` transition to `WAITING_CLIENT_RESPONSE`, or at `created_at` when that is the initial status. `NO_PAYMENT` starts at `confirmed_at` only when the Work has a positive authoritative S6 price and S7 approved receipts net of approved reversals equal zero.

`GET /api/alerts` returns `NOT_CONFIGURED` with no items when a threshold is absent; a configured type returns `CONFIGURED` and only D-017-matching items whose authoritative age meets its configured threshold. The alert engine accepts deterministic `testNow` injection only through its internal test interface; production requests use the Worker clock and ignore any client `now` query parameter. Archived Works are not treated as active overdue Works. D-017 supplies no default duration.

## Query, bind, auth, and data safety

Search and alert list paths use bounded SQL with joins, CTEs, aggregates, and `EXISTS`; no application-level per-Work D1 reads or `Promise.all` fan-out is permitted. PR-A internal target is at most 40 D1 reads per invocation and at most 100 binds per query. Tests reset counters immediately before operations, use 200+ synthetic Works for search and alerts, report measured counts, and prove no result-row query growth.

All data and tests are synthetic. No direct D1 client bypass exists: Worker routes remain authenticated, existing two-account authorization remains authoritative, and the SPA is not extended in PR-A. Source and packaged Worker copies, schemas, migrations, and manifest registration must be byte-identical where applicable.

## Required automated evidence and test-layer mapping

| Requirement / risk | Exact test and layer | Required assertion |
|---|---|---|
| Current and historical title identity | `s8_pr_a_search_filter_alert.test.mjs` — `S8 search finds current and old titles once by immutable Work identity` | Current title, two old titles, and duplicate history all return the same one `id`. |
| Individual filters and archive state | `S8 search filters each authoritative dimension and preserves archived history` | Positive and negative assertions for month, year, status, customer, country, university, specialty, work type, collection, plus archived result state. |
| Bounded pagination and parameter safety | `S8 search pagination is complete, deterministic, parameterized, and bounded` | Walking pages yields each expected Work once; quote/wildcard input is safe; page bounds are enforced. |
| Dynamic catalog | `S8 search filters a supported dynamic catalog value without source change` | Added synthetic catalog value is filterable. |
| D-017 FR-029 anchors and configuration | `D-017 configures FR-029 clocks with authoritative NO_PRICE, NO_REPLY, and NO_PAYMENT anchors` | Missing setting is `NOT_CONFIGURED`; each configured type uses only its approved D-017 anchor and has no default duration. |
| Search / alert performance | `S8 search and alert query budgets remain bounded on large synthetic fixtures` | 200+ Works; measured queries and binds stay within policy without row-wise growth. |
| Auth and API envelope | `S8 search and alert API routes preserve authenticated envelopes` | Success and error envelopes use the existing shape; unauthenticated/unauthorized access is denied. |
| S4–S7 regression integration | Full Node regression | Customer/Work classification, title/archive history, S6 price, and S7 collection truth remain intact. |

## Explicit unresolved and closure boundaries

Alert threshold values are configurable but unseeded by default. D-017 provides the only approved FR-029 anchors and does not introduce a default duration. Missing classifications remain stored as null and are not inferred; PR-B reports them through an output-only `UNSPECIFIED` bucket. Analytics, export architecture, workbook schemas, money/date rendering, RTL workbook validation, and final S8 closure evidence are PR-B/PR-C/PR-D matters.

**PR-A stop condition:** after self-review, focused tests, full regression, Foundation/S2/package/secret validation, and Final-head CI, stop at Draft PR review. Do not merge, close Issue #7, start PR-B/PR-C, or start S9.

## PR-B analytics and export contract
PR-B adds authenticated, read-only analytics and export DTOs only. All analytics responses expose `period_basis` explicitly. The only admitted analytics period bases are `CREATED_AT` and `CONFIRMED_AT`; any month export requires the caller to provide one of those bases, while settlement-aligned fields continue to identify their independent S7 source and never silently become a Work-period calculation. Historical scopes explicitly choose `include_archived`; archived Works contribute to the requested historical population but are reported separately through `archived_work_count`, and never inflate `active_work_count`.

Classification groups use existing Work/catalog fields only: `work_type_key`, `specialty_key`, `country`, and `university`. A null or empty classification is represented only in read/export output as `UNSPECIFIED`; the underlying Work is not modified and no category is inferred from price. Grouped financial values derive from the existing S6 approved `price_movements` and S7 payments less approved `payment_reversals`, in integer halalas. Current price, paid, remaining, and collection status use the same authoritative definitions as S6/S7 read truth. Settlement data is consumed from immutable S7 `settlement_snapshots`; PR-B does not recompute or close a settlement.

| Export DTO / workbook | Exact sheets in order | Required structural rule |
|---|---|---|
| One Work | `ملخص العمل`, `سجل العناوين`, `سجل الحالة`, `متابعة`, `التحصيل` | Arabic headers in row 1, RTL sheet view, autofilter, fixed column widths, text IDs and ISO-UTC date text. |
| Month | `أعمال الشهر`, `التحصيل`, `التسوية` | Explicit Work `period_basis`; archived rows only when requested; settlement rows are immutable S7 values. |
| Follow-up log | `سجل المتابعة` | Date, event type, description, note, Work identity, and recording actor come from Work events. |
| Customer report | `تقرير العميل`, `أعمال العميل`, `التحصيل`, `التحذيرات` | Customer totals use authoritative S6/S7 aggregates and warnings use documented factual flags only. |
| Classification analysis | `حسب النوع`, `حسب التخصص`, `حسب الدولة`, `حسب الجامعة`, `حسب الفترة` | Every sheet maps exactly to the analytics DTO and retains the `UNSPECIFIED` bucket. |

Excel generation is local and dependency-pinned to the official SheetJS Community Edition `xlsx@0.20.3` distribution (Apache-2.0), vendored in the packaged source with no CDN, telemetry, credentials, external workbook links, macros, or active content. The exact vendored module bytes are recorded in `XLSX-0.20.3-SHA256.txt` (`1a0fb062ee9781b13f6687371b202aaefc53b6ce55b530c027e01f9c087b77db`) and checked against its named local module. The Worker returns authenticated authoritative DTOs; it never constructs XLSX files. Workbooks contain precomputed values rather than formulas. Authoritative money remains integer halalas in DTOs and independent test oracles. The workbook uses a numeric SAR cell only when multiplying its value by 100 recovers the original halalas exactly; otherwise it emits exact two-decimal SAR text, never a rounded float. ISO UTC timestamps and IDs are emitted as text. Formula-like user strings are serialized as literal XLSX string cells that reopen byte-for-byte unchanged, with no formula node or active content; output filenames are deterministic, ASCII-safe, extension-fixed `.xlsx`, and cannot contain a path separator.

Every generated XLSX is accepted only after programmatic reopen plus raw OOXML ZIP inspection. Tests assert exact sheet names/order, Arabic headers, row counts, cell values/types, widths, autofilter, RTL `rightToLeft` sheet-view property, no formulas, no external links, no macro payload, no secret-like metadata, exact formula-like source text, and safe deterministic filenames. Analytics and export DTO reads remain bounded below 40 D1 reads per invocation and 100 binds per query; no application-level per-Work query fan-out is permitted. Complete exports use a deterministic continuation token and a fixed page size; callers walk every page by `(created_at,id)` or `(effective_at,id)` order without a product-specific total-row ceiling. The PR-B focused test suite supplies independent synthetic fixture oracles, including 1000+ rows for continuation and N+1/bind measurements.
