import { app, BrowserWindow, ipcMain, dialog, clipboard, shell, protocol, net } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { Store } from './store';
import { Workspace } from './service';
import { startServer } from './server';
import * as files from './files';
import { Tunnel } from './tunnel';
import { atomicPrivateWrite, ensurePrivateDirectory } from './private-io';

app.setName('Workroom');
const isolatedTest = process.env.WORKROOM_ISOLATED_TEST === '1';
if ((!app.isPackaged || isolatedTest) && process.env.WORKROOM_DATA_DIR) app.setPath('userData', path.resolve(process.env.WORKROOM_DATA_DIR));
protocol.registerSchemesAsPrivileged([{ scheme: 'workroom', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
if (!app.requestSingleInstanceLock()) app.quit();
else {
  let window: BrowserWindow | null = null;
  let workspace: Workspace | null = null;
  let tunnel: Tunnel | undefined;
  let closeServer: (() => Promise<void>) | undefined;
  let shuttingDown = false;
  let repaint: NodeJS.Timeout | undefined;
  const rendererDir = path.join(__dirname, '../renderer');
  const appURL = 'workroom://app/index.html';
  const rawDevURL = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
  const devURL = rawDevURL ? new URL(rawDevURL) : undefined;
  if (devURL && (devURL.protocol !== 'http:' || !['127.0.0.1','localhost'].includes(devURL.hostname) || devURL.username || devURL.password)) throw new Error('개발 UI 주소는 로컬 HTTP만 허용됩니다.');
  const trustedURL = devURL?.href ?? appURL;
  const notify = (): void => { if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('change'); };
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  app.whenReady().then(async () => {
    protocol.handle('workroom', async request => {
      try {
        const url = new URL(request.url);
        if (url.hostname !== 'app' || request.method !== 'GET') return new Response(null, { status: 403 });
        const relative = decodeURIComponent(url.pathname);
        if (relative.includes('\\') || relative.includes('\0')) return new Response(null, { status: 403 });
        const target = path.resolve(rendererDir, '.' + relative);
        if (!target.startsWith(rendererDir + path.sep) || !(await fs.lstat(target)).isFile()) return new Response(null, { status: 404 });
        const response = await net.fetch(pathToFileURL(target).href);
        const headers = new Headers(response.headers);
        headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'");
        headers.set('X-Content-Type-Options', 'nosniff');
        return new Response(response.body, { status: response.status, headers });
      } catch { return new Response(null, { status: 404 }); }
    });
    const dataDir = app.getPath('userData');
    await ensurePrivateDirectory(dataDir);
    const store = new Store(path.join(dataDir, 'workspace.json'));
    await store.load();
    const service = new Workspace(store, dataDir, app.isPackaged ? [process.resourcesPath] : []);
    workspace = service;
    let connectionFile = path.join(dataDir, 'connection.json');
    try {
      const port = (!app.isPackaged || isolatedTest) && process.env.WORKROOM_PORT ? Number(process.env.WORKROOM_PORT) : 47831;
      const server = await startServer(service, port); closeServer = server.close; connectionFile = server.connectionFile;
    } catch (err) { service.error = `연결 서버를 시작하지 못했습니다: ${(err as Error).message}`; }
    service.on('change', () => { if (!repaint) repaint = setTimeout(() => { repaint = undefined; notify(); }, 100); });
    tunnel = new Tunnel(dataDir, !app.isPackaged && process.env.WORKROOM_TUNNEL_CLIENT ? [process.env.WORKROOM_TUNNEL_CLIENT] : undefined);
    tunnel.on('change', notify); await tunnel.inspect();
    const handle = (channel: string, fn: (...args: any[]) => unknown): void => {
      ipcMain.handle(channel, (event, ...args) => {
        if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== trustedURL) throw new Error('허용되지 않은 요청입니다.');
        return fn(...args);
      });
    };
    const id = z.string().uuid(); const relative = z.string().max(1024);
    const confirm = async (message: string, detail: string, action: string): Promise<boolean> => {
      const result = await dialog.showMessageBox(window!, { type: 'warning', message, detail, buttons: ['취소', action], defaultId: 0, cancelId: 0, noLink: true });
      return result.response === 1;
    };
    handle('snapshot', () => ({ ...service.snapshot(), version: app.getVersion(), runtime: { packaged: app.isPackaged, platform: process.platform, arch: process.arch } }));
    handle('project:add', async () => { const result = await dialog.showOpenDialog(window!, { properties: ['openDirectory'] }); return result.canceled ? null : service.addProject(result.filePaths[0]!); });
    handle('project:writable', (p, v) => service.writable(id.parse(p), z.boolean().parse(v)));
    handle('project:approval-mode', async (p, value) => {
      const projectId = id.parse(p); const mode = z.enum(['review','delete','automatic']).parse(value);
      if (mode === 'automatic' && !await confirm('파일 변경과 삭제를 자동 승인할까요?', process.platform === 'darwin'
        ? '승인된 폴더의 파일 변경·삭제와 폴더 격리된 셸 명령을 자동 실행합니다. 앱을 재시작하면 해제됩니다.'
        : '승인된 폴더의 파일 변경·삭제를 자동 실행합니다. Windows에서는 자동 셸 명령을 지원하지 않습니다. 앱을 재시작하면 해제됩니다.', '자동 승인 허용')) return;
      await service.setApprovalMode(projectId, mode);
    });
    handle('project:folder-approve', (p,r) => service.approveFolder(id.parse(p), relative.parse(r)));
    handle('project:folder-revoke', (p,r) => service.revokeFolder(id.parse(p), relative.parse(r)));
    handle('project:remove', async p => {
      const projectId = id.parse(p); const project = service.project(projectId);
      if (await confirm(`${project.name} 연결을 해제할까요?`, '이 프로젝트의 작업·실행 기록을 지웁니다. 실제 프로젝트 파일은 삭제하지 않습니다.', '연결 해제')) await service.removeProject(projectId);
    });
    handle('history:clear', async p => {
      const projectId = id.parse(p); service.project(projectId);
      if (await confirm('완료 기록을 정리할까요?', '완료된 요청 원문·출력과 활동 기록을 정리합니다. 실행 중인 요청·작업 체크포인트·중복 실행 방지용 해시는 유지합니다.', '기록 정리')) await service.clearHistory(projectId);
    });
    handle('task:add', (p,t,o) => service.createTask(id.parse(p), z.string().trim().min(1).max(120).parse(t), z.string().max(12000).parse(o)));
    handle('task:status', (t,s) => service.updateTask(id.parse(t), z.enum(['todo','running','blocked','done']).parse(s)));
    handle('job:decide', (j,a) => service.decide(id.parse(j), z.boolean().parse(a)));
    handle('job:cancel', j => service.cancel(id.parse(j)));
    handle('pause', v => service.setPaused(z.boolean().parse(v)));
    handle('files:list', (p,r) => { const project = service.project(id.parse(p)), name = relative.parse(r); files.requireApproved(project, name); return files.listFiles(project, name); });
    handle('files:read', (p,r) => { const project = service.project(id.parse(p)), name = relative.parse(r); files.requireApproved(project, name); return files.readFile(project, name); });
    handle('connection:copy', () => { if (!service.endpoint) throw new Error('연결 서버를 사용할 수 없습니다.'); clipboard.writeText(service.endpoint); });
    handle('prompt:copy', p => {
      const project = service.project(id.parse(p));
      clipboard.writeText(`Workroom 도구로 ${project.name} 프로젝트를 도와줘. projectId: ${project.id}\n먼저 tasks_list와 필요한 파일을 확인해줘. 승인 모드를 존중하고, 기존 파일 일부 수정은 file_patch로 하되 done 응답의 resultHash를 다음 수정의 expectedHash로 이어서 사용해줘. 응답 상태가 done일 때만 완료로 보고 pending/queued/running이면 job_get으로 결과를 확인해줘. 마지막에 task_update로 사실과 다음 단계를 저장해줘.`);
    });
    handle('tunnel:status', () => tunnel!.snapshot());
    handle('tunnel:inspect', () => tunnel!.inspect());
    handle('tunnel:start', (tunnelId,key) => { if (service.paused) throw new Error('도구 연결을 재개한 뒤 터널을 연결하세요.'); return tunnel!.start(tunnelId,key,service.endpoint); });
    handle('tunnel:stop', () => tunnel!.stop());
    handle('tunnel:copy-id', () => { const tunnelId = tunnel!.snapshot().tunnelId; if (!tunnelId) throw new Error('터널 ID를 먼저 설정하세요.'); clipboard.writeText(tunnelId); });
    const links = { keys: 'https://platform.openai.com/settings/organization/api-keys', tunnels: 'https://platform.openai.com/settings/organization/tunnels', plugins: 'https://chatgpt.com/plugins', download: 'https://github.com/openai/tunnel-client/releases/latest', guide: 'https://developers.openai.com/api/docs/guides/secure-mcp-tunnels' };
    handle('connection:open', key => shell.openExternal(links[z.enum(['keys','tunnels','plugins','download','guide']).parse(key)]));
    handle('docs:open', () => shell.openExternal(links.guide));
    await atomicPrivateWrite(path.join(dataDir, 'local-mcp.json'), JSON.stringify({ mcpServers: { workroom: { command: process.execPath, args: [path.join(__dirname,'mcp-stdio.js')], env: { ELECTRON_RUN_AS_NODE: '1', WORKROOM_CONNECTION_FILE: connectionFile } } } }, null, 2));
    window = new BrowserWindow({ width: 1360, height: 900, minWidth: 1000, minHeight: 680, title: 'Workroom', backgroundColor: '#f6f5f1', titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 20, y: 22 }, webPreferences: { preload: path.join(__dirname,'../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, devTools: !app.isPackaged || isolatedTest } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', e => e.preventDefault());
    window.webContents.on('will-attach-webview', e => e.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_webContents,_permission,callback) => callback(false));
    window.webContents.session.setPermissionCheckHandler(() => false);
    window.webContents.on('render-process-gone', () => { void service.setPaused(true).catch(() => {}); });
    await window.loadURL(trustedURL);
    window.on('closed', () => { window = null; });
  }).catch(err => { dialog.showErrorBox('Workroom 시작 오류', (err as Error).message); app.quit(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (shuttingDown) return;
    event.preventDefault(); shuttingDown = true;
    if (repaint) clearTimeout(repaint);
    const cleanup = Promise.allSettled([workspace?.shutdown(), tunnel?.stop(), closeServer?.()]);
    const limit = setTimeout(() => app.exit(1), 8000);
    void cleanup.then(() => { clearTimeout(limit); app.quit(); });
  });
}
