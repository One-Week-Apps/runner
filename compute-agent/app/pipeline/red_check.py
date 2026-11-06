import logging
import re
import shutil
import tempfile
from pathlib import Path
from typing import Awaitable, Callable, NamedTuple, Optional

from app.pipeline.baseline import ReadFailures, checkout_aside
from app.pipeline.command_runner import CommandRunner
from app.pipeline.preflight import install_dependencies
from app.pipeline.screenshots import read_ran_suites
from app.pipeline.xcode_stages import BuildStageError, TestStageError, run_build_stage, run_test_stage

logger = logging.getLogger(__name__)

_CLASS = re.compile(r"class\s+(\w+)\s*:\s*XCTestCase")
_TEST = re.compile(r"func\s+(test\w*)\s*\(")


def _tests_in(text: str) -> "set[str]":
    """"Class/method" for every test method, each under the last test class declared before it."""
    marks = sorted([(m.start(), "class", m.group(1)) for m in _CLASS.finditer(text)]
                   + [(m.start(), "test", m.group(1)) for m in _TEST.finditer(text)])
    found, current = set(), None
    for _, kind, name in marks:
        if kind == "class":
            current = name
        elif current:
            found.add(f"{current}/{name}")
    return found


def _is_test_file(path: str) -> bool:
    return path.split("/")[0].endswith("Tests")


async def _stdout(runner: CommandRunner, args: list, *, cwd: str, timeout: float) -> Optional[str]:
    result = await runner.run(args, cwd=cwd, timeout=timeout)
    return None if result.exit_code != 0 or result.timed_out else result.stdout


async def new_tests(runner: CommandRunner, *, repo_path: str, base_branch: str, timeout: float,
                    read_text: Optional[Callable[[str], str]] = None) -> "list[str]":
    """Test methods the task added, as "Target/Class/method" (the target comes from the folder, by Xcode convention)."""
    read = read_text or (lambda rel: (Path(repo_path) / rel).read_text(encoding="utf-8", errors="replace"))
    names = await _stdout(runner, ["git", "diff", "--name-only", f"origin/{base_branch}", "HEAD", "--", "*.swift"], cwd=repo_path, timeout=timeout)
    added = []
    for path in (names or "").split():
        if "/" not in path or path.startswith("Pods/"):
            continue
        try:
            text = read(path)
        except OSError:
            continue
        if "XCTestCase" not in text:
            continue
        before = await _stdout(runner, ["git", "show", f"origin/{base_branch}:{path}"], cwd=repo_path, timeout=timeout) or ""
        target = path.split("/")[0]
        added += [f"{target}/{test}" for test in sorted(_tests_in(text) - _tests_in(before))]
    return added


class RedCheck(NamedTuple):
    """`vacuous`: the task's new tests that check nothing. `before`: what `keep` drew from the red bundle (the old screens)."""
    vacuous: "list[str]"
    before: list


async def green_without_the_change(
    runner: CommandRunner,
    *,
    repo_path: str,
    base_branch: str,
    test_ids: "list[str]",
    scheme: str,
    container: Optional[list],
    simulator_id: str,
    read: ReadFailures,
    list_dir: Callable[[str], list],
    timeout: float,
    keep: Optional[Callable[[str], Awaitable[list]]] = None,
) -> RedCheck:
    """The task's new tests that still pass once its changes to the app's existing files are undone: they check nothing.

    TDD's red, checked after the fact: in the side worktree, the task's commit with the app files it modified put
    back as on the base (its tests, its new files and the Xcode project stay). When that cannot be judged (nothing
    to undo, the app no longer builds, results unreadable), none: no test is blamed. `keep` reads the red bundle
    before it is deleted (videos included).
    """
    if not test_ids:
        return RedCheck([], [])
    bundle_dir: Optional[Path] = None
    before: list = []
    try:
        sha = (await _stdout(runner, ["git", "rev-parse", "HEAD"], cwd=repo_path, timeout=timeout) or "").strip()
        if not sha:
            return RedCheck([], [])
        aside = await checkout_aside(runner, repo_path=repo_path, ref=sha, timeout=timeout)
        status = await _stdout(runner, ["git", "diff", "--name-status", f"origin/{base_branch}", "HEAD"], cwd=aside, timeout=timeout) or ""
        undone = [path for kind, _, path in (line.partition("\t") for line in status.splitlines())
                  if kind == "M" and not _is_test_file(path) and not path.endswith(".pbxproj") and not path.startswith("Pods/")]
        if not undone:
            return RedCheck([], [])
        result = await runner.run(["git", "checkout", f"origin/{base_branch}", "--", *undone], cwd=aside, timeout=timeout)
        if result.exit_code != 0 or result.timed_out:
            return RedCheck([], [])
        await install_dependencies(runner, repo_path=aside, timeout=timeout, list_dir=list_dir)
        await run_build_stage(runner, repo_path=aside, scheme=scheme, simulator_id=simulator_id, timeout=timeout, container=container)
        bundle_dir = Path(tempfile.mkdtemp(prefix="owa-red-"))
        bundle = str(bundle_dir / "red.xcresult")
        try:
            await run_test_stage(runner, repo_path=aside, scheme=scheme, simulator_id=simulator_id, timeout=timeout,
                                 container=container, result_bundle=bundle, only_testing=test_ids)
            failed, unbuilt = set(), False
        except TestStageError:
            failed = {failure.id for failure in await read(runner, result_bundle=bundle, timeout=timeout)}
            unbuilt = not failed
        if keep:
            try:
                before = await keep(bundle)
            except Exception:
                logger.warning("Could not read the screens before the task", exc_info=True)
        if unbuilt:
            return RedCheck([], before)  # the tests did not even build without the change: that is red too
        ran = await read_ran_suites(runner, result_bundle=bundle, timeout=timeout)
        if ran is None:
            return RedCheck([], before)
        return RedCheck([test for test in test_ids if test not in failed and test.split("/")[1] in ran], before)
    except BuildStageError:
        return RedCheck([], before)
    except Exception:
        logger.warning("Could not check the task's new tests without its change", exc_info=True)
        return RedCheck([], before)
    finally:
        if bundle_dir:
            shutil.rmtree(bundle_dir, ignore_errors=True)
