// A tiny in-memory task list.
const tasks = [];

export function addTask(title) {
  const task = { id: tasks.length + 1, title, done: false };
  tasks.push(task);
  return task;
}

export function completeTask(id) {
  const task = tasks.find((t) => t.id === id);
  if (task) task.done = true;
  return task;
}

// Bug for the candidate to fix: this returns finished tasks instead of open ones.
export function openTasks() {
  return tasks.filter((t) => t.done);
}
