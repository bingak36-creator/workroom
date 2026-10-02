import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { Project } from '../shared';
import { protectedPath, protectedPathPatterns, requireSafeRoot } from './secret-policy';

const literal = (value: string): string => '(literal ' + JSON.stringify(value) + ')';
const subtree = (value: string): string => '(subpath ' + JSON.stringify(value) + ')';

/** Every command, including reviewed commands, has the same non-overridable file boundary. */
export function commandSandbox(project: Project, reviewed = false, protectedTargets: string[] = []): string {
  if (process.platform !== 'darwin') throw new Error('이 OS에서는 비밀파일 차단을 위한 명령의 폴더 격리를 지원하지 않아 셸 명령을 실행할 수 없습니다.');
  requireSafeRoot(project.path);
  const folders = project.approvedFolders ?? [];
  if (!folders.length) throw new Error('명령을 실행하려면 접근 폴더를 먼저 승인하세요.');
  const ancestors = new Set<string>(['/']);
  for (const folder of folders) {
    const target = path.resolve(project.path, folder);
    requireSafeRoot(target);
    if (target !== project.path && !target.startsWith(project.path + path.sep)) throw new Error('승인 폴더가 프로젝트 밖을 가리킵니다.');
    for (let parent = target; parent !== '/'; parent = path.dirname(parent)) ancestors.add(parent);
  }
  const runtime = ['/System/Library', '/usr/bin', '/usr/lib', '/usr/share', '/bin', '/sbin', '/private/var/select'];
  const readable = [...ancestors].map(literal).concat(runtime.map(subtree), folders.map(folder => subtree(path.resolve(project.path, folder))));
  readable.push(literal('/dev/null'));
  // OS-owned public TLS/DNS data, not user credentials or user certificate files.
  const publicCA = '/private/etc/ssl/cert.pem';
  if (reviewed) readable.push(...['/private/etc/ssl/openssl.cnf', publicCA, '/private/etc/resolv.conf', '/private/etc/hosts', '/private/etc/services', '/private/etc/protocols', '/dev/urandom', '/dev/random'].map(literal));
  const writable = folders.map(folder => subtree(path.resolve(project.path, folder))).concat(literal('/dev/null'));
  const protectedFilters = protectedPathPatterns.map(pattern => '(regex #' + JSON.stringify(pattern) + ')').join(' ');
  return '(version 1)(deny default)(allow process-exec)(allow process-fork)' +
    '(allow file-read* ' + readable.join(' ') + ')' +
    '(allow file-write* ' + writable.join(' ') + ')' +
    // Explicit deny overrides a folder grant, including rename/copy/exec attempts.
    '(deny file-write* process-exec ' + protectedFilters + protectedTargets.map(subtree).join(' ') + ')' +
    '(deny file-read* (require-all (require-any ' + protectedFilters + ') (require-not ' + literal(publicCA) + ')) ' + protectedTargets.map(subtree).join(' ') + ')' +
    '(deny file-link)' + (reviewed ? '(allow network*)' : '');
}

/** Detect existing aliases without reading contents. New hard links are denied by Seatbelt. */
export async function inspectCommandTree(project: Project, authorized: () => boolean): Promise<string[]> {
  const targets = new Set<string>(); let scanned = 0;
  const visited = new Set<string>(); const pending = (project.approvedFolders ?? []).map(f => path.resolve(project.path, f));
  while (pending.length) {
    if (!authorized()) throw new Error('명령 검사 중 권한이 취소되었습니다.');
    const directory = pending.pop()!; if (visited.has(directory)) continue; visited.add(directory);
    const handle = await fs.opendir(directory);
    for await (const entry of handle) {
      if (++scanned > 200000) throw new Error('안전하게 검사할 수 있는 파일 수를 초과했습니다. 승인 폴더 범위를 줄이세요.');
      if (!authorized()) throw new Error('명령 검사 중 권한이 취소되었습니다.');
      const target = path.join(directory, entry.name); const stat = await fs.lstat(target);
      if (protectedPath(target)) {
        if (stat.isSymbolicLink()) targets.add(await fs.realpath(target));
        else if (stat.isDirectory()) pending.push(target);
        continue;
      }
      if (stat.isDirectory()) pending.push(target);
      else if (stat.isFile() && stat.nlink !== 1) throw new Error('하드링크 파일이 있는 폴더에서는 비밀파일 우회를 막기 위해 명령을 실행할 수 없습니다.');
      else if (stat.isSymbolicLink()) {
        // In-tree package links may be useful, but an alias cannot introduce an uninspected tree.
        const real = await fs.realpath(target);
        if (!(project.approvedFolders ?? []).some(f => { const root = path.resolve(project.path, f); return real === root || real.startsWith(root + path.sep); })) targets.add(real);
      } else if (!stat.isFile()) throw new Error('특수 파일이 있는 폴더에서는 명령을 실행할 수 없습니다.');
    }
  }
  return [...targets];
}
