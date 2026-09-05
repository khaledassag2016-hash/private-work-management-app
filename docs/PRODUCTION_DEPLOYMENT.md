# Production deployment

The executable source of truth is `deployment/production/deploy.mjs`, backed by `deployment/production/production-manifest.json`. GitHub runs validation only; it has no Cloudflare token, protected deployment environment, or deployment job.

## Local OAuth-only release

Run from the approved checkout using the existing Wrangler 4.118.0 OAuth session. `CLOUDFLARE_API_TOKEN` is forbidden. The script locks `assagwork-app`, the production D1 ID, every binding, `TEST_CONTROLS=disabled`, `/app-config.js`, and the governed `/assets/...` layout.

1. Run `node deployment/production/deploy.mjs validate` after GitHub CI passes.
2. Run `node deployment/production/deploy.mjs stage`. Before any upload it requires one exact clean Git HEAD, reads the existing local OAuth token in memory only using `wrangler auth token --json`, requires exact `script-settings` parity, reads the current Worker `/subdomain` settings, and writes those exact `workers_dev` / `preview_urls` values into the generated Wrangler config. It uploads without a Preview Alias, stages one Candidate at 0%, and smoke-tests it with Version Override. If Candidate verification fails, it restores the previous version to 100% before stopping. On success it saves Candidate, rollback version, source SHA, and subdomain state in the gitignored `.deployment-state/production-candidate-state.json`, outside the rebuildable package directory.
3. After the one human approval, run `node deployment/production/deploy.mjs promote --approve <saved-candidate-version>`. Promotion requires the same clean Git HEAD and unchanged subdomain state, promotes once to 100%, repeats smoke tests, and rolls back once to the saved version if post-promotion verification fails.

Any OAuth-read failure or mismatch stops before upload or traffic change. The OAuth token is neither printed nor written to disk.

This path never runs migrations, modifies Firebase or DNS, creates resources, or enables billing. Intentional target, binding, or observability changes require a separately reviewed manifest change.
