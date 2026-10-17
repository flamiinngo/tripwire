import { addTask, completeTask, openTasks } from "./tasks.js";

addTask("Read the brief");
addTask("Fix the bug");
completeTask(1);
console.log("Open tasks:", openTasks().map((t) => t.title));
