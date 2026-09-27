import {_electron as electron} from 'playwright';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const temp=await fs.mkdtemp(path.join(os.tmpdir(),'workroom-tunnel-ui-'));
const dataDir=path.join(temp,'data');const fake=path.join(temp,'tunnel-client');
// Simulate the external client without sending test credentials to any service.
await fs.writeFile(fake,`#!${process.execPath}
const fs=require('node:fs');const args=process.argv.slice(2);const option=n=>args[args.indexOf(n)+1];
const state=${JSON.stringify(temp)};
if(args[0]==='health')process.exit(fs.existsSync(state+'/healthy')?0:1);
fs.writeFileSync(state+'/pid',String(process.pid));
fs.writeFileSync(option('--health.url-file'),'http://127.0.0.1:31415');
if(process.env.WORKROOM_TUNNEL_API_KEY.includes('invalid')){console.error('401 unauthorized '+process.env.WORKROOM_TUNNEL_API_KEY);setTimeout(()=>process.exit(1),100);}
else fs.writeFileSync(state+'/healthy','yes');
setInterval(()=>{},1000);
`,{mode:0o700});
const env={...process.env,WORKROOM_DATA_DIR:dataDir,WORKROOM_PORT:'0',WORKROOM_TUNNEL_CLIENT:fake};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({args:['.'],cwd:process.cwd(),env});
const errors=[];
try{
  const page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));
  await page.locator('[data-tab="connect"]').click();
  await page.getByText('✓ tunnel-client 설치 확인됨').waitFor();
  assert.equal(await page.getByLabel('런타임 API 키',{exact:true}).getAttribute('type'),'password');
  assert.equal(await page.getByRole('button',{name:'ChatGPT 플러그인 열기'}).isDisabled(),true);
  await page.getByLabel('터널 ID',{exact:true}).fill('tunnel_workroomUITest123');
  await page.getByLabel('런타임 API 키',{exact:true}).fill('sk-invalid-test-only-123456789');
  await page.getByRole('button',{name:'터널 연결',exact:true}).click();
  await page.getByText('API 키 인증에 실패했습니다.',{exact:false}).waitFor();
  assert.equal(await page.getByLabel('런타임 API 키',{exact:true}).inputValue(),'');
  assert.ok(!(await page.locator('body').innerText()).includes('sk-invalid'));
  await page.getByRole('button',{name:'터널 중지'}).click();
  await page.getByText('터널 연결 전',{exact:true}).waitFor();
  await page.getByLabel('런타임 API 키',{exact:true}).fill('sk-test-only-valid-123456789');
  // A workspace refresh must not lose a partially entered key.
  await page.getByRole('button',{name:'설치 다시 확인'}).click();
  assert.equal(await page.getByLabel('런타임 API 키',{exact:true}).inputValue(),'sk-test-only-valid-123456789');
  await page.getByRole('button',{name:'터널 연결',exact:true}).click();
  await page.getByText('터널 연결됨',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'ChatGPT 플러그인 열기'}).isEnabled(),true);
  assert.equal(await page.getByLabel('런타임 API 키',{exact:true}).inputValue(),'');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir,'tunnel-settings.json'),'utf8')),{tunnelId:'tunnel_workroomUITest123'});
  await fs.mkdir('artifacts',{recursive:true});
  await page.screenshot({path:'artifacts/tunnel-connected-test.png'});
  const pid=Number(await fs.readFile(path.join(temp,'pid'),'utf8'));
  await app.close();assert.throws(()=>process.kill(pid,0));
  assert.deepEqual(errors,[]);
  await fs.writeFile('artifacts/tunnel-smoke-result.json',JSON.stringify({passed:true,externalClient:'simulated; no real OpenAI authentication',checks:['password field','registration gated on health','401 explanation','credential clearing','draft survives refresh','connection ready','ID-only persistence','child stopped on app exit'],rendererErrors:errors},null,2));
  console.log('Tunnel UI lifecycle smoke passed (simulated external client).');
}finally{await app.close().catch(()=>{});await fs.rm(temp,{recursive:true,force:true});}
