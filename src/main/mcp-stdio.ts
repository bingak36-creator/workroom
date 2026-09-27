import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { buildMcp } from './tools';
import { readPrivateText } from './private-io';
// Tool bridge only: stdout belongs exclusively to the MCP transport.
serveStdio(() => buildMcp(async (name, args) => {
  const file = process.env.WORKROOM_CONNECTION_FILE;
  if (!file) throw new Error('WORKROOM_CONNECTION_FILE 설정이 필요합니다.');
  let url: URL;
  try {
    const { endpoint } = JSON.parse(await readPrivateText(file, 4096));
    url = new URL(endpoint);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash || !/^\/[a-f0-9]{64}\/mcp$/.test(url.pathname)) throw new Error();
  } catch { throw new Error('Workroom 앱을 열고 로컬 연결 설정을 확인하세요.'); }
  url.pathname = url.pathname.replace(/mcp$/, 'bridge');
  let response: Response;
  try {
    response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, args }), signal: AbortSignal.timeout(30000), redirect: 'error' });
  } catch { throw new Error('Workroom 앱을 열고 연결 상태를 확인하세요.'); }
  const body = await response.json() as { result?: unknown; error?: string };
  if (!response.ok) throw new Error(body.error ?? 'Workroom 요청 실패');
  return body.result;
}));
