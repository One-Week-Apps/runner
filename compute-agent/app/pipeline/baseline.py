import json
import logging
import shutil
import tempfile
from pathlib import Path
from typing import Awaitable, Callable, Optional

from app.pipeline.command_runner import CommandRunner
from app.pipeline.preflight import install_dependencies
from app.pipeline.screenshots import Failure
from app.pipeline.xcode_stages import TestStageError, run_build_stage, run_test_stage

logger = logging.getLogger(__name__)

ReadFailures = Callable[..., Awaitable["list[Failure]"]]


async def failing_on_base(
    runner: CommandRunner,
    *,
    repo_path: str,
    base_branch: str,
    test_ids: "list[str]",
    scheme: str,
    container: Optional[list],
    simulator_id: str,
    cache_dir: Path,
    read: ReadFailures,
    list_dir: Callable[[str], list],
    timeout: float,
) -> "set[str]":
    """Among the task's failing tests, those that already failed on the base branch.

    Replayed once per base commit in a separate git worktree, with the result cached. When the base
    cannot be checked, none: the failures stay the task's.
    """
    try:
        sha_result = await runner.run(["git", "rev-parse", f"origin/{base_branch}"], cwd=repo_path, timeout=timeout)
        sha = sha_result.stdout.strip()
        if sha_result.exit_code != 0 or not sha:
            return set()
        cache_file = Path(cache_dir) / f"{sha}.json"
        known = json.loads(cache_file.read_text()) if cache_file.exists() else {}
        missing = [test for test in test_ids if test not in known]
        if missing:
            failed = await _replay_on_base(
                runner, repo_path=repo_path, base_branch=base_branch, test_ids=missing, scheme=scheme,
                container=container, simulator_id=simulator_id, read=read, list_dir=list_dir, timeout=timeout,
            )
            known.update({test: test in failed for test in missing})
            cache_file.parent.mkdir(parents=True, exist_ok=True)
            cache_file.write_text(json.dumps(known))
        return {test for test in test_ids if known.get(test)}
    except Exception:
        logger.warning("Could not check failing tests against %s", base_branch, exc_info=True)
        return set()


async def checkout_aside(runner: CommandRunner, *, repo_path: str, ref: str, timeout: float) -> str:
    """`ref` checked out in the clone's side worktree (`<clone>-base`), clean: the task's own clone stays untouched."""
    base_path = f"{repo_path}-base"
    if Path(base_path).exists():
        # Cleaned first: the red check leaves the base's app files there, and checkout would refuse to overwrite them.
        steps = [["reset", "--hard"], ["clean", "-fd"], ["checkout", "--detach", ref]]
        cwd = base_path
    else:
        steps = [["worktree", "add", "--force", "--detach", base_path, ref]]
        cwd = repo_path
    for step in steps:
        result = await runner.run(["git", *step], cwd=cwd, timeout=timeout)
        if result.exit_code != 0 or result.timed_out:
            raise RuntimeError(f"git {step[0]} failed: {result.stderr}")
    return base_path


async def _replay_on_base(runner: CommandRunner, *, repo_path: str, base_branch: str, test_ids: "list[str]", scheme: str,
                          container: Optional[list], simulator_id: str, read: ReadFailures,
                          list_dir: Callable[[str], list], timeout: float) -> "set[str]":
    base_path = await checkout_aside(runner, repo_path=repo_path, ref=f"origin/{base_branch}", timeout=timeout)
    await install_dependencies(runner, repo_path=base_path, timeout=timeout, list_dir=list_dir)
    await run_build_stage(runner, repo_path=base_path, scheme=scheme, simulator_id=simulator_id, timeout=timeout, container=container)
    bundle_dir = Path(tempfile.mkdtemp(prefix="owa-base-"))
    bundle = str(bundle_dir / "base.xcresult")
    try:
        await run_test_stage(runner, repo_path=base_path, scheme=scheme, simulator_id=simulator_id, timeout=timeout,
                             container=container, result_bundle=bundle, only_testing=test_ids)
        return set()
    except TestStageError:
        return {failure.id for failure in await read(runner, result_bundle=bundle, timeout=timeout)}
    finally:
        # Only the failures matter: the bundle (videos of failing UI tests included) is not kept.
        shutil.rmtree(bundle_dir, ignore_errors=True)
