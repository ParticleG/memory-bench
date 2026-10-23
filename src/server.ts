import { readdir } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { exportCsv } from './metrics';
import type { Report } from './types';

const runsRoot = resolve('runs');
const distRoot = resolve('dist');
const port = Number(process.env.PORT ?? 9321);
async function runs() {
  const entries = await readdir(runsRoot, { withFileTypes: true }).catch(() => []);
  const rows = await Promise.all(entries.filter(entry => entry.isDirectory()).map(async entry => {
    const file = Bun.file(resolve(runsRoot, entry.name, 'report.json'));
    if (!await file.exists()) return null;
    try { const report = await file.json() as Report; return { runId: report.runId, status: report.status, createdAt: report.createdAt }; } catch { return null; }
  }));
  return rows.filter(row => row !== null).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
Bun.serve({ hostname: '127.0.0.1', port, async fetch(request) {
  const url = new URL(request.url);
  try {
    if (url.pathname === '/api/runs') return Response.json({ runs: await runs() });
    if (url.pathname === '/api/study' || url.pathname === '/api/profiles') {
      const id = url.searchParams.get(url.pathname === '/api/study' ? 'study' : 'run');
      if (!id || !/^[A-Za-z0-9._-]+$/.test(id)) return Response.json({ error: 'Invalid artifact id' }, { status: 400 });
      const name = url.pathname === '/api/study' ? 'study.json' : 'profiles.jsonl';
      const file = Bun.file(resolve(runsRoot, id, name));
      if (!await file.exists()) return Response.json({ error: 'Artifact not found' }, { status: 404 });
      return new Response(file, { headers: { 'Content-Type': name.endsWith('.jsonl') ? 'application/x-ndjson' : 'application/json', 'Cache-Control': 'no-store' } });
    }
    if (url.pathname === '/api/report' || url.pathname === '/api/export') {
      const runId = url.searchParams.get('run') ?? (await runs())[0]?.runId;
      if (!runId || !/^[A-Za-z0-9._-]+$/.test(runId)) return Response.json({ error: 'No valid run is available yet' }, { status: 404 });
      const file = Bun.file(resolve(runsRoot, runId, 'report.json'));
      if (!await file.exists()) return Response.json({ error: 'Run not found' }, { status: 404 });
      if (url.pathname === '/api/report') return new Response(file, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
      const format = url.searchParams.get('format') ?? 'json';
      if (format !== 'json' && format !== 'csv') return Response.json({ error: 'Unknown export format' }, { status: 400 });
      const report = await file.json() as Report;
      return new Response(format === 'csv' ? exportCsv(report.results) : JSON.stringify(report, null, 2), { headers: { 'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json', 'Content-Disposition': `attachment; filename="${runId}.${format}"` } });
    }
    if (url.pathname.startsWith('/api/')) return Response.json({ error: 'Not found' }, { status: 404 });
    const target = resolve(distRoot, `.${decodeURIComponent(url.pathname)}`);
    if (target !== distRoot && !target.startsWith(distRoot + sep)) return new Response('Forbidden', { status: 403 });
    const file = Bun.file(target);
    if (await file.exists() && (await file.stat()).isFile()) return new Response(file);
    const index = Bun.file(resolve(distRoot, 'index.html'));
    return await index.exists() ? new Response(index) : new Response('Build the dashboard with bun run build.', { status: 503 });
  } catch (error) { return Response.json({ error: String(error) }, { status: 500 }); }
} });
console.log(`Memory benchmark dashboard ready at http://127.0.0.1:${port}`);
