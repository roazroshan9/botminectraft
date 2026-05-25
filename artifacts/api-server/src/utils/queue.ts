export type TaskStatus = "pending" | "running" | "done" | "failed" | "cancelled";

export interface Task {
  id: string;
  name: string;
  description: string;
  status: TaskStatus;
  progress: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  fn: () => Promise<void>;
  cancelFn?: () => void;
}

type TaskDoneCallback = (task: Task) => void;
type TaskListCallback = (tasks: Task[]) => void;

export class TaskQueue {
  private queue: Task[] = [];
  private current: Task | null = null;
  private running = false;
  private idCounter = 0;
  private updateListeners: Set<TaskListCallback> = new Set();
  private doneListeners:   Set<TaskDoneCallback>  = new Set();

  enqueue(
    name: string,
    description: string,
    fn: () => Promise<void>,
    cancelFn?: () => void,
  ): Task {
    const task: Task = {
      id: `task_${++this.idCounter}_${Date.now()}`,
      name,
      description,
      status: "pending",
      progress: 0,
      createdAt: Date.now(),
      fn,
      cancelFn,
    };
    this.queue.push(task);
    this.notify();
    this.run();
    return task;
  }

  private async run() {
    if (this.running || this.queue.length === 0) return;
    this.running = true;
    const task = this.queue.shift()!;
    this.current = task;
    task.status = "running";
    task.startedAt = Date.now();
    this.notify();

    try {
      await task.fn();
      if (task.status !== "cancelled") {
        task.status = "done";
        task.progress = 100;
      }
    } catch (err: unknown) {
      if (task.status !== "cancelled") {
        task.status = "failed";
        task.error = err instanceof Error ? err.message : String(err);
      }
    } finally {
      task.finishedAt = Date.now();
      this.current = null;
      this.running = false;
      this.notify();
      this.doneListeners.forEach(l => l(task));
      this.run();
    }
  }

  cancelCurrent() {
    if (this.current) {
      this.current.status = "cancelled";
      this.current.cancelFn?.();
      this.notify();
    }
  }

  clearQueue() {
    this.queue.forEach(t => { t.status = "cancelled"; });
    this.queue = [];
    this.notify();
  }

  stopAll() {
    this.cancelCurrent();
    this.clearQueue();
  }

  updateProgress(taskId: string, progress: number) {
    if (this.current?.id === taskId) {
      this.current.progress = Math.min(100, Math.max(0, progress));
      this.notify();
    }
  }

  /** Convenience: update progress on whatever task is currently running */
  tick(progress: number) {
    if (this.current) {
      this.current.progress = Math.min(100, Math.max(0, progress));
      this.notify();
    }
  }

  getCurrent():  Task | null  { return this.current; }
  getQueue():    Task[]       { return [...this.queue]; }
  isRunning():   boolean      { return this.running; }
  getCurrentId():string       { return this.current?.id ?? ""; }

  onUpdate(listener: TaskListCallback) {
    this.updateListeners.add(listener);
    return () => this.updateListeners.delete(listener);
  }

  onDone(listener: TaskDoneCallback) {
    this.doneListeners.add(listener);
    return () => this.doneListeners.delete(listener);
  }

  private notify() {
    const tasks = this.current ? [this.current, ...this.queue] : [...this.queue];
    this.updateListeners.forEach(l => l(tasks));
  }
}
