from typing import Optional, Union

from app.pipeline.command_runner import CommandRunner


class BuildStageError(Exception):
    pass


class TestStageError(Exception):
    __test__ = False  # not a pytest test class


def _destination(simulator_id: str) -> str:
    return f"platform=iOS Simulator,id={simulator_id}"


def _destinations(simulator_id: Union[str, list]) -> list:
    ids = [simulator_id] if isinstance(simulator_id, str) else list(simulator_id)
    return [arg for udid in ids for arg in ("-destination", _destination(udid))]


async def run_build_stage(
    runner: CommandRunner,
    *,
    repo_path: str,
    scheme: str,
    simulator_id: str,
    timeout: float,
    container: Optional[list] = None,
) -> None:
    result = await runner.run(
        ["xcodebuild", "build-for-testing", *(container or []), "-scheme", scheme, "-destination", _destination(simulator_id)],
        cwd=repo_path,
        timeout=timeout,
    )
    if result.timed_out:
        raise BuildStageError("xcodebuild build timed out")
    if result.exit_code != 0:
        raise BuildStageError(f"xcodebuild build failed: {result.stderr or result.stdout}")


async def run_test_stage(
    runner: CommandRunner,
    *,
    repo_path: str,
    scheme: str,
    simulator_id: Union[str, list],
    timeout: float,
    container: Optional[list] = None,
    result_bundle: Optional[str] = None,
    skip_testing: Optional[list] = None,
    only_testing: Optional[list] = None,
) -> None:
    """Runs the tests already compiled by build-for-testing, without recompiling.

    Parallel testing is off, otherwise xcodebuild cold-boots simulator clones instead of using the one
    already running. Diagnostics collection is off: it cost ~35 s after a failure, and failures are
    already in the result bundle (measured: 96 s → 55 s).
    """
    bundle_args = ["-resultBundlePath", result_bundle] if result_bundle else []
    skip_args = [f"-skip-testing:{name}" for name in skip_testing or []]
    skip_args += [f"-only-testing:{name}" for name in only_testing or []]
    result = await runner.run(
        [
            "xcodebuild", "test-without-building", *(container or []), "-scheme", scheme, *_destinations(simulator_id),
            "-parallel-testing-enabled", "NO", "-collect-test-diagnostics", "never", *bundle_args, *skip_args,
        ],
        cwd=repo_path,
        timeout=timeout,
    )
    if result.timed_out:
        raise TestStageError("xcodebuild test timed out")
    if result.exit_code != 0:
        raise TestStageError(f"xcodebuild test failed: {result.stderr or result.stdout}")
