# Production deployment

The executable source of truth is `.github/workflows/production-deployment.yml`, backed by `deployment/production/production-manifest.json` and `deployment/production/deploy.mjs`. Do not reconstruct or run an alternative production command sequence.

## One-time repository setup

- Store a least-privilege Cloudflare token as the repository secret `CLOUDFLARE_API_TOKEN`.
- Configure the GitHub environment `production` with the required supervisory reviewer and the environment secret `PRODUCTION_APPROVAL_GUARD=enabled`. The promotion job fails closed unless that protected environment is configured.

## Release

1. Merge an approved PR only after **Production deployment guardrails / guard** passes.
2. From `main`, run **Production deployment guardrails** once and enter the approved PR or hotfix reference.
3. The workflow validates the locked target, builds the governed `/assets/...` layout, records the current 100% version as the rollback target, uploads a Candidate, holds it at 0%, and tests assets, `/app-config.js`, Firebase bootstrap, and the visible login form through Version Override.
4. Review the Candidate and rollback IDs shown at the `production` environment gate, then approve once. The workflow promotes the same Candidate to 100% and repeats the smoke checks. A failed post-promotion check triggers one rollback to the saved version and no repair attempt.

The workflow never runs D1 migrations, modifies Firebase or DNS, creates resources, or enables billing. Intentional production target, binding, or observability changes require a separate reviewed manifest change; otherwise parity fails closed.
