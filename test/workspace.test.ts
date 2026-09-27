import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/main/store';
import { Workspace, commandEnvironment } from '../src/main/service';
import { terminal, requiresFileReview } from '../src/main/request';
import * as files from '../src/main/files';
import { startServer } from '../src/main/server';
import { workspaceInvoker, definitions } from '../src/main/tools';
import { atomicPrivateWrite, readPrivateText } from '../src/main/private-io';
import type { Job } from '../src/shared';

let temp: string, store: Store, work: Workspace, projectId: string;
const request = () => ({ projectId, requestId: randomUUID() });
const write = (name='hello.txt', content='hello', expectedHash: string|null=null) => work.propose({ ...request(), kind:'write', path:name, content, expectedHash });
const command = (value: string) => work.propose({ ...request(), kind:'command', command:value });
async function completed(id: string): Promise<Job> { await work.waitForIdle(); return work.jobSnapshot(id); }
beforeEach(async()=>{
  temp=await fs.mkdtemp(path.join(os.tmpdir(),'workroom-release-test-'));
  await fs.mkdir(path.join(temp,'project'));
  store=new Store(path.join(temp,'data','workspace.json'));await store.load();
  work=new Workspace(store,path.join(temp,'data'));
  projectId=(await work.addProject(path.join(temp,'project'))).id;
  await work.approveFolder(projectId,'');
});
afterEach(async()=>{await work.shutdown();await fs.rm(temp,{recursive:true,force:true});});

describe('File boundaries and data integrity',()=>{
  it('refuses traversal, absolute paths, credentials, symlinks and hardlinks',async()=>{
    await fs.writeFile(path.join(temp,'outside.txt'),'private');
    await fs.symlink(path.join(temp,'outside.txt'),path.join(temp,'project','escape.txt'));
    await fs.link(path.join(temp,'outside.txt'),path.join(temp,'project','hardlink.txt'));
    for(const name of ['../outside.txt',path.join(temp,'outside.txt'),'.env','.envbackup','.ssh/id_rsa','secret.p8','escape.txt','hardlink.txt','.workroom-state.tmp']) await expect(files.readFile(work.project(projectId),name)).rejects.toThrow();
  });
  it('refuses a FIFO without blocking a file read',async()=>{
    if(process.platform==='win32')return;
    execFileSync('/usr/bin/mkfifo',[path.join(temp,'project','pipe')]);
    await expect(files.readFile(work.project(projectId),'pipe')).rejects.toThrow('특수');
  });
  it('reads bounded text with its SHA-256 and rejects binary and oversized data',async()=>{
    await fs.writeFile(path.join(temp,'project','a'),'hello');
    expect((await files.readFile(work.project(projectId),'a')).hash).toBe(files.hash('hello'));
    await fs.writeFile(path.join(temp,'project','large'),Buffer.alloc(262145,65));
    await fs.writeFile(path.join(temp,'project','binary'),Buffer.from([0,1,2]));
    await expect(files.readFile(work.project(projectId),'large')).rejects.toThrow();
    await expect(files.readFile(work.project(projectId),'binary')).rejects.toThrow();
  });
  it('preserves BOM, Korean and emoji bytes through read and write',async()=>{
    await work.writable(projectId,true);
    const text='\ufeff안녕하세요 👋\n';const j=await write('unicode.txt',text);await work.decide(j.id,true);
    expect((await completed(j.id)).state).toBe('done');
    expect((await files.readFile(work.project(projectId),'unicode.txt')).content).toBe(text);
    expect(await fs.readFile(path.join(temp,'project','unicode.txt'),'utf8')).toBe(text);
  });
  it('refuses NUL and unpaired surrogates before scheduling',async()=>{
    await work.writable(projectId,true);
    for(const text of ['a\0b','\ud800'])await expect(write('invalid.txt',text)).rejects.toThrow();
    expect(store.data.jobs).toHaveLength(0);
  });
  it('does not overwrite an existing file under create-only semantics',async()=>{
    await work.writable(projectId,true);await fs.writeFile(path.join(temp,'project','a.txt'),'original');
    await expect(write('a.txt','replacement',null)).rejects.toThrow('변경');
    expect(await fs.readFile(path.join(temp,'project','a.txt'),'utf8')).toBe('original');
  });
  it('checks revision after a reviewed proposal and preserves external changes',async()=>{
    await work.writable(projectId,true);await work.setApprovalMode(projectId,'review');
    await fs.writeFile(path.join(temp,'project','a.txt'),'before');
    const j=await write('a.txt','after',files.hash('before'));
    await fs.writeFile(path.join(temp,'project','a.txt'),'external');
    await work.decide(j.id,true);
    expect((await completed(j.id)).state).toBe('failed');
    expect(await fs.readFile(path.join(temp,'project','a.txt'),'utf8')).toBe('external');
  });
  it('rechecks authorization immediately before commit',async()=>{
    await work.writable(projectId,true);
    await expect(files.writeFile(work.project(projectId),'no.txt','new',null,()=>false)).rejects.toThrow('권한');
    await expect(fs.stat(path.join(temp,'project','no.txt'))).rejects.toThrow();
  });
  it('prevents broad roots and application data from becoming projects',async()=>{
    await expect(work.addProject(os.homedir())).rejects.toThrow();
    await expect(work.addProject(path.parse(temp).root)).rejects.toThrow();
    await expect(work.addProject(path.join(temp,'data'))).rejects.toThrow();
    await expect(work.addProject(temp)).rejects.toThrow();
  });
});

describe('Explicit approval modes and asynchronous execution',()=>{
  it('requires a folder grant for reads, writes and deletes',async()=>{
    const invoke=workspaceInvoker(work);
    await fs.mkdir(path.join(temp,'project','private'));
    await fs.writeFile(path.join(temp,'project','private','secret.txt'),'secret');
    await work.revokeFolder(projectId,'');
    await expect(invoke('file_read',{projectId,path:'private/secret.txt'})).rejects.toThrow('접근 승인');
    await work.writable(projectId,true);await work.setApprovalMode(projectId,'automatic');
    await expect(invoke('file_propose',{...request(),path:'private/new.txt',content:'new',expectedHash:null})).rejects.toThrow('접근 승인');
    await expect(invoke('file_delete',{...request(),path:'private/secret.txt',expectedHash:files.hash('secret')})).rejects.toThrow('접근 승인');
    await work.approveFolder(projectId,'private');
    expect((await invoke('file_read',{projectId,path:'private/secret.txt'}) as {content:string}).content).toBe('secret');
    expect(await invoke('file_propose',{...request(),path:'private/new.txt',content:'new',expectedHash:null})).toMatchObject({state:'done'});
    expect(await invoke('file_delete',{...request(),path:'private/secret.txt',expectedHash:files.hash('secret')})).toMatchObject({state:'done'});
  });
  it('queues a folder access request for local approval before file retry',async()=>{
    const invoke=workspaceInvoker(work);
    await work.revokeFolder(projectId,'');
    await fs.mkdir(path.join(temp,'project','new-folder'));
    await fs.writeFile(path.join(temp,'project','new-folder','a.txt'),'a');
    const job=await invoke('folder_access_request',{...request(),path:'new-folder'}) as Job;
    expect(job.state).toBe('pending');
    await expect(invoke('file_read',{projectId,path:'new-folder/a.txt'})).rejects.toThrow('접근 승인');
    await work.decide(job.id,true);expect(work.job(job.id).state).toBe('done');
    expect((await invoke('file_read',{projectId,path:'new-folder/a.txt'}) as {content:string}).content).toBe('a');
  });
  it('reviews deletion in delete mode and every change in review mode',async()=>{
    await work.writable(projectId,true);await work.setApprovalMode(projectId,'delete');
    const created=await write('a.txt','a');expect((await completed(created.id)).state).toBe('done');
    const deletion=await work.propose({...request(),kind:'delete',path:'a.txt',expectedHash:files.hash('a')});
    expect(deletion.state).toBe('pending');await work.decide(deletion.id,true);expect((await completed(deletion.id)).state).toBe('done');
    await work.setApprovalMode(projectId,'review');expect((await write('b.txt','b')).state).toBe('pending');
  });
  it('does not let an automatic shell command read or write outside approved folders',async()=>{
    if(process.platform!=='darwin')return;
    await fs.mkdir(path.join(temp,'project','allowed'));
    await fs.mkdir(path.join(temp,'project','denied'));
    await fs.writeFile(path.join(temp,'project','denied','secret.txt'),'secret');
    await work.revokeFolder(projectId,'');await work.approveFolder(projectId,'allowed');
    await work.writable(projectId,true);await work.setApprovalMode(projectId,'automatic');
    const yes=await command('printf allowed > allowed/ok.txt');
    expect((await completed(yes.id)).state).toBe('done');
    const no=await command('cat denied/secret.txt');
    expect((await completed(no.id)).state).toBe('failed');
    const alias=await command('cat /System/Volumes/Data' + path.join(temp,'project','denied','secret.txt'));
    expect((await completed(alias.id)).state).toBe('failed');
    await fs.writeFile(path.join(temp,'outside.txt'),'outside');
    const outside=await command('cat ' + path.join(temp,'outside.txt'));
    expect((await completed(outside.id)).state).toBe('failed');
    const outsideWrite=await command('printf leak > ' + path.join(temp,'leak.txt'));
    expect((await completed(outsideWrite.id)).state).toBe('failed');
    await expect(fs.stat(path.join(temp,'leak.txt'))).rejects.toThrow();
    const writeOutside=await command('printf leak > denied/leak.txt');
    expect((await completed(writeOutside.id)).state).toBe('failed');
    await expect(fs.stat(path.join(temp,'project','denied','leak.txt'))).rejects.toThrow();
  });
  it('defaults to read-only, then permits reviewed text edits',async()=>{
    expect(work.project(projectId)).toMatchObject({writable:false,approvalMode:'review'});
    await expect(write()).rejects.toThrow('읽기 전용');await work.writable(projectId,true);
    const j=await write();expect(j.state).toBe('pending');await work.decide(j.id,true);
    expect((await completed(j.id)).state).toBe('done');
    expect(work.job(j.id).content).toBeUndefined();expect(work.job(j.id).before).toBeUndefined();
  });
  it('requires manual approval for commands by default',async()=>{
    await work.writable(projectId,true);const j=await command('printf approved > command.txt');
    expect(j.state).toBe('pending');await expect(fs.stat(path.join(temp,'project','command.txt'))).rejects.toThrow();
    await work.decide(j.id,true);expect((await completed(j.id)).exitCode).toBe(0);
    expect(await fs.readFile(path.join(temp,'project','command.txt'),'utf8')).toBe('approved');
  });
  it('rejecting a command has no command side effect',async()=>{
    await work.writable(projectId,true);const j=await command('touch forbidden');await work.decide(j.id,false);
    expect(work.job(j.id).state).toBe('declined');await expect(fs.stat(path.join(temp,'project','forbidden'))).rejects.toThrow();
  });
  it('reviews every write in review mode',async()=>{
    await work.writable(projectId,true);
    for(const name of ['package.json','test.sh','vite.config.ts']) expect((await write(name,'content')).state).toBe('pending');
    expect((await write('empty.txt','')).state).toBe('pending');
    expect(requiresFileReview('scripts/build.js','content')).toBe(true);
  });
  it('all mode executes commands including explicitly requested deletion',async()=>{
    await work.writable(projectId,true);await work.setApprovalMode(projectId,'automatic');
    const first=await write('victim.txt','remove me');await completed(first.id);
    const j=await command('rm -f victim.txt');expect((await completed(j.id)).state).toBe('done');
    await expect(fs.stat(path.join(temp,'project','victim.txt'))).rejects.toThrow();
  });
  it('never interprets a queued command as completed',async()=>{
    await work.writable(projectId,true);await work.setApprovalMode(projectId,'automatic');
    const j=await command('printf started; sleep 30');expect(terminal(j.state)).toBe(false);
    await expect.poll(()=>work.jobSnapshot(j.id).output).toContain('started');
    await work.cancel(j.id);expect((await completed(j.id)).state).toBe('cancelled');
  });
  it('duplicate approvals cannot execute a command twice',async()=>{
    await work.writable(projectId,true);const j=await command('printf once >> count.txt');
    const results=await Promise.allSettled([work.decide(j.id,true),work.decide(j.id,true)]);
    expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);await completed(j.id);
    expect(await fs.readFile(path.join(temp,'project','count.txt'),'utf8')).toBe('once');
    expect(work.paused).toBe(false);
  });
  it('serializes jobs within each project and cancelling queued work prevents execution',async()=>{
    await work.writable(projectId,true);await work.setApprovalMode(projectId,'automatic');
    const first=await command('printf started; sleep 30');
    await expect.poll(()=>work.jobSnapshot(first.id).output).toContain('started');
    const second=await command('touch should-not-exist');expect(second.state).toBe('queued');
    await work.cancel(second.id);await work.cancel(first.id);await work.waitForIdle();
    expect(work.job(second.id).state).toBe('cancelled');await expect(fs.stat(path.join(temp,'project','should-not-exist'))).rejects.toThrow();
  });
  it('revoking permission cancels running and queued work and re-enabling does not replay it',async()=>{
    await work.writable(projectId,true);await work.setApprovalMode(projectId,'automatic');
    const first=await command('printf started; sleep 30');await expect.poll(()=>work.jobSnapshot(first.id).output).toContain('started');
    const second=await command('touch forbidden');await work.writable(projectId,false);await work.waitForIdle();
    await work.writable(projectId,true);await work.waitForIdle();
    expect(work.job(first.id).state).toBe('cancelled');expect(work.job(second.id).state).toBe('cancelled');
    await expect(fs.stat(path.join(temp,'project','forbidden'))).rejects.toThrow();
  });
  it('pause fences new work and cancels manual approvals',async()=>{
    await work.writable(projectId,true);const j=await command('touch later');await work.setPaused(true);
    expect(work.job(j.id).state).toBe('cancelled');await expect(write()).rejects.toThrow('일시 정지');
  });
  it('bounds command output and preserves useful UTF-8',async()=>{
    await work.writable(projectId,true);await work.setApprovalMode(projectId,'automatic');
    const j=await command('printf "한글 👋"');const result=await completed(j.id);
    expect(result.output).toBe('한글 👋');expect(result.exitCode).toBe(0);
  });
  it('does not expose the MCP bearer endpoint in renderer snapshots',()=>{
    work.endpoint='http://127.0.0.1:1234/private/mcp';
    expect(work.snapshot().connected).toBe(true);expect(work.snapshot().endpoint).toBeNull();
    expect(JSON.stringify(work.snapshot())).not.toContain('/private/mcp');
  });
  it('does not inherit unrelated credentials or node injection environment variables',()=>{
    process.env.WORKROOM_TEST_SECRET='never-forward';process.env.NODE_OPTIONS='--inspect=1';
    try { const env=commandEnvironment();expect(env.WORKROOM_TEST_SECRET).toBeUndefined();expect(env.NODE_OPTIONS).toBeUndefined(); }
    finally {delete process.env.WORKROOM_TEST_SECRET;delete process.env.NODE_OPTIONS;}
  });
  it('runs commands with a UTF-8 character locale when the app inherits none',async()=>{
    if(process.platform!=='darwin')return;
    const saved={LANG:process.env.LANG,LC_ALL:process.env.LC_ALL,LC_CTYPE:process.env.LC_CTYPE};
    for(const key of Object.keys(saved))delete process.env[key];
    try{
      await work.writable(projectId,true);await work.setApprovalMode(projectId,'automatic');
      const j=await command("printf '한글' | wc -m | tr -d ' '");expect((await completed(j.id)).output.trim()).toBe('2');
    }finally{for(const [key,value] of Object.entries(saved))if(value!==undefined)process.env[key]=value;}
  });
});

describe('Durability, idempotency and lifecycle',()=>{
  it('migrates old approval modes to review with no approved folders',async()=>{
    await store.update(d=>{d.projects[0]!.approvalMode='automatic';d.projects[0]!.approvedFolders=[];});
    const raw=JSON.parse(await fs.readFile(path.join(temp,'data','workspace.json'),'utf8'));
    raw.projects[0].approvalMode='all';delete raw.projects[0].approvedFolders;
    await fs.writeFile(path.join(temp,'data','workspace.json'),JSON.stringify(raw));
    const restored=new Store(path.join(temp,'data','workspace.json'));await restored.load();
    expect(restored.data.projects[0]).toMatchObject({approvalMode:'review',writable:false,approvedFolders:[]});
  });
  it('deduplicates concurrent identical file proposals',async()=>{
    await work.writable(projectId,true);const input={...request(),kind:'write' as const,path:'a.txt',content:'once',expectedHash:null};
    const [a,b]=await Promise.all([work.propose(input),work.propose(input)]);await work.waitForIdle();
    expect(a.id).toBe(b.id);expect(store.data.jobs).toHaveLength(1);expect(store.data.receipts).toHaveLength(1);
  });
  it('retries a completed file request after raw content was purged without overwriting external edits',async()=>{
    await work.writable(projectId,true);const input={...request(),kind:'write' as const,path:'a.txt',content:'once',expectedHash:null};
    const j=await work.propose(input);if(j.state==='pending')await work.decide(j.id,true);await completed(j.id);await fs.writeFile(path.join(temp,'project','a.txt'),'external');
    expect((await work.propose(input)).id).toBe(j.id);
    expect(await fs.readFile(path.join(temp,'project','a.txt'),'utf8')).toBe('external');
    await expect(work.propose({...input,content:'changed'})).rejects.toThrow('requestId');
  });
  it('history cleanup retains idempotency receipts',async()=>{
    await work.writable(projectId,true);const input={...request(),kind:'write' as const,path:'a.txt',content:'once',expectedHash:null};
    const j=await work.propose(input);if(j.state==='pending')await work.decide(j.id,true);await completed(j.id);await work.clearHistory(projectId);
    expect(store.data.jobs).toHaveLength(0);expect((await work.propose(input)).id).toBe(j.id);
    expect(store.data.jobs).toHaveLength(0);
  });
  it('restart resets authority and preserves checkpoints and completed request identity',async()=>{
    await work.writable(projectId,true);await work.setApprovalMode(projectId,'automatic');
    const task=await work.createTask(projectId,'task','objective');await work.updateTask(task.id,'blocked','resume');
    const input={...request(),kind:'write' as const,path:'a.txt',content:'once',expectedHash:null};
    const j=await work.propose(input);if(j.state==='pending')await work.decide(j.id,true);await completed(j.id);await work.shutdown();
    store=new Store(path.join(temp,'data','workspace.json'));await store.load();work=new Workspace(store,path.join(temp,'data'));
    expect(work.project(projectId)).toMatchObject({writable:false,approvalMode:'review'});
    expect(store.data.tasks[0]?.summary).toBe('resume');expect((await work.propose(input)).id).toBe(j.id);
  });
  it('recovers unfinished legacy jobs as cancelled and never replays them',async()=>{
    const now=Date.now();const job:Job={...request(),id:randomUUID(),kind:'command',command:'touch not-replayed',label:'old',state:'running',output:'',createdAt:now,updatedAt:now};
    await store.update(d=>d.jobs.push(job));await work.shutdown();
    const restored=new Store(path.join(temp,'data','workspace.json'));await restored.load();
    expect(restored.data.jobs[0]?.state).toBe('cancelled');
    await expect(fs.stat(path.join(temp,'project','not-replayed'))).rejects.toThrow();
  });
  it('never evicts active requests when the visible history is full',async()=>{
    await work.writable(projectId,true);
    await store.update(d=>{for(let i=0;i<200;i++)d.jobs.push({...request(),id:randomUUID(),kind:'command',command:'true',label:'pending',state:'pending',output:'',createdAt:i,updatedAt:i});});
    await expect(command('true')).rejects.toThrow('200');expect(store.data.jobs).toHaveLength(200);expect(work.paused).toBe(false);
  });
  it('forgets only the oldest unlisted receipt older than a day at the ledger cap and still restarts',async()=>{
    await work.writable(projectId,true);
    const listed=await write('listed.txt','x');await completed(listed.id);
    const old=Date.now()-2*86400000;
    const receipt=(at:number)=>({id:randomUUID(),requestId:randomUUID(),projectId,requestHash:'0'.repeat(64),kind:'command' as const,state:'done' as const,createdAt:at,updatedAt:at});
    await store.update(d=>{d.receipts[0]!.updatedAt=old;d.receipts.push(...Array.from({length:9999},()=>receipt(Date.now())));});
    await expect(write('blocked.txt','x')).rejects.toThrow('24시간');
    const stale=receipt(old);await store.update(d=>{d.receipts[1]=stale;});
    const next=await write('next.txt','x');await completed(next.id);
    expect(store.data.receipts).toHaveLength(10000);expect(store.data.receipts.map(r=>r.id)).not.toContain(stale.id);
    await work.shutdown();
    store=new Store(path.join(temp,'data','workspace.json'));await store.load();work=new Workspace(store,path.join(temp,'data'));
    expect(store.data.receipts).toHaveLength(10000);expect((await work.propose({...request(),requestId:listed.requestId,kind:'write',path:'listed.txt',content:'x',expectedHash:null})).id).toBe(listed.id);
  });
  it('serializes durable mutations and batches audit events',async()=>{
    await Promise.all(Array.from({length:12},(_,i)=>work.createTask(projectId,`task-${i}`,'')));
    for(let i=0;i<12;i++)work.audit('test',true,projectId);await store.flushLazy();
    expect(store.data.tasks).toHaveLength(12);expect(store.data.activity).toHaveLength(12);
    const saved=JSON.parse(await fs.readFile(path.join(temp,'data','workspace.json'),'utf8'));
    expect(saved.tasks).toHaveLength(12);expect(saved.activity).toHaveLength(12);
  });
  it('keeps corrupt state untouched instead of replacing it with an empty workspace',async()=>{
    const f=path.join(temp,'broken.json');await fs.writeFile(f,'broken');
    await expect(new Store(f).load()).rejects.toThrow('원본');expect(await fs.readFile(f,'utf8')).toBe('broken');
  });
  it('separates rejected mutations from disk errors and retains old memory state',async()=>{
    const before=JSON.stringify(store.data);await expect(store.update(()=>{throw new Error('invalid change');})).rejects.toThrow();
    expect(JSON.stringify(store.data)).toBe(before);expect(work.paused).toBe(false);
    const task=await work.createTask(projectId,'valid','');expect(task.title).toBe('valid');
  });
  it('refuses symlinked private state and uses private permissions',async()=>{
    const target=path.join(temp,'target');await fs.writeFile(target,'keep');const link=path.join(temp,'private','state.json');await fs.mkdir(path.dirname(link));await fs.symlink(target,link);
    await expect(atomicPrivateWrite(link,'bad')).rejects.toThrow();expect(await fs.readFile(target,'utf8')).toBe('keep');
    await expect(readPrivateText(link)).rejects.toThrow();
    if(process.platform!=='win32')expect((await fs.stat(path.join(temp,'data','workspace.json'))).mode&0o777).toBe(0o600);
  });
  it('connection removal deletes metadata only, never the project folder',async()=>{
    await fs.writeFile(path.join(temp,'project','keep.txt'),'keep');await work.removeProject(projectId);
    expect(store.data.projects).toHaveLength(0);expect(await fs.readFile(path.join(temp,'project','keep.txt'),'utf8')).toBe('keep');
  });
  it('shutdown is idempotent and waits for running command cancellation',async()=>{
    await work.writable(projectId,true);await work.setApprovalMode(projectId,'automatic');
    const j=await command('printf started; sleep 30');await expect.poll(()=>work.jobSnapshot(j.id).output).toContain('started');
    await Promise.all([work.shutdown(),work.shutdown()]);expect(work.job(j.id).state).toBe('cancelled');
  });
});

describe('MCP transport and tool surface',()=>{
  it('removes token estimation and offers bounded batch reads with the same file guards',async()=>{
    expect(Object.hasOwn(definitions,'token_estimate')).toBe(false);
    await fs.writeFile(path.join(temp,'project','a.txt'),'hello');await fs.writeFile(path.join(temp,'project','b.txt'),'world');
    const invoke=workspaceInvoker(work);const result=await invoke('files_read_batch',{projectId,paths:['a.txt','b.txt']}) as {content:string}[];
    expect(result.map(r=>r.content)).toEqual(['hello','world']);
    await expect(invoke('files_read_batch',{projectId,paths:['.env']})).rejects.toThrow();
    await expect(invoke('files_read_batch',{projectId,paths:Array(9).fill('a.txt')})).rejects.toThrow();
  });
  it('answers fast automatic work in one call and never holds a pending approval',async()=>{
    await work.writable(projectId,true);const invoke=workspaceInvoker(work);
    const started=Date.now();const pending=await invoke('command_propose',{...request(),command:'touch later'}) as Job;
    expect(pending.state).toBe('pending');expect(Date.now()-started).toBeLessThan(1000);
    await work.setApprovalMode(projectId,'automatic');
    expect(await invoke('command_propose',{...request(),command:'printf ok'})).toMatchObject({state:'done',exitCode:0,output:'ok'});
  });
  it('releases a held tool call with the final state when the user stops the command',async()=>{
    await work.writable(projectId,true);await work.setApprovalMode(projectId,'automatic');
    const call=workspaceInvoker(work)('command_propose',{...request(),command:'printf started; sleep 30'}) as Promise<Job>;
    await expect.poll(()=>store.data.jobs[0]?.state).toBe('running');
    await work.cancel(store.data.jobs[0]!.id);expect((await call).state).toBe('cancelled');
  });
  it('patches exact unique text, chains resultHash revisions and replays a patch by request identity',async()=>{
    await work.writable(projectId,true);await work.setApprovalMode(projectId,'automatic');const invoke=workspaceInvoker(work);
    await fs.writeFile(path.join(temp,'project','notes.md'),'# Title\nalpha\nbeta\n');
    const {hash}=await files.readFile(work.project(projectId),'notes.md');
    const input={...request(),path:'notes.md',expectedHash:hash,edits:[{oldText:'alpha',newText:'ALPHA'},{oldText:'beta\n',newText:'beta\ngamma\n'}]};
    const first=await invoke('file_patch',input) as Job;expect(first.state).toBe('done');
    const second=await invoke('file_patch',{...request(),path:'notes.md',expectedHash:first.resultHash,edits:[{oldText:'# Title',newText:'# Notes'}]}) as Job;
    expect(second).toMatchObject({state:'done',resultHash:files.hash('# Notes\nALPHA\nbeta\ngamma\n')});
    expect((await invoke('file_patch',input) as Job).id).toBe(first.id);
    expect(await fs.readFile(path.join(temp,'project','notes.md'),'utf8')).toBe('# Notes\nALPHA\nbeta\ngamma\n');
  });
  it('refuses missing, ambiguous, overlapping or stale patches before scheduling',async()=>{
    await work.writable(projectId,true);await fs.writeFile(path.join(temp,'project','a.txt'),'one two one');
    const patch=(edits:{oldText:string;newText:string}[],expectedHash=files.hash('one two one'))=>work.propose({...request(),kind:'write',path:'a.txt',expectedHash,edits});
    await expect(patch([{oldText:'three',newText:'3'}])).rejects.toThrow('찾지');
    await expect(patch([{oldText:'one',newText:'1'}])).rejects.toThrow('여러 번');
    await expect(patch([{oldText:'one two',newText:'x'},{oldText:'two one',newText:'y'}])).rejects.toThrow('겹치는');
    await expect(patch([{oldText:'two',newText:'2'}],files.hash('old'))).rejects.toThrow('변경');
    expect(store.data.jobs).toHaveLength(0);expect(await fs.readFile(path.join(temp,'project','a.txt'),'utf8')).toBe('one two one');
  });
  it('requires the bearer path, rejects origins and wrong hosts, handles invalid bridge data, and exposes MCP',async()=>{
    const server=await startServer(work,0);
    try{
      const url=work.endpoint!;
      for(const origin of ['https://evil.example',''])expect((await fetch(url,{headers:{origin}})).status).toBe(403);
      const wrongHostStatus=await new Promise<number|undefined>((resolve,reject)=>{
        const req=http.request(url,{headers:{host:'attacker.invalid'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
        req.on('error',reject);req.end();
      });
      expect(wrongHostStatus).toBe(403);
      expect((await fetch(url.replace(/\/[a-f0-9]{64}\//,'/bad/'))).status).toBe(401);
      const bridge=url.replace(/mcp$/,'bridge');
      for(const data of ['null','[]','{"name":"__proto__","args":{}}','bad'])expect((await fetch(bridge,{method:'POST',headers:{'Content-Type':'application/json'},body:data})).status).toBe(400);
      expect((await fetch(bridge,{method:'POST',body:'{}'})).status).toBe(415);
      expect((await fetch(new URL('/.well-known/oauth-protected-resource',url)))).toMatchObject({status:404});
      const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}})});
      expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');
      const text=await response.text();const result=JSON.parse(text.startsWith("event:")?text.split("\n").find(line=>line.startsWith("data:"))!.slice(5):text);
      expect(result.result.tools.map((t:{name:string})=>t.name).sort()).toEqual(Object.keys(definitions).sort());
      expect(result.result.tools.some((t:any)=>t.name==='token_estimate')).toBe(false);
    }finally{await Promise.all([server.close(),server.close()]);}
  });
  it('rotates the connection secret and deletes its own connection file on close',async()=>{
    const first=await startServer(work,0);const old=new URL(work.endpoint!).pathname;await first.close();
    await expect(fs.stat(first.connectionFile)).rejects.toThrow();
    const second=await startServer(work,0);try{expect(new URL(work.endpoint!).pathname).not.toBe(old);}finally{await second.close();}
  });
});
