import json
import os
import re
from dataclasses import dataclass
from typing import Callable

from app.pipeline.command_runner import CommandRunner

# Reference sizes: the most compact and the largest current iPhones.
COMPACT_SIMULATORS = ["iPhone 17e", "iPhone 16e", "iPhone SE (3rd generation)", "iPhone 13 mini"]
LARGE_SIMULATORS = ["iPhone 17 Pro Max", "iPhone 18 Pro Max", "iPhone 16 Pro Max"]


class PreflightError(Exception):
    pass


async def checkout_branch(
    runner: CommandRunner, *, repo_path: str, branch: str, timeout: float
) -> None:
    fetch_result = await runner.run(["git", "fetch"], cwd=repo_path, timeout=timeout)
    if fetch_result.exit_code != 0 or fetch_result.timed_out:
        raise PreflightError(f"git fetch failed: {fetch_result.stderr}")

    checkout_result = await runner.run(
        ["git", "checkout", branch], cwd=repo_path, timeout=timeout
    )
    if checkout_result.exit_code != 0 or checkout_result.timed_out:
        raise PreflightError(f"git checkout failed: {checkout_result.stderr}")


def _ios_version(runtime_key: str) -> "tuple[int, ...] | None":
    match = re.search(r"iOS-(\d+)-(\d+)", runtime_key)
    return (int(match.group(1)), int(match.group(2))) if match else None


async def _ios_runtimes(runner: CommandRunner, timeout: float) -> list:
    result = await runner.run(
        ["xcrun", "simctl", "list", "devices", "available", "--json"], timeout=timeout
    )
    if result.exit_code != 0 or result.timed_out:
        raise PreflightError(f"xcrun simctl list failed: {result.stderr}")
    runtimes = [
        (version, devices)
        for key, devices in json.loads(result.stdout).get("devices", {}).items()
        if (version := _ios_version(key)) is not None
    ]
    return sorted(runtimes, key=lambda r: r[0], reverse=True)


def _is_iphone(device: dict) -> bool:
    return "udid" in device and device.get("name", "").startswith("iPhone")


async def _habitual_simulator(runner: CommandRunner, timeout: float) -> "str | None":
    """The device last opened in the Simulator app: the one the developer is used to seeing."""
    result = await runner.run(["defaults", "read", "com.apple.iphonesimulator", "CurrentDeviceUDID"], timeout=timeout)
    return result.stdout.strip() or None if result.exit_code == 0 and not result.timed_out else None


async def pick_simulators(runner: CommandRunner, *, devices: str, timeout: float) -> list:
    """Main simulator: an iPhone already booted, else the developer's usual one, else the compact reference.

    Everything is picked on the newest iOS runtime (Xcode rejects older ones). The main simulator is
    booted and left running so the next attempt skips the cold start. `devices="both"` adds a large
    screen when the brain deems the layout sensitive.
    """
    runtimes = await _ios_runtimes(runner, timeout)
    if not runtimes:
        raise PreflightError("No iOS simulator runtime available")
    iphones = [d for d in runtimes[0][1] if _is_iphone(d)]
    if not iphones:
        raise PreflightError("No iPhone simulator on the newest iOS runtime")
    by_udid = {d["udid"]: d for d in iphones}
    by_name = {d["name"]: d["udid"] for d in iphones}

    booted = next((d["udid"] for d in iphones if d.get("state") == "Booted"), None)
    habitual = await _habitual_simulator(runner, timeout)
    compact = next((by_name[n] for n in COMPACT_SIMULATORS if n in by_name), None)
    main = booted or (habitual if habitual in by_udid else None) or compact or iphones[0]["udid"]
    if by_udid[main].get("state") != "Booted":
        result = await runner.run(["xcrun", "simctl", "bootstatus", main, "-b"], timeout=timeout)
        if result.exit_code != 0 or result.timed_out:
            raise PreflightError(f"simctl boot failed: {result.stderr}")
    if devices != "both":
        return [main]
    large = next((by_name[n] for n in LARGE_SIMULATORS if n in by_name and by_name[n] != main), None)
    second = large or (compact if compact != main else None)
    return [main, second] if second else [main]


@dataclass(frozen=True)
class XcodeTarget:
    """What xcodebuild targets: the container (-workspace / -project) and the app's scheme."""

    container: list
    scheme: str


def _container(repo_path: str, list_dir: Callable[[str], list]) -> list:
    """A workspace (CocoaPods) wins over the project: without it, Pods are not built."""
    try:
        entries = sorted(list_dir(repo_path))
    except OSError:
        return []
    for suffix, flag in ((".xcworkspace", "-workspace"), (".xcodeproj", "-project")):
        match = next((e for e in entries if e.endswith(suffix)), None)
        if match:
            return [flag, match]
    return []


def _app_scheme(name: str, schemes: list) -> str:
    """The scheme named after the project, else the first one that is not a CocoaPods scheme."""
    if name in schemes:
        return name
    candidates = [s for s in schemes if not s.startswith("Pods-")]
    if not candidates:
        raise PreflightError(f"No app scheme found among: {schemes}")
    return candidates[0]


async def detect_target(
    runner: CommandRunner,
    *,
    repo_path: str,
    timeout: float,
    list_dir: Callable[[str], list] = os.listdir,
) -> XcodeTarget:
    container = _container(repo_path, list_dir)
    result = await runner.run(["xcodebuild", "-list", "-json", *container], cwd=repo_path, timeout=timeout)
    if result.exit_code != 0 or result.timed_out:
        raise PreflightError(f"xcodebuild -list failed: {result.stderr}")

    data = json.loads(result.stdout)
    listing = data.get("workspace") or data.get("project")
    if not listing:
        raise PreflightError("xcodebuild -list output has no project or workspace")
    schemes = listing.get("schemes", [])
    if not schemes:
        raise PreflightError("No schemes found in xcodebuild -list output")
    return XcodeTarget(container=container, scheme=_app_scheme(listing.get("name", ""), schemes))


def _read_text(path: str) -> str:
    with open(path, encoding="utf-8", errors="replace") as handle:
        return handle.read()


def _pods_up_to_date(repo_path: str, read_text: Callable[[str], str]) -> bool:
    """CocoaPods' own check: Pods/Manifest.lock matches Podfile.lock."""
    try:
        return read_text(os.path.join(repo_path, "Podfile.lock")) == read_text(os.path.join(repo_path, "Pods", "Manifest.lock"))
    except (OSError, KeyError):
        return False


async def install_dependencies(
    runner: CommandRunner,
    *,
    repo_path: str,
    timeout: float,
    list_dir: Callable[[str], list] = os.listdir,
    read_text: Callable[[str], str] = _read_text,
) -> None:
    """Runs `pod install` when the repository has a Podfile and its Pods are stale (saves ~1 min otherwise)."""
    try:
        has_podfile = "Podfile" in list_dir(repo_path)
    except OSError:
        return
    if not has_podfile or _pods_up_to_date(repo_path, read_text):
        return
    result = await runner.run(["pod", "install"], cwd=repo_path, timeout=timeout)
    if result.exit_code != 0 or result.timed_out:
        raise PreflightError(f"pod install failed: {result.stderr or result.stdout}")
