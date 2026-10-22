import asyncio
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Protocol, Union


@dataclass
class CommandResult:
    exit_code: int
    stdout: str
    stderr: str
    timed_out: bool = False


class CommandRunner(Protocol):
    async def run(
        self,
        args: "list[str]",
        *,
        cwd: Optional[Union[str, Path]] = None,
        timeout: float,
    ) -> CommandResult: ...


class SubprocessCommandRunner:
    async def run(
        self,
        args: "list[str]",
        *,
        cwd: Optional[Union[str, Path]] = None,
        timeout: float,
    ) -> CommandResult:
        process = await asyncio.create_subprocess_exec(
            *args,
            cwd=str(cwd) if cwd is not None else None,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                process.communicate(), timeout=timeout
            )
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
            return CommandResult(exit_code=-1, stdout="", stderr="", timed_out=True)

        return CommandResult(
            exit_code=process.returncode or 0,
            stdout=stdout_bytes.decode("utf-8", errors="replace"),
            stderr=stderr_bytes.decode("utf-8", errors="replace"),
        )
