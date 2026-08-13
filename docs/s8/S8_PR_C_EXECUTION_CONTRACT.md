# S8 PR-C Execution Contract

This contract governs S8 PR-C only. The branch starts from `main@2b5170b3e7f5161f6ebe9118dc89672791895167`; PR-A and PR-B are inherited and are not rewritten. PR-C adds SPA integration and acceptance evidence without a broad redesign.

The SPA may call only the authenticated Worker routes already provided by S8: `GET /api/search/works`, `GET /api/analytics`, and the read-only `/api/exports/*` DTO routes. It must use explicit `period_basis` for period-scoped reads, preserve deterministic pagination cursors, and render `UNSPECIFIED` classifications without mutating the underlying Work. Search and analytics must present `is_archived` and must not count archived Works in active-only totals. Historical views may include archived Works only when the user explicitly enables the historical scope.

Financial cells and labels remain projections of S6/S7 authority. The SPA does not calculate price, paid, remaining, collection status, settlement, transfer, subscription, expense, or balance truth locally. It refetches authoritative DTOs after any inherited mutation. Alert clocks remain fail-closed exactly as `S8_ALERT_CLOCK_ANCHOR_BLOCKED = NO_PRICE | NO_REPLY | NO_PAYMENT`; PR-C must not invent anchors or claim `FR-029 PASS`.

Export actions use the local PR-B XLSX generator with no CDN or network dependency. The acceptance path is UI action → authenticated DTO request → local `generateS8Workbook(dto)` → XLSX reopen and raw OOXML checks. Formula-like source text must reopen unchanged as a literal string, money must preserve integer halalas, Arabic sheet names and RTL views must remain intact, and continuation pages must be assembled without omission or a product-specific row ceiling.

Acceptance evidence covers search/filter interaction, deterministic pages, historical archive presentation, analytics period/classification views, all five export DTO types, real XLSX structure/security, S6/S7 financial truth, fail-closed alert state, authenticated envelopes, and full S4–S8 regression. No Cloud writes, Billing, PR-D, S9, or merge is part of PR-C.
