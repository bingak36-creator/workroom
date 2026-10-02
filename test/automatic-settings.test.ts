import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/main/store';
import { Workspace } from '../src/main/service';

let temp: string, stateFile: string, store: Store, work: Workspace, projectId: string;
beforeEach(async () => {
  temp=await fs.mkdtemp(path.join(os.tmpdir(),'workroom-automatic-'));
  await fs.mkdir(path.join(temp,'project'));
  stateFile=path.join(temp,'data','workspace.json');
  store=new Store(stateFile); await store.load();
  work=new Workspace(store,path.join(temp,'data'));
  projectId=(await work.addProject(path.join(temp,'project'))).id;
});
afterEach(async () => { await work.shutdown(); await fs.rm(temp,{recursive:true,force:true}); });

describe('One-action automatic approval', () => {
  it('grants a new project and executes file work while secrets remain blocked', async () => {
    await work.enableAutomatic(projectId,false,[]);
    expect(work.project(projectId)).toMatchObject({writable:true,approvalMode:'automatic',approvedFolders:[''],rememberAutomatic:false});
    const input={projectId,requestId:randomUUID(),kind:'write' as const,path:'hello.txt',content:'hello',expectedHash:null};
    const job=await work.propose(input); await work.waitForIdle();
    expect(work.job(job.id).state).toBe('done');
    await expect(work.propose({...input,requestId:randomUUID(),path:'.env'})).rejects.toThrow();
  });
  it('keeps a narrow existing grant and rejects a stale dialog scope', async () => {
    await fs.mkdir(path.join(temp,'project','src'));
    await work.approveFolder(projectId,'src');
    await expect(work.enableAutomatic(projectId,true,[])).rejects.toThrow('변경');
    expect(work.project(projectId).writable).toBe(false);
    await work.enableAutomatic(projectId,true,['src']);
    expect(work.project(projectId).approvedFolders).toEqual(['src']);
    await expect(work.propose({projectId,requestId:randomUUID(),kind:'write',path:'outside.txt',content:'no',expectedHash:null})).rejects.toThrow('승인');
  });
  it('refuses unavailable folders and paused activation without granting authority', async () => {
    await fs.mkdir(path.join(temp,'project','src')); await work.approveFolder(projectId,'src');
    await fs.rmdir(path.join(temp,'project','src'));
    await expect(work.enableAutomatic(projectId,true,['src'])).rejects.toThrow();
    await work.revokeFolder(projectId,'src'); await work.setPaused(true);
    await expect(work.enableAutomatic(projectId,true,[])).rejects.toThrow('재개');
    expect(work.project(projectId)).toMatchObject({writable:false,rememberAutomatic:false,approvedFolders:[]});
  });
  it.each([false,true])('only restores explicit persistent opt-in: %s', async remember => {
    await work.enableAutomatic(projectId,remember,[]);
    const restored=new Store(stateFile); await restored.load();
    expect(restored.data.projects[0]).toMatchObject({writable:remember,approvalMode:remember?'automatic':'review',rememberAutomatic:remember,approvedFolders:['']});
  });
  it('never replays unfinished jobs even when authority is restored', async () => {
    await work.enableAutomatic(projectId,true,[]);
    const pending=await work.propose({projectId,requestId:randomUUID(),kind:'access',path:''});
    const restored=new Store(stateFile); await restored.load();
    expect(restored.data.projects[0]!.writable).toBe(true);
    expect(restored.data.jobs.find(j=>j.id===pending.id)!.state).toBe('cancelled');
    expect(restored.data.receipts.find(j=>j.id===pending.id)!.state).toBe('cancelled');
  });
  it('turning automatic approval off cancels pending work and restores read-only review', async () => {
    await work.enableAutomatic(projectId,true,[]);
    const pending=await work.propose({projectId,requestId:randomUUID(),kind:'access',path:''});
    await work.disableAutomatic(projectId);
    expect(work.job(pending.id).state).toBe('cancelled');
    expect(work.project(projectId)).toMatchObject({writable:false,approvalMode:'review',rememberAutomatic:false});
    const restored=new Store(stateFile); await restored.load();
    expect(restored.data.projects[0]!.writable).toBe(false);
  });
  it.each(['writable','mode','folder'])('revoking %s also clears persistent opt-in', async kind => {
    await work.enableAutomatic(projectId,true,[]);
    if(kind==='writable')await work.writable(projectId,false);
    else if(kind==='mode')await work.setApprovalMode(projectId,'delete');
    else await work.revokeFolder(projectId,'');
    expect(work.project(projectId).rememberAutomatic).toBe(false);
    const restored=new Store(stateFile); await restored.load();
    expect(restored.data.projects[0]!.writable).toBe(false);
  });
});
