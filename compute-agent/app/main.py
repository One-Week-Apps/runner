import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import BackgroundTasks, FastAPI
from fastapi.staticfiles import StaticFiles

from app.job_runner import run_job
from app.models import JobRequest
from app.pipeline.command_runner import SubprocessCommandRunner
from app.pipeline.preflight import pick_simulators
from app.settings import settings

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
settings.screenshots_dir.mkdir(parents=True, exist_ok=True)


async def _boot_main_simulator() -> None:
    try:
        await pick_simulators(SubprocessCommandRunner(), devices="main", timeout=300)
    except Exception:
        logging.getLogger(__name__).warning("Simulator warm-up failed", exc_info=True)


@asynccontextmanager
async def lifespan(_: FastAPI):
    """Boot the main simulator as soon as the Runner starts (often when the Mac wakes up),
    so the first task does not wait for a cold start."""
    asyncio.get_running_loop().create_task(_boot_main_simulator())
    yield


app = FastAPI(lifespan=lifespan)

app.mount("/screenshots", StaticFiles(directory=settings.screenshots_dir), name="screenshots")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/jobs", status_code=202)
async def create_job(job: JobRequest, background_tasks: BackgroundTasks) -> dict[str, str]:
    background_tasks.add_task(
        run_job,
        job,
        runner=SubprocessCommandRunner(),
        timeout_seconds=settings.job_timeout_seconds,
        screenshots_dir=settings.screenshots_dir.resolve(),
        base_url=settings.self_base_url,
        repos_dir=settings.repos_dir,
    )
    return {"jobId": job.job_id, "status": "accepted"}
