---
title: "🚨 Nightly security scan failed"
labels: security, automated, nightly
---

The nightly security workflow failed at 03:00 UTC. One or more of `gitleaks`, `trivy`, or `osv-scanner` reported a regression in the current state of `main`.

**Run:** {{ env.RUN_URL }}

**Triage steps:**

1. Open the failed job(s) in the linked run.
2. If `gitleaks` red: a secret may have landed in history via a non-PR merge. Rotate the credential immediately, then `git filter-repo` to purge.
3. If `trivy` red: a dependency / OS-package CVE was newly published. Bump the dep or document in `.trivyignore` with rationale + un-ignore date.
4. If `osv-scanner` red: a dep CVE was newly published. Same options.

This issue is updated (not duplicated) by `JasonEtco/create-an-issue@v2` if the next nightly also fails. Close it manually after the run goes green.

Reference: [story-07 spec](../docs/stories/story-07-security-workflow.md).
