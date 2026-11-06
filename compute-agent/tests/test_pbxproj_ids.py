import re

from app.pipeline.command_runner import CommandResult
from app.pipeline.pbxproj_ids import randomize_placeholder_ids, randomize_project_ids

BASE = """
\t\t5F1A9C3B2D8E4F7061B2C3D4 /* App.swift in Sources */ = {isa = PBXBuildFile; fileRef = 7E2B4D6F8A0C1E3F5A7B9C1D /* App.swift */; };
"""

ADDED = BASE + """
\t\tA1E5C0DE0000000000000031 /* FinTests.swift in Sources */ = {isa = PBXBuildFile; fileRef = A1E5C0DE0000000000000032 /* FinTests.swift */; };
\t\tA1E5C0DE0000000000000032 /* FinTests.swift */ = {isa = PBXFileReference; path = FinTests.swift; };
\t\t\t\tA1E5C0DE0000000000000031 /* FinTests.swift in Sources */,
\t\t9C4E7A1B3D5F7081A2B4C6D8 /* Real.swift */ = {isa = PBXFileReference; path = Real.swift; };
"""

ID = re.compile(r"\b[0-9A-F]{24}\b")


def test_invented_ids_added_by_the_task_become_random_everywhere_they_appear():
    text, replaced = randomize_placeholder_ids(ADDED, BASE)

    assert replaced == 2
    assert "A1E5C0DE00000000000000" not in text
    ids = ID.findall(text)
    # Same structure: each new id still appears as often as before, and the two stay distinct.
    first, second = ids[2], ids[3]
    assert first != second
    assert text.count(first) == 2 and text.count(second) == 2


def test_ids_already_on_the_base_and_random_looking_new_ids_are_kept():
    text, replaced = randomize_placeholder_ids(ADDED, BASE)

    assert "5F1A9C3B2D8E4F7061B2C3D4" in text
    assert "7E2B4D6F8A0C1E3F5A7B9C1D" in text
    assert "9C4E7A1B3D5F7081A2B4C6D8" in text


def test_a_placeholder_id_already_on_the_base_is_left_alone():
    base = BASE + "\t\tAAAAAAAA0000000000000001 /* Old */ = {};\n"
    text, replaced = randomize_placeholder_ids(base, base)

    assert replaced == 0
    assert text == base


class FakeRunner:
    def __init__(self, base_text: str) -> None:
        self.base_text = base_text
        self.calls: list = []

    async def run(self, args, *, cwd=None, timeout):
        self.calls.append(list(args))
        return CommandResult(0, self.base_text, "")


async def test_the_project_file_is_rewritten_against_its_base_version(tmp_path):
    project = tmp_path / "App.xcodeproj"
    project.mkdir()
    (project / "project.pbxproj").write_text(ADDED)
    runner = FakeRunner(BASE)

    fixed = await randomize_project_ids(runner, repo_path=str(tmp_path), base_branch="master", timeout=5)

    assert fixed == ["App.xcodeproj/project.pbxproj"]
    assert runner.calls[0] == ["git", "show", "origin/master:App.xcodeproj/project.pbxproj"]
    assert "A1E5C0DE00000000000000" not in (project / "project.pbxproj").read_text()


async def test_nothing_to_rewrite_leaves_the_file_untouched(tmp_path):
    project = tmp_path / "App.xcodeproj"
    project.mkdir()
    (project / "project.pbxproj").write_text(BASE)

    assert await randomize_project_ids(FakeRunner(BASE), repo_path=str(tmp_path), base_branch="master", timeout=5) == []
