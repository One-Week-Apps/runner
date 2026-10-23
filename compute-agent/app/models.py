from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class JobFeature(CamelModel):
    description: str
    repo: str
    branch: str
    attempt_number: int
    instruction: Literal["initial_dev", "iteration_feedback"]
    last_feedback: Optional[str] = None
    # Managed clone: repo is "owner/name"; the pipeline clones it and branches off base_branch.
    clone_url: Optional[str] = None
    base_branch: Optional[str] = None
    # Task title, for the commit message; the description carries the instructions.
    title: Optional[str] = None
    # Execution plan decided by the brain: only the task's UI tests (KISS default) or all of them,
    # on the main simulator only or on a large screen as well.
    ui_tests: Literal["task", "all"] = "task"
    devices: Literal["main", "both"] = "main"
    # Claude Code session of the task's previous attempt, resumed by the fix.
    resume_session: Optional[str] = None


class JobRequest(CamelModel):
    job_id: str
    feature: JobFeature
    callback_url: str
    # Optional: where the Runner receives stage-by-stage progress.
    progress_url: Optional[str] = None
    # Optional: the brain's instructions, written while the Mac prepares the repository. When missing or
    # failed, the job description (the raw task) and the KISS plan apply.
    instructions_url: Optional[str] = None


class NodeCapture(CamelModel):
    node_id: str
    screenshot_url: Optional[str]
    action: Optional[str]
    captured_at: str
    scenario: Optional[str] = None
    device: Optional[str] = None
    # Screenshot from a UI test the task wrote or changed: it shows the target screen and leads the report.
    for_task: bool = False
    # What VoiceOver would read on this screen, in order ("Choisis ton niveau", "Chapitre 1, bouton"…).
    voice_over: Optional[list[str]] = None


class RelatedBranch(CamelModel):
    branch: str
    files: list[str]


class JobCallbackBody(CamelModel):
    outcome: Literal["success", "failure"]
    build_status: Literal["pending", "passed", "failed"]
    test_status: Literal["pending", "passed", "failed"]
    nodes: list[NodeCapture]
    failed_tests: list[str] = []
    # Tests already failing on the base branch: outside the task's scope.
    preexisting_failures: list[str] = []
    # The task's diff against its base branch, read by the brain's code reviewer.
    diff: Optional[str] = None
    # Estimated cost of Claude Code's work in this run, when it reports one.
    dev_cost_usd: Optional[float] = None
    # Claude Code session of this run, resumable by the next fix.
    dev_session_id: Optional[str] = None
    # Other unmerged tasks touching the same files: a conflict is coming.
    related_branches: list[RelatedBranch] = []
    # Claude Code did not work at all (usage limit, login…): its own words, so the Runner tells the developer
    # instead of "fixing" a task nobody touched.
    dev_error: Optional[str] = None
