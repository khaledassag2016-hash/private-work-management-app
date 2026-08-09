# Stable Checkpoint Policy

This policy defines how a known-good repository state is promoted, verified, and recovered. It applies to governance work and does not authorize Cloud, Firebase, Cloudflare, deployment, or billing operations.

## Promotion

A commit is not stable merely because it was merged. Promotion requires all of the following for the same final head SHA:

1. CI passes on the final PR head.
2. A human supervisor reviews and approves the result.
3. The approved SHA is recorded in PROJECT_STATE.md.
4. An explicit stable checkpoint branch or tag is created in a separate, supervised action.

The PR that records a checkpoint does not make later PRs stable automatically. A new head requires a new promotion decision and checkpoint.

## Immutable stable refs

Stable branches and tags are immutable references. Force-push to stable refs and deletion of stable branches or tags are prohibited. This policy does not create or move a stable ref automatically; it only verifies the expected ref and commit locally.

## Final-head CI

CI results are valid only when they test the final head SHA under review. If documentation or code changes after a successful run, CI must run again on the new final head before promotion. A synthetic PR merge check does not replace recording the actual PR head SHA for governance review.

## Human approval

Automation can report evidence, compare refs, and run local validation. It cannot grant supervisory approval, declare a commit stable, or create a stable tag. Human approval must be explicit and recorded with the SHA.

## Recovery

When a sequence of changes is suspect, do not repair main with a force reset. Start a recovery branch from the last stable checkpoint, validate that recovered worktree, and reintroduce changes through ordinary PR review. The recovery branch is not stable until it independently satisfies promotion gates.

## Main protection

Models and agents must not work directly on main. Work starts from a stable checkpoint, or from main only after an explicit verification of the intended base. Changes reach main through a reviewed PR; no local tool in this repository moves main, stable refs, tags, or remote state.
