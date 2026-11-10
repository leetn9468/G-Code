import type { SavedSession } from './tauri'

export interface Project { path: string; name: string }
export const sessionKey = (session: Pick<SavedSession, 'cwd' | 'sessionId'>) => JSON.stringify([session.cwd, session.sessionId])
export const projectName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) || path

export function normalizeProjects(raw: unknown, legacyDirectory?: unknown): Project[] {
  const projects: Project[] = []
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item.path !== 'string' || !item.path.startsWith('/') || projects.some((project) => project.path === item.path)) continue
      projects.push({ path: item.path, name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : projectName(item.path) })
    }
  } else if (typeof legacyDirectory === 'string' && legacyDirectory.startsWith('/')) {
    // Only migrate the old one-project schema once. An explicit empty list
    // means the current working folder belongs to Recents.
    projects.push({ path: legacyDirectory, name: projectName(legacyDirectory) })
  }
  return projects
}

export function groupSessions(projects: Project[], sessions: SavedSession[]) {
  const registered = new Set(projects.map((project) => project.path))
  return {
    projects: projects.map((project) => ({ ...project, sessions: sessions.filter((session) => session.cwd === project.path) })),
    recents: sessions.filter((session) => !registered.has(session.cwd)),
  }
}
