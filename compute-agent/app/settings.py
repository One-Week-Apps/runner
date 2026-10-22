import os
from pathlib import Path


class Settings:
    port: int = int(os.environ.get("PORT", "8000"))
    screenshots_dir: Path = Path(os.environ.get("SCREENSHOTS_DIR", "screenshots"))
    job_timeout_seconds: float = float(os.environ.get("JOB_TIMEOUT_SECONDS", "900"))
    self_base_url: str = os.environ.get("SELF_BASE_URL", f"http://127.0.0.1:{port}")
    # Clones managed by the Runner: the pipeline never touches a personal working copy.
    repos_dir: Path = Path(os.environ.get("AITASKER_REPOS_DIR", str(Path.home() / ".aitasker" / "repos")))


settings = Settings()
