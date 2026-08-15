import fsp from 'node:fs/promises';
import path from 'node:path';

// Groups are a plain map of group name -> list of project paths, kept in a
// user-owned JSON file (not .cache/ — that directory is disposable).

export function isValidGroups(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  return Object.entries(obj).every(([name, members]) =>
    typeof name === 'string' && name.trim() &&
    Array.isArray(members) && members.every(m => typeof m === 'string'));
}

export async function loadGroups(filePath) {
  try {
    const parsed = JSON.parse(await fsp.readFile(filePath, 'utf8'));
    return isValidGroups(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function saveGroups(filePath, groups) {
  if (!isValidGroups(groups)) throw new Error('invalid groups shape');
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp`);
  await fsp.writeFile(tmp, JSON.stringify(groups, null, 2) + '\n');
  await fsp.rename(tmp, filePath); // atomic on the same filesystem
}
