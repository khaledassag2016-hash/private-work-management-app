# PROJECT_SUPERVISION_BRIEF

> Operational supervisory handoff. This file does not replace the governing Word requirements or dated decisions.

## 1. Governing order

1. `docs/APPROVED_REQUIREMENTS.docx` — SHA-256 `6cb2e99449deb287b2008baf23e091efe45a89f3edfb15df721c933271d6b65b`, size 63710 bytes.
2. `docs/DECISION_LOG.md`.
3. `PROJECT_STATE.md`.
4. `docs/TRACEABILITY_MATRIX.md`.
5. Current stage Issue, execution contract and PR evidence.

Never substitute conversation memory, an agent report or `docs/REQUIREMENTS.md` for the governing Word file.

## 2. Current stage state

- `S1 = CLOSED_COMPLETE`.
- `S2 = CLOSED_COMPLETE`.
- `S3 = CLOSED_BLOCKED_DEFERRED` under D-008; not S3 COMPLETE.
- `S4 = CLOSED_COMPLETE`.
- `S5 = CLOSED_COMPLETE`.
- `S6 = CLOSED_COMPLETE`.
- `S7 = CLOSED_COMPLETE` after PR #77 final-head CI, Squash merge, post-merge verification and Issue #6 closure.
- `S8 = CLOSED_COMPLETE` after PR #78/#79/#80 plus PR #81 administrative closure, final-head CI, Squash merge, post-merge verification and Issue #7 closure.
- `S9 = CLOSED_COMPLETE` after PR #82 plus the S9 administrative closure PR complete applicable final-head CI, Squash merge, post-merge verification and Issue #8 closure.
- `S10 = AUTHORIZED_NOT_STARTED` only after the S9 closure condition is effective and a `FINAL_ACTIVATED` S10 package is tied to the exact final S9 main SHA.
- `S11 = NOT_STARTED`; private/local historical preparation is not S11 import execution.

## 3. S5/S6 evidence retained

S5: PR #68/#69 implementation and PR #70 final verification. Work events, title/status history, cancel/archive dual approval, no hard delete and execution/collection separation remain regression-protected. Evidence: `docs/s5/S5_FINAL_VERIFICATION.md`.

S6: PR #71/#72 implementation and PR #73 final verification. Authoritative pricing movements, 30/70 plus dual-approved exceptions, D-012 rounding and bounded D1 list/similar reads remain regression-protected. Final S6 main before S7: `12a4520ea62e8fb32cd33519bf4b12137d43576b`. Evidence: `docs/s6/S6_FINAL_VERIFICATION.md`.

The unresolved S6 negative-final-price policy remains fail-closed.

## 4. S7 final evidence retained

### PR-A #74 — Payments / Collections / Reversals

- Final head `c3387b772ee457bfb88d7ec3dc06090947776dd7`.
- Squash/main `1e1637451bdd1e63ad82a6782cb1fa2b010cb347`.
- Final-head CI: Foundation `31631306517`, S2 `31631306390`, S3 `31631306391` SUCCESS.
- D-010 reversal is append-only, two-account approved and original payment remains immutable.

### PR-B #75 — Transfers / Subscriptions / Expenses / Settlement Core

- Final head `d52254bafcd9dcec2dda454dbef869caee6b4117`.
- Squash/main `0eb382f7146cb1730e64a37bec1bb46876f500b8`.
- Final-head CI: Foundation `31638405137`, S2 `31638405056`, S3 `31638405045` SUCCESS.
- Node `116/116`; PR-B focused `15/15`.
- D1 settlement `8` reads/max bind `71`; transfer/subscription/common-expense lists `1` each.

### PR-C #76 — Financial UI / Business Flows / Integrated Acceptance

- Final head `1f15df2c6605b007d32d7698f604d948b42e4a91`.
- Squash/main `7539b8289b75e3702d19d84fb29c04f20a98d0e6`.
- Final-head CI: Foundation `31641996434`, S2 `31641996429`, S3 `31641996442` SUCCESS.
- Focused `9/9`; full Node `125/125`.
- Post-merge Foundation `31642292225`, S3 `31642292237` SUCCESS.

### PR-D #77 — S7 Final Closure

- Evidence `docs/s7/S7_FINAL_VERIFICATION.md`.
- Final S7 main `ad482ec0dc78ba5796797d40223beb6d6fed0f5b`.
- Issue #6 closed completed.

## 5. S7 authoritative behavior inherited by later stages

- Ordinary payment belongs to exactly one Work.
- Payment correction/cancellation uses D-010 reversal; original facts are not rewritten or deleted.
- Work settlement membership uses nullable authoritative `confirmed_at` only; unconfirmed Work is outside monthly settlement.
- Approved receipts affect settlement according to actual `received_by`; `recorded_by` remains separately auditable.
- `final_balance_halalas > 0` means person_1 owes person_2; negative means the reverse.
- Prior balance is the latest valid prior monthly settlement final balance; reopened prior snapshots are invalid until reclosed.
- Monthly close is soft; exceptional reopen requires the other account under D-011.
- Exactly two subscriptions; current baseline aggregate 13,650 halalas. Do not invent names or individual amounts.
- Subscription changes/cancellation recorded in month M affect settlement month M+1; no daily prorating.
- P-02: person_2 pays subscriptions, shared half/half.
- P-03: person_1 pays transfer fees, shared half/half.
- P-04: Work ratio is applied to authoritative current Work price before shared subscription/fee/expense settlement effects.
- Generic shared-expense allocation without an approved rule stays fail-closed for settlement closing.
- Overpayment beyond remaining stays `S7_OVERPAYMENT_POLICY_UNRESOLVED` fail-closed.

## 6. S8 final evidence chain

### PR-A #78 — Search / Filters / Alert Core

- Final head `5613ef052eb430ccfb469afaceee58181f864f7c`.
- Squash/main `7128b65a23c11589e068680980dd52bb1c004d3a`.
- Final-head CI: Foundation `31687193878`, S2 `31687193877`, S3 `31687193869` SUCCESS.
- Full Node `133/133`.
- Post-merge Foundation `31687592908`, S3 `31687592858` SUCCESS.
- Search is deterministic/bounded, explicit period basis is required for period-scoped reads, archive/current are separated, classifications remain dynamic and missing classification is output-only `UNSPECIFIED`.

### PR-B #79 — Analytics / Export Core

- Final head `f6819c46a76506443514a063d59c861486361850`.
- Squash/main `2b5170b3e7f5161f6ebe9118dc89672791895167`.
- Final-head CI: Foundation `31692056002`, S2 `31692055997`, S3 `31692055987` SUCCESS.
- Full Node after repair `139/139`; real XLSX all five report types PASS.
- Local vendored SheetJS `0.20.3`; no CDN, paid SaaS, telemetry, key or Billing dependency.
- Post-merge Foundation `31692600422`, S3 `31692600458` SUCCESS.

### PR-C #80 — SPA / Authenticated E2E / D-017

- Base `2b5170b3e7f5161f6ebe9118dc89672791895167`.
- Final head `a73531ed3fafb5c1cc89a598389ca9f98ef05260`.
- Squash/main `19856a4b8a31b9e756406ccda0f16ac169af236d`.
- Final-head CI: Foundation `31695541782`, S2 `31695541807`, S3 `31695541798` SUCCESS.
- Focused D-017 search/alert `8/8`; analytics/export `6/6`; authenticated E2E `1/1`; full Node `140/140`.
- E2E path: UI → signed JWT → actual Worker auth/API envelope → authoritative DTO → local real XLSX.
- D-017 implements FR-029 with authoritative anchors, configurable thresholds, no defaults and no client-controlled clock.
- Archive/title history, active-only exclusion, historical inclusion, analytics reconciliation and all five exports are covered.
- Customer export complete totals are repaired and verified beyond a single page.
- Post-merge Foundation `31695925778` SUCCESS; S3 `31695925794` SUCCESS.

### PR-D #81 — S8 Final Verification / Administrative Closure

- Evidence `docs/s8/S8_FINAL_VERIFICATION.md`.
- Final S8 main `5808415e2f5f8710beaacf3dc0496d3645f70d77`.
- Issue #7 closed completed.

## 7. S8 authoritative behavior inherited by S9+

- Search current/old title and explicit historical archive scope are authoritative S8 read behaviors.
- Archived Works are retained and may appear in historical search/analytics but are excluded from active-only counts.
- Analytics and exports consume S6/S7 authoritative financial fields; the SPA does not calculate an alternative financial truth.
- Export DTOs are authenticated, bounded and deterministic; XLSX is generated locally from authoritative DTOs.
- Real XLSX is Arabic RTL, structurally verified, formula-free, macro-free and external-link-free; formula-like source text remains literal.
- D-017: NO_PRICE from `created_at` while PRICE_UNSET; NO_REPLY from latest transition into WAITING_CLIENT_RESPONSE or initial `created_at`; NO_PAYMENT from authoritative `confirmed_at` for positive-price confirmed Work while approved receipts remain zero.
- Alert thresholds have no default values and are stored/configured explicitly.

## 8. S9 final evidence and inherited UX contract

### PR-A #82 — Zero-manual UX automated acceptance

- Base main `5808415e2f5f8710beaacf3dc0496d3645f70d77`.
- Codex handoff head `ec759af7474336f3b358d0e6a0c263e91e0a498d`; Codex stopped before Manus ownership.
- Manus final reviewed head `0eeb902068dc6b411ce3780d96998578ed5dac3e`; Manus stopped before supervisory merge.
- Manus repair was limited to New Work modal focus restoration in both mirrored assets plus deterministic regression.
- Final-head S9 UX Acceptance `31709356193` SUCCESS.
- Final-head S3 CPU Gate Static `31709356421` SUCCESS.
- Final-head S2 architecture validation `31709356846` SUCCESS.
- Playwright Level A `10 PASS`; Level B `34 PASS + 6 intentional non-applicable skips`.
- Full Node regression `140 PASS`, `0 failed`.
- Foundation validator passed locally on the final head; its GitHub workflow is path-scoped and was not applicable to S9 runtime/test files.
- Squash/main `7a19bcdd0c85838a6c5e764e86b1a51e76fde0b7`.
- Post-merge S3 `31710108330` SUCCESS.
- Evidence: `docs/s9/S9_FINAL_VERIFICATION.md`.

### S9 inherited UX contract

- Arabic RTL direction and responsive containment are deterministic acceptance properties.
- Mobile/desktop function capability parity A–M is regression-protected.
- Critical interactive controls on mobile meet the automated touch-target gate.
- Keyboard focus is contained in dialogs and restored to the invoker on close.
- Automated accessibility gate rejects critical/serious axe violations for covered surfaces.
- Sensitive governed mutations require effect confirmation before request transmission.
- Duplicate click/tap/Enter while a mutation is pending must not create a second mutation.
- 400/401/403/409/fail-closed/500/network errors remain visible, recoverable and preserve user input where covered.
- D-018 replaced manual viewport QA for S9 only; snapshots alone never establish acceptance.
- D-019 was S9 PR-A only and does not automatically authorize a Codex↔Manus handoff in S10.

## 9. Architecture and zero-cost constraints

- API: Cloudflare Workers Free.
- Static UI: Cloudflare Workers Static Assets.
- Database: Cloudflare D1 Free via internal binding.
- Authentication: Firebase Auth Spark, Email/Password, two supervisor-created accounts only.
- Private APIs fail closed; browser never connects directly to D1.
- No mandatory Billing, card, PayGo or paid service.
- Money is integer halalas within the JavaScript safe-integer range; no floating-point financial truth.
- No Cloud writes are authorized merely by starting a software stage.

## 10. Permanent delivery rules

- Never edit `main` directly.
- Independent branch + PR for every stage/change.
- Final-head CI is required; Squash merge only.
- A stage is not complete until acceptance, prior-stage regression, `PROJECT_STATE.md` update and post-merge verification.
- Never commit real customer data, passwords, tokens or service keys.
- Do not invent unresolved product policy; fail closed, defer or request a governing decision.
- Stable refs never move automatically.
- Except where a dated scoped decision explicitly permits sequential handoff, coding agents must not push concurrently to the same PR.
- Avoid repeated supervisory stop loops: executor self-repairs within one PR; supervision performs one consolidated final review, at most one consolidated repair batch for discovered defects, then targeted recheck + full regression + final-head CI and immediate merge if clean.

## 11. S10 activation boundary

Issue #9 is `[S10] اختبار التكامل والنسخ والاستعادة`.

Core S10 scope is full-system integration, security/permissions, concurrency/conflicting edits, authoritative financial/reversal/closed-settlement verification, reproducible backup plus actual restore into a separate isolated target, and deterministic performance evidence for two users with multi-year synthetic data.

S10 re-verifies AC-01..AC-14 as an integration report. It must not silently implement S3-deferred AC-11/FR-026 or S11-assigned AC-14/P-07 merely to force a PASS. If the governing sources still leave a cross-stage acceptance conflict at activation time, the S10 package must report that item explicitly and fail closed for supervisory resolution rather than invent scope.

S10 may use only synthetic/local data unless separately authorized. Backup/restore acceptance must prove an actual restore into a distinct empty local D1-compatible/SQLite target and reconcile authoritative rows/history/financial truth and representative API reads; checking a backup file's existence is insufficient.

No numeric latency SLA exists in the governing sources. S10 may measure p50/p95/max/query counts on a deterministic multi-year profile and fail on correctness/security/financial regression, crash/timeout or unbounded/N+1 behavior; it must not invent a millisecond threshold.

S10 starts only from the exact final `main` SHA produced by the S9 administrative closure PR and only under a separately issued S10 `FINAL_ACTIVATED` package tied to that SHA. Preferred executor may be Manus, but no S9-only D-019 handoff is assumed.

## 12. Stable refs

- `stable/2026-08-09-be14a389` -> `be14a389d7e11f1df9f935999d888e7e2295c8a3`.
- `stable/2026-08-09-643de962` -> `643de962dc8631f68a42e3796c4a096a29c4e14c`.

Do not move them without a separate explicit stable-promotion decision.
