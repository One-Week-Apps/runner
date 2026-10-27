from typing import Optional

import pytest

from app.pipeline.command_runner import CommandResult
from app.pipeline.preflight import PreflightError
from app.pipeline.workspace import commit_attempt, prepare_workspace

OK = CommandResult(0, "", "")


class ScriptedRunner:
    """Answers by command prefix and records every call, in order."""

    def __init__(self, responses: Optional[dict] = None) -> None:
        self.responses = responses or {}
        self.calls: "list[tuple[list[str], Optional[str]]]" = []

    async def run(self, args, *, cwd: Optional[str] = None, timeout: float):
        self.calls.append((list(args), cwd))
        for prefix, result in self.responses.items():
            if tuple(args[: len(prefix)]) == prefix:
                return result
        return OK

    def commands(self) -> "list[list[str]]":
        return [args for args, _ in self.calls]


async def test_first_job_clones_then_creates_the_issue_branch_from_the_base(tmp_path):
    runner = ScriptedRunner({("git", "rev-parse"): CommandResult(1, "", "")})

    path = await prepare_workspace(
        runner, repos_dir=tmp_path, slug="One-Week-Apps/EscapeFromBlindness",
        clone_url="https://github.com/One-Week-Apps/EscapeFromBlindness.git",
        branch="aitasker/issue-7", base_branch="chore/xcode27", timeout=10,
    )

    assert path == str(tmp_path / "One-Week-Apps" / "EscapeFromBlindness")
    cmds = runner.commands()
    assert cmds[0] == ["git", "clone", "https://github.com/One-Week-Apps/EscapeFromBlindness.git", path]
    assert ["git", "reset", "--hard"] in cmds and ["git", "clean", "-fd"] in cmds
    assert cmds[-1] == ["git", "checkout", "-b", "aitasker/issue-7", "origin/chore/xcode27"]
    assert all(cwd == path for args, cwd in runner.calls[1:])


async def test_next_attempt_reuses_the_clone_and_the_existing_branch(tmp_path):
    clone = tmp_path / "One-Week-Apps" / "EscapeFromBlindness"
    (clone / ".git").mkdir(parents=True)
    runner = ScriptedRunner()  # rev-parse OK: the branch already exists

    await prepare_workspace(
        runner, repos_dir=tmp_path, slug="One-Week-Apps/EscapeFromBlindness", clone_url="https://x/y.git",
        branch="aitasker/issue-7", base_branch="master", timeout=10,
    )

    cmds = runner.commands()
    assert not any(c[:2] == ["git", "clone"] for c in cmds)
    assert cmds[-1] == ["git", "checkout", "aitasker/issue-7"]


async def test_clone_failure_stops_the_job(tmp_path):
    runner = ScriptedRunner({("git", "clone"): CommandResult(128, "", "Repository not found")})

    with pytest.raises(PreflightError, match="git clone failed"):
        await prepare_workspace(runner, repos_dir=tmp_path, slug="a/b", clone_url="u", branch="x", base_branch="main", timeout=10)


async def test_commit_attempt_commits_only_when_something_changed():
    changed = ScriptedRunner({("git", "status"): CommandResult(0, " M App/SceneDelegate.swift\n", "")})
    assert await commit_attempt(changed, repo_path="/clone", message="aitasker: tentative 1", timeout=10) is True
    assert changed.commands()[-2:] == [["git", "add", "-A"], ["git", "commit", "-m", "aitasker: tentative 1"]]

    clean = ScriptedRunner({("git", "status"): CommandResult(0, "", "")})
    assert await commit_attempt(clean, repo_path="/clone", message="m", timeout=10) is False
    assert not any(c[:2] == ["git", "commit"] for c in clean.commands())


async def test_the_branch_catches_up_with_its_base_before_work():
    from app.pipeline.workspace import catch_up_with_base
    runner = ScriptedRunner()

    conflicts = await catch_up_with_base(runner, repo_path="/r", base_branch="master", timeout=10)

    assert ["git", "merge", "--no-edit", "origin/master"] in runner.commands()
    assert conflicts == []


async def test_conflicts_with_the_base_are_listed_for_claude_code():
    from app.pipeline.workspace import catch_up_with_base
    runner = ScriptedRunner({
        ("git", "merge"): CommandResult(1, "CONFLICT (content)", ""),
        ("git", "ls-files", "-u"): CommandResult(
            0, "100644 a1 1\tApp/Home.swift\n100644 b2 2\tApp/Home.swift\n100644 c3 2\tApp/fr.lproj/Localizable.strings\n", ""),
    })

    conflicts = await catch_up_with_base(runner, repo_path="/r", base_branch="master", timeout=10)

    assert conflicts == ["App/Home.swift", "App/fr.lproj/Localizable.strings"]


async def test_conflict_markers_are_never_committed():
    runner = ScriptedRunner({
        ("git", "status"): CommandResult(0, "UU App/Home.swift\n", ""),
        ("git", "ls-files", "-u"): CommandResult(0, "100644 a1 2\tApp/Home.swift\n", ""),
    })

    committed = await commit_attempt(runner, repo_path="/r", message="m", timeout=10)

    assert ["git", "merge", "--abort"] in runner.commands()
    assert not any(c[:2] == ["git", "commit"] for c in runner.commands())
    assert committed is False


async def test_other_unmerged_tasks_touching_the_same_files():
    from app.pipeline.workspace import related_branches
    runner = ScriptedRunner({
        ("git", "branch", "-r"): CommandResult(0, "  origin/aitasker/issue-13\n  origin/aitasker/issue-7\n  origin/aitasker/issue-11\n", ""),
        ("git", "diff", "--name-only", "origin/master...HEAD"): CommandResult(0, "App/Home.swift\nUITests/AITaskerCapture.swift\n", ""),
        ("git", "diff", "--name-only", "origin/master...origin/aitasker/issue-13"): CommandResult(0, "App/Home.swift\nUITests/AITaskerCapture.swift\n", ""),
        ("git", "diff", "--name-only", "origin/master...origin/aitasker/issue-11"): CommandResult(0, "App/Other.swift\n", ""),
    })

    related = await related_branches(runner, repo_path="/r", base_branch="master", branch="aitasker/issue-7", timeout=10)

    assert ["git", "branch", "-r", "--no-merged", "origin/master", "--list", "origin/aitasker/*"] in runner.commands()
    assert related == [{"branch": "aitasker/issue-13", "files": ["Home.swift"]}]


async def test_human_commits_skip_what_the_runner_and_merges_wrote():
    from app.pipeline.workspace import human_commits
    log = "\x1e".join([
        "Sur Niveaux aligne les tuiles (#19)\x1f* aitasker: tentative 1 — Sur Niveaux aligne les tuiles\n",
        "Merge pull request #18 from One-Week-Apps/aitasker/tache-1\x1f",
        "aitasker: tentative 2 — Titre en gras (#1)\x1f",
        "Merge branch 'master' into feature\x1f",
        "refactor(app coordinator): improve app coordinator readability\x1f",
        "config(version): bump version number to 2.0\x1fadded level selection",
    ]) + "\x1e"
    runner = ScriptedRunner({("git", "log"): CommandResult(0, log, "")})

    commits = await human_commits(runner, repo_path="/r", base_branch="master", timeout=10)

    assert commits == ["refactor(app coordinator): improve app coordinator readability", "config(version): bump version number to 2.0"]
    assert runner.commands()[0][:2] == ["git", "log"] and "origin/master" in runner.commands()[0]


async def test_unreadable_history_gives_no_commits():
    from app.pipeline.workspace import human_commits
    runner = ScriptedRunner({("git", "log"): CommandResult(128, "", "fatal")})

    assert await human_commits(runner, repo_path="/r", base_branch="master", timeout=10) == []
