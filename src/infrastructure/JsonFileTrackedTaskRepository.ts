import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TrackedTaskRepository } from "../adapters/TrackedTaskRepository.js";
import { TrackedTask, type TrackedTaskProps } from "../domain/TrackedTask.js";

/** Tracked tasks in discovery order, reply cursors included, so they survive restarts. */
export class JsonFileTrackedTaskRepository implements TrackedTaskRepository {
  constructor(private readonly filePath: string) {}

  async all(): Promise<TrackedTask[]> {
    try {
      const raw = JSON.parse(await readFile(this.filePath, "utf-8")) as TrackedTaskProps[];
      return raw.map((p) => TrackedTask.fromProps(p)).sort((a, b) => a.discoveredAt.localeCompare(b.discoveredAt));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  /** Written to a temporary file then renamed, so a crash never leaves a truncated file behind. */
  async save(task: TrackedTask): Promise<void> {
    const others = (await this.all()).filter((t) => t.key !== task.key);
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify([...others, task].map((t) => t.toJSON()), null, 2), "utf-8");
    await rename(temporary, this.filePath);
  }
}
