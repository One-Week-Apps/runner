import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import NamedTuple, Optional

from app.models import NodeCapture
from app.pipeline.command_runner import CommandRunner

logger = logging.getLogger(__name__)

VOICE_OVER_SUFFIX = "-voiceover"


def _scenario(test_identifier: str) -> str:
    """Maps "AppUITests/testSettings()" to "testSettings": one test method is one scenario."""
    return test_identifier.split("/")[-1].removesuffix("()") if test_identifier else ""


async def export_screenshots(
    runner: CommandRunner,
    *,
    result_bundle: str,
    output_dir: Path,
    base_url: str,
    job_id: str,
    timeout: float,
) -> "list[NodeCapture]":
    """PNG screenshots attached by UI tests (XCTAttachment), served under /screenshots/<job_id>/.

    Never blocks the job: on failure, there are simply no screenshots.
    """
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    result = await runner.run(
        ["xcrun", "xcresulttool", "export", "attachments", "--path", result_bundle, "--output-path", str(output_dir)],
        timeout=timeout,
    )
    manifest_path = output_dir / "manifest.json"
    if result.exit_code != 0 or result.timed_out or not manifest_path.exists():
        logger.warning("Screenshot export failed for job %s: %s", job_id, result.stderr)
        return []

    manifest = json.loads(manifest_path.read_text())
    # The VoiceOver order attached by the helper ("<nodeId>-voiceover"): one reading per screen, test and device.
    readings = {}
    for test in manifest:
        for attachment in test.get("attachments", []):
            readable = attachment.get("suggestedHumanReadableName", "")
            name = readable.split("_")[0]
            if not name.endswith(VOICE_OVER_SUFFIX):
                continue
            try:
                text = (output_dir / attachment.get("exportedFileName", "")).read_text(encoding="utf-8")
            except OSError:
                continue
            key = (test.get("testIdentifier"), name[: -len(VOICE_OVER_SUFFIX)], attachment.get("deviceName"))
            readings[key] = [line.strip() for line in text.splitlines() if line.strip()]

    nodes = []
    for test in manifest:
        for attachment in test.get("attachments", []):
            file_name = attachment.get("exportedFileName", "")
            if not file_name.endswith(".png"):
                continue
            readable = attachment.get("suggestedHumanReadableName", file_name)
            node_id = readable.split("_")[0]
            nodes.append(NodeCapture(
                node_id=node_id,
                screenshot_url=f"{base_url}/screenshots/{job_id}/{file_name}",
                action=test.get("testIdentifier"),
                captured_at=datetime.fromtimestamp(attachment.get("timestamp", 0), tz=timezone.utc).isoformat(),
                scenario=_scenario(test.get("testIdentifier", "")),
                device=attachment.get("deviceName"),
                voice_over=readings.get((test.get("testIdentifier"), node_id, attachment.get("deviceName"))),
            ))
    return nodes


def _messages(node: dict) -> "list[str]":
    """The node's failure messages, wherever they are nested (under the test or the failing device)."""
    found = [node["name"]] if node.get("nodeType") == "Failure Message" and node.get("name") else []
    for child in node.get("children", []):
        found += _messages(child)
    return found


class Failure(NamedTuple):
    """A failing test: its xcodebuild id ("Target/Suite/test") and what the report shows."""
    id: str
    label: str


async def read_failures(runner: CommandRunner, *, result_bundle: str, timeout: float) -> "list[Failure]":
    """Failing tests as "Suite/test (devices) : first failure message", so the report can say what breaks.

    Never blocks the job: unreadable results mean no failures.
    """
    result = await runner.run(
        ["xcrun", "xcresulttool", "get", "test-results", "tests", "--path", result_bundle],
        timeout=timeout,
    )
    if result.exit_code != 0 or result.timed_out:
        logger.warning("Could not read test results from %s: %s", result_bundle, result.stderr)
        return []
    try:
        tree = json.loads(result.stdout)
    except json.JSONDecodeError:
        return []

    found: "list[Failure]" = []

    def walk(node: dict, bundle: str, suite: str) -> None:
        kind = node.get("nodeType")
        if kind == "Test Case" and node.get("result") == "Failed":
            test = node.get("name", "").removesuffix("()")
            name = f"{suite}/{test}"
            children = node.get("children", [])
            devices = [c.get("name") for c in children if c.get("nodeType") == "Device" and c.get("result") == "Failed"]
            message = next(iter(_messages(node)), None)
            where = f" ({', '.join(devices)})" if devices else ""
            label = f"{name}{where} : {message}" if message else f"{name}{where}"
            if all(f.label != label for f in found):
                found.append(Failure(f"{bundle}/{suite}/{test}", label))
            return
        for child in node.get("children", []):
            walk(
                child,
                node.get("name", bundle) if kind in ("Unit test bundle", "UI test bundle") else bundle,
                node.get("name", suite) if kind == "Test Suite" else suite,
            )

    for node in tree.get("testNodes", []):
        walk(node, "", "")
    return found



async def read_ran_suites(runner: CommandRunner, *, result_bundle: str, timeout: float) -> "Optional[set]":
    """Test classes xcodebuild actually ran. A file in no target never shows up here, and xcodebuild says nothing.

    None when the results are unreadable: nothing can be concluded, so nothing is blamed.
    """
    result = await runner.run(
        ["xcrun", "xcresulttool", "get", "test-results", "tests", "--path", result_bundle],
        timeout=timeout,
    )
    if result.exit_code != 0 or result.timed_out:
        return None
    try:
        tree = json.loads(result.stdout)
    except json.JSONDecodeError:
        return None

    ran = set()

    def walk(node: dict) -> None:
        if node.get("nodeType") == "Test Suite" and any(c.get("nodeType") == "Test Case" for c in node.get("children", [])):
            ran.add(node.get("name", ""))
        for child in node.get("children", []):
            walk(child)

    for node in tree.get("testNodes", []):
        walk(node)
    return ran
