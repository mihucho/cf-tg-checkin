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
import "./roundtrip.test.ts";
import "./socket.test.ts";
import "./budget.test.ts";
import "./webhook.test.ts";
import "./digest.test.ts";
import "./rate.test.ts";
import "./notify-test.test.ts";
import "./release-doc.test.ts";

void runAll();
