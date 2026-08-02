# S1 Hotfix — Authoritative Reference Integrity

## Status

- Incident detected during the S2 entry gate on 2026-08-02.
- S2 correctly stopped before research or repository changes.
- The authoritative DOCX is known by SHA-256 `6cb2e99449deb287b2008baf23e091efe45a89f3edfb15df721c933271d6b65b` and size `63710` bytes.

## Finding

The Base64 source parts stored on `main` do not reconstruct successfully. Parts 05, 06, and 07 differ from the content derived from the approved DOCX. Therefore, the prior statement that a clean checkout of `main` could reconstruct the reference was incorrect.

## Containment

- S2 remains blocked until this hotfix is merged and independently verified.
- No attached DOCX in a chat is treated as authoritative.
- The approved binary DOCX will be stored directly at `docs/APPROVED_REQUIREMENTS.docx`.
- Validation will verify both byte size and SHA-256 directly from the tracked binary.

## Required verification before merge

1. Fetch the branch from a clean state.
2. Verify `docs/APPROVED_REQUIREMENTS.docx` is exactly 63710 bytes.
3. Verify its SHA-256 matches the approved value.
4. Run `python scripts/reconstruct_requirements.py` as a compatibility integrity check.
5. Run `python scripts/validate_foundation.py`.
6. Mutate one byte in a temporary copy and prove the integrity check fails.
7. Confirm no customer data, credentials, or service secrets are present.

## Root cause and process correction

The original S1 review relied on a locally assembled mirror rather than repeating the reconstruction from a clean post-merge `main`. Future stage reviews must include a clean-checkout or clean-export verification of every authoritative artifact after merge.
