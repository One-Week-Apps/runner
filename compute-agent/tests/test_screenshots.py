import json
from pathlib import Path
from typing import Optional

from app.pipeline.command_runner import CommandResult
from app.pipeline.screenshots import export_screenshots, read_failures, read_ran_suites

MANIFEST = [
    {
        "testIdentifier": "AppUITests/testFirstScreen()",
        "attachments": [
            {"exportedFileName": "AAA.png", "suggestedHumanReadableName": "FirstScreen_0_1234.png", "timestamp": 1792082335.271, "deviceName": "iPhone 17e"},
            {"exportedFileName": "BBB.txt", "suggestedHumanReadableName": "log_0_1.txt", "timestamp": 1792082336.0},
        ],
    },
    {
        "testIdentifier": "AppUITests/testSettings()",
        "attachments": [
            {"exportedFileName": "CCC.png", "suggestedHumanReadableName": "Settings_0_99.png", "timestamp": 1792082340.0, "deviceName": "iPhone 18 Pro Max"},
        ],
    },
]


class ExportingRunner:
    """Fakes xcresulttool: writes the manifest and files into the requested folder."""

    def __init__(self, exit_code: int = 0) -> None:
        self.exit_code = exit_code
        self.calls: "list[list[str]]" = []

    async def run(self, args, *, cwd: Optional[str] = None, timeout: float):
        self.calls.append(list(args))
        if self.exit_code == 0:
            out = Path(args[args.index("--output-path") + 1])
            out.mkdir(parents=True, exist_ok=True)
            (out / "manifest.json").write_text(json.dumps(MANIFEST))
            for name in ("AAA.png", "BBB.txt", "CCC.png"):
                (out / name).write_bytes(b"x")
        return CommandResult(self.exit_code, "", "boom" if self.exit_code else "")


async def test_exports_png_attachments_as_named_captures(tmp_path):
    runner = ExportingRunner()

    nodes = await export_screenshots(
        runner, result_bundle=str(tmp_path / "result.xcresult"), output_dir=tmp_path / "job-1",
        base_url="http://mac.ts.net:8000", job_id="job-1", timeout=10,
    )

    assert runner.calls[0][:4] == ["xcrun", "xcresulttool", "export", "attachments"]
    assert [(n.node_id, n.screenshot_url) for n in nodes] == [
        ("FirstScreen", "http://mac.ts.net:8000/screenshots/job-1/AAA.png"),
        ("Settings", "http://mac.ts.net:8000/screenshots/job-1/CCC.png"),
    ]
    assert nodes[0].action == "AppUITests/testFirstScreen()"
    assert nodes[0].captured_at.startswith("2026-10-15")


async def test_export_failure_gives_no_capture_but_never_breaks_the_job(tmp_path):
    nodes = await export_screenshots(
        ExportingRunner(exit_code=1), result_bundle=str(tmp_path / "r.xcresult"), output_dir=tmp_path / "j",
        base_url="http://x", job_id="j", timeout=10,
    )

    assert nodes == []



async def test_captures_carry_their_scenario_and_device(tmp_path):
    nodes = await export_screenshots(
        ExportingRunner(), result_bundle=str(tmp_path / "r.xcresult"), output_dir=tmp_path / "j",
        base_url="http://x", job_id="j", timeout=10,
    )

    assert [(n.scenario, n.device) for n in nodes] == [("testFirstScreen", "iPhone 17e"), ("testSettings", "iPhone 18 Pro Max")]


TEST_RESULTS = {
    "testNodes": [{
        "name": "EscapeFromBlindness", "nodeType": "Test Plan", "children": [
            {"name": "EscapeFromBlindnessTests", "nodeType": "Unit test bundle", "children": [
                {"name": "LoadLevelViewControllerTests", "nodeType": "Test Suite", "children": [
                    {"name": "test_subtitle()", "nodeType": "Test Case", "result": "Failed", "children": [
                        {"name": "iPhone 17e", "nodeType": "Device", "result": "Passed"},
                        {"name": "iPhone 18 Pro Max", "nodeType": "Device", "result": "Failed", "children": [
                            {"name": "XCTAssertEqual failed: (\"nil\") is not equal to (\"Choisis ton niveau\")", "nodeType": "Failure Message"},
                        ]},
                    ]},
                    {"name": "test_grid()", "nodeType": "Test Case", "result": "Passed"},
                ]},
            ]},
            {"name": "EscapeFromBlindnessUITests", "nodeType": "UI test bundle", "children": [
                {"name": "LevelSelectionUITests", "nodeType": "Test Suite", "children": [
                    {"name": "testSousTitre()", "nodeType": "Test Case", "result": "Failed", "children": []},
                ]},
            ]},
        ],
    }],
}


class ResultsRunner:
    def __init__(self, exit_code: int = 0) -> None:
        self.exit_code = exit_code
        self.calls: "list[list[str]]" = []

    async def run(self, args, *, cwd: Optional[str] = None, timeout: float):
        self.calls.append(list(args))
        return CommandResult(self.exit_code, json.dumps(TEST_RESULTS) if self.exit_code == 0 else "", "")


async def test_failed_tests_are_named_with_their_first_failure_message():
    runner = ResultsRunner()

    failed = [f.label for f in await read_failures(runner, result_bundle="/r.xcresult", timeout=10)]

    assert runner.calls[0][:4] == ["xcrun", "xcresulttool", "get", "test-results"]
    assert failed == [
        'LoadLevelViewControllerTests/test_subtitle (iPhone 18 Pro Max) : XCTAssertEqual failed: ("nil") is not equal to ("Choisis ton niveau")',
        "LevelSelectionUITests/testSousTitre",
    ]


async def test_unreadable_results_give_no_names_but_never_break_the_job():
    assert await read_failures(ResultsRunner(exit_code=1), result_bundle="/r.xcresult", timeout=10) == []


async def test_the_suites_that_ran_are_listed_by_class():
    ran = await read_ran_suites(ResultsRunner(), result_bundle="/r.xcresult", timeout=10)

    assert ran == {"LoadLevelViewControllerTests", "LevelSelectionUITests"}


async def test_unreadable_results_say_nothing_about_what_ran():
    assert await read_ran_suites(ResultsRunner(exit_code=1), result_bundle="/r.xcresult", timeout=10) is None
