import { createHash } from 'node:crypto';
import type { Job } from '../shared';

export interface TextEdit { oldText: string; newText: string }
export type Proposal = Pick<Job, 'projectId' | 'taskId' | 'requestId' | 'kind' | 'path' | 'content' | 'expectedHash' | 'command'> & { edits?: TextEdit[] };
export const terminal = (state: Job['state']): boolean => !['pending', 'queued', 'running'].includes(state);

/** A durable digest preserves retry identity after source text is purged. */
export function fingerprint(input: Partial<Proposal>): string {
  const fields = ['projectId', 'taskId', 'kind', 'path', 'content', 'expectedHash', 'command'] as const;
  const values: unknown[] = fields.map(key => input[key] ?? null);
  // A patch is identified by its edits (its content is derived). Appending keeps existing receipts valid.
  if (input.edits) values.push(input.edits.map(edit => [edit.oldText, edit.newText]));
  return createHash('sha256').update(JSON.stringify(values)).digest('hex');
}

/** Exact, unique and non-overlapping replacements, all resolved against one base revision. */
export function applyEdits(base: string, edits: TextEdit[]): string {
  const spans = edits.map((edit, i) => {
    const start = edit.oldText ? base.indexOf(edit.oldText) : -1;
    if (start < 0) throw new Error(`edits[${i}]의 oldText를 파일에서 찾지 못했습니다. 파일을 다시 읽고 정확한 원문을 사용하세요.`);
    if (base.includes(edit.oldText, start + 1)) throw new Error(`edits[${i}]의 oldText가 여러 번 나타납니다. 앞뒤 문맥을 더 포함하세요.`);
    return { start, end: start + edit.oldText.length, text: edit.newText };
  }).sort((a, b) => a.start - b.start);
  let result = ''; let cursor = 0;
  for (const span of spans) {
    if (span.start < cursor) throw new Error('겹치는 edits는 하나로 합치세요.');
    result += base.slice(cursor, span.start) + span.text; cursor = span.end;
  }
  return result + base.slice(cursor);
}

/** File creation/editing is not command execution. Package/config/script edits merit review. */
export function requiresFileReview(relative: string, content: string): boolean {
  const p = relative.toLowerCase();
  return !content.trim()
    || /(?:^|\/)(?:package(?:-lock)?\.json|\.gitattributes|\.gitmodules|makefile|dockerfile|compose\.ya?ml|.*\.config\.[^/]+)$/.test(p)
    || /(?:^|\/)(?:\.github|\.vscode|\.idea|scripts|build)\//.test(p)
    || /\.(?:sh|bash|zsh|fish|bat|cmd|ps1|plist|desktop)$/.test(p);
}
