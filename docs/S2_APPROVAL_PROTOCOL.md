# S2 approval protocol

Status: architecture approval received on 2026-08-03; independent review corrections applied in the same branch and PR #17.

1. The recommendation, alternatives, official evidence and prototype tests were presented.
2. The user approved Cloudflare Workers Free + **Workers Static Assets** + D1 Free, with Firebase Authentication Spark for **Email/Password only**.
3. The same branch and PR #17 remain the only delivery path.
4. ADR-001 is `Accepted` and D-006 records the refined constraints.
5. Pages is fallback only; initial routing uses free `workers.dev` and does not require a paid domain.
6. The schema enforces two active users and unique active roles; provisioning cannot replace an existing pair silently.
7. The local proof covers Firebase X.509 certificates and the full negative token cases.
8. S3 cannot proceed until the 10ms Workers Free CPU gate is measured and passed; Paid/Billing is not an escape path.
9. S1 and S2 workflows must succeed on the latest synthetic PR merge revision.
10. Return PR #17 to general supervision for another independent review. Do not merge it, close Issue #1, create cloud services, or begin S3 here.
