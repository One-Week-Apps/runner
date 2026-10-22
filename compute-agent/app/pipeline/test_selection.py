import os
import re
from typing import Callable, Optional

from app.pipeline.command_runner import CommandRunner

_TEST_CLASS = re.compile(r"class\s+(\w+)\s*:\s*XCTestCase")


def _read_text(path: str) -> str:
    with open(path, encoding="utf-8", errors="replace") as handle:
        return handle.read()


async def _lines(runner: CommandRunner, args: list, *, cwd: str, timeout: float) -> list:
    result = await runner.run(args, cwd=cwd, timeout=timeout)
    if result.exit_code != 0 or result.timed_out:
        return []
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


async def _ui_test_classes(runner: CommandRunner, *, repo_path: str, base_branch: str, timeout: float,
                           read_text: Optional[Callable[[str], str]]) -> "tuple[dict, set]":
    """All UI test classes ("Target/Class" → file) and the Swift files the task touched."""
    read = read_text or (lambda rel: _read_text(os.path.join(repo_path, rel)))
    swift = ["--", "*.swift"]
    changed = set(await _lines(runner, ["git", "diff", "--name-only", f"origin/{base_branch}", *swift], cwd=repo_path, timeout=timeout))
    changed |= set(await _lines(runner, ["git", "ls-files", "--others", "--exclude-standard", *swift], cwd=repo_path, timeout=timeout))
    tracked = await _lines(runner, ["git", "ls-files", *swift], cwd=repo_path, timeout=timeout)

    ui_classes = {}
    for path in set(tracked) | changed:
        if "/" not in path or path.startswith("Pods/"):
            continue
        try:
            text = read(path)
        except (OSError, KeyError):
            continue
        if "XCUIApplication" not in text:
            continue
        target = path.split("/")[0]
        for cls in _TEST_CLASS.findall(text):
            ui_classes[f"{target}/{cls}"] = path
    return ui_classes, changed


async def task_ui_tests(
    runner: CommandRunner,
    *,
    repo_path: str,
    base_branch: str,
    timeout: float,
    read_text: Optional[Callable[[str], str]] = None,
) -> list:
    """UI test classes the task wrote or changed: their screenshots show the target screen."""
    ui_classes, changed = await _ui_test_classes(runner, repo_path=repo_path, base_branch=base_branch, timeout=timeout, read_text=read_text)
    return sorted(name for name, path in ui_classes.items() if path in changed)


async def ui_tests_to_skip(
    runner: CommandRunner,
    *,
    repo_path: str,
    base_branch: str,
    timeout: float,
    read_text: Optional[Callable[[str], str]] = None,
) -> list:
    """UI test classes the task did not touch, as "Target/Class" for -skip-testing.

    Unit tests always run (a few seconds). If the task touched no UI test, nothing is skipped: better
    to replay everything than to show nothing. The target comes from the folder, by Xcode convention
    ("AppUITests/…"). `read_text` reads a path relative to the repository.
    """
    ui_classes, changed = await _ui_test_classes(runner, repo_path=repo_path, base_branch=base_branch, timeout=timeout, read_text=read_text)
    selected = {name for name, path in ui_classes.items() if path in changed}
    if not selected:
        return []
    return sorted(name for name in ui_classes if name not in selected)
