import { spawn } from 'node:child_process';
import { promises as fs, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const signed=process.argv.includes('--signed');
const checkOnly=process.argv.includes('--check-credentials');
if(process.argv.slice(2).some(a=>!['--signed','--check-credentials'].includes(a)))throw new Error('Unknown release option');
if(process.platform!=='darwin'||process.arch!=='arm64')throw new Error('This release pipeline is validated for macOS Apple Silicon only.');
if(signed){
  const signing=!!(process.env.CSC_LINK||process.env.CSC_NAME);
  const notary=!!(process.env.APPLE_ID&&process.env.APPLE_APP_SPECIFIC_PASSWORD&&process.env.APPLE_TEAM_ID)
    ||!!(process.env.APPLE_API_KEY&&process.env.APPLE_API_KEY_ID&&process.env.APPLE_API_ISSUER)
    ||!!process.env.APPLE_KEYCHAIN_PROFILE;
  if(!signing||!notary)throw new Error('Public release stopped: Developer ID signing and notarization credentials must be configured. Credential values are never printed.');
}
if(checkOnly){console.log('Credential configuration check only; no signing or publishing performed.');process.exit(0);}
async function run(executable,args,extra={}){
  await new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{cwd:root,env:{...process.env,...extra},stdio:'inherit'});
    child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error(`Release step failed (exit ${code}): ${path.basename(executable)}`)));
  });
}
const node=(script,args=[],extra={})=>run(process.execPath,[path.join(root,script),...args],extra);
await node('scripts/check-release.mjs');
await node('scripts/verify.mjs');
await node('scripts/smoke.mjs');
await node('scripts/tunnel-smoke.mjs');
await node('node_modules/electron-builder/out/cli/cli.js',['--config','electron-builder.config.cjs','--mac','--arm64','--publish','never'],{WORKROOM_SIGNED_RELEASE:signed?'1':'0'});
const output=path.join(root,signed?'release-public':(process.env.WORKROOM_OUTPUT_DIR||'release-candidate'));
const app=path.join(output,'mac-arm64','Workroom.app');
if(signed){
  await run('/usr/bin/codesign',['--verify','--deep','--strict','--verbose=2',app]);
  await run('/usr/sbin/spctl',['--assess','--type','execute','--verbose=2',app]);
  await run('/usr/bin/xcrun',['stapler','validate',app]);
}else{
  await node('scripts/smoke.mjs',[],{WORKROOM_APP:path.join(app,'Contents/MacOS/Workroom')});
  await run('/usr/bin/codesign',['--verify','--deep','--strict',app]);
}
const checksums=[];
for(const file of (await fs.readdir(output)).filter(f=>/\.(?:dmg|zip)$/.test(f)).sort()){
  const hash=createHash('sha256');for await(const chunk of createReadStream(path.join(output,file)))hash.update(chunk);
  checksums.push(`${hash.digest('hex')}  ${file}`);
}
await fs.writeFile(path.join(output,'SHA256SUMS.txt'),checksums.join('\n')+'\n');
const pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
const manifest={at:new Date().toISOString(),version:pkg.version,electron:pkg.devDependencies.electron,platform:'darwin',arch:'arm64',signing:signed?'Developer ID':'ad-hoc preview',notarized:signed,published:false,checksums:checksums.map(line=>({sha256:line.slice(0,64),file:line.slice(66)}))};
await fs.writeFile(path.join(output,'release-manifest.json'),JSON.stringify(manifest,null,2));
console.log(JSON.stringify(manifest,null,2));
