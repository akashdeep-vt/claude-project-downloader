import JSZip from 'jszip'

type ExportFormat = 'md' | 'zip'

interface ExportRequest {
  type: 'EXPORT'
  format: ExportFormat
}

interface ExportResponse {
  ok: boolean
  filename?: string
  error?: string
}

interface Message {
  role: 'human' | 'assistant'
  content: string
}

// ── DOM Scraping ──────────────────────────────────────────────────────────────

function scrapeConversation(): Message[] {
  // Claude.ai renders turns inside elements with these test ids.
  // Query in DOM order so the interleaving is preserved.
  const turns = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[data-testid="human-turn"], [data-testid="ai-response"]'
    )
  )

  if (turns.length > 0) {
    return turns.map((el) => ({
      role: el.dataset.testid === 'human-turn' ? 'human' : 'assistant',
      content: nodeToMarkdown(el).trim(),
    }))
  }

  // Fallback: role attribute used by some Claude.ai versions
  const roleTurns = Array.from(
    document.querySelectorAll<HTMLElement>('[data-message-author-role]')
  )
  if (roleTurns.length > 0) {
    return roleTurns.map((el) => ({
      role: el.dataset.messageAuthorRole === 'human' ? 'human' : 'assistant',
      content: nodeToMarkdown(el).trim(),
    }))
  }

  return []
}

// ── Node → Markdown ───────────────────────────────────────────────────────────

function nodeToMarkdown(
  node: Node,
  ctx: { listDepth: number; ordered: boolean; index: number } = {
    listDepth: 0,
    ordered: false,
    index: 1,
  }
): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ?? ''
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return ''

  const el = node as HTMLElement
  const tag = el.tagName.toLowerCase()

  const childText = (overrideCtx?: typeof ctx) =>
    Array.from(el.childNodes)
      .map((c) => nodeToMarkdown(c, overrideCtx ?? ctx))
      .join('')

  switch (tag) {
    case 'br':
      return '\n'

    case 'p':
      return `\n\n${childText()}\n\n`

    case 'h1': return `\n\n# ${childText()}\n\n`
    case 'h2': return `\n\n## ${childText()}\n\n`
    case 'h3': return `\n\n### ${childText()}\n\n`
    case 'h4': return `\n\n#### ${childText()}\n\n`
    case 'h5': return `\n\n##### ${childText()}\n\n`
    case 'h6': return `\n\n###### ${childText()}\n\n`

    case 'strong':
    case 'b':
      return `**${childText()}**`

    case 'em':
    case 'i':
      return `*${childText()}*`

    case 's':
    case 'del':
      return `~~${childText()}~~`

    case 'a': {
      const href = el.getAttribute('href') ?? '#'
      return `[${childText()}](${href})`
    }

    case 'code': {
      if (el.closest('pre')) return el.textContent ?? ''
      return `\`${el.textContent}\``
    }

    case 'pre': {
      const codeEl = el.querySelector('code')
      const lang =
        Array.from(codeEl?.classList ?? [])
          .find((c) => c.startsWith('language-'))
          ?.replace('language-', '') ?? ''
      const code = (codeEl ?? el).textContent ?? ''
      return `\n\n\`\`\`${lang}\n${code.replace(/\n$/, '')}\n\`\`\`\n\n`
    }

    case 'blockquote': {
      const inner = childText().trim()
      const quoted = inner
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n')
      return `\n\n${quoted}\n\n`
    }

    case 'ul':
    case 'ol': {
      const ordered = tag === 'ol'
      let i = 1
      const items = Array.from(el.children)
        .map((li) => nodeToMarkdown(li, { listDepth: ctx.listDepth + 1, ordered, index: i++ }))
        .join('\n')
      return `\n\n${items}\n\n`
    }

    case 'li': {
      const indent = '  '.repeat(Math.max(0, ctx.listDepth - 1))
      const bullet = ctx.ordered ? `${ctx.index}.` : '-'
      const inner = childText({ ...ctx }).trim()
      return `${indent}${bullet} ${inner}`
    }

    case 'hr':
      return '\n\n---\n\n'

    case 'table':
      return `\n\n${tableToMarkdown(el)}\n\n`

    // Suppress UI chrome
    case 'button':
    case 'svg':
    case 'script':
    case 'style':
      return ''

    default:
      return childText()
  }
}

function tableToMarkdown(table: HTMLElement): string {
  const rows = Array.from(table.querySelectorAll('tr'))
  if (rows.length === 0) return ''

  const cellText = (el: Element) =>
    (el as HTMLElement).innerText.replace(/\n/g, ' ').trim()

  const toRow = (row: Element) =>
    '| ' + Array.from(row.querySelectorAll('th, td')).map(cellText).join(' | ') + ' |'

  const colCount = rows[0].querySelectorAll('th, td').length
  const separator = '| ' + Array(colCount).fill('---').join(' | ') + ' |'

  return [toRow(rows[0]), separator, ...rows.slice(1).map(toRow)].join('\n')
}

// ── Markdown Assembly ─────────────────────────────────────────────────────────

function buildMarkdown(messages: Message[]): string {
  const title = document.title.replace(/\s*[-–|]?\s*Claude\s*$/i, '').trim() || 'Conversation'
  const date = new Date().toISOString().slice(0, 10)

  const header = `# ${title}\n\n_Exported from Claude · ${date}_\n\n---\n\n`

  const body = messages
    .map(({ role, content }) => {
      const label = role === 'human' ? '**Human**' : '**Claude**'
      return `${label}\n\n${content}`
    })
    .join('\n\n---\n\n')

  return (header + body).replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

function buildBaseName(): string {
  const slug = (document.title.replace(/\s*[-–|]?\s*Claude\s*$/i, '').trim() || 'conversation')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  const date = new Date().toISOString().slice(0, 10)
  return `${date}-${slug}`
}

// ── Download Helpers ──────────────────────────────────────────────────────────

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

async function exportMd(messages: Message[]): Promise<string> {
  const baseName = buildBaseName()
  const filename = `${baseName}.md`
  triggerDownload(new Blob([buildMarkdown(messages)], { type: 'text/markdown' }), filename)
  return filename
}

async function exportZip(messages: Message[]): Promise<string> {
  const baseName = buildBaseName()
  const zip = new JSZip()
  zip.file(`${baseName}.md`, buildMarkdown(messages))
  const blob = await zip.generateAsync({ type: 'blob' })
  const filename = `${baseName}.zip`
  triggerDownload(blob, filename)
  return filename
}

// ── Message Listener ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (message: ExportRequest, _sender, sendResponse: (r: ExportResponse) => void) => {
    if (message.type !== 'EXPORT') return false

    ;(async () => {
      try {
        const messages = scrapeConversation()
        if (messages.length === 0) {
          sendResponse({ ok: false, error: 'No conversation found on this page.' })
          return
        }
        const filename =
          message.format === 'zip' ? await exportZip(messages) : await exportMd(messages)
        sendResponse({ ok: true, filename })
      } catch (err) {
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : 'Export failed.',
        })
      }
    })()

    // Return true to keep the message channel open for the async response
    return true
  }
)
