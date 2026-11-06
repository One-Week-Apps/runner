import json
from pathlib import Path
from typing import Optional

from app.pipeline.before_captures import before_captures, last_frame_tool
from app.pipeline.command_runner import CommandResult


def manifest(*tests: "tuple[str, list[str]]") -> list:
    return [{"testIdentifier": test, "attachments": [
        {"exportedFileName": name, "suggestedHumanReadableName": name, "deviceName": "iPhone 17e", "timestamp": i}
        for i, name in enumerate(names)
    ]} for test, names in tests]


class XcodeRunner:
    """Fakes `xcresulttool export` (writes the manifest) and the frame tool (writes the PNG it is asked for)."""

    def __init__(self, entries: list, frame_ok: bool = True) -> None:
        self.entries = entries
        self.frame_ok = frame_ok
        self.calls: "list[list[str]]" = []

    async def run(self, args, *, cwd: Optional[str] = None, timeout: float):
        self.calls.append(list(args))
        if args[:3] == ["xcrun", "xcresulttool", "export"]:
            out = Path(args[args.index("--output-path") + 1])
            out.mkdir(parents=True, exist_ok=True)
            (out / "manifest.json").write_text(json.dumps(self.entries))
            for test in self.entries:
                for attachment in test["attachments"]:
                    (out / attachment["exportedFileName"]).write_bytes(b"x")
            return CommandResult(0, "", "")
        if args[0] == "swiftc":
            Path(args[args.index("-o") + 1]).write_text("tool")
            return CommandResult(0, "", "")
        if self.frame_ok:
            Path(args[2]).write_bytes(b"\x89PNG")
            return CommandResult(0, "", "")
        return CommandResult(1, "", "no video track")


async def test_the_last_frame_of_each_failing_test_video_becomes_its_before(tmp_path):
    runner = XcodeRunner(manifest(
        ("FinDeJeuUITests/testAfficherLaFinDeJeu()", ["hierarchy.txt", "snapshot", "a.mp4"]),
        ("FinDeJeuUITests/testTexteAgrandi()", ["b.mp4"]),
    ))

    before = await before_captures(runner, result_bundle="/tmp/red.xcresult", output_dir=tmp_path, base_url="http://mac:8000",
                                   job_id="job-1", tool="/tools/last-frame", timeout=10)

    assert [(b.scenario, b.screenshot_url, b.device) for b in before] == [
        ("testAfficherLaFinDeJeu", "http://mac:8000/screenshots/job-1/avant-testAfficherLaFinDeJeu.png", "iPhone 17e"),
        ("testTexteAgrandi", "http://mac:8000/screenshots/job-1/avant-testTexteAgrandi.png", "iPhone 17e"),
    ]
    assert (tmp_path / "avant-testAfficherLaFinDeJeu.png").exists()
    # The exported videos are not kept.
    assert not list(tmp_path.glob("**/*.mp4"))


async def test_no_video_means_no_before(tmp_path):
    runner = XcodeRunner(manifest(("HomeTests/testTitle()", ["hierarchy.txt"])))

    assert await before_captures(runner, result_bundle="/tmp/red.xcresult", output_dir=tmp_path, base_url="",
                                 job_id="job-1", tool="/tools/last-frame", timeout=10) == []


async def test_a_frame_that_cannot_be_read_is_skipped(tmp_path):
    runner = XcodeRunner(manifest(("FinUITests/testFin()", ["a.mp4"])), frame_ok=False)

    assert await before_captures(runner, result_bundle="/tmp/red.xcresult", output_dir=tmp_path, base_url="",
                                 job_id="job-1", tool="/tools/last-frame", timeout=10) == []


async def test_the_frame_tool_is_compiled_once(tmp_path):
    runner = XcodeRunner([])

    first = await last_frame_tool(runner, cache_dir=tmp_path, timeout=10)
    second = await last_frame_tool(runner, cache_dir=tmp_path, timeout=10)

    assert first == second and Path(first).exists()
    assert len([c for c in runner.calls if c[0] == "swiftc"]) == 1
