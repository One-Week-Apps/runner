import json
import logging
from typing import Optional

import pytest

from app.pipeline.claude_dev import DevStageError, build_prompt, run_dev_stage
from app.pipeline.command_runner import CommandResult


class FakeCommandRunner:
    def __init__(self, result: CommandResult) -> None:
        self.result = result
        self.calls: "list[dict]" = []

    async def run(self, args, *, cwd: Optional[str] = None, timeout: float):
        self.calls.append({"args": list(args), "cwd": cwd, "timeout": timeout})
        return self.result


def test_build_prompt_initial_dev():
    prompt = build_prompt(
        description="Add a settings screen", instruction="initial_dev", last_feedback=None
    )
    assert "Add a settings screen" in prompt
    assert "retour" not in prompt.lower()


def test_build_prompt_iteration_feedback():
    prompt = build_prompt(
        description="Add a settings screen",
        instruction="iteration_feedback",
        last_feedback="The button was misaligned",
    )
    assert "Add a settings screen" in prompt
    assert "The button was misaligned" in prompt


async def test_run_dev_stage_succeeds_on_valid_json_no_error():
    output = json.dumps({"is_error": False, "result": "done"})
    runner = FakeCommandRunner(CommandResult(0, output, ""))

    await run_dev_stage(
        runner,
        repo_path="/repo",
        description="Add a settings screen",
        instruction="initial_dev",
        last_feedback=None,
        timeout=10,
    )

    args = runner.calls[0]["args"]
    assert runner.calls[0]["cwd"] == "/repo"
    assert "claude" in args
    assert "--dangerously-skip-permissions" not in args
    assert "--permission-mode" not in args  # acceptEdits would let rm, mv… through without asking
    assert args[args.index("--setting-sources") + 1] == "project,local"  # not the developer's personal hooks/permissions
    allowed = args[args.index("--allowedTools") + 1:]
    assert {"Read", "Edit", "Write", "Glob", "Grep"} <= set(allowed)
    assert "Bash(git diff:*)" in allowed
    assert not any(tool in ("Bash", "Bash(*)", "WebFetch", "WebSearch") for tool in allowed)


async def test_run_dev_stage_raises_on_nonzero_exit():
    runner = FakeCommandRunner(CommandResult(1, "", "boom"))

    with pytest.raises(DevStageError):
        await run_dev_stage(
            runner,
            repo_path="/repo",
            description="Add a settings screen",
            instruction="initial_dev",
            last_feedback=None,
            timeout=10,
        )


async def test_run_dev_stage_raises_on_timeout():
    runner = FakeCommandRunner(CommandResult(-1, "", "", timed_out=True))

    with pytest.raises(DevStageError):
        await run_dev_stage(
            runner,
            repo_path="/repo",
            description="Add a settings screen",
            instruction="initial_dev",
            last_feedback=None,
            timeout=10,
        )


async def test_run_dev_stage_raises_when_is_error_true():
    output = json.dumps({"is_error": True, "result": "could not complete"})
    runner = FakeCommandRunner(CommandResult(0, output, ""))

    with pytest.raises(DevStageError):
        await run_dev_stage(
            runner,
            repo_path="/repo",
            description="Add a settings screen",
            instruction="initial_dev",
            last_feedback=None,
            timeout=10,
        )


class SequenceRunner:
    """Returns results in order: for the session resume, then the fallback."""
    def __init__(self, *results: CommandResult) -> None:
        self.results = list(results)
        self.calls: "list[list[str]]" = []

    async def run(self, args, *, cwd: Optional[str] = None, timeout: float):
        self.calls.append(list(args))
        return self.results.pop(0)


async def test_a_fix_resumes_the_claude_code_session_and_returns_the_new_one():
    runner = SequenceRunner(CommandResult(0, json.dumps({"is_error": False, "session_id": "s2", "total_cost_usd": 0.4}), ""))

    outcome = await run_dev_stage(runner, repo_path="/repo", description="d", instruction="iteration_feedback",
                                  last_feedback="corrige", timeout=10, resume_session="s1")

    assert runner.calls[0][runner.calls[0].index("--resume") + 1] == "s1"
    assert outcome.session_id == "s2"
    assert outcome.cost_usd == 0.4


async def test_a_missing_session_falls_back_to_a_new_one():
    runner = SequenceRunner(
        CommandResult(1, "", "No conversation found with session ID: s1"),
        CommandResult(0, json.dumps({"is_error": False, "session_id": "s3"}), ""),
    )

    outcome = await run_dev_stage(runner, repo_path="/repo", description="d", instruction="iteration_feedback",
                                  last_feedback="corrige", timeout=10, resume_session="s1")

    assert "--resume" in runner.calls[0]
    assert "--resume" not in runner.calls[1]
    assert outcome.session_id == "s3"


async def test_each_run_logs_its_cost_and_whether_it_resumed(caplog):
    runner = SequenceRunner(CommandResult(0, json.dumps({"is_error": False, "session_id": "s2", "total_cost_usd": 0.4, "num_turns": 7}), ""))

    with caplog.at_level(logging.INFO):
        await run_dev_stage(runner, repo_path="/repo", description="d", instruction="iteration_feedback",
                            last_feedback="corrige", timeout=10, resume_session="s1")

    assert "[claude code] ~$0.400, 7 turns, resumed session" in caplog.text
