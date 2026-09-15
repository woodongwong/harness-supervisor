import test from "node:test";
import assert from "node:assert/strict";
import { summarizeWorkerOutput } from "../src/worker-output.mjs";
test("Codex JSONL and CodeBuddy message arrays extract only assistant replies",()=>{
 assert.deepEqual(summarizeWorkerOutput(JSON.stringify([{type:"message",role:"user",content:[{type:"input_text",text:"secret prompt"}]},{type:"message",role:"assistant",content:[{type:"output_text",text:"Ready"}]}])),{reply:"Ready"});
 assert.deepEqual(summarizeWorkerOutput('{"type":"thread.started","thread_id":"example"}\n{"type":"item.completed","item":{"type":"agent_message","text":"Done"}}\n'),{sessionId:"example",reply:"Done"});
 assert.equal(summarizeWorkerOutput('{"type":"turn.failed"}\n').failed,true);
 assert.deepEqual(summarizeWorkerOutput('truncated prefix\n{"type":"item.completed","item":{"type":"agent_message","text":"Done"}}\n',{partial:true}),{reply:"Done"});
 assert.deepEqual(summarizeWorkerOutput('Process completed successfully'),{});
});
