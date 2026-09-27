import path from 'node:path';
import type { Project } from '../shared';

const literal = (value: string): string => '(literal ' + JSON.stringify(value) + ')';
const subtree = (value: string): string => '(subpath ' + JSON.stringify(value) + ')';

/** Seatbelt confines automatic shell commands to explicitly approved project folders. */
export function commandSandbox(project: Project): string {
  if (process.platform !== 'darwin') throw new Error('이 OS에서는 자동 명령의 폴더 격리를 지원하지 않습니다.');
  const folders = project.approvedFolders ?? [];
  if (!folders.length) throw new Error('자동 명령을 실행하려면 접근 폴더를 먼저 승인하세요.');
  const ancestors = new Set<string>(['/']);
  for (const folder of folders) {
    const target = path.resolve(project.path, folder);
    if (target !== project.path && !target.startsWith(project.path + path.sep)) throw new Error('승인 폴더가 프로젝트 밖을 가리킵니다.');
    for (let parent = target; parent !== '/'; parent = path.dirname(parent)) ancestors.add(parent);
  }
  const runtime = ['/System/Library', '/usr/bin', '/usr/lib', '/usr/share', '/bin', '/sbin', '/private/var/select'];
  const readable = [...ancestors].map(literal).concat(runtime.map(subtree), folders.map(folder => subtree(path.resolve(project.path, folder))));
  readable.push(literal('/dev/null'));
  const writable = folders.map(folder => subtree(path.resolve(project.path, folder))).concat(literal('/dev/null'));
  return '(version 1)(deny default)(allow process-exec)(allow process-fork)' +
    '(allow file-read* ' + readable.join(' ') + ')' +
    '(allow file-write* ' + writable.join(' ') + ')';
}
