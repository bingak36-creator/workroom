import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Tunnel, tunnelEnvironment, validateTunnelInput } from '../src/main/tunnel';

const fixtures: {dir:string;tunnel:Tunnel}[]=[];
const key='sk-test-only-do-not-use-123456789';
const id='tunnel_test123456789';
async function fixture(mode='ready') {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'workroom-tunnel-test-'));
  const binary=path.join(dir,'fake-tunnel');
  await fs.writeFile(binary,`#!${process.execPath}
const fs=require('node:fs');const path=require('node:path');
const args=process.argv.slice(2);const option=n=>args[args.indexOf(n)+1];
const home=${JSON.stringify(dir)};
if(args[0]==='health'){
  if(!args.includes('--require-control-plane-poll'))process.exit(9);
  process.exit(${JSON.stringify(mode)}==='ready'?0:1);
}
if(args.includes(process.env.WORKROOM_TUNNEL_API_KEY))process.exit(8);
if(option('--log.format')!=='json')process.exit(5);
if(option('--control-plane.base-url')!=='https://api.openai.com')process.exit(7);
if(!process.env.MCP_SERVER_URL||!process.env.WORKROOM_TUNNEL_API_KEY)process.exit(6);
fs.writeFileSync(path.join(home,'child-pid'),String(process.pid));
fs.writeFileSync(option('--health.url-file'),'http://127.0.0.1:32123');
if(${JSON.stringify(mode)}==='auth'){console.error('401 unauthorized '+process.env.WORKROOM_TUNNEL_API_KEY);setTimeout(()=>process.exit(1),100);}
setInterval(()=>{},1000);
`,{mode:0o700});
  const tunnel=new Tunnel(dir,[binary],25);fixtures.push({dir,tunnel});await tunnel.inspect();
  return {dir,tunnel};
}
afterEach(async()=>{for(const f of fixtures.splice(0)){await f.tunnel.stop();await fs.rm(f.dir,{recursive:true,force:true});}});

describe('tunnel input and environment',()=>{
  it('validates inputs without echoing credentials',()=>{
    expect(()=>validateTunnelInput('bad',key)).toThrow('터널 ID');
    try {validateTunnelInput(id,'secret malicious input');} catch(e){expect(String(e)).not.toContain('secret malicious');}
  });
  it('does not inherit destination or logging overrides and unrelated credentials',()=>{
    process.env.CONTROL_PLANE_BASE_URL='https://evil.example';process.env.OPENAI_API_KEY='unrelated';process.env.LOG_HTTP_RAW_UNSAFE='true';
    try {const env=tunnelEnvironment(key,'http://127.0.0.1:1/private/mcp');expect(env.CONTROL_PLANE_BASE_URL).toBeUndefined();expect(env.OPENAI_API_KEY).toBeUndefined();expect(env.LOG_HTTP_RAW_UNSAFE).toBeUndefined();expect(env.WORKROOM_TUNNEL_API_KEY).toBe(key);}finally{delete process.env.CONTROL_PLANE_BASE_URL;delete process.env.OPENAI_API_KEY;delete process.env.LOG_HTTP_RAW_UNSAFE;}
  });
  it('discovers the fixed Windows installation path',async()=>{
    if(process.platform!=='win32')return;
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'workroom-win-tunnel-'));
    try {
      await fs.mkdir(path.join(dir,'bin'));
      await fs.writeFile(path.join(dir,'bin','tunnel-client.exe'),'test fixture');
      const tunnel=new Tunnel(dir);
      expect((await tunnel.inspect()).installed).toBe(true);
    } finally { await fs.rm(dir,{recursive:true,force:true}); }
  });
});

(process.platform === 'win32' ? describe.skip : describe)('tunnel authentication and lifecycle',()=>{
  it('requires installation and restricts the MCP target to loopback',async()=>{
    const {tunnel,dir}=await fixture();
    await expect(tunnel.start(id,key,'https://example.com')).rejects.toThrow('로컬 MCP');
    const missing=new Tunnel(dir,['/nonexistent/workroom-tunnel']);await missing.inspect();expect(missing.snapshot().installed).toBe(false);
    await expect(missing.start(id,key,'http://127.0.0.1:1/mcp')).rejects.toThrow('설치');
  });
  it('waits for verified health, persists only the ID, rejects duplicate starts, and stops the child',async()=>{
    const {tunnel,dir}=await fixture();
    expect((await tunnel.start(id,key,'http://127.0.0.1:47831/private/mcp')).phase).toBe('starting');
    await expect(tunnel.start(id,key,'http://127.0.0.1:1/mcp')).rejects.toThrow('진행 중');
    await expect.poll(()=>tunnel.snapshot().phase).toBe('ready');
    expect(JSON.stringify(tunnel.snapshot())).not.toContain(key);
    expect(JSON.parse(await fs.readFile(path.join(dir,'tunnel-settings.json'),'utf8'))).toEqual({tunnelId:id});
    const pid=Number(await fs.readFile(path.join(dir,'child-pid'),'utf8'));
    await Promise.all([tunnel.stop(),tunnel.stop()]);
    expect(tunnel.snapshot().phase).toBe('stopped');expect(()=>process.kill(pid,0)).toThrow();
    const restored=new Tunnel(dir,[]);await restored.inspect();expect(restored.snapshot().tunnelId).toBe(id);expect(restored.snapshot().phase).toBe('stopped');
  });
  it('does not report connected from a running process alone',async()=>{
    const {tunnel}=await fixture('unready');await tunnel.start(id,key,'http://127.0.0.1:1/mcp');
    await new Promise(resolve=>setTimeout(resolve,200));expect(tunnel.snapshot().phase).toBe('starting');
  });
  it('turns authentication output into a helpful message without exposing the key',async()=>{
    const {tunnel}=await fixture('auth');await tunnel.start(id,key,'http://127.0.0.1:1/mcp');
    await expect.poll(()=>tunnel.snapshot().phase).toBe('error');
    expect(tunnel.snapshot().message).toContain('API 키 인증');expect(JSON.stringify(tunnel.snapshot())).not.toContain(key);
  });
  it('cancels a start before any child can be launched',async()=>{
    const {tunnel}=await fixture();const starting=tunnel.start(id,key,'http://127.0.0.1:1/mcp');
    const rejection=expect(starting).rejects.toThrow('취소');await tunnel.stop();await rejection;
    expect(tunnel.snapshot().phase).toBe('stopped');
  });
});
