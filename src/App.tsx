import { useState, useEffect } from 'react'
import JSZip from 'jszip'
import { Download, FileText, Archive, AlertCircle, CheckCircle, Loader2, FolderOpen } from 'lucide-react'
import './App.css'

type ExportFormat = 'md' | 'zip'
type PageType = 'detecting' | 'project' | 'conversation' | 'other'
type Status = 'idle' | 'exporting' | 'success' | 'error'

interface ScrapedMessage { role: 'human' | 'assistant'; content: string }
interface ScrapedPage { title: string; messages: ScrapedMessage[] }
interface ScrapedFile { name: string; base64: string; mime: string }
interface FileStatus { name: string; status: 'ok' | 'unavailable'; reason?: string }
interface ScrapedProject { projectName: string; files: ScrapedFile[]; report: FileStatus[] }

// ── Injected: scrape conversation ─────────────────────────────────────────────

function scrapeConversation(): ScrapedPage | null {
  function tableToMarkdown(table: HTMLElement): string {
    const rows = Array.from(table.querySelectorAll('tr'))
    if (!rows.length) return ''
    const cell = (el: Element) => (el as HTMLElement).innerText.replace(/\n/g, ' ').trim()
    const toRow = (row: Element) =>
      '| ' + Array.from(row.querySelectorAll('th,td')).map(cell).join(' | ') + ' |'
    const cols = rows[0].querySelectorAll('th,td').length
    const sep = '| ' + Array(cols).fill('---').join(' | ') + ' |'
    return [toRow(rows[0]), sep, ...rows.slice(1).map(toRow)].join('\n')
  }

  function nodeMd(node: Node, d = 0, ol = false, idx = { n: 1 }): string {
    if (node.nodeType === 3) return node.textContent ?? ''
    if (node.nodeType !== 1) return ''
    const el = node as HTMLElement
    const tag = el.tagName.toLowerCase()
    const ch = (od = d, ool = ol, oidx = idx) =>
      Array.from(el.childNodes).map((n) => nodeMd(n, od, ool, oidx)).join('')
    switch (tag) {
      case 'br': return '\n'
      case 'p': return `\n\n${ch()}\n\n`
      case 'h1': return `\n\n# ${ch()}\n\n`
      case 'h2': return `\n\n## ${ch()}\n\n`
      case 'h3': return `\n\n### ${ch()}\n\n`
      case 'h4': return `\n\n#### ${ch()}\n\n`
      case 'h5': return `\n\n##### ${ch()}\n\n`
      case 'h6': return `\n\n###### ${ch()}\n\n`
      case 'strong': case 'b': return `**${ch()}**`
      case 'em':    case 'i': return `*${ch()}*`
      case 's':     case 'del': return `~~${ch()}~~`
      case 'a': return `[${ch()}](${el.getAttribute('href') ?? '#'})`
      case 'code':
        return el.closest('pre') ? (el.textContent ?? '') : `\`${el.textContent}\``
      case 'pre': {
        const code = el.querySelector('code')
        const lang = Array.from(code?.classList ?? [])
          .find((c) => c.startsWith('language-'))?.slice(9) ?? ''
        return `\n\n\`\`\`${lang}\n${(code ?? el).textContent?.replace(/\n$/, '') ?? ''}\n\`\`\`\n\n`
      }
      case 'blockquote':
        return '\n\n' + ch().trim().split('\n').map((l) => `> ${l}`).join('\n') + '\n\n'
      case 'ul': case 'ol': {
        const ordered = tag === 'ol'
        const counter = { n: 1 }
        return '\n\n' +
          Array.from(el.children).map((li) => nodeMd(li, d + 1, ordered, counter)).join('\n') +
          '\n\n'
      }
      case 'li': {
        const indent = '  '.repeat(Math.max(0, d - 1))
        const bullet = ol ? `${idx.n++}.` : '-'
        return `${indent}${bullet} ${ch(d, ol, idx).trim()}`
      }
      case 'hr': return '\n\n---\n\n'
      case 'table': return `\n\n${tableToMarkdown(el)}\n\n`
      case 'button': case 'svg': case 'script': case 'style': return ''
      default: return ch()
    }
  }

  let turns = Array.from(document.querySelectorAll<HTMLElement>(
    '[data-testid="human-turn"], [data-testid="ai-response"]'
  ))
  if (!turns.length) {
    turns = Array.from(document.querySelectorAll<HTMLElement>('[data-message-author-role]'))
  }
  if (!turns.length) return null

  return {
    title: document.title,
    messages: turns.map((el) => ({
      role:
        el.dataset.testid === 'human-turn' || el.dataset.messageAuthorRole === 'human'
          ? 'human' : 'assistant',
      content: nodeMd(el).trim(),
    })),
  }
}

// ── Injected: scrape project context files and fetch their bytes ──────────────

async function scrapeProjectFiles(): Promise<ScrapedProject> {
  const projectName = document.title.replace(/\s*[-–|]?\s*Claude\s*$/i, '').trim() || 'project'

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function bail(reason: string): ScrapedProject {
    return { projectName, files: [], report: [{ name: '_diagnostic', status: 'unavailable', reason }] }
  }

  try {
  const projectId   = window.location.pathname.match(/\/project\/([^/]+)/)?.[1]

  // Always return something — worst case a ZIP with just _report.md
  function fail(reason: string): ScrapedProject {
    return { projectName, files: [], report: [{ name: '_setup', status: 'unavailable', reason }] }
  }

  if (!projectId) return fail('Could not read project ID from URL: ' + window.location.href)

  // Try multiple org sources in priority order
  const orgCandidates: string[] = []
  const syncOrg = localStorage.getItem('ccd-sync-org')
  if (syncOrg) orgCandidates.push(syncOrg)
  try {
    const ho = JSON.parse(sessionStorage.getItem('history-organizations') ?? '{}')
    if (ho.current) orgCandidates.push(ho.current)
  } catch { /* ignore */ }
  // Also try every org the account belongs to
  try {
    const r = await fetch('/api/organizations', { credentials: 'include' })
    if (r.ok) {
      const orgs = await r.json()
      if (Array.isArray(orgs)) orgs.forEach((o: { uuid?: string }) => { if (o.uuid) orgCandidates.push(o.uuid) })
    }
  } catch { /* ignore */ }

  if (!orgCandidates.length) return fail('Could not determine org ID — not logged in?')

  async function fetchBinary(url: string): Promise<string | null> {
    try {
      const r = await fetch(url, { credentials: 'include' })
      if (!r.ok) return null
      const buf = await r.arrayBuffer()
      const bytes = new Uint8Array(buf)
      let binary = ''
      for (let i = 0; i < bytes.length; i += 8192)
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
      return btoa(binary)
    } catch { return null }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function fetchJson(url: string): Promise<any | null> {
    try {
      const r = await fetch(url, { credentials: 'include' })
      return r.ok ? await r.json() : null
    } catch { return null }
  }

  // Find the org that owns this project by trying each candidate
  let orgId = ''
  let docsBase = ''
  let filesBase = ''
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let docsList: any[] | null = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let filesList: any[] | null = null

  for (const oid of [...new Set(orgCandidates)]) {
    const db  = `/api/organizations/${oid}/projects/${projectId}/docs`
    const fl  = `/api/organizations/${oid}/projects/${projectId}/files`
    const dl  = await fetchJson(db)
    const fll = await fetchJson(fl)
    const hasContent =
      (Array.isArray(dl)  && dl.length  > 0) ||
      (Array.isArray(fll) && fll.length > 0)
    if (hasContent) {
      orgId = oid; docsBase = db; filesBase = fl
      docsList  = Array.isArray(dl)  ? dl  : null
      filesList = Array.isArray(fll) ? fll : null
      break
    }
  }

  if (!orgId) {
    const tried = [...new Set(orgCandidates)].join(', ')
    return fail(`No files returned from /docs or /files for any org. Tried: ${tried}. Project: ${projectId}`)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allEntries: any[] = []
  if (Array.isArray(docsList))  allEntries.push(...docsList)
  if (Array.isArray(filesList)) allEntries.push(...filesList)

  // Deduplicate by filename — same file can appear in both /docs and /files
  const seenNames = new Set<string>()
  const uniqueEntries = allEntries.filter((e) => {
    const n = (e.file_name ?? e.filename ?? e.name ?? '').toLowerCase()
    if (seenNames.has(n)) return false
    seenNames.add(n)
    return true
  })

  // Deep-scan an object for any http(s) URL value, regardless of field name
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function deepFindUrls(obj: any, depth = 0): string[] {
    if (depth > 6 || obj == null) return []
    if (typeof obj === 'string') return /^https?:\/\//.test(obj) ? [obj] : []
    if (Array.isArray(obj)) return obj.flatMap(v => deepFindUrls(v, depth + 1))
    if (typeof obj === 'object') return Object.values(obj).flatMap(v => deepFindUrls(v, depth + 1))
    return []
  }

  const results: ScrapedFile[]  = []
  const report:  FileStatus[]   = []

  for (const entry of uniqueEntries) {
    const entryId: string = entry.uuid ?? entry.id ?? ''
    const name: string    = entry.file_name ?? entry.filename ?? entry.name ?? 'untitled'
    if (!entryId) continue

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const isDoc     = !!docsList?.find((d: any) => (d.uuid ?? d.id) === entryId)
    const detailUrl = isDoc ? `${docsBase}/${entryId}` : `${filesBase}/${entryId}`
    const full      = (await fetchJson(detailUrl)) ?? entry

    // Collect every candidate URL to try (relative paths + absolute)
    const fileUuid: string = full.file_uuid ?? entry.file_uuid ?? ''
    const candidates: string[] = []

    // ── From `path` field (relative path exposed by the files API) ─────────────
    if (typeof full.path === 'string')   candidates.push(full.path)
    if (typeof entry.path === 'string')  candidates.push(entry.path)

    // ── Asset fields on PDFs (may be string URL or nested object) ─────────────
    for (const asset of [full.document_asset, full.preview_asset, full.thumbnail_asset]) {
      if (typeof asset === 'string') candidates.push(asset)
      else if (asset && typeof asset === 'object') candidates.push(...deepFindUrls(asset))
    }

    // ── file_uuid-based endpoints (correct pattern: /api/{orgId}/files/{fileUuid}) ──
    if (fileUuid) {
      candidates.push(`/api/${orgId}/files/${fileUuid}/download`)
      candidates.push(`/api/${orgId}/files/${fileUuid}`)
      candidates.push(`/api/files/${fileUuid}/download`)
      candidates.push(`/api/files/${fileUuid}`)
    }

    // ── Asset URLs — try the URL exactly as returned, then common variant swaps ──
    for (const asset of [full.document_asset, full.preview_asset, full.thumbnail_asset]) {
      const assetUrl: string | undefined = typeof asset === 'string' ? asset : asset?.url
      if (typeof assetUrl === 'string' && assetUrl.startsWith('/')) {
        candidates.push(assetUrl)   // ← try the exact URL first (e.g. /document_pdf)
        const base = assetUrl.replace(/\/[^/]+$/, '')
        for (const suffix of ['document_pdf', 'download', 'content', 'original', 'pdf', 'raw', 'file', 'document']) {
          candidates.push(`${base}/${suffix}`)
        }
      }
    }

    // ── uuid-based download routes ─────────────────────────────────────────────
    candidates.push(`${detailUrl}/download`)
    candidates.push(`${detailUrl}/content`)

    // ── Deep-scan object for any https:// URL ──────────────────────────────────
    candidates.push(...deepFindUrls(full))

    // Try every candidate; resolve relative paths against origin
    let fetched = false
    for (const raw of candidates) {
      if (!raw || typeof raw !== 'string' || !raw.trim()) continue
      const url = raw.startsWith('http') ? raw : `${window.location.origin}${raw.startsWith('/') ? '' : '/'}${raw}`
      const b64 = await fetchBinary(url)
      if (b64) {
        const mime =
          name.endsWith('.pdf')  ? 'application/pdf' :
          name.endsWith('.xlsx') ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' :
          name.endsWith('.docx') ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' :
          'application/octet-stream'
        results.push({ name, base64: b64, mime })
        report.push({ name, status: 'ok' })
        fetched = true
        break
      }
    }
    if (fetched) continue

    // ── 4. Text content ────────────────────────────────────────────────────────
    const text: string | null =
      full.content ?? full.text ?? full.extracted_content ?? null
    if (text !== null) {
      results.push({
        name,
        base64: btoa(unescape(encodeURIComponent(text))),
        mime: 'text/plain',
      })
      report.push({ name, status: 'ok' })
      continue
    }

    // ── 5. No strategy worked ──────────────────────────────────────────────────
    const snap = JSON.stringify(full).slice(0, 2000)
    report.push({
      name,
      status: 'unavailable',
      reason: `All ${candidates.filter(Boolean).length} candidates failed. API response: ${snap}`,
    })
  }

  return { projectName, files: results, report }

  } catch (err) {
    return bail(`Unhandled error: ${String(err)}`)
  }
}

// ── Markdown helpers ──────────────────────────────────────────────────────────

function buildMarkdown(messages: ScrapedMessage[], rawTitle: string): string {
  const title = rawTitle.replace(/\s*[-–|]?\s*Claude\s*$/i, '').trim() || 'Conversation'
  const date = new Date().toISOString().slice(0, 10)
  const header = `# ${title}\n\n_Exported from Claude · ${date}_\n\n---\n\n`
  const body = messages
    .map(({ role, content }) => `**${role === 'human' ? 'Human' : 'Claude'}**\n\n${content}`)
    .join('\n\n---\n\n')
  return (header + body).replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

function buildBaseName(rawTitle: string): string {
  return rawTitle
    .replace(/\s*[-–|]?\s*Claude\s*$/i, '').trim()
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'conversation'
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click(); a.remove()
  URL.revokeObjectURL(url)
}

// ── Component ─────────────────────────────────────────────────────────────────

function App() {
  const [format, setFormat] = useState<ExportFormat>('md')
  const [pageType, setPageType] = useState<PageType>('detecting')
  const [status, setStatus] = useState<Status>('idle')
  const [message, setMessage] = useState('')

  useEffect(() => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const url = tabs[0]?.url ?? ''
      if (url.includes('claude.ai/chat/')) setPageType('conversation')
      else if (url.includes('claude.ai/project/') && url.includes('/chat/')) setPageType('conversation')
      else if (url.includes('claude.ai/project/')) setPageType('project')
      else setPageType('other')
    })
  }, [])

  const handleExport = async () => {
    setStatus('exporting')
    setMessage('')
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })

      if (pageType === 'project') {
        // Project page: scrape and fetch context files, bundle as ZIP
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: tab.id! },
          func: scrapeProjectFiles,
        })
        if (!result) {
          setStatus('error')
          setMessage('Script returned no result — try reloading the Claude tab.')
          return
        }
        const zip = new JSZip()
        for (const file of result.files) {
          const bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0))
          zip.file(file.name, bytes)
        }

        // Build _report.md
        const ok   = result.report.filter(r => r.status === 'ok')
        const fail = result.report.filter(r => r.status === 'unavailable')
        const date = new Date().toISOString().slice(0, 10)
        const reportLines = [
          `# Export Report — ${result.projectName}`,
          `_${date} · ${ok.length} downloaded, ${fail.length} unavailable_`,
          '',
          `## Downloaded (${ok.length})`,
          ...ok.map(r => `- ${r.name}`),
          '',
          ...(fail.length ? [
            `## Unavailable (${fail.length})`,
            ...fail.map(r => `- **${r.name}**  \n  ${r.reason ?? 'Unknown reason'}`),
          ] : []),
        ]
        zip.file('_report.md', reportLines.join('\n'))

        const blob = await zip.generateAsync({ type: 'blob' })
        const baseName = buildBaseName(result.projectName)
        downloadBlob(blob, `${baseName}.zip`)
        setStatus('success')
        const msg = fail.length
          ? `${ok.length} files downloaded, ${fail.length} unavailable — see _report.md`
          : `${ok.length} file${ok.length > 1 ? 's' : ''} downloaded`
        setMessage(msg)

      } else {
        // Conversation page: scrape messages → markdown or zip
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: tab.id! },
          func: scrapeConversation,
        })
        if (!result || result.messages.length === 0) {
          setStatus('error')
          setMessage('No conversation found. Try scrolling through the full chat first.')
          return
        }
        const md = buildMarkdown(result.messages, result.title)
        const baseName = buildBaseName(result.title)
        if (format === 'zip') {
          const zip = new JSZip()
          zip.file(`${baseName}.md`, md)
          const blob = await zip.generateAsync({ type: 'blob' })
          downloadBlob(blob, `${baseName}.zip`)
          setMessage(`Saved as ${baseName}.zip`)
        } else {
          downloadBlob(new Blob([md], { type: 'text/markdown' }), `${baseName}.md`)
          setMessage(`Saved as ${baseName}.md`)
        }
        setStatus('success')
      }
    } catch (err) {
      setStatus('error')
      setMessage(err instanceof Error ? err.message : 'Unexpected error.')
    }
  }

  const isDetecting = pageType === 'detecting'
  const isExporting = status === 'exporting'
  const isProject = pageType === 'project'
  const isReady = pageType === 'project' || pageType === 'conversation'

  const statusLabel = isDetecting
    ? 'Detecting page…'
    : pageType === 'project'
    ? 'Claude project detected'
    : pageType === 'conversation'
    ? 'Claude conversation detected'
    : 'Open a Claude project or conversation'

  return (
    <div className="popup">
      <header className="header">
        <FileText size={18} className="header-icon" />
        <span className="header-title">Claude Project Downloader</span>
      </header>

      <main className="body">
        <div className={`page-status ${isReady ? 'ok' : 'warn'}`}>
          {isDetecting ? (
            <Loader2 size={13} className="spin" />
          ) : isReady ? (
            isProject ? <FolderOpen size={13} /> : <CheckCircle size={13} />
          ) : (
            <AlertCircle size={13} />
          )}
          <span>{statusLabel}</span>
        </div>

        {/* Format selector only shown for conversations */}
        {pageType === 'conversation' && (
          <div className="format-group">
            <label className="format-label">Export as</label>
            <div className="format-options">
              <button
                className={`format-btn${format === 'md' ? ' active' : ''}`}
                onClick={() => setFormat('md')}
                disabled={isExporting}
              >
                <FileText size={13} />
                Markdown
              </button>
              <button
                className={`format-btn${format === 'zip' ? ' active' : ''}`}
                onClick={() => setFormat('zip')}
                disabled={isExporting}
              >
                <Archive size={13} />
                ZIP
              </button>
            </div>
          </div>
        )}

        {/* For project pages always ZIP */}
        {pageType === 'project' && (
          <p className="hint">
            <Archive size={12} />
            Context files will be downloaded as a ZIP
          </p>
        )}

        <button
          className="export-btn"
          onClick={handleExport}
          disabled={!isReady || isExporting || isDetecting}
        >
          {isExporting ? <Loader2 size={15} className="spin" /> : <Download size={15} />}
          {isExporting ? 'Exporting…' : 'Export'}
        </button>

        {status === 'success' && (
          <p className="feedback success">
            <CheckCircle size={12} />
            {message}
          </p>
        )}
        {status === 'error' && (
          <p className="feedback error">
            <AlertCircle size={12} />
            {message}
          </p>
        )}
      </main>
    </div>
  )
}

export default App
