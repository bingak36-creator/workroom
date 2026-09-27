export const APP_VERSION = '0.3.0-rc.3';
export type ApprovalMode = 'automatic' | 'delete' | 'review';
export interface Project { id: string; name: string; path: string; writable: boolean; approvalMode?: ApprovalMode; approvedFolders?: string[] }
export interface Task { id: string; projectId: string; title: string; objective: string; status: 'todo' | 'running' | 'blocked' | 'done'; summary: string; createdAt: number; updatedAt: number }
export interface Job {
  id: string; requestId: string; projectId: string; taskId?: string;
  kind: 'write' | 'delete' | 'command' | 'access'; state: 'pending' | 'queued' | 'running' | 'done' | 'failed' | 'declined' | 'cancelled';
  label: string; path?: string; content?: string; expectedHash?: string | null; command?: string;
  before?: string; requestHash?: string; resultHash?: string; approval?: 'manual' | 'automatic';
  output: string; exitCode?: number | null; createdAt: number; updatedAt: number;
}
export interface Receipt { id: string; requestId: string; projectId: string; requestHash?: string; kind: Job['kind']; state: Job['state']; createdAt: number; updatedAt: number }
export interface Activity { id: string; at: number; tool: string; projectId?: string; detail: string; ok: boolean }
export interface Snapshot {
  projects: Project[]; tasks: Task[]; jobs: Job[]; activity: Activity[];
  connected: boolean; paused: boolean; lastCall: number | null;
  endpoint: null; error: string | null; dataDir: string;
  version: string; runtime?: { packaged: boolean; platform: string; arch: string };
}
export interface FileEntry { name: string; directory: boolean }
export interface FileRead { path: string; content: string; hash: string }
export interface TunnelStatus { installed: boolean; phase: 'stopped' | 'starting' | 'ready' | 'error'; tunnelId: string; message: string }
export type ConnectionLink = 'keys' | 'tunnels' | 'plugins' | 'download' | 'guide';
export interface WorkroomAPI {
  snapshot(): Promise<Snapshot>; addProject(): Promise<Project | null>;
  setWritable(id: string, value: boolean): Promise<void>;
  setApprovalMode(id: string, mode: ApprovalMode): Promise<void>;
  approveFolder(id: string, relative: string): Promise<void>;
  revokeFolder(id: string, relative: string): Promise<void>;
  removeProject(id: string): Promise<void>; clearHistory(id: string): Promise<void>;
  addTask(projectId: string, title: string, objective: string): Promise<void>;
  setTask(id: string, status: Task['status']): Promise<void>;
  decide(id: string, accept: boolean): Promise<void>; cancelJob(id: string): Promise<void>;
  pause(value: boolean): Promise<void>;
  listFiles(projectId: string, relative: string): Promise<FileEntry[]>;
  readFile(projectId: string, relative: string): Promise<FileRead>;
  copyConnection(): Promise<void>; copyPrompt(projectId: string): Promise<void>; openDocs(): Promise<void>;
  tunnelStatus(): Promise<TunnelStatus>; inspectTunnel(): Promise<TunnelStatus>;
  startTunnel(tunnelId: string, apiKey: string): Promise<TunnelStatus>;
  stopTunnel(): Promise<TunnelStatus>;
  openConnectionLink(link: ConnectionLink): Promise<void>;
  copyTunnelId(): Promise<void>;
  onChange(callback: () => void): () => void;
}
declare global { interface Window { workroom: WorkroomAPI } }
