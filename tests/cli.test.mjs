import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const bridge = fileURLToPath(new URL('../zcode-plugin/hooks/bridge.mjs', import.meta.url));

test('CLI quota → manual ZCode hooks → unbind → original Codex thread', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hs-cli-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const worker = path.join(dir, 'worker.mjs');
  await fs.writeFile(worker, `
const args=process.argv.slice(2);
const resumed=args.includes('resume');
if(resumed && args[args.indexOf('resume')+1]!=='saved-thread') process.exit(3);
if(resumed && !args.at(-1).includes('ZCode fixed the edge case')) process.exit(4);
console.log(JSON.stringify({type:'thread.started',thread_id:'saved-thread'}));
console.log(JSON.stringify(resumed ? {type:'turn.completed'} : {type:'turn.failed',error:{message:'usage limit reached'}}));
process.exitCode=resumed?0:1;
`);
  const env = { ...process.env, HARNESS_SUPERVISOR_HOME: path.join(dir, 'state'),
    CODEX_BIN: process.execPath, CODEX_SUPERVISOR_ARGS_JSON: '[]',
    ZCODE_SUPERVISOR_ARGS_JSON: '[]', ZCODE_SUPERVISOR_RESUME_ARGS_JSON: '[]',
    HARNESS_SUPERVISOR_EVENT_SINK: '', HARNESS_SUPERVISOR_CONTEXT_FILE: '', ZCODE_PLUGIN_DATA: path.join(dir,'plugin') };
  // A real executable fixture receives the native Codex argv unchanged.
  const launcher = path.join(dir, 'codex');
  await fs.writeFile(launcher, `#!/usr/bin/env node\nimport ${JSON.stringify(worker)};\n`, { mode: 0o755 });
  env.CODEX_BIN = launcher;
  const run = (args) => spawnSync(process.execPath, [cli, ...args], {env,encoding:'utf8',timeout:10000});
  const first=run(['run','--cwd',dir,'--task','fix edge case','--json']);
  assert.equal(first.status,2,first.stderr);
  const {task}=JSON.parse(first.stdout);
  assert.equal(task.status,'awaiting_manual');
  assert.equal(run(['bind-zcode',task.id]).status,0);
  for(const [hook,extra] of [['SessionStart',{}],['Stop',{last_assistant_message:'ZCode fixed the edge case'}]]) {
    const response=spawnSync(process.execPath,[bridge],{env,encoding:'utf8',input:JSON.stringify({cwd:dir,session_id:'desktop-1',hook_event_name:hook,...extra}),timeout:10000});
    assert.equal(response.status,0,response.stderr);
    if(hook==='SessionStart') assert.match(JSON.parse(response.stdout).hookSpecificOutput.additionalContext,/fix edge case/);
  }
  const blocked=run(['takeover',task.id,'--to','codex']);
  assert.equal(blocked.status,1);
  assert.match(blocked.stderr,/unbind-zcode/);
  assert.equal(run(['unbind-zcode',task.id]).status,0);
  const final=run(['takeover',task.id,'--to','codex','--json']);
  assert.equal(final.status,0,final.stderr);
  assert.equal(JSON.parse(final.stdout).task.sessions.codex,'saved-thread');
  assert.match(run(['status',task.id]).stdout,/状态：completed/);
});
