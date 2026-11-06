import json
from pathlib import Path
from typing import Optional

from app.pipeline.command_runner import CommandResult
from app.pipeline.red_check import green_without_the_change, new_tests
from app.pipeline.screenshots import Failure

OK = CommandResult(0, "", "")
BASE_TEST = "final class HomeTests: XCTestCase {\n    func testTitle() {}\n}\n"
TASK_TEST = (BASE_TEST.replace("}\n}", "}\n    func testChapterTitleWraps() {}\n}")
             + "final class ChapterUITests: XCTestCase {\n    func testLongTitle() { XCUIApplication() }\n}\n")


class ScriptedRunner:
    """Answers by command prefix, the longest first, and records every call with its folder."""

    def __init__(self, responses: Optional[dict] = None) -> None:
        self.responses = responses or {}
        self.calls: "list[tuple[list[str], Optional[str]]]" = []

    async def run(self, args, *, cwd: Optional[str] = None, timeout: float):
        self.calls.append((list(args), cwd))
        for prefix in sorted(self.responses, key=len, reverse=True):
            if tuple(args[: len(prefix)]) == prefix:
                return self.responses[prefix]
        return OK

    def commands(self, *prefix: str) -> "list[list[str]]":
        return [args for args, _ in self.calls if tuple(args[: len(prefix)]) == prefix]


def ran(*suites: str) -> CommandResult:
    cases = [{"nodeType": "Test Suite", "name": s, "children": [{"nodeType": "Test Case", "name": "t()"}]} for s in suites]
    return CommandResult(0, json.dumps({"testNodes": [{"nodeType": "Unit test bundle", "name": "EFBTests", "children": cases}]}), "")


async def no_failures(runner, *, result_bundle, timeout):
    return []


async def test_only_the_test_methods_the_task_added_count(tmp_path):
    runner = ScriptedRunner({
        ("git", "diff"): CommandResult(0, "EFB/Home/HomeView.swift\nEFBTests/HomeTests.swift\n", ""),
        ("git", "show"): CommandResult(0, BASE_TEST, ""),
    })
    files = {"EFB/Home/HomeView.swift": "struct HomeView {}", "EFBTests/HomeTests.swift": TASK_TEST}

    found = await new_tests(runner, repo_path=str(tmp_path), base_branch="master", timeout=10, read_text=files.__getitem__)

    assert found == ["EFBTests/ChapterUITests/testLongTitle", "EFBTests/HomeTests/testChapterTitleWraps"]
    assert runner.commands("git", "show") == [["git", "show", "origin/master:EFBTests/HomeTests.swift"]]


def red_runner(overrides: Optional[dict] = None) -> ScriptedRunner:
    return ScriptedRunner({
        ("git", "rev-parse"): CommandResult(0, "abc123\n", ""),
        ("git", "diff", "--name-status"): CommandResult(0, "M\tEFB/Home/ChapterCell.swift\nA\tEFB/Home/Wrap.swift\n"
                                                           "M\tEFBTests/HomeTests.swift\nM\tEFB.xcodeproj/project.pbxproj\n", ""),
        ("xcrun", "xcresulttool"): ran("HomeTests"),
        **(overrides or {}),
    })


async def red(runner, tmp_path, read=no_failures, keep=None):
    return await green_without_the_change(
        runner, repo_path=str(tmp_path / "EFB"), base_branch="master",
        test_ids=["EFBTests/HomeTests/testChapterTitleWraps", "EFBTests/HomeTests/testLineCount"],
        scheme="EFB", container=None, simulator_id="SIM", read=read, list_dir=lambda _: [], timeout=10, keep=keep,
    )


async def check(runner, tmp_path, read=no_failures):
    return (await red(runner, tmp_path, read)).vacuous


async def test_a_new_test_that_passes_on_the_old_app_code_checks_nothing(tmp_path):
    runner = red_runner({("xcodebuild", "test-without-building"): CommandResult(65, "", "TEST FAILED")})

    async def read(runner, *, result_bundle, timeout):
        return [Failure("EFBTests/HomeTests/testLineCount", "HomeTests/testLineCount : 1 != 2")]

    assert await check(runner, tmp_path, read) == ["EFBTests/HomeTests/testChapterTitleWraps"]
    # Only the app files the task modified go back to the base: its tests, new files and Xcode project stay.
    assert runner.commands("git", "checkout", "origin/master") == [["git", "checkout", "origin/master", "--", "EFB/Home/ChapterCell.swift"]]
    assert runner.commands("git", "worktree") == [["git", "worktree", "add", "--force", "--detach", str(tmp_path / "EFB-base"), "abc123"]]
    assert "-only-testing:EFBTests/HomeTests/testChapterTitleWraps" in runner.commands("xcodebuild", "test-without-building")[0]


async def test_new_tests_that_fail_without_the_change_are_red_as_they_should(tmp_path):
    runner = red_runner({("xcodebuild", "test-without-building"): CommandResult(65, "", "TEST FAILED")})

    async def read(runner, *, result_bundle, timeout):
        return [Failure(f"EFBTests/HomeTests/{t}", t) for t in ("testChapterTitleWraps", "testLineCount")]

    assert await check(runner, tmp_path, read) == []


async def test_nothing_is_blamed_when_it_cannot_be_judged(tmp_path):
    # The app no longer builds without the change, the tests do not build, nothing to undo, a test that did not run.
    assert await check(red_runner({("xcodebuild", "build-for-testing"): CommandResult(65, "", "BUILD FAILED")}), tmp_path) == []
    assert await check(red_runner({("xcodebuild", "test-without-building"): CommandResult(65, "", "TEST FAILED")}), tmp_path) == []
    assert await check(red_runner({("git", "diff", "--name-status"): CommandResult(0, "A\tEFB/Home/Wrap.swift\n", "")}), tmp_path) == []
    assert await check(red_runner({("xcrun", "xcresulttool"): ran("OtherTests")}), tmp_path) == []


async def test_the_side_worktree_is_cleaned_before_switching_commits(tmp_path):
    # EscapeFromBlindness#17, 2026-11-06: the previous check left the base's app files there, and checkout refused.
    (tmp_path / "EFB-base").mkdir()
    runner = red_runner({("xcodebuild", "test-without-building"): CommandResult(65, "", "TEST FAILED")})

    await check(runner, tmp_path)

    in_aside = [args[1] for args, cwd in runner.calls if cwd == str(tmp_path / "EFB-base") and args[0] == "git"]
    assert in_aside[:3] == ["reset", "clean", "checkout"]


async def test_the_screens_before_the_task_are_kept_from_the_red_bundle_which_is_then_deleted(tmp_path):
    runner = red_runner({("xcodebuild", "test-without-building"): CommandResult(65, "", "TEST FAILED")})
    seen = []

    async def read(runner, *, result_bundle, timeout):
        return [Failure(f"EFBTests/HomeTests/{t}", t) for t in ("testChapterTitleWraps", "testLineCount")]

    async def keep(bundle):
        seen.append(bundle)
        return ["avant"]

    result = await red(runner, tmp_path, read, keep)

    assert result.before == ["avant"]
    assert seen and seen[0].endswith("red.xcresult")
    assert not Path(seen[0]).parent.exists()


async def test_no_red_check_means_no_before(tmp_path):
    runner = red_runner({("git", "diff", "--name-status"): CommandResult(0, "A\tEFB/Home/Wrap.swift\n", "")})

    async def keep(bundle):
        raise AssertionError("no bundle to read")

    assert (await red(runner, tmp_path, keep=keep)).before == []
