# UAT reset safeguard

The reset capability is intentionally fail-closed. `uatResetPolicy(env)` returns `allowed: true` only when all of the following are true:

- `APP_ENVIRONMENT` is exactly `uat`;
- `ALLOW_UAT_RESET` is exactly `true`;
- `UAT_RESET_NONCE` is present and at least 16 characters long.

The current remediation does not execute a cloud reset and does not expose a production reset route. A future UAT-only operator must still require an explicit nonce check, an authenticated `person_1` actor, a dry-run report, and an append-only audit row before enabling an environment-specific reset handler.
