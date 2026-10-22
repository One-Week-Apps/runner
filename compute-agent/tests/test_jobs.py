from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

import app.main as main_module
from app.main import app

SAMPLE_JOB_BODY = {
    "jobId": "job-1",
    "feature": {
        "description": "Add a settings screen",
        "repo": "/tmp/fake-repo",
        "branch": "main",
        "attemptNumber": 0,
        "instruction": "initial_dev",
        "lastFeedback": None,
    },
    "callbackUrl": "http://localhost:3939/api/jobs/job-1/callback",
}


def test_create_job_returns_202_immediately(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(main_module, "run_job", AsyncMock())

    client = TestClient(app)
    response = client.post("/jobs", json=SAMPLE_JOB_BODY)

    assert response.status_code == 202
    assert response.json() == {"jobId": "job-1", "status": "accepted"}


def test_create_job_schedules_run_job_with_correct_args(monkeypatch: pytest.MonkeyPatch) -> None:
    mock_run_job = AsyncMock()
    monkeypatch.setattr(main_module, "run_job", mock_run_job)

    client = TestClient(app)
    client.post("/jobs", json=SAMPLE_JOB_BODY)

    mock_run_job.assert_awaited_once()
    call = mock_run_job.await_args
    job_arg = call.args[0]
    assert job_arg.job_id == "job-1"
    assert call.kwargs["timeout_seconds"] == main_module.settings.job_timeout_seconds
