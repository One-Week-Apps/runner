from typing import Optional

import pytest

from app.pipeline.command_runner import CommandResult
from app.pipeline.xcode_stages import (
    BuildStageError,
    TestStageError,
    run_build_stage,
    run_test_stage,
)


class FakeCommandRunner:
    def __init__(self, result: CommandResult) -> None:
        self.result = result
        self.calls: "list[dict]" = []

    async def run(self, args, *, cwd: Optional[str] = None, timeout: float):
        self.calls.append({"args": list(args), "cwd": cwd, "timeout": timeout})
        return self.result


async def test_run_build_stage_succeeds_on_zero_exit():
    runner = FakeCommandRunner(CommandResult(0, "BUILD SUCCEEDED", ""))

    await run_build_stage(
        runner,
        repo_path="/repo",
        scheme="MyApp",
        simulator_id="SIM-UDID",
        timeout=10,
    )

    assert "-destination" in runner.calls[0]["args"]
    assert "platform=iOS Simulator,id=SIM-UDID" in runner.calls[0]["args"]
    assert runner.calls[0]["cwd"] == "/repo"


async def test_run_build_stage_raises_on_failure():
    runner = FakeCommandRunner(CommandResult(65, "", "BUILD FAILED"))

    with pytest.raises(BuildStageError):
        await run_build_stage(
            runner,
            repo_path="/repo",
            scheme="MyApp",
            simulator_id="SIM-UDID",
            timeout=10,
        )


async def test_run_build_stage_raises_on_timeout():
    runner = FakeCommandRunner(CommandResult(-1, "", "", timed_out=True))

    with pytest.raises(BuildStageError):
        await run_build_stage(
            runner,
            repo_path="/repo",
            scheme="MyApp",
            simulator_id="SIM-UDID",
            timeout=10,
        )


async def test_run_test_stage_succeeds_on_zero_exit():
    runner = FakeCommandRunner(CommandResult(0, "TEST SUCCEEDED", ""))

    await run_test_stage(
        runner,
        repo_path="/repo",
        scheme="MyApp",
        simulator_id="SIM-UDID",
        timeout=10,
    )

    assert runner.calls[0]["cwd"] == "/repo"


async def test_run_test_stage_raises_on_failure():
    runner = FakeCommandRunner(CommandResult(65, "", "TEST FAILED"))

    with pytest.raises(TestStageError):
        await run_test_stage(
            runner,
            repo_path="/repo",
            scheme="MyApp",
            simulator_id="SIM-UDID",
            timeout=10,
        )


async def test_run_test_stage_raises_on_timeout():
    runner = FakeCommandRunner(CommandResult(-1, "", "", timed_out=True))

    with pytest.raises(TestStageError):
        await run_test_stage(
            runner,
            repo_path="/repo",
            scheme="MyApp",
            simulator_id="SIM-UDID",
            timeout=10,
        )


async def test_build_and_test_stages_target_the_workspace():
    runner = FakeCommandRunner(CommandResult(0, "OK", ""))
    container = ["-workspace", "EscapeFromBlindness.xcworkspace"]

    await run_build_stage(runner, repo_path="/repo", scheme="EscapeFromBlindness", simulator_id="SIM-UDID", timeout=10, container=container)
    await run_test_stage(runner, repo_path="/repo", scheme="EscapeFromBlindness", simulator_id="SIM-UDID", timeout=10, container=container)

    for call in runner.calls:
        args = call["args"]
        assert args[2:4] == container
        assert args[args.index("-scheme") + 1] == "EscapeFromBlindness"



async def test_test_stage_writes_a_result_bundle_when_asked():
    runner = FakeCommandRunner(CommandResult(0, "OK", ""))

    await run_test_stage(runner, repo_path="/repo", scheme="App", simulator_id="SIM", timeout=10, result_bundle="/tmp/job/result.xcresult")

    args = runner.calls[0]["args"]
    assert args[args.index("-resultBundlePath") + 1] == "/tmp/job/result.xcresult"



async def test_test_stage_runs_on_every_simulator():
    runner = FakeCommandRunner(CommandResult(0, "OK", ""))

    await run_test_stage(runner, repo_path="/repo", scheme="App", simulator_id=["17E", "18PM"], timeout=10)

    args = runner.calls[0]["args"]
    destinations = [args[i + 1] for i, a in enumerate(args) if a == "-destination"]
    assert destinations == ["platform=iOS Simulator,id=17E", "platform=iOS Simulator,id=18PM"]
