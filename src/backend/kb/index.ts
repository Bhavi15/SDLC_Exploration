import * as fs from 'fs/promises';

export async function listKbFiles(dir: string): Promise<{ name: string; kind: 'file' | 'dir' }[]> {
  try {
    await fs.mkdir(dir, { recursive: true });
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .map(e => ({ name: e.name + (e.isDirectory() ? '/' : ''), kind: (e.isDirectory() ? 'dir' : 'file') as 'file' | 'dir' }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}
