import json
import logging
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


async def _replay_on_base(runner: CommandRunner, *, repo_path: str, base_branch: str, test_ids: "list[str]", scheme: str,
                          container: Optional[list], simulator_id: str, read: ReadFailures,
                          list_dir: Callable[[str], list], timeout: float) -> "set[str]":
    base_path = f"{repo_path}-base"
    if Path(base_path).exists():
        steps = [["checkout", "--detach", f"origin/{base_branch}"], ["reset", "--hard"], ["clean", "-fd"]]
        cwd = base_path
    else:
        steps = [["worktree", "add", "--force", "--detach", base_path, f"origin/{base_branch}"]]
        cwd = repo_path
    for step in steps:
        result = await runner.run(["git", *step], cwd=cwd, timeout=timeout)
        if result.exit_code != 0 or result.timed_out:
            raise RuntimeError(f"git {step[0]} failed: {result.stderr}")
    await install_dependencies(runner, repo_path=base_path, timeout=timeout, list_dir=list_dir)
    await run_build_stage(runner, repo_path=base_path, scheme=scheme, simulator_id=simulator_id, timeout=timeout, container=container)
    bundle = str(Path(tempfile.mkdtemp(prefix="owa-base-")) / "base.xcresult")
    try:
        await run_test_stage(runner, repo_path=base_path, scheme=scheme, simulator_id=simulator_id, timeout=timeout,
                             container=container, result_bundle=bundle, only_testing=test_ids)
        return set()
    except TestStageError:
        return {failure.id for failure in await read(runner, result_bundle=bundle, timeout=timeout)}
