import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

async function check(dir) {
  for (const entry of await fs.readdir(dir, {withFileTypes:true})) {
    const file=path.join(dir,entry.name);
    if(entry.isDirectory()) await check(file);
    else if(file.endsWith('.mjs')) {
      const result=spawnSync(process.execPath,['--check',file],{stdio:'inherit'});
      if(result.error) throw result.error;
      if(result.status!==0) process.exit(result.status??1);
    }
  }
}
for(const dir of ['src','tests','zcode-plugin','scripts']) await check(dir);
console.log('All JavaScript syntax checks passed.');
