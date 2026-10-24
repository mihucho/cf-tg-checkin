/** 测试入口：汇总所有用例后统一执行 */
import { runAll } from "./harness.ts";
import "./time.test.ts";
import "./dsl.test.ts";
import "./buttons.test.ts";
import "./targets.test.ts";
import "./guard.test.ts";
import "./command.test.ts";
import "./task.test.ts";
import "./events.test.ts";

void runAll();
