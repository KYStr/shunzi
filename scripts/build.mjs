import { build } from 'esbuild';
import { mkdir, cp, writeFile, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createZip } from './zip.mjs';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
await mkdir('dist/core', {recursive:true});
await build({entryPoints:['src/core/index.ts'],bundle:true,platform:'neutral',format:'esm',target:'es2022',outfile:'dist/core/index.js'});
execFileSync(process.execPath,['node_modules/typescript/bin/tsc','-p','tsconfig.core.json'],{stdio:'inherit'});
if (process.argv.includes('--core-only')) process.exit(0);
const hostedOrigin = process.env.SHUNZI_HOSTED_ORIGIN || 'https://proof.040141.xyz';
if (!/^https:\/\/[^/]+$/.test(hostedOrigin)) throw new Error('Hosted origin must be a bare HTTPS origin');
for (const mode of ['byok','hosted']) {
  const dir=`dist/${mode}`;
  await mkdir(dir,{recursive:true});
  for(const entry of ['background','content','options']) {
    if(!existsSync(`src/extension/${entry}.ts`)) throw new Error(`Missing extension entry: ${entry}`);
    await build({entryPoints:[`src/extension/${entry}.ts`],bundle:true,platform:'browser',format:entry==='background'?'esm':'iife',target:'chrome120',outfile:`${dir}/${entry}.js`,
      define:{__MODE__:JSON.stringify(mode),__HOSTED_ORIGIN__:JSON.stringify(hostedOrigin)},legalComments:'none'});
  }
  for(const filename of await readdir('src/extension')) {
    if(/\.(html|css|svg)$/.test(filename)) await writeFile(`${dir}/${filename}`,(await readFile(`src/extension/${filename}`,'utf8')).replaceAll('\r\n','\n'));
    else if(/\.png$/.test(filename)) await cp(`src/extension/${filename}`,`${dir}/${filename}`);
  }
  const manifest={manifest_version:3,name:`順字${mode==='byok'?' · 自備 API':' · 託管版'}`,version:pkg.version,
    description:'在 ChatGPT 草稿中，依上下文提示繁體中文錯字。',permissions:['storage'],
    host_permissions:mode==='byok'?['https://generativelanguage.googleapis.com/*']:[`${hostedOrigin}/*`],
    background:{service_worker:'background.js',type:'module'},
    action:{default_title:'順字設定'},options_ui:{page:'options.html',open_in_tab:true},
    content_scripts:[{matches:['https://chatgpt.com/*'],js:['content.js'],run_at:'document_idle'}],
    content_security_policy:{extension_pages:`script-src 'self'; object-src 'self'; connect-src ${mode==='byok'?'https://generativelanguage.googleapis.com':hostedOrigin};`}};
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
