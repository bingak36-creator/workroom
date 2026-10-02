import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { Workspace, commandEnvironment } from '../src/main/service';
import { Store } from '../src/main/store';
import { workspaceInvoker } from '../src/main/tools';
import { outputRedactor } from '../src/main/command-environment';
import * as files from '../src/main/files';
import type { Job } from '../src/shared';

let temp: string, work: Workspace, projectId: string, project: string;
const input = () => ({ projectId, requestId: randomUUID() });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return {promise, resolve}; };
async function run(command: string, environment?: string[]): Promise<Job> {
  const job = await work.propose({...input(), kind:'command', command, ...(environment ? {environment} : {})});
  if (job.state === 'pending') await work.decide(job.id, true);
  await work.waitForIdle(); return work.jobSnapshot(job.id);
}
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'workroom-security-fixture-'));
  await fs.mkdir(path.join(temp, 'project'));
  const store = new Store(path.join(temp, 'data', 'workspace.json')); await store.load();
  work = new Workspace(store, path.join(temp, 'data'));
  projectId = (await work.addProject(path.join(temp, 'project'))).id; project = work.project(projectId).path;
  await work.approveFolder(projectId, ''); await work.writable(projectId, true);
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await work.shutdown(); await fs.rm(temp, {recursive:true, force:true}); });

it('rejects protected roots, restored roots and protected directories even when users approve them', async () => {
  const root = path.join(temp, '.aws'); await fs.mkdir(root); await fs.writeFile(path.join(root, 'plain.txt'), 'fixture');
  await expect(work.addProject(root)).rejects.toThrow('보호 경로');
  await expect(files.readFile({...work.project(projectId), path:root}, 'plain.txt')).rejects.toThrow('보호 경로');
  for (const name of ['.ENV.production', 'credentials', '.aws', '.ssh', '.git', 'keychains']) {
    await fs.mkdir(path.join(project, name));
    await expect(work.approveFolder(projectId, name)).rejects.toThrow();
    await expect(files.resolveFile(work.project(projectId), `${name}/new`, true)).rejects.toThrow();
  }
});
it('accepts only environment names through local settings and never inherits app credentials or profiles', async () => {
  vi.stubEnv('AUDIT_UNSELECTED', 'unselected-fixture'); vi.stubEnv('HOME', '/audit-home'); vi.stubEnv('LANG', 'host-locale');
  expect(commandEnvironment()).not.toHaveProperty('AUDIT_UNSELECTED'); expect(commandEnvironment()).not.toHaveProperty('HOME'); expect(commandEnvironment()).not.toHaveProperty('LANG');
  for (const names of [['TOKEN=value'], ['NODE_OPTIONS'], ['PATH'], ['BASH_ENV'], ['DYLD_INSERT_LIBRARIES'], ['WORKROOM_TUNNEL_API_KEY'], ['TOKEN','TOKEN'], {TOKEN:'value'}])
    await expect(work.setEnvironmentNames(projectId, names)).rejects.toThrow('환경변수 이름');
  await work.setEnvironmentNames(projectId, ['AUDIT_ALLOWED']);
  expect(work.project(projectId).environmentNames).toEqual(['AUDIT_ALLOWED']);
  await expect(workspaceInvoker(work)('command_propose', {...input(), command:'true', environment:{AUDIT_ALLOWED:'value'}})).rejects.toThrow();
});
it('redacts selected values across stream chunks without dropping ordinary output', () => {
  const secret = 'fixture-token-123456'; const redact = outputRedactor([secret]);
  const result = [...`prefix:${secret}:suffix`].map(c => redact(c)).join('') + redact('', true);
  expect(result).toBe('prefix:[환경변수 값 숨김]:suffix');
    const overlap = outputRedactor(['abc','abcdef']); expect(overlap('abcdef',true)).toBe('[환경변수 값 숨김]');
    const special = 'a.b[$]c\\d'; expect(outputRedactor([special])(special,true)).toBe('[환경변수 값 숨김]');
});
it('rechecks delete authorization after the final asynchronous revision check', async () => {
  const target = path.join(project, 'victim.txt'); await fs.writeFile(target, 'fixture-only');
  const job = await work.propose({...input(), kind:'delete', path:'victim.txt', expectedHash:files.hash('fixture-only')});
  const entered = deferred(), release = deferred(); let reads = 0; const original = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementation((async (...args: any[]) => {
    if (String(args[0]) === target && ++reads === 2) { entered.resolve(); await release.promise; }
    return (original as any)(...args);
  }) as any);
  await work.decide(job.id, true);
  try { await entered.promise; await work.writable(projectId, false); } finally { release.resolve(); }
  await work.waitForIdle(); expect(await fs.readFile(target,'utf8')).toBe('fixture-only'); expect(work.job(job.id).state).toBe('cancelled');
});
it('fails closed for all command approval modes on unsupported platforms', async () => {
  if (process.platform === 'darwin') return;
  for (const mode of ['review','delete','automatic'] as const) {
    await work.setApprovalMode(projectId, mode);
    await expect(work.propose({...input(),kind:'command',command:'echo blocked'})).rejects.toThrow('비밀파일 차단');
  }
  expect(work.store.data.jobs).toHaveLength(0);
});

describe.skipIf(process.platform !== 'darwin')('Native mandatory command boundary', () => {
  it.each(['automatic','review'] as const)('blocks secret read, copy, rename, delete and execution in %s mode', async mode => {
    await work.setApprovalMode(projectId, mode);
    for (const relative of ['.env', 'nested/.ENV.local', '.aws/credentials', 'nested/private.KEY', '.git/hooks/hook']) {
      await fs.mkdir(path.dirname(path.join(project, relative)), {recursive:true}); await fs.writeFile(path.join(project, relative), 'AUDIT_FAKE_SECRET=fixture-only');
      await expect(workspaceInvoker(work)('file_read', {projectId, path:relative})).rejects.toThrow();
      for (const command of [`cat '${relative}'`, `cp '${relative}' copy.txt`, `mv '${relative}' renamed.txt`, `rm '${relative}'`]) {
        const result = await run(command); expect(result.state, command).toBe('failed'); expect(result.output).not.toContain('AUDIT_FAKE_SECRET');
      }
    }
    expect((await run('printf blocked > .env.new')).state).toBe('failed');
    expect((await run('printf blocked > .git/hooks/new-hook')).state).toBe('failed');
    const script = path.join(project,'.env-script'); await fs.writeFile(script,'#!/bin/sh\nprintf escaped > escaped.txt\n',{mode:0o700});
    expect((await run('./.env-script')).state).toBe('failed'); await expect(fs.stat(path.join(project,'escaped.txt'))).rejects.toThrow();
    expect((await run('printf allowed > normal.txt; cat normal.txt')).output).toBe('allowed');
  });
  it('blocks symbolic aliases, secret symlink targets and existing or new hard links', async () => {
    await work.setApprovalMode(projectId,'automatic'); await fs.writeFile(path.join(project,'.env'),'fixture-secret');
    await fs.symlink('.env',path.join(project,'alias.txt')); expect((await run('cat alias.txt')).state).toBe('failed');
    await fs.writeFile(path.join(project,'hidden-by-env-alias'),'fixture-secret');
    await fs.symlink('hidden-by-env-alias',path.join(project,'.env.link')); expect((await run('cat hidden-by-env-alias')).state).toBe('failed');
    await fs.mkdir(path.join(project,'.aws')); await fs.writeFile(path.join(project,'credential-target'),'fixture-secret');
    await fs.symlink('../credential-target',path.join(project,'.aws','credentials')); expect((await run('cat credential-target')).state).toBe('failed');
    await fs.writeFile(path.join(project,'ordinary'),'public'); expect((await run('ln ordinary linked')).state).toBe('failed');
    await fs.link(path.join(project,'.env'),path.join(project,'hard-alias'));
    const linked = await run('cat hard-alias'); expect(linked.state).toBe('failed'); expect(linked.output).toContain('하드링크'); expect(linked.output).not.toContain('fixture-secret');
  });
  it('passes only requested user-allowed existing OS variables and redacts raw values from output and state', async () => {
    vi.stubEnv('AUDIT_ALLOWED','audit-sensitive-fixture-9381'); vi.stubEnv('AUDIT_UNSELECTED','unselected-secret-fixture');
    await work.setEnvironmentNames(projectId,['AUDIT_ALLOWED','AUDIT_UNSELECTED','AUDIT_MISSING']);
    await work.setApprovalMode(projectId,'automatic');
    const use = await run('test -n "$AUDIT_ALLOWED" && test -z "$AUDIT_UNSELECTED" && printf ok',['AUDIT_ALLOWED']);
    expect(use).toMatchObject({state:'done',output:'ok'});
    expect((await run('test -z "$AUDIT_ALLOWED" && printf no-inheritance')).output).toBe('no-inheritance');
    const echo = await run('printf "%s" "$AUDIT_ALLOWED"',['AUDIT_ALLOWED']);
    expect(echo.output).toBe('[환경변수 값 숨김]');
    const streams = await run('printf "%.12s" "$AUDIT_ALLOWED"; sleep 0.1; printf "%s" "$AUDIT_ALLOWED" | cut -c13- >&2',['AUDIT_ALLOWED']);
    expect(streams.output.trim()).toBe('[환경변수 값 숨김]');
    expect(JSON.stringify(work.snapshot())).not.toContain('audit-sensitive-fixture-9381');
    expect(await fs.readFile(path.join(temp,'data','workspace.json'),'utf8')).not.toContain('audit-sensitive-fixture-9381');
    await expect(run('true',['AUDIT_MISSING'])).rejects.toThrow('앱 실행 환경에 없는');
    await expect(run('true',['AUDIT_NOT_ALLOWED'])).rejects.toThrow('먼저 허용');
    const retry = {...input(),kind:'command' as const,command:'true',environment:['AUDIT_ALLOWED']};
    const first = await work.propose(retry); await work.waitForIdle(); expect((await work.propose(retry)).id).toBe(first.id);
    await expect(work.propose({...retry,environment:['AUDIT_UNSELECTED']})).rejects.toThrow('requestId');
  });
  it('lets a reviewed command use an allowed variable for a request while automatic network access stays denied', async () => {
    const secret='audit-network-fixture-only'; vi.stubEnv('AUDIT_NETWORK_TOKEN',secret);
    await work.setEnvironmentNames(projectId,['AUDIT_NETWORK_TOKEN']); let calls=0;
    const server=http.createServer((req,res)=>{calls++;res.end(req.headers.authorization===`Bearer ${secret}`?'accepted':'denied');});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const port=(server.address() as {port:number}).port;
    try {
      const cmd=`/usr/bin/curl --silent --show-error --max-time 2 --noproxy '*' -H "Authorization: Bearer $AUDIT_NETWORK_TOKEN" http://127.0.0.1:${port}`;
      expect(await run(cmd,['AUDIT_NETWORK_TOKEN'])).toMatchObject({state:'done',output:'accepted'});
      await work.setApprovalMode(projectId,'automatic');expect((await run(cmd,['AUDIT_NETWORK_TOKEN'])).state).toBe('failed');expect(calls).toBe(1);
    } finally { server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve())); }
  });
  it('cancels pending work when the allowlist changes and checks again before execution', async () => {
    vi.stubEnv('AUDIT_ALLOWED','fixture'); await work.setEnvironmentNames(projectId,['AUDIT_ALLOWED']);
    const job=await work.propose({...input(),kind:'command',command:'true',environment:['AUDIT_ALLOWED']});
    await work.setEnvironmentNames(projectId,[]); expect(work.job(job.id).state).toBe('cancelled');
    await expect(work.decide(job.id,true)).rejects.toThrow();
    await work.setEnvironmentNames(projectId,['AUDIT_ALLOWED']);
    const missing=await work.propose({...input(),kind:'command',command:'touch should-not-exist',environment:['AUDIT_ALLOWED']});
    delete process.env.AUDIT_ALLOWED; await work.decide(missing.id,true); await work.waitForIdle();
    expect(work.job(missing.id).state).toBe('failed'); await expect(fs.stat(path.join(project,'should-not-exist'))).rejects.toThrow();
  });
  it('does not start a command after revocation during asynchronous folder validation', async () => {
    await work.revokeFolder(projectId,''); const folder=path.join(project,'allowed'); await fs.mkdir(folder);
    await work.approveFolder(projectId,'allowed'); await work.setApprovalMode(projectId,'automatic');
    const entered=deferred(),release=deferred();let checks=0;const original=fs.lstat.bind(fs);
    vi.spyOn(fs,'lstat').mockImplementation((async(...args:any[])=>{if(String(args[0])===folder&&++checks===2){entered.resolve();await release.promise;}return (original as any)(...args);}) as any);
    const job=await work.propose({...input(),kind:'command',command:'printf escaped > allowed/race-marker'});
    try{await entered.promise;await work.writable(projectId,false);}finally{release.resolve();}
    await work.waitForIdle();expect(work.job(job.id).state).toBe('cancelled');await expect(fs.stat(path.join(folder,'race-marker'))).rejects.toThrow();
  });
  it('terminates a child that ignores SIGTERM even when its parent closes first', async () => {
    await work.setApprovalMode(projectId,'automatic');
    const job=await work.propose({...input(),kind:'command',command:`/bin/sh -c 'trap "" TERM; exec >/dev/null 2>&1; printf ready > child-ready; sleep 2; printf survived > after-stop' & printf parent-ready; wait`});
    await expect.poll(()=>fs.readFile(path.join(project,'child-ready'),'utf8').catch(()=> '')).toBe('ready');
    await work.writable(projectId,false);await work.waitForIdle();expect(work.job(job.id).state).toBe('cancelled');
    await new Promise(r=>setTimeout(r,2200));await expect(fs.stat(path.join(project,'after-stop'))).rejects.toThrow();
  });
});
