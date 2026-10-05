import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Sorted entries, fixed DOS epoch, UTF-8 paths, no platform metadata: identical inputs give identical ZIPs.
export async function createZip(directory) {
  const entries = [];
  async function visit(path, prefix = '') {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a,b) => a.name < b.name ? -1 : 1)) {
      const name = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error('Release must not include symlinks');
      if (entry.isDirectory()) await visit(join(path, entry.name), `${name}/`);
      else if (entry.isFile()) entries.push({ name, bytes: await readFile(join(path, entry.name)) });
    }
  }
  await visit(directory);
  const local = [], central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), data = deflateRawSync(entry.bytes, { level: 9 }), crc = crc32(entry.bytes);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50); h.writeUInt16LE(20,4); h.writeUInt16LE(0x800,6); h.writeUInt16LE(8,8);
    h.writeUInt16LE(33,12); h.writeUInt32LE(crc,14); h.writeUInt32LE(data.length,18); h.writeUInt32LE(entry.bytes.length,22); h.writeUInt16LE(name.length,26);
    local.push(h,name,data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20,4); c.writeUInt16LE(20,6); c.writeUInt16LE(0x800,8); c.writeUInt16LE(8,10);
    c.writeUInt16LE(33,14); c.writeUInt32LE(crc,16); c.writeUInt32LE(data.length,20); c.writeUInt32LE(entry.bytes.length,24);
    c.writeUInt16LE(name.length,28); c.writeUInt32LE(offset,42); central.push(c,name);
    offset += h.length + name.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length,8); end.writeUInt16LE(entries.length,10);
  end.writeUInt32LE(cd.length,12); end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,cd,end]);
}

export function readZipEntries(archive) {
  const result = [];
  let offset = 0;
  while (archive.readUInt32LE(offset) === 0x04034b50) {
    const method = archive.readUInt16LE(offset+8), size = archive.readUInt32LE(offset+18);
    const nameSize = archive.readUInt16LE(offset+26), extraSize = archive.readUInt16LE(offset+28);
    const name = archive.subarray(offset+30,offset+30+nameSize).toString('utf8');
    const start = offset+30+nameSize+extraSize;
    if (method !== 8 || name.includes('..') || name.startsWith('/') || name.includes('\\')) throw new Error('Unsafe ZIP entry');
    const bytes = inflateRawSync(archive.subarray(start,start+size), { maxOutputLength: 5_000_000 });
    if (bytes.length !== archive.readUInt32LE(offset+22) || crc32(bytes) !== archive.readUInt32LE(offset+14)) throw new Error('Corrupt ZIP');
    result.push({name,bytes}); offset = start+size;
  }
  if (archive.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid ZIP directory');
  return result;
}
