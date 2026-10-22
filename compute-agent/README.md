# Compute agent

FastAPI service that runs one task on the Mac: managed clone, Claude Code, `xcodebuild` build and UI tests on
simulators, screenshot export, then a callback to the Runner orchestrator. It only listens on `127.0.0.1`.

## Run

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000
```

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8000` | Used to build screenshot URLs |
| `SELF_BASE_URL` | `http://127.0.0.1:<PORT>` | Base URL of the screenshots returned in the callback |
| `SCREENSHOTS_DIR` | `screenshots/` | Where screenshots are exported |
| `JOB_TIMEOUT_SECONDS` | `900` | Timeout applied to each stage separately |
| `AITASKER_REPOS_DIR` | `~/.aitasker/repos` | Managed clones |

## API

| Method | Route | Description |
|---|---|---|
| GET | `/health` | Liveness check |
| POST | `/jobs` | Starts a job and returns `202` at once |
| GET | `/screenshots/{job_id}/{file}.png` | Screenshots exported from the UI tests |

## Pipeline

Each job runs these stages; any of them can stop the job and trigger a failure callback:

1. **Simulator**: an iPhone already booted, else the one last opened in the Simulator app, else a compact
   reference iPhone, always on the newest iOS runtime. It stays booted for the next attempt.
2. **Checkout**: clone under `AITASKER_REPOS_DIR`, task branch created from `origin/<base>` or resumed, then
   merged with the latest base (conflicts are handed to Claude Code first). `pod install` only when Pods are stale.
3. **Instructions**: fetched from the orchestrator while the repository is prepared; the raw task otherwise.
4. **Dev**: `claude -p` with an allowlist of tools and `--setting-sources project,local`.
5. **Build**: `xcodebuild build-for-testing` once.
6. **Test**: `xcodebuild test-without-building`, skipping UI tests the task did not touch. Failing tests are
   replayed on the base branch in a separate worktree (cached per base commit) to tell pre-existing failures apart.
7. **Screenshots**: PNG attachments exported with `xcresulttool`, with the VoiceOver reading order attached by
   `app/resources/AITaskerCapture.swift`.
8. **Commit and push** the attempt, even when the build or tests fail, so the next attempt builds on it.

## Test

```bash
.venv/bin/ruff check app tests
.venv/bin/pytest
```
