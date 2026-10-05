import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readZipEntries } from './zip.mjs';

const findings = [];
const patterns = [
  /AIza[0-9A-Za-z_-]{35}/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /(?:ghp|gho|github_pat)_[A-Za-z0-9_]{30,}/g,
  /\bsz_[A-Za-z0-9_-]{43}\b/g,
  /\bsk-[A-Za-z0-9_-]{32,}\b/g,
];
// Actual in-process credentials are checked by equality too; findings never print the matched secret.
const secrets = Object.entries(process.env).filter(([k,v]) => /(?:KEY|TOKEN|SECRET)$/.test(k) && v && v.length >= 20).map(([,v])=>v);
let files = 0;
function scan(name, bytes) {
  files++;
  if (/(?:^|\/)(?:\.env(?:\..+)?|\.local|.*\.(?:pem|key|sqlite|db|log))$/.test(name)) findings.push(`${name}: forbidden release file`);
  const text = bytes.toString('utf8');
  if (patterns.some(p => {p.lastIndex=0; return p.test(text);}) || secrets.some(s=>text.includes(s))) findings.push(`${name}: possible credential (redacted)`);
}
async function visit(directory) {
  for (const entry of await readdir(directory,{withFileTypes:true})) {
    if (['node_modules','.git','.local','release','dist'].includes(entry.name)) continue;
    const path=join(directory,entry.name);
    if(entry.isSymbolicLink()) throw new Error(`Unexpected source symlink: ${path}`);
    if(entry.isDirectory()) await visit(path); else scan(path.replaceAll('\\','/'),await readFile(path));
  }
}
await visit('.');
const pkg=JSON.parse(await readFile('package.json','utf8'));
const sums=(await readFile('release/SHA256SUMS','utf8')).trim().split('\n');
for(const mode of ['byok','hosted']) {
  const name=`shunzi-${mode}-${pkg.version}.zip`, zip=await readFile(`release/${name}`);
  const hash=createHash('sha256').update(zip).digest('hex');
  if(!sums.includes(`${hash}  ${name}`)) findings.push(`${name}: checksum mismatch`);
  const entries=readZipEntries(zip);
  const allowed=['background.js','content.js','options.js','options.html','style.css','manifest.json'];
  for(const entry of entries) {
    if(!allowed.includes(entry.name)) findings.push(`${name}/${entry.name}: unexpected packaged file`);
    scan(`${name}/${entry.name}`,entry.bytes);
  }
  if(allowed.some(x=>!entries.some(e=>e.name===x))) findings.push(`${name}: missing runtime file`);
  const manifest=JSON.parse(entries.find(e=>e.name==='manifest.json').bytes);
  const hosts=manifest.host_permissions;
  if(mode==='byok' && JSON.stringify(hosts)!==JSON.stringify(['https://generativelanguage.googleapis.com/*'])) findings.push(`${name}: unexpected BYOK hosts`);
  if(manifest.externally_connectable || manifest.web_accessible_resources) findings.push(`${name}: exposes extension surface to pages`);
}
if(findings.length) { console.error(findings.join('\n')); process.exitCode=1; }
else console.log(`PASS: scanned ${files} source/package files and both ZIP contents; checksums and permission boundaries match.`);
