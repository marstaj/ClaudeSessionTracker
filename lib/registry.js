import fsp from 'node:fs/promises';
import path from 'node:path';

export function defaultIsPidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

export async function readLiveSessions(sessionsDir, isPidAlive = defaultIsPidAlive) {
  let entries = [];
  try { entries = await fsp.readdir(sessionsDir); } catch { return []; }
  const live = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    let obj;
    try { obj = JSON.parse(await fsp.readFile(path.join(sessionsDir, entry), 'utf8')); } catch { continue; }
    if (obj?.pid && obj.sessionId && isPidAlive(obj.pid)) live.push(obj);
  }
  return live;
}

// Headless `claude -p` runs execute from the macOS per-user temp dir
// (/var/folders/.../T, sometimes via the /private prefix) and log sessions
// under that path; a stray "/" project comes from the same class of runs.
const HEADLESS_PROJECT = /^(\/private)?\/var\/folders\/.+\/T\/?$/;

export function normalizeProject(project) {
  if (!project) return project;
  if (project === '/' || HEADLESS_PROJECT.test(project)) return '<headless-temp>';
  return project;
}

export function mergeLive(sessions, live) {
  const byId = new Map(sessions.map(s => [s.sessionId, { ...s }]));
  for (const l of live) {
    const status = l.status === 'busy' ? 'busy' : 'idle';
    const s = byId.get(l.sessionId);
    if (s) {
      s.status = status;
      s.liveName = l.name ?? null;
    } else {
      byId.set(l.sessionId, {
        sessionId: l.sessionId,
        cwd: l.cwd ?? null,
        project: l.cwd ?? null,
        customTitle: null,
        firstPrompt: null,
        liveName: l.name ?? null,
        createdAt: l.startedAt ?? null,
        lastActivity: l.updatedAt ?? l.startedAt ?? null,
        status,
      });
    }
  }
  const rows = [...byId.values()];
  for (const s of rows) {
    if (!s.status) s.status = 'ended';
    s.name = s.customTitle || s.liveName || s.firstPrompt || '<no name>';
    s.project = normalizeProject(s.project);
  }
  rows.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
  return rows;
}
