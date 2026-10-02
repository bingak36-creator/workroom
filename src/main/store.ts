import { EventEmitter } from 'node:events';
import { z } from 'zod';
import type { Project, Task, Job, Activity, Receipt } from '../shared';
import { atomicPrivateWrite, readPrivateText } from './private-io';
import { fingerprint, terminal } from './request';
import { environmentNames } from './command-environment';

export interface Data { version: 1; projects: Project[]; tasks: Task[]; jobs: Job[]; activity: Activity[]; receipts: Receipt[] }
type Mutation = (draft: Data) => void;
const id = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const state = z.enum(['pending', 'queued', 'running', 'done', 'failed', 'declined', 'cancelled']);
const schema = z.object({
  version: z.literal(1),
  projects: z.array(z.object({ id, name: z.string().max(1024), path: z.string().max(8192), writable: z.boolean(), approvalMode: z.enum(['review', 'automatic', 'delete']).default('review'), approvedFolders: z.array(z.string().max(1024)).max(500).default([]), environmentNames: environmentNames.default([]), rememberAutomatic: z.boolean().default(false) })).max(100),
  tasks: z.array(z.object({ id, projectId: id, title: z.string().max(120), objective: z.string().max(12000), status: z.enum(['todo','running','blocked','done']), summary: z.string().max(16000), createdAt: z.number(), updatedAt: z.number() })).max(2000),
  jobs: z.array(z.object({
    id, requestId: id, projectId: id, taskId: id.optional(), kind: z.enum(['write','delete','command','access']), state,
    label: z.string().max(8000), path: z.string().max(1024).optional(), content: z.string().max(262144).optional(), expectedHash: digest.nullable().optional(), command: z.string().max(8000).optional(), environment: environmentNames.optional(),
    before: z.string().max(262144).optional(), requestHash: digest.optional(), resultHash: digest.optional(), approval: z.enum(['manual','automatic']).optional(),
    output: z.string().max(64000), exitCode: z.number().nullable().optional(), createdAt: z.number(), updatedAt: z.number()
  })).max(200),
  activity: z.array(z.object({ id, at: z.number(), tool: z.string().max(128), projectId: id.optional(), detail: z.string().max(2048), ok: z.boolean() })).max(200),
  receipts: z.array(z.object({ id, requestId: id, projectId: id, requestHash: digest.optional(), kind: z.enum(['write','delete','command','access']), state, createdAt: z.number(), updatedAt: z.number() })).max(10000).default([])
});

export class Store extends EventEmitter {
  data: Data = { version: 1, projects: [], tasks: [], jobs: [], activity: [], receipts: [] };
  private queue: Promise<unknown> = Promise.resolve();
  private lazyMutations: Mutation[] = [];
  private lazyTimer: NodeJS.Timeout | undefined;
  constructor(private file: string) { super(); }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readPrivateText(this.file));
      if (Array.isArray(raw?.projects)) for (const project of raw.projects) {
        if (project?.approvalMode === 'all' || project?.approvalMode === 'edits') project.approvalMode = 'review';
      }
      this.data = schema.parse(raw);
    }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('작업 목록 파일을 읽을 수 없습니다. 원본을 보존했습니다.');
    }
    // Only a user's explicit persistent opt-in restores authority. Old jobs are never replayed.
    for (const project of this.data.projects) {
      if (!(project.rememberAutomatic && project.writable && project.approvalMode === 'automatic' && project.approvedFolders?.length)) {
        project.writable = false; project.rememberAutomatic = false;
        if (project.approvalMode === 'automatic') project.approvalMode = 'review';
      }
    }
    for (const job of this.data.jobs) {
      if (!job.requestHash && (job.kind === 'command' || job.content !== undefined)) job.requestHash = fingerprint(job);
      if (!terminal(job.state)) {
        job.state = 'cancelled'; job.updatedAt = Date.now();
        job.output = '앱 재시작으로 중단되었습니다. 실제 결과를 확인하세요. 자동 재실행하지 않았습니다.';
      }
      if (job.kind === 'write') { delete job.before; delete job.content; }
      job.output = job.output.slice(-32000);
      const receipt = this.data.receipts.find(r => r.requestId === job.requestId);
      if (receipt) { receipt.state = job.state; receipt.updatedAt = job.updatedAt; }
      else this.data.receipts.push({ id: job.id, requestId: job.requestId, projectId: job.projectId, requestHash: job.requestHash, kind: job.kind, state: job.state, createdAt: job.createdAt, updatedAt: job.updatedAt });
    }
    for (const receipt of this.data.receipts) if (!terminal(receipt.state)) receipt.state = 'cancelled';
    await this.update(() => {});
  }

  update(mutate: Mutation): Promise<void> {
    const work = this.queue.then(async () => {
      const lazy = this.lazyMutations.splice(0);
      if (this.lazyTimer) { clearTimeout(this.lazyTimer); this.lazyTimer = undefined; }
      let writing = false;
      try {
        const draft = structuredClone(this.data);
        for (const fn of lazy) fn(draft);
        mutate(draft);
        const valid = schema.parse(draft);
        const text = JSON.stringify(valid);
        if (Buffer.byteLength(text) > 32 * 1024 * 1024) throw new Error('작업 데이터가 32MB를 초과했습니다. 완료 기록을 정리하세요.');
        writing = true;
        await atomicPrivateWrite(this.file, text);
        this.data = valid;
      } catch (err) {
        this.lazyMutations = [...lazy, ...this.lazyMutations].slice(-200);
        if (writing) this.emit('warning', '작업 기록 저장에 실패했습니다. 연결을 일시 정지하고 디스크 상태를 확인하세요.');
        throw err;
      }
    });
    this.queue = work.catch(() => {});
    return work;
  }

  /** Audit events only: execution/approval state always uses durable update(). */
  updateLazy(mutate: Mutation): void {
    this.lazyMutations.push(mutate);
    if (this.lazyMutations.length > 200) this.lazyMutations.shift();
    if (this.lazyTimer) return;
    this.lazyTimer = setTimeout(() => {
      this.lazyTimer = undefined;
      void this.flushLazy().catch(() => {}); // warning event reports failures; no unhandled rejection
    }, 300);
    this.lazyTimer.unref();
  }

  async flushLazy(): Promise<void> {
    if (this.lazyTimer) { clearTimeout(this.lazyTimer); this.lazyTimer = undefined; }
    if (this.lazyMutations.length) await this.update(() => {});
    await this.queue;
  }
}
