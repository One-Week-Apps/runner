import asyncio
import logging
import os
import shutil
from pathlib import Path
from typing import Callable, Literal, Optional

import httpx

from app.models import JobCallbackBody, JobRequest
from app.pipeline.baseline import failing_on_base
from app.pipeline.capture_helper import upgrade_capture_helper
from app.pipeline.claude_dev import DevStageError, run_dev_stage
from app.pipeline.command_runner import CommandRunner
from app.pipeline.preflight import (
    PreflightError,
    checkout_branch,
    detect_target,
    install_dependencies,
    pick_simulators,
)
from app.pipeline.screenshots import export_screenshots, read_failures
from app.pipeline.test_selection import task_ui_tests, ui_tests_to_skip
from app.pipeline.workspace import catch_up_with_base, commit_attempt, prepare_workspace, push_branch, related_branches, task_diff
from app.pipeline.xcode_stages import (
    BuildStageError,
    TestStageError,
    run_build_stage,
    run_test_stage,
)

logger = logging.getLogger(__name__)

Status = Literal["pending", "passed", "failed"]


async def post_callback(callback_url: str, body: JobCallbackBody) -> None:
    async with httpx.AsyncClient() as client:
        response = await client.post(callback_url, json=body.model_dump(by_alias=True), timeout=10.0)
        response.raise_for_status()


async def post_progress(progress_url: str, stage: str, status: str, detail: Optional[str] = None) -> None:
    body = {"stage": stage, "status": status, **({"detail": detail} if detail else {})}
    async with httpx.AsyncClient() as client:
        response = await client.post(progress_url, json=body, timeout=5.0)
        response.raise_for_status()


async def fetch_instructions(url: str, *, timeout: float, poll_seconds: float = 2.0) -> Optional[dict]:
    """Waits for the brain's instructions (202 while they are being written). None means: run the raw task."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    async with httpx.AsyncClient() as client:
        while loop.time() < deadline:
            try:
                response = await client.get(url, timeout=5.0)
            except httpx.HTTPError:
                return None
            if response.status_code == 200:
                return response.json()
            if response.status_code != 202:
                return None
            await asyncio.sleep(poll_seconds)
    return None


def describe_changes(files: list) -> Optional[str]:
    """Describes changed files for the developer, e.g. "3 fichiers modifiés : A.swift, B.swift, C.swift"."""
    if not files:
        return None
    names = [os.path.basename(f.rstrip("/")) for f in files]
    shown = ", ".join(names[:3]) + (f" et {len(names) - 3} autres" if len(names) > 3 else "")
    return f"{len(names)} fichier{'s' if len(names) > 1 else ''} modifié{'s' if len(names) > 1 else ''} : {shown}"


async def watch_dev(runner: CommandRunner, repo_path: str, report, interval: float) -> None:
    """While Claude Code works, publishes what changes in the repository whenever it moves."""
    last = None
    while True:
        await asyncio.sleep(interval)
        try:
            status = await runner.run(["git", "status", "--porcelain"], cwd=repo_path, timeout=10)
        except Exception:
            continue
        files = [line[3:].strip() for line in status.stdout.splitlines() if line.strip()]
        detail = describe_changes(files)
        if detail and detail != last:
            await report("dev", "started", detail)
            last = detail


async def run_job(
    job: JobRequest,
    *,
    runner: CommandRunner,
    timeout_seconds: float,
    list_dir: Callable[[str], list] = os.listdir,
    screenshots_dir: Optional[Path] = None,
    base_url: str = "",
    repos_dir: Optional[Path] = None,
    dev_watch_seconds: float = 20.0,
) -> None:
    outcome: Literal["success", "failure"] = "failure"
    build_status: Status = "pending"
    test_status: Status = "pending"
    nodes: list = []
    failures: "list[str]" = []
    preexisting: "list[str]" = []
    diff: Optional[str] = None
    dev_cost: Optional[float] = None
    dev_session: Optional[str] = None
    related: list = []
    feature = job.feature
    repo_path = feature.repo
    managed = bool(feature.clone_url and repos_dir)
    dev_done = False
    stage = "checkout"

    async def report(step: str, status: str, detail: Optional[str] = None) -> None:
        """Best-effort progress: an unreachable Runner must never fail the job."""
        nonlocal stage
        stage = step
        if not job.progress_url:
            return
        try:
            await post_progress(job.progress_url, step, status, detail)
        except Exception:
            logger.warning("Progress report failed for job %s (%s %s)", job.job_id, step, status)

    try:
        # The main simulator boots while the brain writes the instructions.
        simulator_ids = await pick_simulators(runner, devices="main" if job.instructions_url else feature.devices, timeout=timeout_seconds)

        # The project is inspected on the job's branch with Pods installed, never before checkout.
        await report("checkout", "started")
        if managed:
            repo_path = await prepare_workspace(
                runner, repos_dir=Path(repos_dir), slug=feature.repo, clone_url=feature.clone_url,
                branch=feature.branch, base_branch=feature.base_branch or "main", timeout=timeout_seconds,
            )
        else:
            await checkout_branch(runner, repo_path=repo_path, branch=feature.branch, timeout=timeout_seconds)
        conflicts: "list[str]" = []
        if managed:
            conflicts = await catch_up_with_base(runner, repo_path=repo_path, base_branch=feature.base_branch or "main", timeout=timeout_seconds)
        await install_dependencies(runner, repo_path=repo_path, timeout=timeout_seconds, list_dir=list_dir)
        if managed:
            # Update the Runner's helper (screenshots + VoiceOver reading) before Claude Code writes its tests.
            try:
                upgrade_capture_helper(repo_path)
            except OSError:
                logger.warning("Capture helper upgrade failed for job %s", job.job_id, exc_info=True)
        target = await detect_target(runner, repo_path=repo_path, timeout=timeout_seconds, list_dir=list_dir)
        await report("checkout", "passed")

        if job.instructions_url:
            brief = await fetch_instructions(job.instructions_url, timeout=min(timeout_seconds, 300))
            if brief:
                feature = feature.model_copy(update={
                    "description": brief.get("description") or feature.description,
                    "ui_tests": brief.get("uiTests", feature.ui_tests),
                    "devices": brief.get("devices", feature.devices),
                })
            else:
                # The Runner must know this attempt runs the raw task: its report will say so.
                await report("brief", "failed")
            if feature.devices == "both":
                simulator_ids = await pick_simulators(runner, devices="both", timeout=timeout_seconds)

        if conflicts:
            # The base moved on while the task waited: Claude Code resolves the conflicts first, then does the task.
            feature = feature.model_copy(update={"description": (
                f"Avant tout : résous les conflits de fusion avec {feature.base_branch or 'main'} dans "
                f"{', '.join(conflicts)} (marqueurs <<<<<<< / >>>>>>>), en gardant le travail des deux côtés.\n\n"
                f"{feature.description}")})
        dev_done = True
        await report("dev", "started")
        watcher = asyncio.get_running_loop().create_task(watch_dev(runner, repo_path, report, dev_watch_seconds)) if job.progress_url else None
        try:
            dev_cost, dev_session = await run_dev_stage(
                runner,
                repo_path=repo_path,
                description=feature.description,
                instruction=feature.instruction,
                last_feedback=feature.last_feedback,
                timeout=timeout_seconds,
                resume_session=feature.resume_session,
            )
        finally:
            if watcher:
                watcher.cancel()

        await report("dev", "passed")

        await report("build", "started")
        try:
            await run_build_stage(
                runner,
                repo_path=repo_path,
                scheme=target.scheme,
                simulator_id=simulator_ids[0],
                timeout=timeout_seconds,
                container=target.container,
            )
            build_status = "passed"
            await report("build", "passed")
        except BuildStageError:
            build_status = "failed"
            raise

        job_dir = Path(screenshots_dir) / job.job_id if screenshots_dir else None
        result_bundle = str(job_dir / "result.xcresult") if job_dir else None
        if job_dir and job_dir.exists():
            shutil.rmtree(job_dir)  # xcodebuild refuses an existing result bundle
        skip = (
            await ui_tests_to_skip(runner, repo_path=repo_path, base_branch=feature.base_branch or "main", timeout=timeout_seconds)
            if managed and feature.ui_tests == "task" else []
        )
        await report("test", "started")
        try:
            await run_test_stage(
                runner,
                repo_path=repo_path,
                scheme=target.scheme,
                simulator_id=simulator_ids,
                timeout=timeout_seconds,
                container=target.container,
                result_bundle=result_bundle,
                skip_testing=skip,
            )
            test_status = "passed"
            await report("test", "passed")
        except TestStageError:
            test_status = "failed"
            found = await read_failures(runner, result_bundle=result_bundle, timeout=timeout_seconds) if result_bundle else []
            if managed and found:
                # A test already failing before the task is not its failure: the Runner does not waste rounds on it.
                on_base = await failing_on_base(
                    runner, repo_path=repo_path, base_branch=feature.base_branch or "main",
                    test_ids=[f.id for f in found], scheme=target.scheme, container=target.container,
                    simulator_id=simulator_ids[0], cache_dir=Path(repos_dir) / ".baselines", read=read_failures,
                    list_dir=list_dir, timeout=timeout_seconds,
                )
                preexisting = [f.label for f in found if f.id in on_base]
                found = [f for f in found if f.id not in on_base]
                if preexisting and not found:
                    test_status = "passed"
                    await report("test", "passed")
            failures = [f.label for f in found]
            if test_status == "failed":
                raise
        finally:
            # Screenshots matter when a test fails too: they show where it breaks.
            if job_dir:
                await report("captures", "started")
                nodes = await export_screenshots(
                    runner, result_bundle=result_bundle, output_dir=job_dir,
                    base_url=base_url, job_id=job.job_id, timeout=timeout_seconds,
                )
                if managed:
                    # The target screen is shown by the UI tests the task wrote or changed.
                    touched = {name.split("/")[-1] for name in await task_ui_tests(
                        runner, repo_path=repo_path, base_branch=feature.base_branch or "main", timeout=timeout_seconds)}
                    nodes = [n.model_copy(update={"for_task": (n.action or "").split("/")[0] in touched}) for n in nodes]
                await report("captures", "passed")

        outcome = "success"

    except (PreflightError, DevStageError, BuildStageError, TestStageError):
        logger.exception("Job %s failed", job.job_id)
        await report(stage, "failed")
    except Exception:
        logger.exception("Job %s failed with an unexpected error", job.job_id)
        await report(stage, "failed")

    if managed and dev_done:
        # Even when the build or tests fail: the next attempt (KO) builds on this work.
        try:
            committed = await commit_attempt(
                runner, repo_path=repo_path, timeout=timeout_seconds,
                message=f"aitasker: tentative {feature.attempt_number + 1} — "
                        f"{(feature.title or feature.description.splitlines()[0])[:72]}",
            )
            if committed:
                await push_branch(runner, repo_path=repo_path, branch=feature.branch, timeout=timeout_seconds)
        except PreflightError:
            logger.exception("Could not commit or push attempt for job %s", job.job_id)
        diff = await task_diff(runner, repo_path=repo_path, base_branch=feature.base_branch or "main", timeout=timeout_seconds) or None
        try:
            related = await related_branches(runner, repo_path=repo_path, base_branch=feature.base_branch or "main",
                                             branch=feature.branch, timeout=timeout_seconds)
        except Exception:
            logger.warning("Could not list related branches for job %s", job.job_id, exc_info=True)

    body = JobCallbackBody(
        outcome=outcome,
        build_status=build_status,
        test_status=test_status,
        nodes=nodes,
        failed_tests=failures,
        preexisting_failures=preexisting,
        diff=diff,
        dev_cost_usd=dev_cost,
        dev_session_id=dev_session,
        related_branches=related,
    )

    try:
        await post_callback(job.callback_url, body)
    except Exception:
        logger.exception("Failed to post callback for job %s", job.job_id)
