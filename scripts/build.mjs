import { build } from 'esbuild';
import { mkdir, cp, writeFile, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createZip } from './zip.mjs';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
await mkdir('dist/core', {recursive:true});
await build({entryPoints:['src/core/index.ts'],bundle:true,platform:'neutral',format:'esm',target:'es2022',outfile:'dist/core/index.js'});
await build({entryPoints:['src/core/paragraph/index.ts'],bundle:true,platform:'neutral',format:'esm',target:'es2022',outfile:'dist/core/paragraph/index.js'});
execFileSync(process.execPath,['node_modules/typescript/bin/tsc','-p','tsconfig.core.json'],{stdio:'inherit'});
if (process.argv.includes('--core-only')) process.exit(0);
// Package only the exact locally reproduced dictionary whose upstream notices were reviewed.
const dictionaryBytes = await readFile('.local/mcbopomofo/lexicon.json');
if(createHash('sha256').update(dictionaryBytes).digest('hex') !== 'ac6756d5053980d3014eff14d33bee0cc1b627a0ee6c0500d644be25bf4ba72e')
  throw new Error('Dictionary differs from pinned extraction; run paragraph:prepare and review provenance.');
const dictionary = JSON.parse(dictionaryBytes);
const notices = JSON.parse(await readFile('third_party/mcbopomofo-web/PROVENANCE.json','utf8'));
for(const notice of notices.notices) {
  if(createHash('sha256').update(await readFile(`third_party/mcbopomofo-web/${notice.path}`)).digest('hex')!==notice.sha256)
    throw new Error('Upstream notice hash mismatch');
}
const hostedOrigin = process.env.SHUNZI_HOSTED_ORIGIN || 'https://proof.040141.xyz';
if (!/^https:\/\/[^/]+$/.test(hostedOrigin)) throw new Error('Hosted origin must be a bare HTTPS origin');
for (const mode of ['byok','hosted']) {
  const dir=`dist/${mode}`;
  await mkdir(dir,{recursive:true});
  await mkdir(`${dir}/data`,{recursive:true});
  await writeFile(`${dir}/data/lexicon.json`,JSON.stringify(dictionary.entries));
  await cp('third_party',`${dir}/third_party`,{recursive:true});
  await cp('LICENSE',`${dir}/LICENSE`);
  for(const entry of ['background','content','options']) {
    if(!existsSync(`src/extension/${entry}.ts`)) throw new Error(`Missing extension entry: ${entry}`);
    await build({entryPoints:[`src/extension/${entry}.ts`],bundle:true,platform:'browser',format:entry==='background'?'esm':'iife',target:'chrome120',outfile:`${dir}/${entry}.js`,
      define:{__MODE__:JSON.stringify(mode),__HOSTED_ORIGIN__:JSON.stringify(mode==='hosted'?hostedOrigin:'')},legalComments:'none'});
  }
  for(const filename of await readdir('src/extension')) {
    if(/\.(html|css|svg)$/.test(filename)) await writeFile(`${dir}/${filename}`,(await readFile(`src/extension/${filename}`,'utf8')).replaceAll('\r\n','\n'));
    else if(/\.png$/.test(filename)) await cp(`src/extension/${filename}`,`${dir}/${filename}`);
  }
  const manifest={manifest_version:3,name:`順字${mode==='byok'?' · 自備 API':' · 託管版'}`,version:pkg.version,
    description:'說完之後，少花時間修錯字。在 ChatGPT 草稿中提示繁體中文錯字，保留你的原話。',permissions:['storage'],
    host_permissions:mode==='byok'?['https://api.typesafe.ai/*']:[`${hostedOrigin}/*`],
    background:{service_worker:'background.js',type:'module'},
    action:{default_title:'順字設定'},options_ui:{page:'options.html',open_in_tab:true},
    content_scripts:[{matches:['https://chatgpt.com/*'],js:['content.js'],run_at:'document_idle'}],
    content_security_policy:{extension_pages:`script-src 'self'; object-src 'self'; connect-src 'self' ${mode==='byok'?'https://api.typesafe.ai':hostedOrigin};`}};
  await writeFile(`${dir}/manifest.json`,JSON.stringify(manifest,null,2));
}
await mkdir('release',{recursive:true});
for(const mode of ['byok','hosted']) {
  await writeFile(`release/shunzi-${mode}-${pkg.version}.zip`, await createZip(`dist/${mode}`));
}
const sums=[];
for(const mode of ['byok','hosted']) { const name=`shunzi-${mode}-${pkg.version}.zip`; sums.push(`${createHash('sha256').update(await readFile(`release/${name}`)).digest('hex')}  ${name}`); }
await writeFile('release/SHA256SUMS',sums.join('\n')+'\n');
console.log('Built core, BYOK and hosted extensions; ZIPs in release/.');
