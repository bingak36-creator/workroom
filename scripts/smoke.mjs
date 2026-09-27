import { _electron as electron } from 'playwright';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const packaged=!!process.env.WORKROOM_APP;
const windows=process.platform==='win32';
const label=packaged?'packaged-smoke':'ui-smoke';
const artifacts=path.join(root,'artifacts/release-audit');await fs.mkdir(artifacts,{recursive:true});
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'workroom-ui-'));
const project=path.join(temp,'project');const dataDir=path.join(temp,'data');await fs.mkdir(project);
const pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
const executable=packaged?path.resolve(process.env.WORKROOM_APP):windows
  ?path.join(root,'node_modules/electron/dist/electron.exe')
  :path.join(root,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const env={...process.env,WORKROOM_DATA_DIR:dataDir,WORKROOM_PORT:'0',WORKROOM_ISOLATED_TEST:'1',ELECTRON_ENABLE_SECURITY_WARNINGS:'1'};
// Finder-launched apps carry no locale; the smoke mirrors that so the command locale fallback is exercised.
for(const key of ['ELECTRON_RUN_AS_NODE','ELECTRON_RENDERER_URL','WORKROOM_TUNNEL_CLIENT','NODE_OPTIONS','LANG','LC_ALL','LC_CTYPE'])delete env[key];
let app;let page;let bridge;let endpoint;let rpcId=0;const checks=[];const errors=[];const start=Date.now();
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,description,timeout=10000){const deadline=Date.now()+timeout;while(Date.now()<deadline){if(await fn())return;await pause(50);}throw new Error('Timed out: '+description);}
async function launch(){
  app=await electron.launch({executablePath:executable,args:packaged?[]:[root],cwd:root,env,timeout:15000});
  page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));
  await page.waitForSelector('nav button',{timeout:10000});
  endpoint=JSON.parse(await fs.readFile(path.join(dataDir,'connection.json'),'utf8')).endpoint;
}
async function rpc(method,params){
  const res=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:++rpcId,method,params}),signal:AbortSignal.timeout(30000)});
  assert.equal(res.status,200);assert.equal(res.headers.get('cache-control'),'no-store');
  const text=await res.text();const body=JSON.parse(text.split('\n').find(line=>line.startsWith('data:'))?.slice(5)??text);
  assert.ok(!body.error,JSON.stringify(body.error));return body.result;
}
async function tool(name,args){const result=await rpc('tools/call',{name,arguments:args});if(result.isError)throw new Error(result.content[0].text);return JSON.parse(result.content[0].text);}
async function jobDone(id){let value;await until(async()=>{value=await tool('job_get',{jobId:id});return !['pending','queued','running'].includes(value.state);},'job completion');return value;}
async function exists(file){return fs.stat(file).then(()=>true,()=>false);}
async function snapshot(){return page.evaluate(()=>window.workroom.snapshot());}
async function nativeResponse(response){await app.evaluate(({dialog},value)=>{globalThis.__workroomConfirmations=0;dialog.showMessageBox=async()=>{globalThis.__workroomConfirmations++;return {response:value,checkboxChecked:false};};},response);}
try{
  await launch();
  assert.equal(page.url(),'workroom://app/index.html');
  let snap=await snapshot();assert.equal(snap.version,pkg.version);assert.equal(snap.runtime.packaged,packaged);assert.equal(snap.endpoint,null);
  assert.equal(await page.locator('[data-tab="tokens"]').count(),0);
  assert.equal(await page.evaluate(()=>typeof window.workroom.estimateTokens),'undefined');
  assert.equal(await page.evaluate(()=>typeof window.require),'undefined');
  const prefs=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
  assert.equal(prefs.contextIsolation,true);assert.equal(prefs.nodeIntegration,false);assert.equal(prefs.sandbox,true);assert.equal(prefs.webSecurity,true);
  checks.push('custom protocol, isolated renderer, redacted endpoint and token feature removed');
  await app.evaluate(({dialog},folder)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]});},project);
  await page.locator('[data-action="add-project"]').first().click();
  await until(async()=>(await snapshot()).projects.length===1,'project added');
  const p=(await snapshot()).projects[0];assert.equal(p.writable,false);assert.equal(p.approvalMode,'review');
  const initialize=await rpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'workroom-release-smoke',version:'1'}});
  assert.equal(initialize.serverInfo.version,pkg.version);
  const tools=(await rpc('tools/list',{})).tools;assert.ok(!tools.some(t=>t.name==='token_estimate'));assert.ok(['files_read_batch','file_patch'].every(name=>tools.some(t=>t.name===name)));
  const denied=await rpc('tools/call',{name:'file_propose',arguments:{projectId:p.id,requestId:randomUUID(),path:'no.txt',content:'no',expectedHash:null}});assert.equal(denied.isError,true);
  await page.locator('[name=folder]').fill('/');await page.locator('#folder-form button').click();
  await until(async()=>(await snapshot()).projects[0].approvedFolders.includes(''),'folder approved').catch(async error=>{
    console.error('Folder approval diagnostic:',JSON.stringify({project:(await snapshot()).projects[0],input:await page.locator('#approved-folder-path').inputValue(),toast:await page.locator('#toast').textContent()}));
    throw error;
  });
  await page.locator('#writable').check();await until(async()=>(await snapshot()).projects[0].writable,'write enabled');
  await page.locator('#approval-mode').selectOption('delete');await until(async()=>(await snapshot()).projects[0].approvalMode==='delete','delete mode enabled');
  const input={projectId:p.id,requestId:randomUUID(),path:'hello.txt',content:'Workroom smoke 한글 👋\n',expectedHash:null};
  const acceptedAt=Date.now();const write=await tool('file_propose',input);const writeCallMs=Date.now()-acceptedAt;
  assert.equal(write.state,'done','automatic write should finish within one tool call');assert.equal(await fs.readFile(path.join(project,'hello.txt'),'utf8'),input.content);
  const patched=await tool('file_patch',{projectId:p.id,requestId:randomUUID(),path:'hello.txt',expectedHash:write.resultHash,edits:[{oldText:'smoke',newText:'patched'}]});
  assert.equal(patched.state,'done');assert.equal(await fs.readFile(path.join(project,'hello.txt'),'utf8'),'Workroom patched 한글 👋\n');
  assert.equal((await tool('file_propose',input)).id,write.id);
  assert.equal((await tool('files_read_batch',{projectId:p.id,paths:['hello.txt']}))[0].hash,patched.resultHash);
  checks.push('real MCP initialization, single-call write, resultHash patch chain, batch read and duplicate retry');
  const task=await tool('task_create',{projectId:p.id,title:'Smoke checkpoint',objective:'Preserve across restart'});
  await tool('task_update',{taskId:task.id,status:'done',summary:'Verified checkpoint'});
  const command=await tool('command_propose',{projectId:p.id,requestId:randomUUID(),command:windows?"[System.IO.File]::WriteAllText('command.txt','approved')":'printf approved > command.txt'});
  assert.equal(command.state,'pending');assert.equal(await exists(path.join(project,'command.txt')),false);
  await page.locator('[data-tab="jobs"]').click();await page.locator(`[data-approve="${command.id}"]`).click();
  assert.equal((await jobDone(command.id)).state,'done');assert.equal(await fs.readFile(path.join(project,'command.txt'),'utf8'),'approved');
  const reject=await tool('command_propose',{projectId:p.id,requestId:randomUUID(),command:windows?"New-Item rejected.txt -ItemType File":'touch rejected.txt'});
  await page.locator(`[data-reject="${reject.id}"]`).click();assert.equal((await jobDone(reject.id)).state,'declined');assert.equal(await exists(path.join(project,'rejected.txt')),false);
  checks.push('manual command approval and rejection via UI');
  await nativeResponse(0);await page.locator('#approval-mode').selectOption('automatic');
  await until(()=>app.evaluate(()=>globalThis.__workroomConfirmations>0),'native risk confirmation');
  await until(async()=>await page.locator('#approval-mode').inputValue()==='delete','cancelled risk dialog restores policy');
  assert.equal((await snapshot()).projects[0].approvalMode,'delete');
  await nativeResponse(1);await page.locator('#approval-mode').selectOption('automatic');
  await until(async()=>(await snapshot()).projects[0].approvalMode==='automatic','automatic mode enabled after consent');
  const deletion=await tool('file_delete',{projectId:p.id,requestId:randomUUID(),path:'hello.txt',expectedHash:patched.resultHash});assert.equal(deletion.state,'done');assert.equal(await exists(path.join(project,'hello.txt')),false);
  if(windows){
    const unsupported=await rpc('tools/call',{name:'command_propose',arguments:{projectId:p.id,requestId:randomUUID(),command:'Get-Content command.txt'}});
    assert.equal(unsupported.isError,true,'Windows automatic command must fail closed');
    await page.locator('#approval-mode').selectOption('review');
    await until(async()=>(await snapshot()).projects[0].approvalMode==='review','review mode enabled');
  }else{
    const locale=await tool('command_propose',{projectId:p.id,requestId:randomUUID(),command:"printf '한글' | wc -m | tr -d ' '"});
    assert.equal(locale.output.trim(),'2','commands need a UTF-8 character locale');
  }
  const runningCall=tool('command_propose',{projectId:p.id,requestId:randomUUID(),command:windows?'Write-Output started; Start-Sleep -Seconds 30':'printf started; sleep 30'});
  if(windows){
    const pending=await runningCall;
    assert.equal(pending.state,'pending');
    await page.locator(`[data-approve="${pending.id}"]`).click();
  }
  let running;await until(async()=>(running=(await snapshot()).jobs.find(j=>j.state==='running'&&j.output.includes('started'))),'running output');
  await page.locator(`[data-cancel-job="${running.id}"]`).click();
  if(windows)assert.equal((await jobDone(running.id)).state,'cancelled');
  else assert.equal((await runningCall).state,'cancelled','UI stop releases the held tool call');
  await page.screenshot({path:path.join(artifacts,label+'.png'),fullPage:true});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+2),'Unexpected horizontal UI overflow');
  checks.push(windows?'native opt-in, automatic deletion, rejected automatic command, reviewed PowerShell stop and UI layout bounds':'native opt-in, single-call automatic deletion, UTF-8 command locale, running command stop and UI layout bounds');
  await page.locator('[data-action="clear-history"]').click();await until(async()=>(await snapshot()).jobs.length===0,'completed history cleanup');
  assert.equal((await tool('file_propose',input)).id,write.id);assert.equal(await exists(path.join(project,'hello.txt')),false);
  checks.push('history cleanup keeps replay protection');
  const config=JSON.parse(await fs.readFile(path.join(dataDir,'local-mcp.json'),'utf8')).mcpServers.workroom;
  bridge=spawn(config.command,config.args,{env:{...env,...config.env},stdio:['pipe','pipe','pipe']});
  let buffer='';const responses=new Map();bridge.stdout.on('data',chunk=>{buffer+=chunk.toString();let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(line.trim()){const message=JSON.parse(line);if(message.id)responses.set(message.id,message);}}});
  bridge.stderr.resume();
  bridge.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'stdio-smoke',version:'1'}}})+'\n');
  await until(()=>responses.has(1),'stdio initialize');assert.ok(!responses.get(1).error);
  bridge.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  bridge.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list',params:{}})+'\n');
  await until(()=>responses.has(2),'stdio tools');assert.equal(responses.get(2).result.tools.length,tools.length);bridge.kill();bridge=null;
  checks.push('packaged-compatible STDIO bridge');
  const oldEndpoint=endpoint;await app.close();app=null;assert.equal(await exists(path.join(dataDir,'connection.json')),false);
  await launch();snap=await snapshot();assert.equal(snap.projects[0].writable,false);assert.equal(snap.projects[0].approvalMode,'review');assert.equal(snap.tasks[0].summary,'Verified checkpoint');assert.notEqual(endpoint,oldEndpoint);
  checks.push('restart resets authority, rotates secret and restores checkpoints');
  assert.deepEqual(errors,[]);
  const report={at:new Date().toISOString(),version:pkg.version,packaged,passed:true,durationMs:Date.now()-start,automaticWriteCallMs:writeCallMs,checks};
  await fs.writeFile(path.join(artifacts,label+'.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){
  if(page)await page.screenshot({path:path.join(artifacts,label+'-failure.png'),fullPage:true}).catch(()=>{});
  await fs.writeFile(path.join(artifacts,label+'.json'),JSON.stringify({at:new Date().toISOString(),passed:false,packaged,checks,error:String(error)},null,2));
  throw error;
}finally{
  bridge?.kill();if(app)await app.close().catch(()=>{});await fs.rm(temp,{recursive:true,force:true});
}
