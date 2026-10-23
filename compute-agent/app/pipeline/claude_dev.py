import json
import logging
from typing import NamedTuple, Optional

from app.pipeline.command_runner import CommandRunner

logger = logging.getLogger(__name__)


class DevStageError(Exception):
    """Claude Code could not do the task. `reason`: what it said, for the developer (usage limit, login…)."""

    def __init__(self, message: str, reason: Optional[str] = None) -> None:
        super().__init__(message)
        self.reason = reason or message


def _reason(result) -> str:
    """A refusal (usage limit, expired login) comes as JSON on stdout with an empty stderr: keep its words."""
    try:
        said = json.loads(result.stdout).get("result")
        if isinstance(said, str) and said.strip():
            return said.strip()[:500]
    except (json.JSONDecodeError, AttributeError):
        pass
    return (result.stderr or result.stdout or "aucun message").strip()[:500]



class DevOutcome(NamedTuple):
    """Estimated cost of the work (list prices) and the Claude Code session the next fix can resume."""
    cost_usd: Optional[float]
    session_id: Optional[str]


# What the developer's Claude Code may do in the managed clone: read and edit code, plus a few
# read-only commands. Building, testing and committing are done by the pipeline itself.
ALLOWED_TOOLS = [
    "Read", "Edit", "Write", "Glob", "Grep",
    "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)",
    "Bash(ls:*)", "Bash(xcodebuild -list:*)", "Bash(plutil -lint:*)",
]


def build_prompt(*, description: str, instruction: str, last_feedback: Optional[str]) -> str:
    if instruction == "iteration_feedback" and last_feedback:
        return (
            f"Voici la feature à développer : {description}\n\n"
            f"La tentative précédente a été rejetée avec le retour suivant : {last_feedback}\n"
            "Corrige le code en conséquence."
        )
    return f"Développe la feature suivante : {description}"


async def run_dev_stage(
    runner: CommandRunner,
    *,
    repo_path: str,
    description: str,
    instruction: str,
    last_feedback: Optional[str],
    timeout: float,
    resume_session: Optional[str] = None,
) -> DevOutcome:
    """Runs Claude Code headless on the task. A fix may resume the previous attempt's session so Claude Code
    keeps what it just read instead of rereading the repository; if that session is gone, a new one starts."""
    prompt = build_prompt(
        description=description, instruction=instruction, last_feedback=last_feedback
    )

    def command(resume: Optional[str]) -> list:
        # The developer's personal settings (hooks, permission rules) are ignored: only the allowlist applies.
        return ["claude", "-p", prompt, "--output-format", "json", "--setting-sources", "project,local",
                *(["--resume", resume] if resume else []), "--allowedTools", *ALLOWED_TOOLS]

    result_args = command(resume_session)
    result = await runner.run(result_args, cwd=repo_path, timeout=timeout)
    if resume_session and not result.timed_out and result.exit_code != 0:
        logger.warning("Could not resume Claude Code session %s, starting a new one: %s", resume_session, result.stderr)
        result_args = command(None)
        result = await runner.run(result_args, cwd=repo_path, timeout=timeout)

    if result.timed_out:
        raise DevStageError("Claude Code timed out")

    if result.exit_code != 0:
        raise DevStageError(f"Claude Code exited with code {result.exit_code}: {_reason(result)}", reason=_reason(result))

    try:
        parsed = json.loads(result.stdout)
    except json.JSONDecodeError as err:
        raise DevStageError(f"Could not parse Claude Code output as JSON: {err}") from err

    if parsed.get("is_error"):
        raise DevStageError(f"Claude Code reported an error: {parsed.get('result')}")

    cost = parsed.get("total_cost_usd")
    session = parsed.get("session_id")
    resumed = bool(resume_session) and "--resume" in result_args
    # One log line per run, to judge session resumption on numbers.
    logger.info("[claude code] ~$%.3f, %s turns, %s session", float(cost or 0), parsed.get("num_turns", "?"),
                "resumed" if resumed else "new")
    return DevOutcome(
        float(cost) if isinstance(cost, (int, float)) else None,
        session if isinstance(session, str) and session else None,
    )
