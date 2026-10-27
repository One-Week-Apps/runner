from pathlib import Path

from app.pipeline.command_runner import CommandRunner
from app.pipeline.preflight import PreflightError


async def _git(runner: CommandRunner, args: list, *, cwd: str, timeout: float, what: str):
    result = await runner.run(["git", *args], cwd=cwd, timeout=timeout)
    if result.exit_code != 0 or result.timed_out:
        raise PreflightError(f"{what} failed: {result.stderr or result.stdout}")
    return result


async def prepare_workspace(
    runner: CommandRunner,
    *,
    repos_dir: Path,
    slug: str,
    clone_url: str,
    branch: str,
    base_branch: str,
    timeout: float,
) -> str:
    """A clean clone managed by the Runner (never your working copy), on the task's branch.

    First attempt: the branch starts from `origin/<base_branch>`. Later attempts resume the existing
    branch with the work already committed.
    """
    path = Path(repos_dir) / slug
    if not (path / ".git").exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        await _git(runner, ["clone", clone_url, str(path)], cwd=str(path.parent), timeout=timeout, what="git clone")
    cwd = str(path)
    await _git(runner, ["fetch", "origin", "--prune"], cwd=cwd, timeout=timeout, what="git fetch")
    await _git(runner, ["reset", "--hard"], cwd=cwd, timeout=timeout, what="git reset")
    await _git(runner, ["clean", "-fd"], cwd=cwd, timeout=timeout, what="git clean")

    local = await runner.run(["git", "rev-parse", "--verify", "--quiet", f"refs/heads/{branch}"], cwd=cwd, timeout=timeout)
    if local.exit_code == 0:
        await _git(runner, ["checkout", branch], cwd=cwd, timeout=timeout, what="git checkout")
    else:
        await _git(runner, ["checkout", "-b", branch, f"origin/{base_branch}"], cwd=cwd, timeout=timeout, what="git checkout")
    return cwd


async def _unmerged(runner: CommandRunner, *, repo_path: str, timeout: float) -> "list[str]":
    """Files still in conflict: `git ls-files -u` lists one line per version ("mode sha stage\tpath")."""
    result = await runner.run(["git", "ls-files", "-u"], cwd=repo_path, timeout=timeout)
    if result.exit_code != 0:
        return []
    return list(dict.fromkeys(line.split("\t", 1)[1] for line in result.stdout.splitlines() if "\t" in line))


async def catch_up_with_base(runner: CommandRunner, *, repo_path: str, base_branch: str, timeout: float) -> "list[str]":
    """Merges what landed on the base since, so each attempt starts from everything the developer approved.
    Conflicts are left in the files for Claude Code to resolve first."""
    merge = await runner.run(["git", "merge", "--no-edit", f"origin/{base_branch}"], cwd=repo_path, timeout=timeout)
    if merge.exit_code == 0:
        return []
    return await _unmerged(runner, repo_path=repo_path, timeout=timeout)


async def commit_attempt(runner: CommandRunner, *, repo_path: str, message: str, timeout: float) -> bool:
    """Commits the attempt's work on the task branch; does nothing when there is nothing to commit.
    With conflicts still present, the merge is aborted rather than committing conflict markers."""
    status = await runner.run(["git", "status", "--porcelain"], cwd=repo_path, timeout=timeout)
    if status.exit_code != 0 or not status.stdout.strip():
        return False
    if await _unmerged(runner, repo_path=repo_path, timeout=timeout):
        await runner.run(["git", "merge", "--abort"], cwd=repo_path, timeout=timeout)
        return False
    await _git(runner, ["add", "-A"], cwd=repo_path, timeout=timeout, what="git add")
    await _git(runner, ["commit", "-m", message], cwd=repo_path, timeout=timeout, what="git commit")
    return True


async def push_branch(runner: CommandRunner, *, repo_path: str, branch: str, timeout: float) -> None:
    """Pushes the task branch: the pull request opens on it after an OK, and the diff reads from a phone."""
    await _git(runner, ["push", "-u", "origin", branch], cwd=repo_path, timeout=timeout, what="git push")


# Beyond this, the diff is cut: a generated file must not bloat the callback to the Runner.
MAX_DIFF_CHARS = 200_000


async def task_diff(runner: CommandRunner, *, repo_path: str, base_branch: str, timeout: float) -> str:
    """Everything the task changed since its base branch, earlier attempts included, for the code reviewer."""
    # The capture helper is refreshed by the Runner on every branch: not the task's code, kept out of the review.
    result = await runner.run(["git", "diff", f"origin/{base_branch}...HEAD", "--", ".", ":(exclude)**/AITaskerCapture.swift"],
                              cwd=repo_path, timeout=timeout)
    if result.exit_code != 0 or result.timed_out:
        return ""
    return result.stdout[:MAX_DIFF_CHARS]


# The capture helper is kept up to date on every branch, so it says nothing about related work.
RUNNER_FILES = {"AITaskerCapture.swift"}


async def _changed_files(runner: CommandRunner, *, repo_path: str, range_: str, timeout: float) -> "set[str]":
    result = await runner.run(["git", "diff", "--name-only", range_], cwd=repo_path, timeout=timeout)
    if result.exit_code != 0:
        return set()
    return {line.strip() for line in result.stdout.splitlines() if line.strip() and Path(line.strip()).name not in RUNNER_FILES}


async def human_commits(runner: CommandRunner, *, repo_path: str, base_branch: str, timeout: float, limit: int = 60) -> "list[str]":
    """Commit subjects of the base branch written by people: Studio writes the merge commit the same way.

    What agents wrote (the Runner's attempts and squashes, which mention "aitasker") and merge commits
    are not the project's convention. Unreadable history: no subjects, Studio falls back to Conventional Commits.
    """
    result = await runner.run(["git", "log", "--format=%s%x1f%b%x1e", "-400", f"origin/{base_branch}"], cwd=repo_path, timeout=timeout)
    if result.exit_code != 0 or result.timed_out:
        return []
    subjects = []
    for record in result.stdout.split("\x1e"):
        subject, _, body = record.strip().partition("\x1f")
        if subject and "aitasker" not in (subject + body).lower() and not subject.startswith("Merge "):
            subjects.append(subject)
    return subjects[:limit]


async def related_branches(runner: CommandRunner, *, repo_path: str, base_branch: str, branch: str, timeout: float) -> "list[dict]":
    """Other unmerged tasks touching the same files, so the developer sees a coming conflict before
    approving. Plain git, no AI cost."""
    listed = await runner.run(["git", "branch", "-r", "--no-merged", f"origin/{base_branch}", "--list", "origin/aitasker/*"],
                              cwd=repo_path, timeout=timeout)
    if listed.exit_code != 0:
        return []
    mine = await _changed_files(runner, repo_path=repo_path, range_=f"origin/{base_branch}...HEAD", timeout=timeout)
    related = []
    for other in (line.strip() for line in listed.stdout.splitlines()):
        name = other.removeprefix("origin/")
        if not other or name == branch:
            continue
        shared = mine & await _changed_files(runner, repo_path=repo_path, range_=f"origin/{base_branch}...{other}", timeout=timeout)
        if shared:
            related.append({"branch": name, "files": sorted(Path(f).name for f in shared)})
    return related
