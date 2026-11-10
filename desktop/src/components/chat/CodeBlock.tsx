// Code block for chat markdown: gcodeNight Prism theme, hairline-ring frame,
// header with language + copy, CSS-counter line numbers, diff line tints,
// right-edge fade when it scrolls sideways, and a collapse for long blocks.
// Memoised on code + language so completed blocks never re-tokenize while a
// later part of the message streams.

import { memo, useDeferredValue, useEffect, useId, useRef, useState } from 'react'
import { Highlight, type Token } from 'prism-react-renderer'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Check, ChevronDown, Copy } from 'lucide-react'
import { copyToClipboard } from '@/lib/tauri'
import { easeOut, springCollapse, swap } from '@/lib/motion'
import { languageLabel, prismLanguage } from '@/lib/prismLanguages'
import { DECORATOR_STYLE, gcodeNight } from '@/lib/prismTheme'
import { Tooltip } from '../shell/Tooltip'

const NUMBERED_MIN_LINES = 8
const COLLAPSE_AFTER_LINES = 24
const COLLAPSED_HEIGHT = 420
const COPIED_MS = 1600

interface Props {
  code: string
  language: string
  /** The parent message is still streaming: highlight a deferred copy and follow the tail. */
  streaming?: boolean
}

type DiffKind = 'add' | 'del' | 'hunk' | 'meta'

function diffKind(line: Token[]): DiffKind | undefined {
  const text = line.map((token) => token.content).join('')
  if (text.startsWith('+++') || text.startsWith('---')) return 'meta'
  if (text.startsWith('@@')) return 'hunk'
  if (text.startsWith('+')) return 'add'
  if (text.startsWith('-')) return 'del'
  return undefined
}

function countLines(text: string) {
  let lines = 1
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) lines++
  return lines
}

function CodeBlockView({ code, language, streaming = false }: Props) {
  // While tokens stream in, highlighting lags a frame behind instead of
  // blocking input and scrolling (React 18 concurrent rendering).
  const deferred = useDeferredValue(code)
  const source = (streaming ? deferred : code).replace(/\n$/, '')
  const grammar = prismLanguage(language)
  const diff = grammar === 'diff'
  const lineCount = countLines(source)
  const numbered = diff || lineCount >= NUMBERED_MIN_LINES
  const collapsible = lineCount > COLLAPSE_AFTER_LINES

  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const [overflowing, setOverflowing] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const timer = useRef<number>()
  const viewportId = useId()
  const reduce = useReducedMotion()
  const collapsed = collapsible && !expanded

  useEffect(() => () => window.clearTimeout(timer.current), [])

  // Right-edge fade only while there is more code to the right.
  useEffect(() => {
    const element = scrollRef.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const update = () => setOverflowing(element.scrollWidth - element.clientWidth - element.scrollLeft > 1)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    // <code> is width: max-content, so it (unlike <pre>) grows as a line streams wider.
    const content = element.querySelector('code')
    if (content) observer.observe(content)
    element.addEventListener('scroll', update, { passive: true })
    return () => {
      observer.disconnect()
      element.removeEventListener('scroll', update)
    }
  }, [])

  const copy = async () => {
    try {
      await copyToClipboard(code)
    } catch {
      return
    }
    setCopied(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), COPIED_MS)
  }

  return (
    <figure className="gc-code" data-numbered={numbered ? '' : undefined} data-diff={diff ? '' : undefined}>
      <figcaption className="gc-code-header">
        <span className="gc-code-lang" translate="no">{languageLabel(language)}</span>
        <span className="gc-code-actions">
          <AnimatePresence initial={false}>
            {copied && (
              <motion.span
                key="copied"
                className="gc-code-copied"
                aria-hidden="true"
                initial={{ opacity: 0, transform: reduce ? 'translateX(0px)' : 'translateX(4px)' }}
                animate={{ opacity: 1, transform: 'translateX(0px)', transition: { duration: 0.16, ease: easeOut } }}
                exit={{ opacity: 0, transition: { duration: 0.12, ease: easeOut } }}
              >
                Copied
              </motion.span>
            )}
          </AnimatePresence>
          <Tooltip content="Copy code">
            <button type="button" className="gc-code-copy" onClick={() => void copy()} aria-label="Copy code" data-copied={copied ? '' : undefined}>
              <AnimatePresence initial={false}>
                <motion.span key={copied ? 'check' : 'copy'} className="gc-icon-swap" variants={swap} initial="initial" animate="animate" exit="exit">
                  {copied ? <Check size={14} strokeWidth={2} /> : <Copy size={14} strokeWidth={1.75} />}
                </motion.span>
              </AnimatePresence>
            </button>
          </Tooltip>
          <span className="sr-only" aria-live="polite">{copied ? 'Copied to clipboard' : ''}</span>
        </span>
      </figcaption>

      <motion.div
        id={viewportId}
        className="gc-code-viewport"
        data-collapsed={collapsed ? '' : undefined}
        data-tail={collapsed && streaming ? '' : undefined}
        initial={false}
        animate={{ height: collapsed ? COLLAPSED_HEIGHT : 'auto' }}
        transition={springCollapse}
      >
        <div ref={scrollRef} className="gc-code-scroll" data-overflow={overflowing ? '' : undefined}>
          <Highlight theme={gcodeNight} code={source} language={grammar}>
            {({ className, tokens, getLineProps, getTokenProps }) => (
              <pre className={`gc-code-pre ${className}`}>
                <code>
                  {tokens.map((line, lineIndex) => (
                    <span key={lineIndex} {...getLineProps({ line, className: 'gc-code-line' })} data-diff={diff ? diffKind(line) : undefined}>
                      {line.map((token, tokenIndex) => (
                        <span key={tokenIndex} {...getTokenProps({ token, style: token.types.includes('decorator') ? DECORATOR_STYLE : undefined })} />
                      ))}
                    </span>
                  ))}
                </code>
              </pre>
            )}
          </Highlight>
        </div>
        {collapsed && <div className="gc-code-fade" data-edge={streaming ? 'top' : 'bottom'} aria-hidden="true" />}
      </motion.div>

      {collapsible && (
        <div className="gc-code-footer">
          <button type="button" className="gc-code-expand" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} aria-controls={viewportId}>
            <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />
            <span className="gc-code-expand-label">{expanded ? 'Show less' : `Show all ${lineCount} lines`}</span>
          </button>
        </div>
      )}
    </figure>
  )
}

export const CodeBlock = memo(CodeBlockView, (previous, next) =>
  previous.code === next.code && previous.language === next.language && previous.streaming === next.streaming)
