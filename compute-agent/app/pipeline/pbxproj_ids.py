import re
import secrets
from pathlib import Path

from app.pipeline.command_runner import CommandRunner

# Xcode object ids: 24 uppercase hex characters, random. A model writing a project file by hand tends to
# invent readable ones (A1E5C0DE0000000000000031), which collide across tasks: the Runner replaces them itself
# instead of asking Claude Code for a command it may not run.
_ID = re.compile(r"\b[0-9A-F]{24}\b")
_PLACEHOLDER = re.compile(r"([0-9A-F])\1{5}")


def _fresh(taken: "set[str]") -> str:
    while True:
        candidate = secrets.token_hex(12).upper()
        if candidate not in taken:
            return candidate


def randomize_placeholder_ids(text: str, base_text: str) -> "tuple[str, int]":
    """Replaces the invented-looking ids the task added (not those of the base), everywhere they appear."""
    known = set(_ID.findall(base_text))
    taken = known | set(_ID.findall(text))
    invented = sorted({found for found in _ID.findall(text) if found not in known and _PLACEHOLDER.search(found)})
    if not invented:
        return text, 0
    replacement = {}
    for found in invented:
        replacement[found] = _fresh(taken)
        taken.add(replacement[found])
    return _ID.sub(lambda match: replacement.get(match.group(0), match.group(0)), text), len(invented)


async def randomize_project_ids(runner: CommandRunner, *, repo_path: str, base_branch: str, timeout: float) -> "list[str]":
    """Rewrites each project file whose task-added ids look invented; returns the files changed."""
    root = Path(repo_path)
    changed = []
    for project in sorted(root.glob("**/*.xcodeproj/project.pbxproj")):
        if "Pods" in project.relative_to(root).parts:
            continue
        relative = project.relative_to(root).as_posix()
        base = await runner.run(["git", "show", f"origin/{base_branch}:{relative}"], cwd=repo_path, timeout=timeout)
        text = project.read_text(encoding="utf-8")
        fixed, count = randomize_placeholder_ids(text, base.stdout if base.exit_code == 0 else "")
        if count:
            project.write_text(fixed, encoding="utf-8")
            changed.append(relative)
    return changed
