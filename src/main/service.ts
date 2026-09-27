import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { Store } from './store';
import * as files from './files';
import { APP_VERSION, type ApprovalMode, type Job, type Project, type Snapshot, type Task, type Receipt } from '../shared';
import { applyEdits, fingerprint, terminal, type Proposal } from './request';
import { commandSandbox } from './command-sandbox';

interface Runtime { process: ChildProcess; output: string; bytes: number; cancelled: boolean; reason: string; killTimer?: NodeJS.Timeout }
const MAX_OUTPUT = 32000;
export function commandEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NO_COLOR: '1', TERM: 'dumb' };
  for (const name of ['HOME','TMPDIR','LANG','LC_ALL','LC_CTYPE','SystemRoot']) if (process.env[name]) env[name] = process.env[name];
  env.PATH = process.platform === 'win32'
    ? `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32;${process.env.SystemRoot ?? 'C:\\Windows'}`
    : '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  // Finder-launched apps inherit no locale; the C locale makes wc/cut/tr/awk treat Korean text as raw bytes.
  if (process.platform === 'darwin' && !env.LANG && !env.LC_ALL && !env.LC_CTYPE) env.LC_CTYPE = 'en_US.UTF-8';
  return env;
}
const overlaps = (a: string, b: string): boolean => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);

export class Workspace extends EventEmitter {
  paused = false; lastCall: number | null = null; endpoint: string | null = null; error: string | null = null;
  private active = new Map<string, Promise<void>>();
  private activeProjects = new Set<string>();
  private cancellations = new Set<string>();
  private revoked = new Set<string>();
  private processes = new Map<string, Runtime>();
  private proposalQueue: Promise<unknown> = Promise.resolve();
  private incoming = 0;
  private closing = false;
  private shutdownPromise?: Promise<void>;
  private outputTimer?: NodeJS.Timeout;
  private waiters = new Set<() => void>();
  constructor(public store: Store, public dataDir: string, private protectedPaths: string[] = []) {
    super();
    store.on('warning', (message: string) => this.failClosed(message));
  }
  changed(): void { for (const wake of this.waiters) wake(); this.emit('change'); }
  /** Holds a tool response while automatic work runs, so fast jobs return their final state in one call. */
  async settle(id: string, ms: number): Promise<Job> {
    const active = (): boolean => { const state = this.job(id).state; return state === 'queued' || state === 'running'; };
    if (ms > 0 && !this.closing && active()) await new Promise<void>(resolve => {
      const done = (): void => { clearTimeout(timer); this.waiters.delete(wake); resolve(); };
      const wake = (): void => { try { if (this.closing || !active()) done(); } catch { done(); } };
      const timer = setTimeout(done, ms); timer.unref();
      this.waiters.add(wake);
    });
    return this.jobSnapshot(id);
  }
  private outputChanged(): void {
    if (this.closing) return;
    if (!this.outputTimer) this.outputTimer = setTimeout(() => { this.outputTimer = undefined; this.changed(); }, 100);
  }
  private failClosed(message: string): void {
    this.error = message; this.paused = true;
    for (const job of this.store.data.jobs) if (!terminal(job.state)) this.cancellations.add(job.id);
    for (const id of this.processes.keys()) this.kill(id, '저장 오류로 실행을 중지했습니다.');
    this.changed();
  }
  snapshot(): Snapshot {
    return { projects: this.store.data.projects.map(p => ({ ...p })), tasks: this.store.data.tasks.map(t => ({ ...t })), jobs: this.store.data.jobs.map(j => this.jobSnapshot(j.id)), activity: this.store.data.activity.map(a => ({ ...a })), connected: !!this.endpoint, paused: this.paused, lastCall: this.lastCall, endpoint: null, error: this.error, dataDir: this.dataDir, version: APP_VERSION };
  }
  jobSnapshot(id: string): Job { const job = this.job(id); return { ...job, output: this.processes.get(id)?.output ?? job.output }; }
  project(id: string): Project { const p = this.store.data.projects.find(p => p.id === id); if (!p) throw new Error('등록되지 않은 프로젝트입니다.'); return p; }
  job(id: string): Job {
    const job = this.store.data.jobs.find(j => j.id === id);
    if (job) return job;
    const receipt = this.store.data.receipts.find(r => r.id === id);
    if (receipt) return this.receiptJob(receipt);
    throw new Error('작업 요청을 찾을 수 없습니다.');
  }
  private receiptJob(r: Receipt): Job { return { ...r, label: '정리된 실행 기록', output: '이 요청은 이미 처리되었습니다. 원문·출력 기록은 정리되어 재실행하지 않습니다.' }; }
  private requireWritable(id: string): void {
    if (this.paused || this.closing) throw new Error('Workroom 연결이 일시 정지되어 있습니다.');
    if (this.revoked.has(id) || !this.project(id).writable) throw new Error('읽기 전용 프로젝트입니다. Workroom에서 변경 허용을 켜세요.');
  }
  private allowed(job: Job): boolean {
    return !this.paused && !this.closing && !this.revoked.has(job.projectId) && !this.cancellations.has(job.id) && !!this.store.data.projects.find(p => p.id === job.projectId && p.writable);
  }
  async addProject(folder: string): Promise<Project> {
    const canonical = await fs.realpath(folder);
    if (!(await fs.stat(canonical)).isDirectory()) throw new Error('폴더를 선택하세요.');
    const privateRoot = await fs.realpath(this.dataDir).catch(() => path.resolve(this.dataDir));
    if (canonical === path.parse(canonical).root || canonical === await fs.realpath(os.homedir()) || overlaps(canonical, privateRoot) || this.protectedPaths.some(p => overlaps(canonical, path.resolve(p)))) throw new Error('홈·시스템 루트·앱 데이터 폴더 대신 작업용 하위 폴더를 선택하세요.');
    const existing = this.store.data.projects.find(p => p.path === canonical); if (existing) return existing;
    const project: Project = { id: randomUUID(), name: path.basename(canonical), path: canonical, writable: false, approvalMode: 'review', approvedFolders: [] };
    await this.store.update(d => { if (d.projects.length >= 100) throw new Error('프로젝트는 최대 100개입니다.'); if (!d.projects.some(p => p.path === canonical)) d.projects.push(project); });
    this.changed(); return this.store.data.projects.find(p => p.path === canonical)!;
  }
  async writable(id: string, value: boolean): Promise<void> {
    this.project(id);
    if (!value) { this.revoked.add(id); await this.cancelProject(id); }
    await this.store.update(d => { d.projects.find(p => p.id === id)!.writable = value; });
    if (value) this.revoked.delete(id);
    this.changed(); this.pump();
  }
  async setApprovalMode(id: string, mode: ApprovalMode): Promise<void> {
    this.project(id);
    if (!['review','delete','automatic'].includes(mode)) throw new Error('지원하지 않는 승인 모드입니다.');
    this.revoked.add(id);
    try { await this.cancelProject(id); await this.store.update(d => { d.projects.find(p => p.id === id)!.approvalMode = mode; }); }
    finally { this.revoked.delete(id); this.changed(); }
  }
  async approveFolder(id: string, relative: string): Promise<void> {
    const project = this.project(id);
    const target = await files.resolveFile(project, relative);
    if (!(await fs.lstat(target)).isDirectory()) throw new Error('폴더를 선택하세요.');
    const normalized = path.relative(project.path, target).split(path.sep).join('/');
    await this.store.update(d => { const p = d.projects.find(p => p.id === id)!; p.approvedFolders ??= []; if (!p.approvedFolders.includes(normalized)) p.approvedFolders.push(normalized); });
    this.changed();
  }
  async revokeFolder(id: string, relative: string): Promise<void> {
    this.project(id); this.revoked.add(id);
    try { await this.cancelProject(id); await this.store.update(d => { const p = d.projects.find(p => p.id === id)!; p.approvedFolders = (p.approvedFolders ?? []).filter(folder => folder !== relative); }); }
    finally { this.revoked.delete(id); this.changed(); }
  }
  async clearHistory(projectId: string): Promise<void> {
    this.project(projectId); await this.store.flushLazy();
    await this.store.update(d => { d.jobs = d.jobs.filter(j => j.projectId !== projectId || !terminal(j.state)); d.activity = d.activity.filter(a => a.projectId !== projectId); });
    this.changed();
  }
  async removeProject(id: string): Promise<void> {
    await this.writable(id, false); await this.waitForIdle();
    await this.store.update(d => { d.projects = d.projects.filter(p => p.id !== id); d.tasks = d.tasks.filter(t => t.projectId !== id); d.jobs = d.jobs.filter(j => j.projectId !== id); d.activity = d.activity.filter(a => a.projectId !== id); });
    this.revoked.delete(id); this.changed(); // Never deletes project files. Receipts retain only hashes/IDs.
  }
  async createTask(projectId: string, title: string, objective: string): Promise<Task> {
    this.project(projectId); const now = Date.now();
    const task: Task = { id: randomUUID(), projectId, title, objective, status: 'todo', summary: '', createdAt: now, updatedAt: now };
    await this.store.update(d => { if (d.tasks.length >= 2000) throw new Error('작업 목록이 가득 찼습니다.'); d.tasks.unshift(task); }); this.changed(); return task;
  }
  async updateTask(id: string, status: Task['status'], summary?: string): Promise<Task> {
    await this.store.update(d => { const t = d.tasks.find(t => t.id === id); if (!t) throw new Error('작업을 찾을 수 없습니다.'); t.status = status; if (summary !== undefined) t.summary = summary; t.updatedAt = Date.now(); });
    this.changed(); return this.store.data.tasks.find(t => t.id === id)!;
  }
  propose(input: Proposal): Promise<Job> {
    if (this.incoming >= 32) return Promise.reject(new Error('요청이 많습니다. 실행 결과를 확인한 뒤 다시 시도하세요.'));
    const copy = { ...input }; this.incoming++;
    const work = this.proposalQueue.then(() => this.accept(copy));
    this.proposalQueue = work.then(() => {}, () => {});
    return work.finally(() => { this.incoming--; });
  }
  private retry(requestId: string, requestHash: string): Job | undefined {
    const receipt = this.store.data.receipts.find(r => r.requestId === requestId);
    if (!receipt) return undefined;
    if (!receipt.requestHash) throw new Error('이전 버전의 requestId입니다. 실제 결과를 확인하세요. 자동 재실행하지 않습니다.');
    if (receipt.requestHash !== requestHash) throw new Error('이미 사용한 requestId입니다. 다른 요청에는 새 UUID를 사용하세요.');
    return this.jobSnapshot(receipt.id);
  }
  private async accept(input: Proposal): Promise<Job> {
    this.project(input.projectId);
    // Identity is the caller's request; a patch's derived content depends on the file and is excluded.
    const requestHash = fingerprint(input);
    const previous = this.retry(input.requestId, requestHash); if (previous) return previous;
    if (input.kind === 'access') {
      if (this.paused || this.closing) throw new Error('Workroom 연결이 일시 정지되어 있습니다.');
      const target = await files.resolveFile(this.project(input.projectId), input.path!);
      if (!(await fs.lstat(target)).isDirectory()) throw new Error('폴더를 선택하세요.');
      input.path = path.relative(this.project(input.projectId).path, target).split(path.sep).join('/');
      const now = Date.now();
      const job: Job = { ...input, id: randomUUID(), requestHash, approval: 'manual', label: input.path || '/', state: 'pending', output: '', createdAt: now, updatedAt: now };
      await this.store.update(d => {
        if (d.jobs.length >= 200 || d.receipts.length >= 10000) throw new Error('실행 기록이 가득 찼습니다.');
        d.jobs.unshift(job);d.receipts.push({id:job.id,requestId:job.requestId,projectId:job.projectId,requestHash,kind:'access',state:'pending',createdAt:now,updatedAt:now});
      });
      this.changed();return this.jobSnapshot(job.id);
    }
    this.requireWritable(input.projectId);
    if (!['write','delete','command'].includes(input.kind)) throw new Error('지원하지 않는 요청입니다.');
    if (input.kind === 'command' && (!input.command || input.command.length > 8000 || input.command.includes('\0'))) throw new Error('명령 형식이 올바르지 않습니다.');
    if (input.kind === 'delete' && !/^[a-f0-9]{64}$/.test(input.expectedHash ?? '')) throw new Error('삭제할 파일의 현재 SHA-256 해시가 필요합니다.');
    const { edits, ...request } = input;
    if (request.kind === 'write' && !edits) files.validateContent(request.content!);
    if (request.kind !== 'command') files.requireApproved(this.project(request.projectId), request.path!);
    const before = request.kind === 'write' ? await files.checkRevision(this.project(request.projectId), request.path!, request.expectedHash ?? null) : undefined;
    if (request.kind === 'delete') await files.checkRevision(this.project(request.projectId), request.path!, request.expectedHash!);
    if (edits) { request.content = applyEdits(before!, edits); files.validateContent(request.content); }
    this.requireWritable(request.projectId);
    const mode = this.project(request.projectId).approvalMode ?? 'review';
    if (mode === 'automatic' && request.kind === 'command') commandSandbox(this.project(request.projectId));
    const automatic = mode === 'automatic' || (mode === 'delete' && request.kind === 'write');
    const now = Date.now();
    const job: Job = { ...request, id: randomUUID(), requestHash, approval: automatic ? 'automatic' : 'manual', label: request.kind === 'command' ? request.command! : request.path!, state: automatic ? 'queued' : 'pending', before, output: '', createdAt: now, updatedAt: now };
    await this.store.update(d => {
      this.requireWritable(input.projectId);
      if (input.taskId && !d.tasks.some(t => t.id === input.taskId && t.projectId === input.projectId)) throw new Error('작업과 프로젝트가 일치하지 않습니다.');
      if (d.receipts.length >= 10000) {
        // Forget the oldest settled request older than a day. Listed jobs keep their receipts,
        // so a restart never has to recreate one past the cap; recent retries stay idempotent.
        const listed = new Set(d.jobs.map(j => j.id));
        const index = d.receipts.findIndex(r => terminal(r.state) && r.updatedAt < now - 86400000 && !listed.has(r.id));
        if (index < 0) throw new Error('최근 24시간의 중복 실행 방지 기록이 10,000개입니다. 잠시 후 다시 시도하세요.');
        d.receipts.splice(index, 1);
      }
      if (d.jobs.length >= 200) {
        const index = d.jobs.findLastIndex(j => terminal(j.state));
        if (index < 0) throw new Error('대기·실행 요청이 200개입니다. 일부를 완료하거나 취소하세요.');
        d.jobs.splice(index, 1);
      }
      d.jobs.unshift(job);
      d.receipts.push({ id: job.id, requestId: job.requestId, projectId: job.projectId, requestHash: job.requestHash, kind: job.kind, state: job.state, createdAt: now, updatedAt: now });
    });
    this.changed(); this.pump(); return this.jobSnapshot(job.id);
  }
  async decide(id: string, accept: boolean): Promise<void> {
    const job = this.job(id);
    if (job.state !== 'pending') throw new Error('이미 처리된 요청입니다.');
    if (!accept) { await this.finish(id, 'declined', '사용자가 거절했습니다.'); return; }
    if (job.kind === 'access') {
      if (this.paused || this.closing) throw new Error('Workroom 연결이 일시 정지되어 있습니다.');
      await this.approveFolder(job.projectId,job.path!);
      await this.finish(id,'done','폴더 접근을 승인했습니다. 원래 파일 요청을 다시 시도하세요.');
      return;
    }
    this.requireWritable(job.projectId);
    await this.store.update(d => { const j = d.jobs.find(j => j.id === id)!; if (j.state !== 'pending') throw new Error('이미 처리된 요청입니다.'); j.state = 'queued'; j.updatedAt = Date.now(); });
    this.changed(); this.pump();
  }
  private pump(): void {
    if (this.paused || this.closing) return;
    for (const job of [...this.store.data.jobs].reverse()) {
      if (this.active.size >= 2) break;
      if (job.state !== 'queued' || this.active.has(job.id) || this.activeProjects.has(job.projectId)) continue;
      this.activeProjects.add(job.projectId);
      const run = Promise.resolve().then(() => this.execute(job.id)).catch(() => {
        this.failClosed('작업 기록을 확정하지 못했습니다. 실제 파일·명령 결과를 확인하고 앱을 재시작하세요.');
      }).finally(() => { this.active.delete(job.id); this.activeProjects.delete(job.projectId); this.cancellations.delete(job.id); this.changed(); this.pump(); });
      this.active.set(job.id, run);
    }
  }
  private async execute(id: string): Promise<void> {
    const job = this.job(id);
    if (terminal(job.state)) return;
    if (!this.allowed(job)) { await this.finish(id, 'cancelled', '실행 전에 권한 또는 연결이 취소되었습니다.'); return; }
    await this.store.update(d => {
      const j = d.jobs.find(j => j.id === id)!;
      if (j.state !== 'queued') return;
      j.state = 'running'; j.updatedAt = Date.now();
      d.receipts.find(r => r.id === id)!.state = 'running';
    });
    this.changed();
    if (!this.allowed(job) || this.job(id).state !== 'running') { await this.finish(id, 'cancelled', '실행 전에 권한이 취소되었습니다.'); return; }
    let result: { state: Job['state']; output: string; code?: number | null; resultHash?: string };
    try {
      if (job.kind === 'write') {
        await files.writeFile(this.project(job.projectId), job.path!, job.content!, job.expectedHash ?? null, () => this.allowed(job) && files.approved(this.project(job.projectId), job.path!));
        // The saved text's revision lets the caller chain the next edit without re-reading.
        result = { state: 'done', output: '파일을 저장했습니다.', resultHash: files.hash(job.content!) };
      } else if (job.kind === 'delete') {
        await files.deleteFile(this.project(job.projectId), job.path!, job.expectedHash!, () => this.allowed(job) && files.approved(this.project(job.projectId), job.path!));
        result = { state: 'done', output: '파일을 삭제했습니다.' };
      } else result = await this.runCommand(job);
    } catch (err) { result = { state: this.allowed(job) ? 'failed' : 'cancelled', output: (err as Error).message }; }
    // Do not convert persistence failure after a side effect into a claim that it never happened.
    await this.finish(id, result.state, result.output, result.code, result.resultHash);
  }
  private async runCommand(job: Job): Promise<{ state: Job['state']; output: string; code?: number | null }> {
    const project = this.project(job.projectId);
    await files.resolveFile(project, '.');
    if (!this.allowed(job)) throw new Error('실행 전에 변경 권한이 취소되었습니다.');
    const windows = process.platform === 'win32';
    const sandbox = job.approval === 'automatic' ? commandSandbox(project) : null;
    if (sandbox) for (const folder of project.approvedFolders ?? []) {
      const target = await files.resolveFile(project, folder);
      if (!(await fs.lstat(target)).isDirectory()) throw new Error('승인 폴더가 변경되었습니다. 다시 승인하세요.');
    }
    const executable = sandbox ? '/usr/bin/sandbox-exec' : windows ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '/bin/sh';
    const args = sandbox ? ['-p', sandbox, '/bin/sh', '-c', job.command!] : windows ? ['-NoProfile','-NonInteractive','-Command',job.command!] : ['-c',job.command!];
    // This is intentionally arbitrary command execution, NEVER an OS/filesystem sandbox.
    const child = spawn(executable, args, { cwd: project.path, env: commandEnvironment(), detached: !windows, windowsHide: true, shell: false, stdio: ['ignore','pipe','pipe'] });
    const runtime: Runtime = { process: child, output: '', bytes: 0, cancelled: false, reason: '' };
    this.processes.set(job.id, runtime);
    const collect = (text: string): void => { runtime.output = (runtime.output + text).slice(-MAX_OUTPUT); this.outputChanged(); };
    const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
    [child.stdout, child.stderr].forEach((stream, i) => stream?.on('data', (buffer: Buffer) => {
      runtime.bytes += buffer.length; collect(decoders[i]!.write(buffer));
      if (runtime.bytes > 2 * 1024 * 1024 && !runtime.cancelled) this.kill(job.id, '총 출력 2MB 한도로 실행을 중지했습니다.');
    }));
    const timer = setTimeout(() => this.kill(job.id, '120초 실행 한도에 도달했습니다.'), 120000);
    try {
      const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      for (const decoder of decoders) collect(decoder.end());
      return { state: runtime.cancelled ? 'cancelled' : code === 0 ? 'done' : 'failed', output: (runtime.output + (runtime.reason ? '\n[' + runtime.reason + ']' : '')).slice(-MAX_OUTPUT) || '(출력 없음)', code };
    } finally { clearTimeout(timer); if (runtime.killTimer) clearTimeout(runtime.killTimer); this.processes.delete(job.id); }
  }
  private kill(id: string, reason = '사용자가 실행을 중지했습니다.'): void {
    const runtime = this.processes.get(id); if (!runtime || runtime.cancelled) return;
    runtime.cancelled = true; runtime.reason = reason;
    const signal = (value: NodeJS.Signals): void => { try { if (process.platform !== 'win32' && runtime.process.pid) process.kill(-runtime.process.pid, value); else runtime.process.kill(value); } catch {} };
    signal('SIGTERM'); runtime.killTimer = setTimeout(() => signal('SIGKILL'), 1000); runtime.killTimer.unref();
  }
  async cancel(id: string): Promise<void> {
    const job = this.job(id); if (terminal(job.state)) return;
    this.cancellations.add(id); this.kill(id);
    if (job.state === 'pending' || job.state === 'queued') await this.finish(id, 'cancelled', '사용자가 취소했습니다.');
    this.changed();
  }
  private async cancelProject(projectId?: string): Promise<void> {
    const ids = this.store.data.jobs.filter(j => (!projectId || j.projectId === projectId) && !terminal(j.state)).map(j => j.id);
    for (const id of ids) { this.cancellations.add(id); this.kill(id, '프로젝트 권한 또는 연결이 변경되었습니다.'); }
    await this.store.update(d => {
      for (const j of d.jobs) if (ids.includes(j.id) && (j.state === 'pending' || j.state === 'queued')) {
        j.state = 'cancelled'; j.output = '실행 전에 취소되었습니다.'; j.updatedAt = Date.now(); delete j.content; delete j.before;
        const receipt = d.receipts.find(r => r.id === j.id); if (receipt) { receipt.state = j.state; receipt.updatedAt = j.updatedAt; }
      }
    });
  }
  async setPaused(value: boolean): Promise<void> {
    if (this.closing && !value) throw new Error('앱이 종료 중입니다.');
    this.paused = value;
    if (value) await this.cancelProject();
    else { await this.store.flushLazy(); this.error = null; }
    this.changed(); this.pump();
  }
  private async finish(id: string, state: Job['state'], output: string, code?: number | null, resultHash?: string): Promise<void> {
    await this.store.update(d => {
      const j = d.jobs.find(j => j.id === id); if (!j || terminal(j.state)) return;
      j.state = state; j.output = output.slice(-MAX_OUTPUT); j.exitCode = code; j.updatedAt = Date.now();
      if (resultHash) j.resultHash = resultHash;
      if (terminal(state)) { delete j.before; delete j.content; }
      const r = d.receipts.find(r => r.id === id); if (r) { r.state = state; r.updatedAt = j.updatedAt; }
    }); this.changed();
  }
  audit(tool: string, ok: boolean, projectId?: string): void {
    if (this.closing) return;
    this.lastCall = Date.now(); const at = this.lastCall;
    this.store.updateLazy(d => { d.activity.unshift({ id: randomUUID(), at, tool, projectId, detail: ok ? '도구 호출 완료' : '도구 호출 실패', ok }); d.activity = d.activity.slice(0,200); });
    this.outputChanged();
  }
  async waitForIdle(): Promise<void> {
    await this.proposalQueue; this.pump();
    while (this.active.size) await Promise.allSettled([...this.active.values()]);
  }
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closing = true; this.paused = true;
    for (const wake of this.waiters) wake();
    if (this.outputTimer) clearTimeout(this.outputTimer);
    this.shutdownPromise = (async () => { await this.proposalQueue; await this.cancelProject(); await this.waitForIdle(); await this.store.flushLazy(); })();
    return this.shutdownPromise;
  }
}
