import hashlib
import json
import logging
import shutil
import tempfile
from pathlib import Path
from typing import Optional

from app.models import BeforeCapture
from app.pipeline.command_runner import CommandRunner
from app.pipeline.screenshots import _scenario

logger = logging.getLogger(__name__)

TOOL_SOURCE = Path(__file__).resolve().parent.parent / "resources" / "last_frame.swift"


async def last_frame_tool(runner: CommandRunner, *, cache_dir: Path, timeout: float) -> Optional[str]:
    """The frame tool, compiled once per version of its source (a few seconds), then reused."""
    source = TOOL_SOURCE.read_bytes()
    tool = Path(cache_dir) / f"last-frame-{hashlib.sha256(source).hexdigest()[:12]}"
    if tool.exists():
        return str(tool)
    tool.parent.mkdir(parents=True, exist_ok=True)
    result = await runner.run(["swiftc", "-O", str(TOOL_SOURCE), "-o", str(tool)], timeout=timeout)
    if result.exit_code != 0 or result.timed_out or not tool.exists():
        logger.warning("Could not compile the frame tool: %s", result.stderr)
        return None
    return str(tool)


async def before_captures(
    runner: CommandRunner,
    *,
    result_bundle: str,
    output_dir: Path,
    base_url: str,
    job_id: str,
    tool: str,
    timeout: float,
) -> "list[BeforeCapture]":
    """The screen before the task, one per scenario: the last frame of the video Xcode keeps for a test that fails.

    Read from the red check's bundle, where the task's new tests fail on the old code. The videos are not kept.
    """
    exported = Path(tempfile.mkdtemp(prefix="owa-avant-"))
    try:
        result = await runner.run(
            ["xcrun", "xcresulttool", "export", "attachments", "--path", result_bundle, "--output-path", str(exported)],
            timeout=timeout,
        )
        manifest_path = exported / "manifest.json"
        if result.exit_code != 0 or result.timed_out or not manifest_path.exists():
            return []
        before = []
        for test in json.loads(manifest_path.read_text()):
            videos = sorted((a for a in test.get("attachments", []) if a.get("exportedFileName", "").endswith(".mp4")),
                            key=lambda a: a.get("timestamp", 0))
            scenario = _scenario(test.get("testIdentifier", ""))
            if not videos or not scenario or any(b.scenario == scenario for b in before):
                continue
            name = f"avant-{scenario}.png"
            frame = await runner.run([tool, str(exported / videos[-1]["exportedFileName"]), str(Path(output_dir) / name)],
                                     timeout=timeout)
            if frame.exit_code != 0 or frame.timed_out:
                logger.warning("No before frame for %s: %s", scenario, frame.stderr)
                continue
            before.append(BeforeCapture(scenario=scenario, screenshot_url=f"{base_url}/screenshots/{job_id}/{name}",
                                        device=videos[-1].get("deviceName")))
        return before
    finally:
        shutil.rmtree(exported, ignore_errors=True)
