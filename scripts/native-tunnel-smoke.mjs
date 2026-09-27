import {_electron as electron} from 'playwright';
import {promises as fs} from 'node:fs';
import {spawn} from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'workroom-native-tunnel-'));
const env={...process.env,WORKROOM_DATA_DIR:temp,WORKROOM_PORT:'0'};delete env.ELECTRON_RUN_AS_NODE;
const routes=new Set();
const control=http.createServer((req,res)=>{routes.add(req.method+' '+req.url);req.resume();if(req.url.includes('.well-known')){res.writeHead(404);res.end();return;}setTimeout(()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({commands:[]}));},100);});
await new Promise(resolve=>control.listen(0,'127.0.0.1',resolve));
const app=await electron.launch({args:['.'],cwd:process.cwd(),env});let child;let proxy;const mcpRequests=[];
try{
 await app.firstWindow();
 const {endpoint}=JSON.parse(await fs.readFile(path.join(temp,'connection.json'),'utf8'));
 proxy=http.createServer((req,res)=>{const request=http.request(new URL(req.url,endpoint),{method:req.method,headers:{...req.headers,host:new URL(endpoint).host}},response=>{mcpRequests.push(req.method+' '+req.url.replace(/\/[a-f0-9]{64}/g,'/[key]')+' '+response.statusCode);res.writeHead(response.statusCode,response.headers);response.pipe(res);});req.pipe(request);});
 await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
 const target=new URL(endpoint);target.port=String(proxy.address().port);
 child=spawn('/opt/homebrew/bin/tunnel-client',['run','--control-plane.base-url',`http://127.0.0.1:${control.address().port}`,'--control-plane.tunnel-id','tunnel_0123456789abcdef0123456789abcdef','--control-plane.api-key','env:WORKROOM_TUNNEL_API_KEY','--health.listen-addr','127.0.0.1:0','--health.url-file',path.join(temp,'health.url'),'--log.format','json','--log.level','warn'],{env:{HOME:temp,PATH:process.env.PATH,WORKROOM_TUNNEL_API_KEY:'sk-local-test-no-real-credential',MCP_SERVER_URL:target.href},stdio:['ignore','pipe','pipe']});
 let logs='';child.stdout.on('data',d=>logs=(logs+d.toString()).slice(-6000));child.stderr.on('data',d=>logs=(logs+d.toString()).slice(-6000));
 let result;
 for(let i=0;i<20;i++){
  await new Promise(resolve=>setTimeout(resolve,500));
  if(child.exitCode!==null)break;
  try{const base=(await fs.readFile(path.join(temp,'health.url'),'utf8')).trim();const r=await fetch(base+'/readyz',{signal:AbortSignal.timeout(1000)});const body=await r.text();result={status:r.status,body};if(r.ok)break;}catch{}
 }
 console.log(JSON.stringify({nativeClientReady:result?.status===200,result,routes:[...routes],mcpRequests,controlPort:control.address().port,mcpPort:new URL(endpoint).port,diagnostics:logs.replaceAll(endpoint,'[local MCP]').replaceAll('sk-local-test-no-real-credential','[test key]')},null,2));
 assert.equal(result?.status,200,'Native tunnel readiness failed');
 const health=spawn('/opt/homebrew/bin/tunnel-client',['health','--url-file',path.join(temp,'health.url'),'--require-control-plane-poll','--json'],{stdio:'ignore'});
 const healthExit=await new Promise(resolve=>health.once('exit',resolve));assert.equal(healthExit,0,'Control-plane poll health failed');
 await fs.writeFile('artifacts/native-tunnel-smoke-result.json',JSON.stringify({passed:true,client:'installed official tunnel-client',controlPlane:'local HTTP fixture; no OpenAI authentication',checks:['native process startup','MCP discovery without OAuth','native readiness','successful poll required']},null,2));
}finally{
 if(child&&child.exitCode===null&&child.signalCode===null){const closed=new Promise(resolve=>child.once('close',resolve));child.kill();await closed;}
 if(proxy){proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));}
 await app.close();control.closeAllConnections();await new Promise(resolve=>control.close(resolve));await fs.rm(temp,{recursive:true,force:true});
}
