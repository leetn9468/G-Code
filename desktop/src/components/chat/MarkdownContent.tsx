// Assistant markdown. The text is split into top-level blocks, each rendered by
// a memoised ReactMarkdown keyed by index, so while a reply streams only the
// last block re-parses. The in-flight block goes through remend() so a
// half-written **bold**, `code` or [link]( never flashes raw markers.

import { memo, useMemo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remend from 'remend'
import type { Element, ElementContent, Root, RootContent } from 'hast'
import { splitMarkdownBlocks } from '@/lib/markdownBlocks'
import { CodeBlock } from './CodeBlock'

interface Props {
  content: string
  /** The message is still streaming: heal the tail block and defer code highlighting. */
  streaming?: boolean
  /** Show the streaming caret at the end of the last line of text. */
  caret?: boolean
}

const REMARK_PLUGINS = [remarkGfm]
const REMEND_OPTIONS = { katex: false, inlineKatex: false }
const INCOMPLETE_LINK = 'streamdown:'

function textOf(node: ElementContent | RootContent): string {
  if (node.type === 'text') return node.value
  if (node.type === 'element') return node.children.map(textOf).join('')
  return ''
}

function makeComponents(streaming: boolean): Components {
  return {
    // react-markdown blanks unsafe protocols to ''; remend marks unfinished links
    // as streamdown:incomplete-link. Neither should be clickable.
    a: ({ node: _node, href, children, ...props }) => (!href || href.startsWith(INCOMPLETE_LINK)
      ? <span className="gc-md-link-pending">{children}</span>
      : <a {...props} href={href} target="_blank" rel="noreferrer">{children}</a>),
    // Block code (fenced or indented) always arrives as <pre><code>.
    pre: ({ node, children }) => {
      const code = node?.children.find((child): child is Element => child.type === 'element' && child.tagName === 'code')
      if (!code) return <pre>{children}</pre>
      const classes = code.properties.className
      const className = Array.isArray(classes) ? classes.join(' ') : String(classes ?? '')
      const language = /language-([\w+#.-]+)/.exec(className)?.[1] ?? 'text'
      return <CodeBlock language={language} code={textOf(code)} streaming={streaming} />
    },
    code: ({ node: _node, className, children, ...props }) => <code className={className} {...props}>{children}</code>,
    table: ({ node: _node, children, ...props }) => <div className="gc-md-table"><table {...props}>{children}</table></div>,
  }
}

const COMPONENTS = makeComponents(false)
const STREAMING_COMPONENTS = makeComponents(true)

// Elements the caret must not be placed inside; it goes after them instead.
const NO_CARET = new Set(['a', 'pre', 'code', 'table', 'hr', 'img', 'br', 'input', 'svg'])

/** rehype plugin: append the streaming caret to the deepest last text container. */
function rehypeStreamCaret() {
  return (tree: Root) => {
    let parent: Root | Element = tree
    for (;;) {
      const children: Array<RootContent | ElementContent> = parent.children
      let index = children.length - 1
      while (index >= 0) {
        const child = children[index]
        if (child.type === 'text' && !child.value.trim()) index--
        else break
      }
      const last = children[index]
      if (last && last.type === 'element' && !NO_CARET.has(last.tagName)) { parent = last; continue }
      break
    }
    const caret: Element = { type: 'element', tagName: 'span', properties: { className: ['gc-stream-caret'], ariaLabel: 'Streaming' }, children: [] }
    ;(parent.children as ElementContent[]).push(caret)
  }
}
const CARET_PLUGINS = [rehypeStreamCaret]

/**
 * A block longer than this shows as plain text. Parsing grows faster than its length: a single
 * 300 KB paragraph held the webview for seconds and 1.2 MB for over a minute, Stop included.
 */
export const MARKDOWN_BLOCK_CHARS = 64 * 1024

const MarkdownBlock = memo(function MarkdownBlock({ text, streaming, caret }: { text: string; streaming: boolean; caret: boolean }) {
  if (text.length > MARKDOWN_BLOCK_CHARS) return <p className="gc-md-plain">{text}{caret && <span className="gc-stream-caret" aria-label="Streaming" />}</p>
  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={caret ? CARET_PLUGINS : undefined} components={streaming ? STREAMING_COMPONENTS : COMPONENTS}>
      {text}
    </ReactMarkdown>
  )
})

export function MarkdownContent({ content, streaming = false, caret = false }: Props) {
  const blocks = useMemo(() => splitMarkdownBlocks(content), [content])
  const last = blocks.length - 1
  return (
    <div className="gc-markdown">
      {blocks.map((block, index) => {
        const tail = index === last
        return <MarkdownBlock key={index} text={tail && streaming && block.length <= MARKDOWN_BLOCK_CHARS ? remend(block, REMEND_OPTIONS) : block} streaming={tail && streaming} caret={tail && caret} />
      })}
      {caret && blocks.length === 0 && <span className="gc-stream-caret" aria-label="Streaming" />}
    </div>
  )
}
