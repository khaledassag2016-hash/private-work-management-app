# Production deployment

The executable source of truth is `deployment/production/deploy.mjs`, backed by `deployment/production/production-manifest.json`. GitHub runs validation only; it has no Cloudflare token, protected deployment environment, or deployment job.

## Local OAuth-only release

Run from the approved checkout using the existing Wrangler 4.118.0 OAuth session. `CLOUDFLARE_API_TOKEN` is forbidden. The script locks `assagwork-app`, the production D1 ID, every binding, `TEST_CONTROLS=disabled`, `/app-config.js`, and the governed `/assets/...` layout.

1. Run `node deployment/production/deploy.mjs validate` after GitHub CI passes.
2. Run `node deployment/production/deploy.mjs stage`. Before any upload it reads the existing local OAuth token in memory only using `wrangler auth token --json`, calls the read-only `script-settings` API, and requires exact observability, Logpush, and tail-consumer parity. It then stages one Candidate at 0%, smoke-tests it with Version Override, and saves the Candidate plus rollback version locally in `.deployment-dist/production-candidate-state.json`.
3. After the one human approval, run `node deployment/production/deploy.mjs promote --approve <saved-candidate-version>`. It promotes once to 100%, repeats smoke tests, and rolls back once to the saved version if post-promotion verification fails.

Any OAuth-read failure or mismatch stops before upload or traffic change. The OAuth token is neither printed nor written to disk.

This path never runs migrations, modifies Firebase or DNS, creates resources, or enables billing. Intentional target, binding, or observability changes require a separately reviewed manifest change.
