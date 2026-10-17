import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, readdir, readFile, mkdir, writeFile, realpath, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, basename, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function safePath(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || /[\x00-\x1f\x7f]/.test(name) || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').some(x => !x || x === '.' || x === '..')) throw new Error('Unsafe path');
  return name;
}
export async function policy(root) {
  const p = JSON.parse(await readFile(join(root, 'distribution-files.json'), 'utf8'));
  for (const key of ['runtime', 'source']) {
    if (!Array.isArray(p[key]) || new Set(p[key]).size !== p[key].length) throw new Error('Invalid allowlist');
    p[key].forEach(safePath);
  }
  if (!p.runtime.includes('src/index.ts') || !p.runtime.every(x => p.source.includes(x))) throw new Error('Incomplete allowlist');
  return p;
}
export async function regularFile(root, name) {
  safePath(name);
  for (const [i, part] of name.split('/').entries()) {
    const path = join(root, ...name.split('/').slice(0, i + 1));
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || (i < name.split('/').length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) throw new Error(`Non-regular file: ${name}`);
  }
  return readFile(join(root, name));
}
export function checkSet(actual, expected) {
  if (new Set(actual).size !== actual.length || [...actual].sort().join('\n') !== [...expected].sort().join('\n')) throw new Error('Files differ from approved allowlist');
}
export function readArchive(gzip, approved) {
  const tar = gunzipSync(gzip, { maxOutputLength: 32 * 1024 * 1024 });
  const files = new Map();
  let pos = 0;
  const text = b => b.toString('utf8').replace(/\0.*$/s, '');
  const octal = b => {
    const s = text(b).trim();
    if (!/^[0-7]+$/.test(s)) throw new Error('Invalid tar number');
    return parseInt(s, 8);
  };
  while (pos + 512 <= tar.length && tar.subarray(pos, pos + 512).some(x => x !== 0)) {
    const h = tar.subarray(pos, pos + 512);
    const checksum = [...h].reduce((n, x, i) => n + (i >= 148 && i < 156 ? 32 : x), 0);
    if (checksum !== octal(h.subarray(148, 156))) throw new Error('Invalid tar checksum');
    if (text(h.subarray(257, 263)) !== 'ustar') throw new Error('Unsupported tar format');
    const prefix = text(h.subarray(345, 500));
    const name = safePath((prefix ? prefix + '/' : '') + text(h.subarray(0, 100)));
    if (!name.startsWith('package/')) throw new Error('Unexpected archive root');
    const local = safePath(name.slice(8));
    if (![0, 48].includes(h[156]) || h.subarray(157, 257).some(x => x !== 0)) throw new Error('Archive links/special entries forbidden');
    if (!approved.includes(local) || files.has(local)) throw new Error('Unapproved or duplicate archive file');
    const size = octal(h.subarray(124, 136));
    if (pos + 512 + size > tar.length) throw new Error('Truncated archive');
    files.set(local, tar.subarray(pos + 512, pos + 512 + size));
    pos += 512 + Math.ceil(size / 512) * 512;
  }
  if (tar.length - pos < 1024 || tar.subarray(pos).some(x => x !== 0)) throw new Error('Invalid tar ending');
  checkSet([...files.keys()], approved);
  return files;
}
export async function inspectArchive(root, archive) {
  const p = await policy(root);
  const bytes = await readFile(archive);
  const files = readArchive(bytes, p.runtime);
  const manifest = JSON.parse(files.get('package.json').toString());
  if (JSON.stringify(manifest.pi) !== JSON.stringify({ extensions: ['./src/index.ts'] })) throw new Error('Invalid package entry');
  const fingerprints = {};
  for (const [name, content] of files) {
    if (!content.equals(await regularFile(root, name))) throw new Error(`Archive/source mismatch: ${name}`);
    fingerprints[name] = sha256(content);
  }
  return { sha256: sha256(bytes), files: fingerprints };
}
export async function inspectSnapshot(root, sourceRoot = root) {
  const p = await policy(sourceRoot);
  const found = [];
  async function walk(dir, base = '') {
    for (const name of await readdir(dir)) {
      const local = safePath(base + name);
      const s = await lstat(join(dir, name));
      if (s.isDirectory() && !s.isSymbolicLink()) await walk(join(dir, name), local + '/');
      else { await regularFile(root, local); found.push(local); }
    }
  }
  await walk(root);
  checkSet(found, p.source);
  const files = {};
  for (const name of [...found].sort()) {
    const content = await regularFile(root, name);
    if (!content.equals(await regularFile(sourceRoot, name))) throw new Error(`Snapshot/source mismatch: ${name}`);
    files[name] = sha256(content);
  }
  return { treeSha256: sha256(JSON.stringify(files)), files };
}
export async function prepareSnapshot(root, output) {
  const p = await policy(root);
  const canonicalRoot = await realpath(root);
  const parent = await realpath(dirname(resolve(output)));
  const rel = relative(canonicalRoot, join(parent, basename(resolve(output))));
  if (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) throw new Error('Snapshot must be outside source root');
  await mkdir(output);
  for (const name of p.source) {
    const content = await regularFile(root, name);
    await mkdir(dirname(join(output, name)), { recursive: true });
    await writeFile(join(output, name), content, { flag: 'wx', mode: 0o644 });
  }
  return inspectSnapshot(output, root);
}
export async function pack(root, output) {
  const p = await policy(root);
  for (const name of p.runtime) await regularFile(root, name);
  await mkdir(output);
  const home = await mkdtemp(join(tmpdir(), 'auto-memory-pack-env-'));
  try {
    const userconfig = join(home, 'user.npmrc');
    const globalconfig = join(home, 'global.npmrc');
    await writeFile(userconfig, '');
    await writeFile(globalconfig, '');
    const env = { PATH: process.env.PATH, HOME: home, TMPDIR: home,
      npm_config_userconfig: userconfig, npm_config_globalconfig: globalconfig,
      npm_config_cache: join(home, 'cache'), npm_config_registry: 'https://registry.npmjs.org/',
      npm_config_audit: 'false', npm_config_fund: 'false' };
    const result = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', resolve(output)], { cwd: root, env, encoding: 'utf8' }));
    checkSet(result[0].files.map(x => x.path), p.runtime);
    const archive = join(output, safePath(result[0].filename));
    return { archive, ...await inspectArchive(root, archive) };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, output] = process.argv.slice(2);
  const root = process.cwd();
  if (!output || !['pack', 'snapshot', 'inspect'].includes(command)) throw new Error('Usage: node scripts/distribution.mjs pack|snapshot|inspect OUTPUT');
  const result = command === 'pack' ? await pack(root, resolve(output)) : command === 'snapshot' ? await prepareSnapshot(root, resolve(output)) : await inspectArchive(root, resolve(output));
  console.log(JSON.stringify(result, null, 2));
}
