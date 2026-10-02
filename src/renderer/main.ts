import './style.css';
import type { Snapshot, FileEntry, FileRead, Job, Task, TunnelStatus, ConnectionLink, ApprovalMode } from '../shared';
const api = window.workroom;
const root = document.querySelector<HTMLDivElement>('#app')!;
let data: Snapshot;
let tunnel: TunnelStatus = {installed:false,phase:'stopped',tunnelId:'',message:''};
let tunnelBusy = false;
let projectId = '';
let tab: 'tasks'|'files'|'jobs'|'activity'|'connect' = 'tasks';
let filter = 'all';
let jobsLimit = 40;
let folder = ''; let entries: FileEntry[] = []; let preview: FileRead | null = null; let fileError = ''; let fileEpoch = 0;
let snapshotEpoch = 0;
let toastTimer: ReturnType<typeof setTimeout>;
const openDetails = new Set<string>();
const escape = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g,c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const icons = { grid: '▦', folder: '▱', check: '✓', arrow: '↗', terminal: '⌘', link: '⇄' };
const labels: Record<string,string> = { todo:'대기',running:'진행 중',blocked:'확인 필요',done:'완료',pending:'승인 대기',queued:'실행 대기',failed:'실패',declined:'거절됨',cancelled:'취소됨' };
const time = (at: number): string => new Date(at).toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'});
function toast(message: string): void { const node = document.querySelector('#toast')!; node.textContent = message.replace(/^Error invoking remote method '[^']+': (Error: )?/,''); node.classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => node.classList.remove('visible'),5500); }
async function action(fn: () => Promise<unknown>): Promise<void> { try { await fn(); await refresh(tab==='connect'); } catch(err) { toast((err as Error).message); } }
let refreshPromise: Promise<void> | null = null;
let refreshAgain = false; let wantsTunnel = false;
async function refresh(includeTunnel = tab==='connect'): Promise<void> {
  refreshAgain=true; wantsTunnel ||= includeTunnel;
  if(refreshPromise) return refreshPromise;
  refreshPromise=(async()=>{
    do {
      refreshAgain=false; const withTunnel=wantsTunnel; wantsTunnel=false;
      const [next,status]=await Promise.all([api.snapshot(),withTunnel?api.tunnelStatus():Promise.resolve(tunnel)]);
      data=next;tunnel=status;
      if(!data.projects.some(p=>p.id===projectId)) {projectId=data.projects[0]?.id??'';folder='';entries=[];preview=null;}
      render();
    } while(refreshAgain);
  })();
  try{await refreshPromise;}finally{refreshPromise=null;}
}
function badge(state: string): string { return `<span class="badge ${escape(state)}"><i></i>${labels[state] ?? escape(state)}</span>`; }
function empty(title: string, text: string, symbol = '✦'): string { return `<div class="empty"><span class="empty-symbol">${symbol}</span><h3>${title}</h3><p>${text}</p></div>`; }
function welcome(): string {
  return `<div class="welcome"><div class="eyebrow">YOUR LOCAL WORKSPACE</div><h1>생각은 대화에서.<br>결과는 내 작업실에.</h1><p>ChatGPT와 나누는 대화에 로컬 프로젝트를 연결하세요.<br>파일, 실행 요청, 다음 할 일을 한곳에서 관리합니다.</p><button class="primary large" data-action="add-project">+ 첫 프로젝트 연결</button><div class="welcome-steps"><article><span>01</span><h3>프로젝트를 선택하고</h3><p>작업할 폴더를 직접 지정하세요.<br>처음에는 읽기 전용으로 연결됩니다.</p></article><article><span>02</span><h3>ChatGPT에서 이야기하고</h3><p>공식 MCP 연결로 필요한 파일과<br>저장된 작업을 불러옵니다.</p></article><article><span>03</span><h3>실행 권한을 관리하세요</h3><p>변경 권한과 승인 모드를 선택하고<br>실제 실행 결과를 확인합니다.</p></article></div></div>`;
}
function taskView(): string {
  const tasks = data.tasks.filter(t=>t.projectId===projectId);
  const selected=tasks.filter(t=>filter==='all'||t.status===filter);
  return `<div class="section-heading"><div><div class="eyebrow">PROJECT OVERVIEW</div><h2>작업 보드 <span class="count">${tasks.length}</span></h2><p>목표를 정리하고, 대화가 끝나도 다음 단계를 남겨 두세요.</p></div><button class="primary" data-action="new-task">+ 새 작업</button></div><div class="filters">${[['all','전체'],['todo','대기'],['running','진행 중'],['blocked','확인 필요'],['done','완료']].map(([id,label])=>`<button data-filter="${id}" class="${filter===id?'selected':''}">${label}</button>`).join('')}</div>${selected.length?`<div class="task-grid">${selected.map(t=>`<article class="task-card">${badge(t.status)}<h3>${escape(t.title)}</h3><p class="objective">${escape(t.objective||'ChatGPT에서 이 작업의 목표를 구체화해 보세요.')}</p>${t.summary?`<details data-detail="${t.id}" ${openDetails.has(t.id)?'open':''}><summary>저장된 체크포인트</summary><pre>${escape(t.summary)}</pre></details>`:''}<footer><span>${new Date(t.updatedAt).toLocaleDateString('ko-KR')}</span><select aria-label="작업 상태" data-task="${t.id}">${['todo','running','blocked','done'].map(s=>`<option value="${s}" ${t.status===s?'selected':''}>${labels[s]}</option>`).join('')}</select></footer></article>`).join('')}</div>`:empty('다음 작업을 위한 빈 페이지','새 작업을 추가하거나 ChatGPT에 Workroom 작업을 저장해 달라고 요청하세요.')}`;
}
function folderView(): string {
  const project=data.projects.find(p=>p.id===projectId);
  if(!project)return '';
  const folders=project.approvedFolders??[];
  return '<section class="approved-folders"><h3>접근 승인 폴더</h3><p>승인된 폴더 안의 파일만 도구로 읽거나 변경할 수 있습니다. /는 프로젝트 전체입니다.</p><form id="folder-form" data-project="'+project.id+'"><input id="approved-folder-path" name="folder" aria-label="승인할 폴더" placeholder="폴더 경로 또는 /" required><button type="submit">폴더 승인</button></form>' + folders.map(f=>'<div><code>'+escape(f||'/')+'</code> <span><button data-open-folder="'+escape(f)+'">열기</button> <button data-revoke-folder="'+escape(f)+'">승인 취소</button></span></div>').join('') + '</section>';
}
function automaticView(): string {
  const project=data.projects.find(p=>p.id===projectId); if(!project)return '';
  const active=project.writable&&project.approvalMode==='automatic'&&!!project.approvedFolders?.length;
  const scope=project.approvedFolders?.length?'현재 승인된 폴더에서 파일 수정·삭제를 자동 실행합니다.':'시작할 때 프로젝트 전체의 폴더 접근과 변경 허용을 함께 승인합니다.';
  return `<section class="automatic-bar ${active?'enabled':''}" aria-label="자동승인 설정"><div><strong>${active?'자동승인 켜짐':'자동승인으로 바로 작업하기'}</strong><p>${active?(project.rememberAutomatic?'앱을 다시 열어도 유지됩니다.':'이번 실행에만 적용됩니다.')+' 비밀파일 차단은 유지됩니다.':scope}</p></div><div class="automatic-actions">${active?`<button data-action="start-automatic" ${data.paused?'disabled':''}>유지 설정</button><button data-action="stop-automatic">자동승인 끄기</button>`:`<button class="primary" data-action="start-automatic" ${data.paused?'disabled':''}>자동승인 시작</button>`}</div></section>`;
}
function environmentView(): string {
  const project=data.projects.find(p=>p.id===projectId); if(!project)return '';
  const names=project.environmentNames??[];
  return '<section class="approved-folders environment-settings"><h3>명령에 허용할 OS 환경변수</h3><p>변수 이름만 공백 또는 쉼표로 구분해 입력하세요. 명령은 이 목록 중 요청한 변수만 사용합니다. 값은 앱 실행 환경에서 가져오며, .env 파일은 읽지 않습니다. 목록을 바꾸면 대기·실행 중인 작업이 취소됩니다.</p><form id="environment-form" data-project="'+project.id+'" autocomplete="off"><label for="environment-names">허용할 변수 이름</label><input id="environment-names" name="names" aria-label="허용할 환경변수 이름" value="'+escape(names.join(', '))+'" placeholder="API_TOKEN, DATABASE_URL" spellcheck="false" autocomplete="off"><button type="submit">허용 목록 저장</button></form><p>현재 허용: '+(names.length?names.map(n=>'<code>'+escape(n)+'</code>').join(', '):'없음')+' · 이름만 저장하며 값은 표시하지 않습니다. 비밀파일 차단은 승인 모드와 관계없이 유지됩니다.</p></section>';
}
function filesView(): string {
  return `<div class="section-heading"><div><div class="eyebrow">PROJECT FILES</div><h2>파일 둘러보기</h2><p>텍스트 미리보기 · 최대 256KB · 폴더당 최대 500개 표시</p></div><button data-action="refresh-files">새로고침</button></div><div class="file-workspace"><div class="file-list"><div class="file-path">${escape(folder||'/')} ${folder?'<button data-action="parent-folder" aria-label="상위 폴더">↑</button>':''}</div>${entries.map(e=>`<button class="file-row ${preview?.path===(folder?folder+'/':'')+e.name?'selected':''}" data-file="${escape(e.name)}" data-directory="${e.directory}"><span>${e.directory?'▸':'≡'}</span>${escape(e.name)}${e.directory?'<small>/</small>':''}</button>`).join('')}</div><div class="file-preview">${fileError?`<div class="inline-error">${escape(fileError)}</div>`:preview?`<header>${escape(preview.path)}<span>UTF-8</span></header><pre>${escape(preview.content)}</pre>`:empty('파일을 선택하세요','승인된 프로젝트 안의 텍스트 파일을 읽습니다.','≡')}</div></div>`;
}
function jobCard(j: Job): string {
  return `<article class="job-card"><div class="job-top"><span class="job-icon">${j.kind==='command'?'⌘':'≡'}</span><div><h3>${({write:'파일 변경',delete:'파일 삭제',access:'폴더 접근 승인',command:'명령 실행'} as const)[j.kind]}</h3><p>${escape(data.projects.find(p=>p.id===j.projectId)?.name)} · ${time(j.createdAt)}</p></div>${badge(j.state)}</div><pre class="job-label">${escape(j.label)}</pre>${j.kind==='command'?`<p class="small">요청한 환경변수: ${escape(j.environment?.join(', ')||'없음')}</p>`:''}${j.state==='pending'&&j.kind==='command'?'<div class="notice">네트워크를 사용할 수 있는 명령입니다. 승인 폴더와 비밀파일 차단은 유지됩니다. 전체 명령과 요청한 환경변수 이름을 확인하세요.</div>':''}${j.kind==='write'&&j.content!==undefined?`<details data-detail="${j.id}" ${openDetails.has(j.id)?'open':''}><summary>변경 전·후 확인</summary><div class="diff"><div><h4>변경 전</h4><pre>${escape(j.before||'(새 파일)')}</pre></div><div><h4>변경 후</h4><pre>${escape(j.content)}</pre></div></div></details>`:''}${j.output?`<details data-detail="output-${j.id}" ${openDetails.has('output-'+j.id)||j.state==='running'?'open':''}><summary>실행 결과 ${j.exitCode!==undefined&&j.exitCode!==null?`· 종료 코드 ${j.exitCode}`:''}</summary><pre class="output">${escape(j.output)}</pre></details>`:''}${j.state==='pending'?`<div class="job-actions"><button data-reject="${j.id}">거절</button><button class="primary" data-approve="${j.id}" ${data.paused?'disabled':''}>${j.kind==='access'?'폴더 승인':'승인하고 실행'}</button></div>`:(j.state==='queued'||j.state==='running')?`<div class="job-actions"><button class="danger" data-cancel-job="${j.id}">취소 / 중지</button></div>`:''}</article>`;
}
function jobsView(): string {
  const jobs=data.jobs.filter(j=>!projectId||j.projectId===projectId);
  return `<div class="section-heading"><div><div class="eyebrow">REVIEW & RUN</div><h2>실행 기록</h2><p>승인 대기·실행 중·완료 상태를 구분합니다. 모든 명령에 폴더 격리와 비밀파일 차단을 적용합니다. Windows에서는 셸 명령을 실행하지 않습니다.</p></div><div><span class="soft-label">요청 ${jobs.length}개</span> <button data-action="clear-history">완료 기록 정리</button></div></div>${jobs.length?`<div class="jobs">${jobs.slice(0,jobsLimit).map(jobCard).join('')}${jobs.length>jobsLimit?'<button data-action="more-jobs">이전 기록 더 보기</button>':''}</div>`:empty('아직 실행 기록이 없습니다','ChatGPT가 파일 수정이나 명령을 실행하면 결과가 여기에 나타납니다.','✓')}`;
}
function connectionView(): string {
  const active=tunnel.phase==='starting'||tunnel.phase==='ready'||tunnel.phase==='error';
  const locked=tunnelBusy||active;
  const states={stopped:'터널 연결 전',starting:'연결 확인 중',ready:'터널 연결됨',error:'연결 확인 필요'};
  return `<div class="section-heading"><div><div class="eyebrow">CHATGPT CONNECTION</div><h2>ChatGPT와 연결</h2><p>터널 ID와 API 키를 준비하면 이 화면에서 연결할 수 있습니다.</p></div><button data-connection-link="guide">공식 안내 ↗</button></div>
  <div class="connection-status"><div class="status-orb ${data.connected&&!data.paused?'on':''}"></div><div><h3>${data.paused?'도구 연결 일시 정지':data.connected?'로컬 MCP 서버 준비됨':'로컬 서버 오류'}</h3><p>로컬 서버 준비와 ChatGPT 연결은 별개입니다. 아래 터널 상태를 확인하세요.</p></div></div>
  <div class="setup-layout"><div class="setup-main">
    <article class="connect-card setup-card"><span class="step">1</span><h3>터널과 런타임 API 키 준비</h3><p>OpenAI Platform에서 터널과 API 키를 발급하세요. 키 소유자에게 <strong>Tunnels Read + Use</strong> 권한이 필요합니다. 터널에는 사용할 ChatGPT 워크스페이스를 연결하세요.</p><div class="setup-buttons"><button data-connection-link="tunnels">터널 만들기 ↗</button><button data-connection-link="keys">API 키 발급 ↗</button></div><p class="key-explanation">API 키는 <strong>OpenAI 터널 인증용</strong>입니다. Workroom은 모델 API를 호출하지 않습니다. 관리용 Admin API 키 대신 런타임 키를 사용하세요.</p></article>
    <article class="connect-card setup-card"><span class="step">2</span><h3>정보 입력 후 연결</h3><div class="install-status">${tunnel.installed?'✓ tunnel-client 설치 확인됨':'tunnel-client 설치가 필요합니다.'}<button data-action="check-tunnel">설치 다시 확인</button>${!tunnel.installed?'<button data-connection-link="download">다운로드 ↗</button>':''}</div>
      <form id="tunnel-form" autocomplete="off"><label for="tunnel-id">터널 ID</label><input id="tunnel-id" name="tunnelId" value="${escape(tunnel.tunnelId)}" placeholder="tunnel_…" required spellcheck="false" autocomplete="off" ${locked?'disabled':''}>
      <label for="tunnel-key">런타임 API 키</label><input id="tunnel-key" name="apiKey" type="password" placeholder="sk-…" required autocomplete="off" spellcheck="false" ${locked?'disabled':''}>
      <p class="small">키는 파일에 저장하지 않습니다. 연결 요청 후 입력란을 비우며, 중지하거나 앱을 종료하면 다시 입력해야 합니다. 터널 ID만 저장합니다.</p>
      <button class="primary" type="submit" ${locked||!tunnel.installed||!data.connected||data.paused?'disabled':''}>${tunnelBusy?'처리 중…':'터널 연결'}</button></form>
      <div class="tunnel-state ${tunnel.phase}" role="status"><strong>${states[tunnel.phase]}</strong><p>${escape(tunnel.message)}</p>${active?'<button data-action="stop-tunnel">터널 중지</button>':''}</div>
    </article>
  </div><aside class="setup-aside"><article class="connect-card setup-card"><span class="step">3</span><h3>ChatGPT에 Workroom 추가</h3><ol><li>ChatGPT 설정 → 보안 및 로그인에서 개발자 모드를 켭니다.</li><li>플러그인 페이지에서 <strong>+</strong>를 누릅니다.</li><li>이름은 <strong>Workroom</strong>, 연결 방식은 <strong>Tunnel</strong>을 선택합니다.</li><li>아래 버튼으로 복사한 터널 ID를 입력합니다.</li></ol><button data-action="copy-tunnel-id" ${!tunnel.tunnelId?'disabled':''}>터널 ID 복사</button><button class="primary" data-connection-link="plugins" ${tunnel.phase!=='ready'?'disabled':''}>ChatGPT 플러그인 열기 ↗</button><p class="small">터널 연결이 확인되면 등록 버튼이 활성화됩니다. 등록할 때와 대화 중에는 Workroom을 켜 두세요.</p></article>
    <article class="connect-card setup-card troubleshooting"><h3>생성 오류가 나오나요?</h3><p>“Something went wrong”가 나오면 터널 연결 상태, API 키의 조직·권한, ChatGPT 워크스페이스 연결 여부를 확인하세요.</p><p>ChatGPT에 <code>127.0.0.1</code> 주소나 API 키를 입력하지 않습니다. <strong>Tunnel과 터널 ID</strong>를 사용하세요.</p><p>계정에 개발자 모드가 제공되는지도 확인하세요. 터널이 연결되어도 ChatGPT 등록까지 완료된 것은 아닙니다.</p></article></aside></div>
    <details class="local-mcp"><summary>로컬 MCP 환경에 직접 연결하는 경우</summary><p>로컬 Codex 작업 환경의 MCP 설정은 터널 없이 사용할 수 있습니다. 일반 ChatGPT 대화의 연결과는 다릅니다.</p><button data-action="copy-connection" ${!data.connected?'disabled':''}>연결 주소 복사 ↗</button><p>연결 주소에는 접근 키가 포함되므로 다른 사람과 공유하지 마세요.</p></details>`;
}
function activityView(): string {
  const logs=data.activity.filter(a=>!projectId||!a.projectId||a.projectId===projectId);
  return `<div class="section-heading"><div><div class="eyebrow">ACTIVITY LOG</div><h2>활동 기록</h2><p>실제로 수신한 MCP 도구 호출을 표시합니다. 최근 200개 보관.</p></div></div>${logs.length?`<div class="activity-list">${logs.map(a=>`<div><span class="activity-dot ${a.ok?'':'error'}"></span><code>${escape(a.tool)}</code><span>${escape(a.detail)}</span><time>${time(a.at)}</time></div>`).join('')}</div>`:empty('아직 기록이 없습니다','ChatGPT가 Workroom 도구를 호출하면 이곳에 기록됩니다.','◷')}`;
}
function render(): void {
  const project=data.projects.find(p=>p.id===projectId);
  const preservedInputs=tab==='connect' ? [...root.querySelectorAll<HTMLInputElement>('#tunnel-form input')]
    : root.querySelector<HTMLFormElement>('#folder-form')?.dataset.project===projectId ? [...root.querySelectorAll<HTMLInputElement>('#folder-form input, #environment-form input')] : [];
  const focused=document.activeElement;
  const pending=data.jobs.filter(j=>j.state==='pending').length;
  const standalone=tab==='connect';
  const content=tab==='connect'?connectionView():!project?welcome():tab==='files'?folderView()+filesView():tab==='jobs'?jobsView():tab==='activity'?activityView():taskView()+folderView()+environmentView();
  const scroll=root.querySelector('.content')?.scrollTop??0;
  root.innerHTML=`<aside class="sidebar"><div class="brand"><div class="brand-symbol">w<span>·</span></div><div>workroom<small>나의 로컬 작업실</small></div></div><div class="side-label">WORKSPACE</div><nav>${([['tasks','작업 보드',icons.grid],['files','프로젝트 파일',icons.folder],['jobs','실행 기록',icons.check],['activity','활동 기록','◷']] as const).map(([id,label,icon])=>`<button data-tab="${id}" class="${tab===id?'active':''}"><span>${icon}</span>${label}${id==='jobs'&&pending?`<b>${pending}</b>`:''}</button>`).join('')}</nav><div class="side-label project-label">PROJECTS<button aria-label="프로젝트 추가" data-action="add-project">+</button></div><div class="project-list">${data.projects.map(p=>`<button data-project="${p.id}" class="${p.id===projectId?'selected':''}"><i></i><span>${escape(p.name)}</span></button>`).join('')||'<p class="side-empty">아직 연결한 프로젝트가 없습니다.</p>'}</div><div class="sidebar-bottom"><button class="connection-link ${tab==='connect'?'active':''}" data-tab="connect"><span class="dot ${data.connected&&!data.paused?'green':''}"></span><div>ChatGPT 연결<small>${data.paused?'일시 정지':data.lastCall?'도구 호출 수신됨':'연결 설정'}</small></div><span>↗</span></button><div class="local-note"><span>◉</span> 내 컴퓨터에 저장 <small>v${escape(data.version)}</small></div></div></aside><main><header class="topbar"><div><span class="breadcrumb">내 작업실</span><span class="slash">/</span><strong>${escape(tab==='connect'?'연결 설정':project?.name||'시작하기')}</strong></div><div class="top-actions">${project&&!standalone?`<button class="subtle" data-action="copy-prompt">ChatGPT 시작 문구 복사 ↗</button>`:''}<button class="pause ${data.paused?'paused':''}" data-action="pause"><span>${data.paused?'▶':'Ⅱ'}</span>${data.paused?'연결 재개':'일시 정지'}</button></div></header>${project&&!standalone?`<div class="project-strip"><code>${escape(project.path)}</code><label class="approval-setting">승인 모드 <select id="approval-mode"><option value="automatic" ${project.approvalMode==='automatic'?'selected':''}>자동승인</option><option value="delete" ${project.approvalMode==='delete'?'selected':''}>삭제만 승인</option><option value="review" ${(project.approvalMode??'review')==='review'?'selected':''}>전부 승인</option></select></label><button class="subtle" data-action="remove-project">연결 해제</button><label class="permission"><input type="checkbox" id="writable" ${project.writable?'checked':''}><span class="toggle"></span>변경 허용</label></div>`:''}${data.error?`<div class="global-error">${escape(data.error)}</div>`:''}${data.paused?'<div class="pause-banner">도구 호출이 일시 정지되었습니다. 대기 요청은 취소되며, 실행 중 명령은 중지됩니다.</div>':''}<div class="content">${project&&!standalone?automaticView():''}${content}</div><footer class="bottom-bar"><span><i class="dot ${data.connected?'green':''}"></i>${data.connected?'MCP 서버 준비됨':'서버 연결 오류'}</span><span>ChatGPT에서 대화 · Workroom에서 관리</span></footer></main>`;
  for(const input of preservedInputs){const replacement=root.querySelector<HTMLInputElement>('#'+input.id);if(replacement){input.disabled=replacement.disabled;replacement.replaceWith(input);if(input===focused)input.focus({preventScroll:true});}}
  const scroller=root.querySelector('.content'); if(scroller) scroller.scrollTop=scroll;
}
async function loadFiles(): Promise<void> {
  const epoch=++fileEpoch, owner=projectId, current=folder; fileError='';entries=[];render();
  try { const result=await api.listFiles(owner,current); if(epoch===fileEpoch&&owner===projectId&&current===folder){entries=result;render();} }
  catch(err){if(epoch===fileEpoch){fileError=(err as Error).message;render();}}
}
root.addEventListener('click',event=>{
  const target=(event.target as HTMLElement).closest<HTMLElement>('button'); if(!target||target.hasAttribute('disabled'))return;
  if(target.dataset.connectionLink){void action(()=>api.openConnectionLink(target.dataset.connectionLink as ConnectionLink));return;}
  if(target.dataset.tab){ tab=target.dataset.tab as typeof tab;if(tab==='connect')void refresh(true).catch(e=>toast(e.message));else render();if(tab==='files'&&projectId)void loadFiles();return; }
  if(target.dataset.project){ jobsLimit=40; projectId=target.dataset.project;folder='';entries=[];preview=null;fileError='';fileEpoch++;render();if(tab==='files')void loadFiles();return; }
  if(target.dataset.filter){filter=target.dataset.filter;render();return;}
  if(target.dataset.file){const name=target.dataset.file;const relative=folder?folder+'/'+name:name;if(target.dataset.directory==='true'){folder=relative;preview=null;void loadFiles();}else{const epoch=++fileEpoch;void action(async()=>{const result=await api.readFile(projectId,relative);if(epoch===fileEpoch){preview=result;fileError='';}});}return;}
  if(target.dataset.approve||target.dataset.reject){ const id=target.dataset.approve||target.dataset.reject!;target.setAttribute('disabled','');void action(()=>api.decide(id,!!target.dataset.approve));return;}
  if(target.dataset.revokeFolder!==undefined){void action(()=>api.revokeFolder(projectId,target.dataset.revokeFolder!));return;}
  if(target.dataset.openFolder!==undefined){folder=target.dataset.openFolder;preview=null;tab='files';void loadFiles();return;}
  if(target.dataset.cancelJob){void action(()=>api.cancelJob(target.dataset.cancelJob!));return;}
  switch(target.dataset.action){
    case 'start-automatic': target.setAttribute('disabled','');void action(()=>api.startAutomatic(projectId)).finally(()=>target.removeAttribute('disabled'));break;
    case 'stop-automatic': target.setAttribute('disabled','');void action(()=>api.stopAutomatic(projectId)).finally(()=>target.removeAttribute('disabled'));break;
    case 'add-project': void action(async()=>{const p=await api.addProject();if(p){projectId=p.id;tab='tasks';}});break;
    case 'new-task': document.querySelector<HTMLDialogElement>('#task-dialog')!.showModal();break;
    case 'copy-prompt':void action(async()=>{await api.copyPrompt(projectId);toast('시작 문구를 복사했습니다. ChatGPT 대화에 붙여 넣으세요.');});break;
    case 'copy-connection':void action(async()=>{await api.copyConnection();toast('로컬 MCP 연결 주소를 복사했습니다.');});break;
    case 'check-tunnel':void action(async()=>{tunnel=await api.inspectTunnel();toast(tunnel.installed?'tunnel-client 설치가 확인되었습니다.':'tunnel-client를 설치한 뒤 다시 확인하세요.');});break;
    case 'copy-tunnel-id':void action(async()=>{await api.copyTunnelId();toast('터널 ID를 복사했습니다.');});break;
    case 'stop-tunnel':tunnelBusy=true;render();void action(async()=>{try{tunnel=await api.stopTunnel();}finally{tunnelBusy=false;render();}});break;
    case 'open-docs':void action(()=>api.openDocs());break;
    case 'pause':void action(()=>api.pause(!data.paused));break;
    case 'more-jobs':jobsLimit+=40;render();break;
    case 'clear-history':void action(()=>api.clearHistory(projectId));break;
    case 'remove-project':void action(()=>api.removeProject(projectId));break;
    case 'refresh-files':void loadFiles();break;
    case 'parent-folder':folder=folder.split('/').slice(0,-1).join('/');preview=null;void loadFiles();break;
  }
});
root.addEventListener('submit',event=>{
  if((event.target as HTMLElement).id==='environment-form'){event.preventDefault();const form=event.target as HTMLFormElement;const input=form.elements.namedItem('names') as HTMLInputElement;const owner=form.dataset.project!;const names=input.value.trim()?input.value.trim().split(/[\s,]+/):[];void action(async()=>{await api.setEnvironmentNames(owner,names);toast('환경변수 허용 목록을 저장했습니다.');});return;}
  if((event.target as HTMLElement).id==='folder-form'){event.preventDefault();const input=(event.target as HTMLFormElement).elements.namedItem('folder') as HTMLInputElement;const value=input.value.trim();void action(()=>api.approveFolder(projectId,value==='/'?'':value));return;}
  if((event.target as HTMLElement).id!=='tunnel-form')return;event.preventDefault();
  if(tunnelBusy)return;
  const id=root.querySelector<HTMLInputElement>('#tunnel-id')!.value;
  const input=root.querySelector<HTMLInputElement>('#tunnel-key')!;const key=input.value;input.value='';
  tunnelBusy=true;render();
  void action(async()=>{try{tunnel=await api.startTunnel(id,key);}finally{tunnelBusy=false;render();}});
});
root.addEventListener('change',event=>{const t=event.target as HTMLInputElement;if(t.id==='approval-mode')void action(()=>api.setApprovalMode(projectId,t.value as ApprovalMode));else if(t.id==='writable')void action(()=>api.setWritable(projectId,t.checked));else if(t.dataset.task)void action(()=>api.setTask(t.dataset.task!,t.value as Task['status']));});
root.addEventListener('toggle',event=>{const d=event.target as HTMLDetailsElement;if(d.dataset.detail){if(d.open)openDetails.add(d.dataset.detail);else openDetails.delete(d.dataset.detail);}},true);
const taskDialog=document.querySelector<HTMLDialogElement>('#task-dialog')!;
document.querySelector('#dialog-cancel')!.addEventListener('click',()=>taskDialog.close());
document.querySelector<HTMLFormElement>('#task-form')!.addEventListener('submit',event=>{event.preventDefault();const form=event.currentTarget as HTMLFormElement;const fields=new FormData(form);void action(async()=>{await api.addTask(projectId,String(fields.get('title')),String(fields.get('objective')));form.reset();taskDialog.close();});});
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
api.onChange(()=>{if(!refreshTimer&&!document.hidden)refreshTimer=setTimeout(()=>{refreshTimer=undefined;void refresh(tab==='connect').catch(e=>toast(e.message));},100);});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refresh(tab==='connect').catch(e=>toast(e.message));});
void refresh(true).catch(err=>{root.textContent='Workroom을 시작하지 못했습니다: '+err.message;});
