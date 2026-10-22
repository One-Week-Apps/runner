import json
from typing import Optional

import pytest

from app.pipeline.command_runner import CommandResult
from app.pipeline.preflight import (
    PreflightError,
    checkout_branch,
)


class FakeCommandRunner:
    def __init__(self, responses: dict) -> None:
        self.responses = responses
        self.calls: "list[dict]" = []

    async def run(self, args, *, cwd: Optional[str] = None, timeout: float):
        self.calls.append({"args": list(args), "cwd": cwd, "timeout": timeout})
        key = tuple(args)
        if key not in self.responses:
            raise AssertionError(f"Unexpected command: {args}")
        return self.responses[key]


async def test_checkout_branch_runs_fetch_then_checkout():
    runner = FakeCommandRunner(
        {
            ("git", "fetch"): CommandResult(0, "", ""),
            ("git", "checkout", "main"): CommandResult(0, "", ""),
        }
    )

    await checkout_branch(runner, repo_path="/repo", branch="main", timeout=10)

    assert [call["args"] for call in runner.calls] == [
        ["git", "fetch"],
        ["git", "checkout", "main"],
    ]
    assert all(call["cwd"] == "/repo" for call in runner.calls)


async def test_checkout_branch_raises_when_fetch_fails():
    runner = FakeCommandRunner({("git", "fetch"): CommandResult(1, "", "network error")})

    with pytest.raises(PreflightError):
        await checkout_branch(runner, repo_path="/repo", branch="main", timeout=10)


async def test_checkout_branch_raises_when_checkout_fails():
    runner = FakeCommandRunner(
        {
            ("git", "fetch"): CommandResult(0, "", ""),
            ("git", "checkout", "main"): CommandResult(1, "", "branch not found"),
        }
    )

    with pytest.raises(PreflightError):
        await checkout_branch(runner, repo_path="/repo", branch="main", timeout=10)


def _simctl(devices: dict) -> FakeCommandRunner:
    return FakeCommandRunner({
        ("xcrun", "simctl", "list", "devices", "available", "--json"): CommandResult(0, json.dumps({"devices": devices}), "")
    })


# --- Xcode target: CocoaPods workspace and the app's scheme ---

from app.pipeline.preflight import XcodeTarget, detect_target  # noqa: E402


def _list_output(kind: str, name: str, schemes: list) -> CommandResult:
    return CommandResult(0, json.dumps({kind: {"name": name, "schemes": schemes}}), "")


async def test_detect_target_uses_the_workspace_when_present():
    runner = FakeCommandRunner({
        ("xcodebuild", "-list", "-json", "-workspace", "EscapeFromBlindness.xcworkspace"):
            _list_output("workspace", "EscapeFromBlindness", ["Pods-EscapeFromBlindness", "EscapeFromBlindness", "SwiftGen", "SwiftLint"]),
    })

    target = await detect_target(
        runner, repo_path="/repo", timeout=10,
        list_dir=lambda _: ["EscapeFromBlindness.xcodeproj", "EscapeFromBlindness.xcworkspace", "Pods", "Podfile"],
    )

    assert target == XcodeTarget(container=["-workspace", "EscapeFromBlindness.xcworkspace"], scheme="EscapeFromBlindness")
    assert runner.calls[0]["cwd"] == "/repo"


async def test_detect_target_uses_the_project_without_workspace():
    runner = FakeCommandRunner({
        ("xcodebuild", "-list", "-json", "-project", "MyApp.xcodeproj"):
            _list_output("project", "MyApp", ["MyAppTests", "MyApp"]),
    })

    target = await detect_target(runner, repo_path="/repo", timeout=10, list_dir=lambda _: ["MyApp.xcodeproj", "README.md"])

    assert target == XcodeTarget(container=["-project", "MyApp.xcodeproj"], scheme="MyApp")


async def test_detect_target_skips_pods_schemes_when_no_name_matches():
    runner = FakeCommandRunner({
        ("xcodebuild", "-list", "-json", "-workspace", "App.xcworkspace"):
            _list_output("workspace", "App", ["Pods-Other", "RealScheme"]),
    })

    target = await detect_target(runner, repo_path="/repo", timeout=10, list_dir=lambda _: ["App.xcworkspace"])

    assert target.scheme == "RealScheme"


async def test_detect_target_raises_when_only_pods_schemes():
    runner = FakeCommandRunner({
        ("xcodebuild", "-list", "-json", "-workspace", "App.xcworkspace"):
            _list_output("workspace", "App", ["Pods-App"]),
    })

    with pytest.raises(PreflightError):
        await detect_target(runner, repo_path="/repo", timeout=10, list_dir=lambda _: ["App.xcworkspace"])


async def test_detect_target_falls_back_to_plain_list_when_repo_cannot_be_listed():
    runner = FakeCommandRunner({("xcodebuild", "-list", "-json"): _list_output("project", "MyApp", ["MyApp"])})

    def unreadable(_):
        raise FileNotFoundError("/repo")

    target = await detect_target(runner, repo_path="/repo", timeout=10, list_dir=unreadable)

    assert target == XcodeTarget(container=[], scheme="MyApp")


# --- Dependencies: pod install when the repository has a Podfile (Pods/ is often not committed) ---

from app.pipeline.preflight import install_dependencies  # noqa: E402


async def test_install_dependencies_runs_pod_install_when_a_podfile_exists():
    runner = FakeCommandRunner({("pod", "install"): CommandResult(0, "Pod installation complete!", "")})

    await install_dependencies(runner, repo_path="/repo", timeout=10, list_dir=lambda _: ["Podfile", "App.xcodeproj"])

    assert runner.calls == [{"args": ["pod", "install"], "cwd": "/repo", "timeout": 10}]


async def test_install_dependencies_does_nothing_without_podfile():
    runner = FakeCommandRunner({})

    await install_dependencies(runner, repo_path="/repo", timeout=10, list_dir=lambda _: ["App.xcodeproj"])

    assert runner.calls == []


async def test_install_dependencies_raises_when_pod_install_fails():
    runner = FakeCommandRunner({("pod", "install"): CommandResult(1, "", "CDN unreachable")})

    with pytest.raises(PreflightError, match="pod install failed"):
        await install_dependencies(runner, repo_path="/repo", timeout=10, list_dir=lambda _: ["Podfile"])



# --- Simulators: main one first, plus a large screen on demand ---



