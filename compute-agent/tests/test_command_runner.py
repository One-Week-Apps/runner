from app.pipeline.command_runner import SubprocessCommandRunner


async def test_run_returns_stdout_and_exit_code():
    runner = SubprocessCommandRunner()
    result = await runner.run(["echo", "hello"], timeout=5)
    assert result.exit_code == 0
    assert result.stdout.strip() == "hello"
    assert result.timed_out is False


async def test_run_captures_nonzero_exit_code():
    runner = SubprocessCommandRunner()
    result = await runner.run(["sh", "-c", "exit 3"], timeout=5)
    assert result.exit_code == 3


async def test_run_times_out_and_kills_process():
    runner = SubprocessCommandRunner()
    result = await runner.run(["sleep", "5"], timeout=0.2)
    assert result.timed_out is True
