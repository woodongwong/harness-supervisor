import { AutoHandoff, denyHook } from "./auto-handoff.mjs";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
let input;
try {
  input = JSON.parse(raw);
  const result = await new AutoHandoff({ root: process.argv[3] }).handle(process.argv[2], input);
  process.stdout.write(JSON.stringify(result ?? {}) + "\n");
} catch (error) {
  const hook = input?.hook_event_name ?? input?.hookEventName;
  process.stderr.write(`[harness-relay] ${error.message}\n`);
  process.stdout.write(JSON.stringify(denyHook(hook, `交接记录失败，暂不执行：${error.message}`)) + "\n");
  // Do not use a generic nonzero exit for tool guards: clients can fail open.
}
