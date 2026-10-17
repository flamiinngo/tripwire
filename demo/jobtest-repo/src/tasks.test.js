import assert from "node:assert";
import { addTask, completeTask, openTasks } from "./tasks.js";

addTask("a");
addTask("b");
completeTask(1);
assert.deepStrictEqual(openTasks().map((t) => t.title), ["b"]);
console.log("all tests passed");
