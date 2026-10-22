import json
from pathlib import Path
from typing import Optional

from app.pipeline.capture_helper import HELPER_SOURCE, upgrade_capture_helper
from app.pipeline.command_runner import CommandResult
from app.pipeline.screenshots import export_screenshots

MANIFEST = [
    {
        "testIdentifier": "HomeUITests/testTitreEnGras()",
        "attachments": [
            {"exportedFileName": "A.png", "suggestedHumanReadableName": "Accueil_0_1.png", "timestamp": 1792082335.0, "deviceName": "iPhone 17e"},
            {"exportedFileName": "A.txt", "suggestedHumanReadableName": "Accueil-voiceover_0_2.txt", "timestamp": 1792082335.1, "deviceName": "iPhone 17e"},
            {"exportedFileName": "B.png", "suggestedHumanReadableName": "AccueilTexteAgrandi_0_3.png", "timestamp": 1792082336.0, "deviceName": "iPhone 17e"},
        ],
    },
]


class ExportingRunner:
    async def run(self, args, *, cwd: Optional[str] = None, timeout: float):
        out = Path(args[args.index("--output-path") + 1])
        out.mkdir(parents=True, exist_ok=True)
        (out / "manifest.json").write_text(json.dumps(MANIFEST))
        (out / "A.png").write_bytes(b"x")
        (out / "B.png").write_bytes(b"x")
        (out / "A.txt").write_text("Choisis ton niveau\nChapitre 1 : Ice Cave, bouton\n\nNiveau 1, bouton\n", encoding="utf-8")
        return CommandResult(0, "", "")


async def test_the_voiceover_reading_follows_its_screenshot(tmp_path):
    nodes = await export_screenshots(ExportingRunner(), result_bundle=str(tmp_path / "r.xcresult"), output_dir=tmp_path / "j",
                                     base_url="http://mac:8000", job_id="j", timeout=10)

    assert [(n.node_id, n.voice_over) for n in nodes] == [
        ("Accueil", ["Choisis ton niveau", "Chapitre 1 : Ice Cave, bouton", "Niveau 1, bouton"]),
        ("AccueilTexteAgrandi", None),
    ]
    assert nodes[0].model_dump(by_alias=True)["voiceOver"][0] == "Choisis ton niveau"


def test_the_helper_replaces_the_old_one_without_touching_pods(tmp_path):
    ui = tmp_path / "AppUITests"
    ui.mkdir()
    (ui / "AITaskerCapture.swift").write_text("enum AITaskerCapture { /* ancien */ }")
    pods = tmp_path / "Pods" / "X"
    pods.mkdir(parents=True)
    (pods / "AITaskerCapture.swift").write_text("ne pas toucher")

    assert upgrade_capture_helper(str(tmp_path)) == [str(ui / "AITaskerCapture.swift")]
    assert (ui / "AITaskerCapture.swift").read_text() == HELPER_SOURCE.read_text()
    assert "voiceOverOrder" in (ui / "AITaskerCapture.swift").read_text()
    assert (pods / "AITaskerCapture.swift").read_text() == "ne pas toucher"
    assert upgrade_capture_helper(str(tmp_path)) == []


def test_without_a_helper_in_the_repository_nothing_is_created(tmp_path):
    assert upgrade_capture_helper(str(tmp_path)) == []
    assert not list(tmp_path.rglob("AITaskerCapture.swift"))
