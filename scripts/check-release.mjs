import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=p=>fs.readFile(path.join(root,p),'utf8');
const pkg=JSON.parse(await read('package.json'));
const lock=JSON.parse(await read('package-lock.json'));
assert.equal(pkg.version,lock.version,'Package/lock version mismatch');
assert.equal(pkg.version,lock.packages[''].version,'Lock root mismatch');
assert.ok((await read('src/shared.ts')).includes(`APP_VERSION = '${pkg.version}'`),'UI/server version mismatch');
for(const group of ['dependencies','devDependencies'])assert.deepEqual(pkg[group],lock.packages[''][group],'Lock dependency mismatch');
for(const p of ['src/main/tokens.ts','test/tokens.test.ts']){
  const exists=await fs.stat(path.join(root,p)).then(()=>true,()=>false);assert.equal(exists,false,`Removed feature remains: ${p}`);
}
const forbidden=/token_estimate|estimateTokens|TokenEstimate|tokenView/;
for(const p of ['src/main/tools.ts','src/main/index.ts','src/preload/index.ts','src/shared.ts','src/renderer/main.ts'])assert.ok(!forbidden.test(await read(p)),`Removed API remains: ${p}`);
for(const p of ['README.md','SECURITY.md','PRIVACY.md','CHANGELOG.md','docs/release.md','electron-builder.config.cjs','build/entitlements.mac.plist'])assert.ok((await read(p)).trim().length>0,`Missing release document: ${p}`);
const report={at:new Date().toISOString(),version:pkg.version,electron:pkg.devDependencies.electron,passed:true,checks:['version consistency','lock consistency','feature removal','release documents']};
await fs.mkdir(path.join(root,'artifacts/release-audit'),{recursive:true});
await fs.writeFile(path.join(root,'artifacts/release-audit/release-check.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
