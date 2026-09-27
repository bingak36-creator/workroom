import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const reportDir=path.join(root,'artifacts','release-audit');
await fs.mkdir(reportDir,{recursive:true});
const checks=[
  ['typecheck','node_modules/typescript/bin/tsc',['--noEmit']],
  ['tests','node_modules/vitest/vitest.mjs',['run','--reporter=default','--reporter=json','--outputFile=artifacts/release-audit/tests.json']],
  ['build','node_modules/electron-vite/bin/electron-vite.js',['build']]
];
const results=[];
for(const [name,script,args] of checks){
  const started=Date.now();
  const code=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[path.join(root,script),...args],{cwd:root,env:{...process.env,NO_COLOR:'1'},stdio:'inherit'});
    child.once('error',reject);child.once('close',code=>resolve(code??1));
  });
  results.push({name,exitCode:code,durationMs:Date.now()-started});
  if(code!==0)break;
}
const passed=results.length===checks.length&&results.every(r=>r.exitCode===0);
const report={at:new Date().toISOString(),platform:process.platform,arch:process.arch,node:process.version,passed,checks:results};
await fs.writeFile(path.join(reportDir,'verify.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
if(!passed)process.exitCode=1;
