import type { TrackedTask } from "../domain/TrackedTask.js";

export interface TrackedTaskRepository {
  all(): Promise<TrackedTask[]>;
  save(task: TrackedTask): Promise<void>;
}
