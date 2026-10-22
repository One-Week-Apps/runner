import os
from pathlib import Path

HELPER_NAME = "AITaskerCapture.swift"
HELPER_SOURCE = Path(__file__).resolve().parent.parent / "resources" / HELPER_NAME
SKIPPED_DIRS = {".git", "Pods", "DerivedData", "build", "node_modules"}


def upgrade_capture_helper(repo_path: str) -> "list[str]":
    """Keeps the Runner's capture helper up to date in the repository (it also attaches the VoiceOver order).

    Only an existing helper is replaced, since it is already part of the UI test target; without one,
    the brain's instructions ask Claude Code to create it. Returns the updated files.
    """
    wanted = HELPER_SOURCE.read_text(encoding="utf-8")
    updated = []
    for root, dirs, files in os.walk(repo_path):
        dirs[:] = [d for d in dirs if d not in SKIPPED_DIRS]
        if HELPER_NAME in files:
            path = Path(root) / HELPER_NAME
            if path.read_text(encoding="utf-8", errors="replace") != wanted:
                path.write_text(wanted, encoding="utf-8")
                updated.append(str(path))
    return updated
