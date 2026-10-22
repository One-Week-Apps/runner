"""Fast path: simulator already booted, a single build, only the task's UI tests."""
import json
from typing import Optional

from app.pipeline.command_runner import CommandResult
from app.pipeline.preflight import install_dependencies, pick_simulators
from app.pipeline.test_selection import ui_tests_to_skip
from app.pipeline.xcode_stages import run_build_stage, run_test_stage


class ScriptedRunner:
    """Answers by command prefix and records every call."""

    def __init__(self, responses: dict) -> None:
        self.responses = responses
        self.calls: "list[list[str]]" = []

    async def run(self, args, *, cwd: Optional[str] = None, timeout: float):
        self.calls.append(list(args))
        for prefix, result in self.responses.items():
            if tuple(args[: len(prefix)]) == prefix:
                return result
        raise AssertionError(f"Unexpected command: {args}")


def simctl(devices_by_runtime: dict) -> CommandResult:
    return CommandResult(0, json.dumps({"devices": {
        f"com.apple.CoreSimulator.SimRuntime.{runtime}": [
            {"name": name, "udid": udid, "state": state} for name, udid, state in devices
        ] for runtime, devices in devices_by_runtime.items()
    }}), "")


NEWEST = "iOS-27-0"


async def test_an_already_booted_simulator_is_used_as_is():
    runner = ScriptedRunner({
        ("xcrun", "simctl", "list"): simctl({NEWEST: [("iPhone 17e", "E", "Shutdown"), ("iPhone Air", "AIR", "Booted")]}),
        ("defaults", "read"): CommandResult(0, "E\n", ""),
    })

    assert await pick_simulators(runner, devices="main", timeout=10) == ["AIR"]
    assert not any(c[:3] == ["xcrun", "simctl", "bootstatus"] for c in runner.calls)


async def test_otherwise_the_usual_simulator_is_booted_and_kept_running():
    runner = ScriptedRunner({
        ("xcrun", "simctl", "list"): simctl({NEWEST: [("iPhone 17e", "E", "Shutdown"), ("iPhone 17", "S17", "Shutdown")]}),
        ("defaults", "read"): CommandResult(0, "S17\n", ""),
        ("xcrun", "simctl", "bootstatus"): CommandResult(0, "", ""),
    })

    assert await pick_simulators(runner, devices="main", timeout=10) == ["S17"]
    assert ["xcrun", "simctl", "bootstatus", "S17", "-b"] in runner.calls
    assert not any("shutdown" in c for c in runner.calls)


async def test_a_usual_simulator_on_an_old_ios_gives_way_to_the_compact_reference():
    runner = ScriptedRunner({
        ("xcrun", "simctl", "list"): simctl({
            "iOS-18-6": [("iPhone SE (3rd generation)", "SE", "Shutdown")],
            NEWEST: [("iPhone 17e", "E", "Shutdown"), ("iPhone 18 Pro Max", "PM", "Shutdown")],
        }),
        ("defaults", "read"): CommandResult(0, "SE\n", ""),
        ("xcrun", "simctl", "bootstatus"): CommandResult(0, "", ""),
    })

    assert await pick_simulators(runner, devices="main", timeout=10) == ["E"]


async def test_both_devices_when_the_brain_asks():
    runner = ScriptedRunner({
        ("xcrun", "simctl", "list"): simctl({NEWEST: [("iPhone 17e", "E", "Booted"), ("iPhone 18 Pro Max", "PM", "Shutdown")]}),
        ("defaults", "read"): CommandResult(1, "", "absent"),
        ("xcrun", "simctl", "bootstatus"): CommandResult(0, "", ""),
    })

    assert await pick_simulators(runner, devices="both", timeout=10) == ["E", "PM"]


async def test_builds_once_then_tests_without_rebuilding_skipping_unrelated_tests():
    runner = ScriptedRunner({("xcodebuild",): CommandResult(0, "OK", "")})

    await run_build_stage(runner, repo_path="/r", scheme="App", simulator_id="S", timeout=10)
    await run_test_stage(runner, repo_path="/r", scheme="App", simulator_id=["S"], timeout=10,
                         skip_testing=["AppUITests/LevelSelectionUITests"])

    assert runner.calls[0][1] == "build-for-testing"
    assert runner.calls[1][1] == "test-without-building"
    assert "-skip-testing:AppUITests/LevelSelectionUITests" in runner.calls[1]
    flag = runner.calls[1].index("-parallel-testing-enabled")
    assert runner.calls[1][flag + 1] == "NO"
    diagnostics = runner.calls[1].index("-collect-test-diagnostics")
    assert runner.calls[1][diagnostics + 1] == "never"


FILES = {
    "AppUITests/HomeVersionUITests.swift": "import XCTest\nfinal class HomeVersionUITests: XCTestCase { let app = XCUIApplication() }",
    "AppUITests/LevelSelectionUITests.swift": "final class LevelSelectionUITests: XCTestCase { let app = XCUIApplication() }",
    "AppUITests/AppUITests.swift": "class AppUITests : XCTestCase { func t() { XCUIApplication().launch() } }",
    "AppTests/VersionTests.swift": "final class VersionTests: XCTestCase {}",
    "App/HomeViewController.swift": "final class HomeViewController {}",
}


def git_lists(changed: str, untracked: str = "") -> ScriptedRunner:
    return ScriptedRunner({
        ("git", "diff"): CommandResult(0, changed, ""),
        ("git", "ls-files", "--others"): CommandResult(0, untracked, ""),
        ("git", "ls-files"): CommandResult(0, "\n".join(FILES), ""),
    })


async def test_only_touched_ui_tests_run_unit_tests_always_do():
    runner = git_lists(changed="App/HomeViewController.swift\nAppUITests/HomeVersionUITests.swift\n")

    skip = await ui_tests_to_skip(runner, repo_path="/r", base_branch="master", timeout=10, read_text=FILES.__getitem__)

    assert sorted(skip) == ["AppUITests/AppUITests", "AppUITests/LevelSelectionUITests"]
    assert ["git", "diff", "--name-only", "origin/master"] == runner.calls[0][:4]


async def test_a_new_untracked_ui_test_file_counts_too():
    runner = git_lists(changed="App/HomeViewController.swift\n", untracked="AppUITests/HomeVersionUITests.swift\n")

    skip = await ui_tests_to_skip(runner, repo_path="/r", base_branch="master", timeout=10, read_text=FILES.__getitem__)

    assert "AppUITests/HomeVersionUITests" not in skip


async def test_without_task_ui_tests_everything_runs():
    runner = git_lists(changed="App/HomeViewController.swift\n")

    assert await ui_tests_to_skip(runner, repo_path="/r", base_branch="master", timeout=10, read_text=FILES.__getitem__) == []


async def test_pod_install_is_skipped_when_pods_are_up_to_date():
    runner = ScriptedRunner({("pod", "install"): CommandResult(0, "", "")})
    locks = {"/r/Podfile.lock": "PODS: A (1.0)", "/r/Pods/Manifest.lock": "PODS: A (1.0)"}

    await install_dependencies(runner, repo_path="/r", timeout=10, list_dir=lambda _: ["Podfile"], read_text=locks.__getitem__)
    assert runner.calls == []

    locks["/r/Pods/Manifest.lock"] = "PODS: A (0.9)"
    await install_dependencies(runner, repo_path="/r", timeout=10, list_dir=lambda _: ["Podfile"], read_text=locks.__getitem__)
    assert runner.calls == [["pod", "install"]]


async def test_the_tasks_ui_tests_are_those_the_diff_touches():
    from app.pipeline.test_selection import task_ui_tests
    runner = git_lists(changed="App/HomeViewController.swift\n", untracked="AppUITests/HomeVersionUITests.swift\n")

    assert await task_ui_tests(runner, repo_path="/r", base_branch="master", timeout=10, read_text=FILES.__getitem__) == ["AppUITests/HomeVersionUITests"]
