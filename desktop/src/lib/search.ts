import type { SavedSession } from './tauri'

export interface SearchableCommand { name: string; section: string }
export interface ChatSearchResult {
  session: SavedSession
  title: string
  snippet: string
  match: 'recent' | 'title' | 'content'
}

function displayText(text: string) { return text.normalize('NFKC').replace(/\s+/g, ' ').trim() }
function searchText(text: string) { return displayText(text).toLowerCase() }

/** Commands tolerate abbreviated, in-order characters; chats use text matches. */
export function fuzzyMatch(value: string, query: string): boolean {
  const needle = Array.from(searchText(query))
  if (!needle.length) return true
  let index = 0
  for (const character of searchText(value)) {
    if (character === needle[index]) index++
    if (index === needle.length) return true
  }
  return false
}

export function searchCommands<T extends SearchableCommand>(commands: T[], query: string): T[] {
  return commands.filter((command) => fuzzyMatch(`${command.section} ${command.name}`, query))
}

/** Bounded context includes the match even when it occurs deep in a message. */
export function conversationSnippet(text: string, query = '', maxLength = 140): string {
  const content = displayText(text)
  const needle = searchText(query)
  const matchIndex = needle ? content.toLowerCase().indexOf(needle) : 0
  const start = Math.max(0, matchIndex - 36)
  const end = Math.min(content.length, start + Math.max(maxLength, needle.length + 36))
  return `${start > 0 ? '…' : ''}${content.slice(start, end)}${end < content.length ? '…' : ''}`
}

export function searchSessions(sessions: SavedSession[], query: string): ChatSearchResult[] {
  const needle = searchText(query)
  return [...sessions].sort((left, right) => right.savedAt - left.savedAt).flatMap((session): ChatSearchResult[] => {
    // Do not stringify structured payloads: only real conversation text is
    // searchable, so malformed content cannot produce "[object Object]" hits.
    const messages = session.messages.filter((message) => typeof message.content === 'string' && message.content.trim())
    const firstUser = messages.find((message) => message.role === 'user')
    const title = firstUser ? displayText(firstUser.content) : 'Untitled chat'
    const titleMatches = needle.length > 0 && searchText(title).includes(needle)
    const matchingMessage = needle ? messages.find((message) => searchText(message.content).includes(needle)) : undefined
    if (needle && !titleMatches && !matchingMessage) return []
    const preview = matchingMessage && (!titleMatches || title.length > 80)
      ? matchingMessage.content
      : messages.find((message) => message.role === 'assistant')?.content ?? messages.at(-1)?.content ?? ''
    return [{ session, title, snippet: conversationSnippet(preview, preview === matchingMessage?.content ? needle : ''), match: !needle ? 'recent' : titleMatches ? 'title' : 'content' }]
  })
}
