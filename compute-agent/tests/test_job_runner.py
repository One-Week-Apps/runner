import json
from typing import Optional
from unittest.mock import AsyncMock

import pytest

import app.job_runner as job_runner_module
from app.job_runner import run_job
from app.models import JobRequest
from app.pipeline.command_runner import CommandResult
from app.pipeline.screenshots import Failure

SIMCTL_OUTPUT = json.dumps({"devices": {"com.apple.CoreSimulator.SimRuntime.iOS-27-0": [{"name": "iPhone 17e", "udid": "E", "state": "Booted"}]}})
XCODEBUILD_LIST_OUTPUT = json.dumps({"project": {"name": "MyApp", "schemes": ["MyApp"]}})

SAMPLE_JOB = JobRequest.model_validate(
    {
        "jobId": "job-1",
        "feature": {
            "description": "Add a settings screen",
            "repo": "/repo",
            "branch": "main",
            "attemptNumber": 0,
            "instruction": "initial_dev",
            "lastFeedback": None,
        },
        "callbackUrl": "http://localhost:3939/api/jobs/job-1/callback",
    }
)


class FakeCommandRunner:
    def __init__(self, overrides: Optional[dict] = None) -> None:
        self.overrides = overrides or {}
        self.calls: "list[list[str]]" = []
        self._default_responses = {
            ("xcrun", "simctl"): CommandResult(0, SIMCTL_OUTPUT, ""),
            ("xcodebuild", "-list"): CommandResult(0, XCODEBUILD_LIST_OUTPUT, ""),
            ("git", "fetch"): CommandResult(0, "", ""),
            ("git", "checkout"): CommandResult(0, "", ""),
            ("pod", "install"): CommandResult(0, "", ""),
            ("git", "clone"): CommandResult(0, "", ""),
            ("git", "reset"): CommandResult(0, "", ""),
            ("git", "clean"): CommandResult(0, "", ""),
            ("git", "rev-parse"): CommandResult(1, "", ""),
            ("git", "status"): CommandResult(0, " M App.swift\n", ""),
            ("git", "add"): CommandResult(0, "", ""),
            ("git", "commit"): CommandResult(0, "", ""),
            ("git", "push"): CommandResult(0, "", ""),
            ("git", "diff"): CommandResult(0, "", ""),
            ("git", "worktree"): CommandResult(0, "", ""),
            ("git", "merge"): CommandResult(0, "", ""),
            ("git", "branch"): CommandResult(0, "", ""),
            ("git", "ls-files"): CommandResult(0, "", ""),
            ("defaults", "read"): CommandResult(1, "", ""),
            ("claude", "-p"): CommandResult(0, json.dumps({"is_error": False}), ""),
            ("xcodebuild", "build-for-testing"): CommandResult(0, "BUILD SUCCEEDED", ""),
            ("xcodebuild", "test-without-building"): CommandResult(0, "TEST SUCCEEDED", ""),
        }

    async def run(self, args, *, cwd: Optional[str] = None, timeout: float):
        self.calls.append(list(args))
        prefix = tuple(args[:2])
        if prefix in self.overrides:
            return self.overrides[prefix]
        if prefix in self._default_responses:
            return self._default_responses[prefix]
        raise AssertionError(f"Unexpected command: {args}")

    def was_called_with_prefix(self, *prefix: str) -> bool:
        return any(call[: len(prefix)] == list(prefix) for call in self.calls)


@pytest.fixture(autouse=True)
def mock_post_callback(monkeypatch: pytest.MonkeyPatch):
    mock = AsyncMock()
    monkeypatch.setattr(job_runner_module, "post_callback", mock)
    return mock


async def test_preflight_failure_reports_pending_pending(mock_post_callback):
    runner = FakeCommandRunner(overrides={("xcrun", "simctl"): CommandResult(1, "", "no simctl")})

    await run_job(SAMPLE_JOB, runner=runner, timeout_seconds=10)

    mock_post_callback.assert_awaited_once()
    body = mock_post_callback.await_args.args[1]
    assert body.outcome == "failure"
    assert body.build_status == "pending"
    assert body.test_status == "pending"
    assert body.nodes == []
    assert not runner.was_called_with_prefix("git", "fetch")


async def test_checkout_failure_reports_pending_pending(mock_post_callback):
    runner = FakeCommandRunner(overrides={("git", "fetch"): CommandResult(1, "", "no network")})

    await run_job(SAMPLE_JOB, runner=runner, timeout_seconds=10)

    body = mock_post_callback.await_args.args[1]
    assert body.outcome == "failure"
    assert body.build_status == "pending"
    assert body.test_status == "pending"
    assert not runner.was_called_with_prefix("claude", "-p")


async def test_dev_failure_reports_pending_pending(mock_post_callback):
    runner = FakeCommandRunner(overrides={("claude", "-p"): CommandResult(1, "", "claude failed")})

    await run_job(SAMPLE_JOB, runner=runner, timeout_seconds=10)

    body = mock_post_callback.await_args.args[1]
    assert body.outcome == "failure"
    assert body.build_status == "pending"
    assert body.test_status == "pending"
    assert not runner.was_called_with_prefix("xcodebuild", "build-for-testing")
    assert body.dev_error == "claude failed"


async def test_build_failure_reports_failed_pending(mock_post_callback):
    runner = FakeCommandRunner(
        overrides={("xcodebuild", "build-for-testing"): CommandResult(65, "", "BUILD FAILED")}
    )

    await run_job(SAMPLE_JOB, runner=runner, timeout_seconds=10)

    body = mock_post_callback.await_args.args[1]
    assert body.outcome == "failure"
    assert body.build_status == "failed"
    assert body.test_status == "pending"
    assert not runner.was_called_with_prefix("xcodebuild", "test-without-building")


async def test_test_failure_reports_passed_failed(mock_post_callback):
    runner = FakeCommandRunner(
        overrides={("xcodebuild", "test-without-building"): CommandResult(65, "", "TEST FAILED")}
    )

    await run_job(SAMPLE_JOB, runner=runner, timeout_seconds=10)

    body = mock_post_callback.await_args.args[1]
    assert body.outcome == "failure"
    assert body.build_status == "passed"
    assert body.test_status == "failed"


async def test_all_stages_succeed_reports_success(mock_post_callback):
    runner = FakeCommandRunner()

    await run_job(SAMPLE_JOB, runner=runner, timeout_seconds=10)

    body = mock_post_callback.await_args.args[1]
    assert body.outcome == "success"
    assert body.build_status == "passed"
    assert body.test_status == "passed"
    assert body.nodes == []



async def test_project_is_inspected_after_checkout_and_pods_are_installed(mock_post_callback):
    runner = FakeCommandRunner()

    await run_job(SAMPLE_JOB, runner=runner, timeout_seconds=10, list_dir=lambda _: ["Podfile", "MyApp.xcworkspace"])

    order = [tuple(call[:2]) for call in runner.calls]
    assert order.index(("git", "checkout")) < order.index(("pod", "install")) < order.index(("xcodebuild", "-list"))
    build = next(call for call in runner.calls if call[:2] == ["xcodebuild", "build-for-testing"])
    assert build[2:4] == ["-workspace", "MyApp.xcworkspace"]
    assert mock_post_callback.await_args.args[1].outcome == "success"



async def test_success_callback_carries_the_screenshots_of_the_ui_tests(mock_post_callback, tmp_path, monkeypatch):
    from app.models import NodeCapture

    captured = {}

    async def fake_export(runner, *, result_bundle, output_dir, base_url, job_id, timeout):
        captured.update(result_bundle=result_bundle, output_dir=str(output_dir), base_url=base_url, job_id=job_id)
        return [NodeCapture(node_id="FirstScreen", screenshot_url=f"{base_url}/screenshots/{job_id}/a.png", action=None, captured_at="now")]

    monkeypatch.setattr(job_runner_module, "export_screenshots", fake_export)
    runner = FakeCommandRunner()

    await run_job(SAMPLE_JOB, runner=runner, timeout_seconds=10, screenshots_dir=tmp_path, base_url="http://mac:8000")

    test_call = next(call for call in runner.calls if call[:2] == ["xcodebuild", "test-without-building"])
    assert test_call[test_call.index("-resultBundlePath") + 1] == str(tmp_path / "job-1" / "result.xcresult")
    body = mock_post_callback.await_args.args[1]
    assert [n.screenshot_url for n in body.nodes] == ["http://mac:8000/screenshots/job-1/a.png"]
    assert captured["output_dir"] == str(tmp_path / "job-1")



MANAGED_JOB = JobRequest.model_validate(
    {
        "jobId": "job-7",
        "feature": {
            "description": "Agrandir le bouton Jouer",
            "repo": "One-Week-Apps/EscapeFromBlindness",
            "cloneUrl": "https://github.com/One-Week-Apps/EscapeFromBlindness.git",
            "branch": "aitasker/issue-7",
            "baseBranch": "chore/xcode27",
            "attemptNumber": 1,
            "instruction": "iteration_feedback",
            "lastFeedback": "KO 1.2 : toujours trop petit",
        },
        "callbackUrl": "http://localhost:3939/api/jobs/job-7/callback",
    }
)


async def test_managed_job_works_in_its_own_clone_and_commits_the_attempt(mock_post_callback, tmp_path):
    runner = FakeCommandRunner()

    await run_job(MANAGED_JOB, runner=runner, timeout_seconds=10, repos_dir=tmp_path)

    order = [tuple(c[:2]) for c in runner.calls]
    assert order.index(("git", "clone")) < order.index(("claude", "-p")) < order.index(("git", "commit"))
    commit = next(c for c in runner.calls if c[:2] == ["git", "commit"])
    assert commit[-1].startswith("aitasker: tentative 2")
    assert mock_post_callback.await_args.args[1].outcome == "success"


async def test_managed_job_commits_even_when_the_build_fails(mock_post_callback, tmp_path):
    runner = FakeCommandRunner(overrides={("xcodebuild", "build-for-testing"): CommandResult(65, "", "error")})

    await run_job(MANAGED_JOB, runner=runner, timeout_seconds=10, repos_dir=tmp_path)

    assert runner.was_called_with_prefix("git", "commit")
    assert mock_post_callback.await_args.args[1].build_status == "failed"



async def test_managed_job_pushes_the_issue_branch_after_committing(mock_post_callback, tmp_path):
    runner = FakeCommandRunner()

    await run_job(MANAGED_JOB, runner=runner, timeout_seconds=10, repos_dir=tmp_path)

    order = [tuple(c[:2]) for c in runner.calls]
    assert order.index(("git", "commit")) < order.index(("git", "push"))
    push = next(c for c in runner.calls if c[:2] == ["git", "push"])
    assert push == ["git", "push", "-u", "origin", "aitasker/issue-7"]


async def test_nothing_to_commit_means_nothing_to_push(mock_post_callback, tmp_path):
    runner = FakeCommandRunner(overrides={("git", "status"): CommandResult(0, "", "")})

    await run_job(MANAGED_JOB, runner=runner, timeout_seconds=10, repos_dir=tmp_path)

    assert not runner.was_called_with_prefix("git", "push")



async def test_progress_is_reported_at_each_stage(mock_post_callback, tmp_path, monkeypatch):
    events = []

    async def fake_progress(url, stage, status, detail=None):
        events.append((url, stage, status))

    monkeypatch.setattr(job_runner_module, "post_progress", fake_progress)
    job = MANAGED_JOB.model_copy(update={"progress_url": "http://localhost:3939/api/issue-jobs/job-7/progress"})

    await run_job(job, runner=FakeCommandRunner(), timeout_seconds=10, repos_dir=tmp_path)

    assert {url for url, _, _ in events} == {"http://localhost:3939/api/issue-jobs/job-7/progress"}
    assert [(stage, status) for _, stage, status in events] == [
        ("checkout", "started"), ("checkout", "passed"),
        ("dev", "started"), ("dev", "passed"),
        ("build", "started"), ("build", "passed"),
        ("test", "started"), ("test", "passed"),
    ]


async def test_failed_build_is_reported_and_progress_errors_never_break_the_job(mock_post_callback, tmp_path, monkeypatch):
    events = []

    async def flaky_progress(url, stage, status, detail=None):
        events.append((stage, status))
        raise RuntimeError("Focus injoignable")

    monkeypatch.setattr(job_runner_module, "post_progress", flaky_progress)
    job = MANAGED_JOB.model_copy(update={"progress_url": "http://x/progress"})
    runner = FakeCommandRunner(overrides={("xcodebuild", "build-for-testing"): CommandResult(65, "", "error")})

    await run_job(job, runner=runner, timeout_seconds=10, repos_dir=tmp_path)

    assert ("build", "failed") in events
    assert mock_post_callback.await_args.args[1].build_status == "failed"


async def test_no_progress_url_means_no_progress_calls(mock_post_callback, tmp_path, monkeypatch):
    calls = []

    async def recording(url, stage, status, detail=None):
        calls.append(stage)

    monkeypatch.setattr(job_runner_module, "post_progress", recording)

    await run_job(MANAGED_JOB, runner=FakeCommandRunner(), timeout_seconds=10, repos_dir=tmp_path)

    assert calls == []


async def test_failed_tests_are_named_in_the_callback(mock_post_callback, tmp_path, monkeypatch):
    async def fake_export(runner, **kwargs):
        return []

    async def fake_failed(runner, *, result_bundle, timeout):
        return [Failure("AppTests/LoadLevelViewControllerTests/test_subtitle", "LoadLevelViewControllerTests/test_subtitle : nil")]

    monkeypatch.setattr(job_runner_module, "export_screenshots", fake_export)
    monkeypatch.setattr(job_runner_module, "read_failures", fake_failed)
    runner = FakeCommandRunner(overrides={("xcodebuild", "test-without-building"): CommandResult(65, "", "TEST FAILED")})

    await run_job(SAMPLE_JOB, runner=runner, timeout_seconds=10, screenshots_dir=tmp_path, base_url="http://mac:8000")

    body = mock_post_callback.await_args.args[1]
    assert body.test_status == "failed"
    assert body.failed_tests == ["LoadLevelViewControllerTests/test_subtitle : nil"]
    assert body.model_dump(by_alias=True)["failedTests"] == body.failed_tests


async def test_the_commit_is_titled_with_the_task_not_the_instructions(mock_post_callback, tmp_path):
    job = MANAGED_JOB.model_copy(update={"feature": MANAGED_JOB.feature.model_copy(update={
        "title": "Agrandir le bouton Jouer (#7)", "description": "# Consignes\n1. Ajoute…",
    })})
    runner = FakeCommandRunner()

    await run_job(job, runner=runner, timeout_seconds=10, repos_dir=tmp_path)

    commit = next(c for c in runner.calls if c[:2] == ["git", "commit"])
    assert commit[-1] == "aitasker: tentative 2 — Agrandir le bouton Jouer (#7)"


async def test_the_brains_plan_picks_tests_and_devices(mock_post_callback, tmp_path, monkeypatch):
    async def skip_all_but_the_task(runner, **kwargs):
        return ["AppUITests/LevelSelectionUITests"]

    monkeypatch.setattr(job_runner_module, "ui_tests_to_skip", skip_all_but_the_task)

    runner = FakeCommandRunner()
    await run_job(MANAGED_JOB, runner=runner, timeout_seconds=10, repos_dir=tmp_path)
    test_call = next(c for c in runner.calls if c[:2] == ["xcodebuild", "test-without-building"])
    assert "-skip-testing:AppUITests/LevelSelectionUITests" in test_call
    assert test_call.count("-destination") == 1

    everything = MANAGED_JOB.model_copy(update={"feature": MANAGED_JOB.feature.model_copy(update={"ui_tests": "all"})})
    runner = FakeCommandRunner()
    await run_job(everything, runner=runner, timeout_seconds=10, repos_dir=tmp_path)
    test_call = next(c for c in runner.calls if c[:2] == ["xcodebuild", "test-without-building"])
    assert not any(a.startswith("-skip-testing") for a in test_call)



async def test_changed_files_are_published_during_dev(mock_post_callback, tmp_path, monkeypatch):
    import asyncio
    events = []

    async def fake_progress(url, stage, status, detail=None):
        events.append((stage, status, detail))

    class SlowClaude(FakeCommandRunner):
        async def run(self, args, *, cwd=None, timeout):
            if args[:2] == ["claude", "-p"]:
                await asyncio.sleep(0.05)
            return await super().run(args, cwd=cwd, timeout=timeout)

    monkeypatch.setattr(job_runner_module, "post_progress", fake_progress)
    job = MANAGED_JOB.model_copy(update={"progress_url": "http://x/progress"})

    await run_job(job, runner=SlowClaude(), timeout_seconds=10, repos_dir=tmp_path, dev_watch_seconds=0.01)

    assert ("dev", "started", "1 fichier modifié : App.swift") in events
    assert events.index(("dev", "started", "1 fichier modifié : App.swift")) < events.index(("dev", "passed", None))


def test_changes_are_summarized_in_one_line():
    from app.job_runner import describe_changes
    assert describe_changes([]) is None
    assert describe_changes(["App/A.swift", "App/B.swift", "C.swift", "D.swift", "E.swift"]) == "5 fichiers modifiés : A.swift, B.swift, C.swift et 2 autres"


async def test_the_brains_instructions_arrive_during_preparation(mock_post_callback, tmp_path, monkeypatch):
    order = []

    async def fake_fetch(url, *, timeout, poll_seconds=2.0):
        order.append(("fetch", url))
        return {"description": "CONSIGNES du cerveau", "uiTests": "all", "devices": "main"}

    monkeypatch.setattr(job_runner_module, "fetch_instructions", fake_fetch)
    job = MANAGED_JOB.model_copy(update={"instructions_url": "http://focus/api/issue-jobs/job-7/instructions"})
    runner = FakeCommandRunner()

    await run_job(job, runner=runner, timeout_seconds=10, repos_dir=tmp_path)

    calls = [tuple(c[:2]) for c in runner.calls]
    assert order == [("fetch", "http://focus/api/issue-jobs/job-7/instructions")]
    assert calls.index(("git", "clone")) < calls.index(("claude", "-p"))
    claude = next(c for c in runner.calls if c[:2] == ["claude", "-p"])
    assert "CONSIGNES du cerveau" in claude[2]
    test_call = next(c for c in runner.calls if c[:2] == ["xcodebuild", "test-without-building"])
    assert not any(a.startswith("-skip-testing") for a in test_call)


async def test_without_instructions_the_job_runs_the_raw_task(mock_post_callback, tmp_path, monkeypatch):
    async def no_brief(url, *, timeout, poll_seconds=2.0):
        return None

    monkeypatch.setattr(job_runner_module, "fetch_instructions", no_brief)
    job = MANAGED_JOB.model_copy(update={"instructions_url": "http://focus/x"})
    runner = FakeCommandRunner()

    await run_job(job, runner=runner, timeout_seconds=10, repos_dir=tmp_path)

    claude = next(c for c in runner.calls if c[:2] == ["claude", "-p"])
    assert "Agrandir le bouton Jouer" in claude[2]


async def test_without_instructions_the_mac_reports_it(mock_post_callback, tmp_path, monkeypatch):
    events = []

    async def no_brief(url, *, timeout, poll_seconds=2.0):
        return None

    async def fake_progress(url, step, status, detail=None):
        events.append((step, status))

    monkeypatch.setattr(job_runner_module, "fetch_instructions", no_brief)
    monkeypatch.setattr(job_runner_module, "post_progress", fake_progress)
    job = MANAGED_JOB.model_copy(update={"instructions_url": "http://focus/x", "progress_url": "http://focus/progress"})

    await run_job(job, runner=FakeCommandRunner(), timeout_seconds=10, repos_dir=tmp_path)

    assert ("brief", "failed") in events
    assert events.index(("brief", "failed")) < events.index(("dev", "started"))


async def test_fetch_instructions_waits_then_returns_them():
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    from app.job_runner import fetch_instructions

    hits = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            hits.append(self.path)
            ready = len(hits) >= 2 and self.path.endswith("/ok")
            self.send_response(200 if ready else (202 if self.path.endswith("/ok") else 404))
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"description":"CONSIGNES","uiTests":"task","devices":"main"}' if ready else b"{}")

        def log_message(self, *args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_port}"
    try:
        assert await fetch_instructions(f"{base}/ok", timeout=5, poll_seconds=0.01) == {"description": "CONSIGNES", "uiTests": "task", "devices": "main"}
        assert await fetch_instructions(f"{base}/inconnu", timeout=5, poll_seconds=0.01) is None
    finally:
        server.shutdown()


async def test_screenshots_from_the_tasks_ui_tests_are_flagged(mock_post_callback, tmp_path, monkeypatch):
    from app.models import NodeCapture

    async def fake_export(runner, *, result_bundle, output_dir, base_url, job_id, timeout):
        return [
            NodeCapture(node_id="FirstScreen", screenshot_url="u1", action="AppUITests/testLaunch()", captured_at="t1"),
            NodeCapture(node_id="Accueil", screenshot_url="u2", action="HomeVersionUITests/testVersion()", captured_at="t2"),
        ]

    async def touched(runner, **kwargs):
        return ["AppUITests/HomeVersionUITests"]

    monkeypatch.setattr(job_runner_module, "export_screenshots", fake_export)
    monkeypatch.setattr(job_runner_module, "task_ui_tests", touched)

    await run_job(MANAGED_JOB, runner=FakeCommandRunner(), timeout_seconds=10, repos_dir=tmp_path / "repos", screenshots_dir=tmp_path / "shots", base_url="http://mac:8000")

    body = mock_post_callback.await_args.args[1]
    assert [(n.node_id, n.for_task) for n in body.nodes] == [("FirstScreen", False), ("Accueil", True)]
    assert body.model_dump(by_alias=True)["nodes"][1]["forTask"] is True


async def test_the_task_diff_is_sent_after_the_commit(mock_post_callback, tmp_path):
    runner = FakeCommandRunner(overrides={("git", "diff"): CommandResult(0, "diff --git a/A.swift b/A.swift\n+ .bold()\n", "")})

    await run_job(MANAGED_JOB, runner=runner, timeout_seconds=10, repos_dir=tmp_path)

    # The Runner's capture helper is refreshed on every branch: it is not the task's code, reviewers never see it.
    task_diff = ["git", "diff", "origin/chore/xcode27...HEAD", "--", ".", ":(exclude)**/AITaskerCapture.swift"]
    assert task_diff in runner.calls
    assert runner.calls.index(task_diff) > next(i for i, c in enumerate(runner.calls) if c[:2] == ["git", "commit"])
    assert mock_post_callback.await_args.args[1].diff == "diff --git a/A.swift b/A.swift\n+ .bold()\n"


async def test_a_huge_diff_is_cut_before_sending(mock_post_callback, tmp_path):
    runner = FakeCommandRunner(overrides={("git", "diff"): CommandResult(0, "x" * 500_000, "")})

    await run_job(MANAGED_JOB, runner=runner, timeout_seconds=10, repos_dir=tmp_path)

    assert len(mock_post_callback.await_args.args[1].diff) == 200_000


async def test_claude_codes_cost_is_reported(mock_post_callback, tmp_path):
    runner = FakeCommandRunner(overrides={("claude", "-p"): CommandResult(0, json.dumps({"is_error": False, "total_cost_usd": 1.25}), "")})

    await run_job(MANAGED_JOB, runner=runner, timeout_seconds=10, repos_dir=tmp_path)

    body = mock_post_callback.await_args.args[1]
    assert body.dev_cost_usd == 1.25
    assert body.model_dump(by_alias=True)["devCostUsd"] == 1.25


OLD = Failure("Tests/HomeVersionLabelTests/test_version", "HomeVersionLabelTests/test_version (iPhone 17e) : XCTAssertTrue failed")
NEW = Failure("Tests/InstructionsTests/test_hint", "InstructionsTests/test_hint (iPhone 17e) : hint absent")


def failing(monkeypatch, on_task, on_base):
    """Failures read from the result bundle: the task's, or the base branch's."""
    async def fake_export(runner, **kwargs):
        return []

    async def fake_read(runner, *, result_bundle, timeout):
        return on_base if "base" in result_bundle else on_task

    monkeypatch.setattr(job_runner_module, "export_screenshots", fake_export)
    monkeypatch.setattr(job_runner_module, "read_failures", fake_read)


def red_tests_runner():
    return FakeCommandRunner(overrides={
        ("xcodebuild", "test-without-building"): CommandResult(65, "", "TEST FAILED"),
        ("git", "rev-parse"): CommandResult(0, "abc123\n", ""),
    })


async def test_a_test_already_failing_on_the_base_is_not_the_tasks_failure(mock_post_callback, tmp_path, monkeypatch):
    failing(monkeypatch, on_task=[OLD, NEW], on_base=[OLD])
    runner = red_tests_runner()

    await run_job(MANAGED_JOB, runner=runner, timeout_seconds=10, repos_dir=tmp_path, screenshots_dir=tmp_path / "shots")

    body = mock_post_callback.await_args.args[1]
    assert body.failed_tests == [NEW.label]
    assert body.preexisting_failures == [OLD.label]
    assert body.test_status == "failed"
    base_run = [c for c in runner.calls if c[:2] == ["xcodebuild", "test-without-building"]][-1]
    assert "-only-testing:Tests/HomeVersionLabelTests/test_version" in base_run
    assert "-only-testing:Tests/InstructionsTests/test_hint" in base_run


async def test_only_preexisting_failures_means_the_task_passes(mock_post_callback, tmp_path, monkeypatch):
    failing(monkeypatch, on_task=[OLD], on_base=[OLD])

    await run_job(MANAGED_JOB, runner=red_tests_runner(), timeout_seconds=10, repos_dir=tmp_path, screenshots_dir=tmp_path / "shots")

    body = mock_post_callback.await_args.args[1]
    assert body.test_status == "passed"
    assert body.outcome == "success"
    assert body.failed_tests == []
    assert body.model_dump(by_alias=True)["preexistingFailures"] == [OLD.label]


async def test_the_base_is_checked_once_per_commit(mock_post_callback, tmp_path, monkeypatch):
    failing(monkeypatch, on_task=[OLD], on_base=[OLD])
    runner = red_tests_runner()

    await run_job(MANAGED_JOB, runner=runner, timeout_seconds=10, repos_dir=tmp_path, screenshots_dir=tmp_path / "shots")
    await run_job(MANAGED_JOB, runner=runner, timeout_seconds=10, repos_dir=tmp_path, screenshots_dir=tmp_path / "shots")

    builds = [c for c in runner.calls if c[:2] == ["xcodebuild", "build-for-testing"]]
    assert len(builds) == 3  # task, base, task: the base comes from the cache the second time
    assert mock_post_callback.await_args.args[1].preexisting_failures == [OLD.label]


async def test_when_the_base_cannot_be_checked_failures_stay_the_tasks(mock_post_callback, tmp_path, monkeypatch):
    failing(monkeypatch, on_task=[OLD], on_base=[OLD])
    runner = red_tests_runner()
    runner.overrides[("git", "worktree")] = CommandResult(128, "", "fatal")

    await run_job(MANAGED_JOB, runner=runner, timeout_seconds=10, repos_dir=tmp_path, screenshots_dir=tmp_path / "shots")

    body = mock_post_callback.await_args.args[1]
    assert body.failed_tests == [OLD.label]
    assert body.preexisting_failures == []


async def test_the_claude_code_session_follows_the_task(mock_post_callback, tmp_path):
    runner = FakeCommandRunner(overrides={("claude", "-p"): CommandResult(0, json.dumps({"is_error": False, "session_id": "s2"}), "")})
    job = MANAGED_JOB.model_copy(update={"feature": MANAGED_JOB.feature.model_copy(update={"resume_session": "s1"})})

    await run_job(job, runner=runner, timeout_seconds=10, repos_dir=tmp_path)

    claude = next(c for c in runner.calls if c[:2] == ["claude", "-p"])
    assert claude[claude.index("--resume") + 1] == "s1"
    assert mock_post_callback.await_args.args[1].model_dump(by_alias=True)["devSessionId"] == "s2"


async def test_conflicts_with_the_base_are_announced_to_claude_code(mock_post_callback, tmp_path):
    runner = FakeCommandRunner(overrides={
        ("git", "merge"): CommandResult(1, "CONFLICT", ""),
        ("git", "ls-files"): CommandResult(0, "100644 a1 2\tApp/Home.swift\n", ""),
        ("git", "rev-parse"): CommandResult(0, "", ""),
    })

    await run_job(MANAGED_JOB, runner=runner, timeout_seconds=10, repos_dir=tmp_path)

    prompt = next(c for c in runner.calls if c[:2] == ["claude", "-p"])[2]
    assert "conflits de fusion avec chore/xcode27" in prompt
    assert "App/Home.swift" in prompt


async def test_the_callback_flags_related_unmerged_tasks(mock_post_callback, tmp_path):
    runner = FakeCommandRunner(overrides={
        ("git", "branch"): CommandResult(0, "  origin/aitasker/issue-13\n", ""),
        ("git", "diff"): CommandResult(0, "App/Home.swift\n", ""),
    })

    await run_job(MANAGED_JOB, runner=runner, timeout_seconds=10, repos_dir=tmp_path)

    body = mock_post_callback.await_args.args[1].model_dump(by_alias=True)
    assert body["relatedBranches"] == [{"branch": "aitasker/issue-13", "files": ["Home.swift"]}]


def task_wrote(monkeypatch, tests, ran):
    """The UI tests the task wrote, and the suites xcodebuild actually ran (None: unreadable results)."""
    async def fake_export(runner, **kwargs):
        return []

    async def touched(runner, **kwargs):
        return tests

    async def fake_ran(runner, *, result_bundle, timeout):
        return ran

    monkeypatch.setattr(job_runner_module, "export_screenshots", fake_export)
    monkeypatch.setattr(job_runner_module, "task_ui_tests", touched)
    monkeypatch.setattr(job_runner_module, "read_ran_suites", fake_ran)


async def test_a_task_test_that_never_ran_fails_the_tests(mock_post_callback, tmp_path, monkeypatch):
    # EscapeFromBlindness, 2026-10-26: the file was on disk but in no target, xcodebuild said nothing.
    task_wrote(monkeypatch, ["AppUITests/NiveauxTuilesAlignementUITests", "AppUITests/ActivationUITests"],
               ran={"AppUITests", "ActivationUITests"})

    await run_job(MANAGED_JOB, runner=FakeCommandRunner(), timeout_seconds=10, repos_dir=tmp_path / "repos", screenshots_dir=tmp_path / "shots", base_url="http://mac:8000")

    body = mock_post_callback.await_args.args[1]
    assert body.outcome == "failure"
    assert body.test_status == "failed"
    assert body.failed_tests == [
        "NiveauxTuilesAlignementUITests n'a pas tourné : son fichier n'est dans aucune cible de tests du projet. "
        "Ajoute-le à la cible des tests UI, ou supprime le fichier s'il ne sert plus",
    ]


async def test_task_tests_that_ran_keep_the_tests_green(mock_post_callback, tmp_path, monkeypatch):
    task_wrote(monkeypatch, ["AppUITests/ActivationUITests"], ran={"ActivationUITests"})

    await run_job(MANAGED_JOB, runner=FakeCommandRunner(), timeout_seconds=10, repos_dir=tmp_path / "repos", screenshots_dir=tmp_path / "shots", base_url="http://mac:8000")

    assert mock_post_callback.await_args.args[1].test_status == "passed"


async def test_unreadable_results_never_fail_the_task(mock_post_callback, tmp_path, monkeypatch):
    task_wrote(monkeypatch, ["AppUITests/ActivationUITests"], ran=None)

    await run_job(MANAGED_JOB, runner=FakeCommandRunner(), timeout_seconds=10, repos_dir=tmp_path / "repos", screenshots_dir=tmp_path / "shots", base_url="http://mac:8000")

    assert mock_post_callback.await_args.args[1].test_status == "passed"
