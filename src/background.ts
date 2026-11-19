import JSZip from 'jszip'

// ── Types ─────────────────────────────────────────────────────────────────────

type JobType = 'conversation' | 'files' | 'instructions' | 'chats' | 'full'
type ExportFormat = 'md' | 'zip'

export interface JobState {
  running: JobType | null
  lastResult: { success: boolean; msg: string } | null
}

interface StartJobMsg { type: 'START_JOB'; job: JobType; tabId: number; format: ExportFormat }
interface GetStateMsg  { type: 'GET_STATE' }

// ── Shared job state ──────────────────────────────────────────────────────────

let jobState: JobState = { running: null, lastResult: null }

function pushState(patch: Partial<JobState>) {
  jobState = { ...jobState, ...patch }
  chrome.runtime.sendMessage({ type: 'JOB_STATE', ...jobState }).catch(() => {})
}

// ── Markdown helpers ──────────────────────────────────────────────────────────

interface ScrapedMessage { role: 'human' | 'assistant'; content: string }

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
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'export'
}

function toSlug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'chat'
}

// ── Download helper (injected into page) ─────────────────────────────────────

async function blobToB64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 8192)
    bin += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return btoa(bin)
}

async function downloadInTab(tabId: number, b64: string, filename: string, mime: string) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (b: string, f: string, m: string) => {
      const bytes = Uint8Array.from(atob(b), c => c.charCodeAt(0))
      const url = URL.createObjectURL(new Blob([bytes], { type: m }))
      const a = document.createElement('a')
      a.href = url; a.download = f
      document.body.appendChild(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 2000)
    },
    args: [b64, filename, mime],
  })
}

// ── Injected scraping functions ───────────────────────────────────────────────
// Each function is fully self-contained — no outer-scope references.

interface ScrapedPage { title: string; messages: ScrapedMessage[] }

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      case 'em': case 'i': return `*${ch()}*`
      case 's': case 'del': return `~~${ch()}~~`
      case 'a': return `[${ch()}](${el.getAttribute('href') ?? '#'})`
      case 'code': return el.closest('pre') ? (el.textContent ?? '') : `\`${el.textContent}\``
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
  if (!turns.length)
    turns = Array.from(document.querySelectorAll<HTMLElement>('[data-message-author-role]'))
  if (!turns.length) return null
  return {
    title: document.title,
    messages: turns.map((el) => ({
      role: el.dataset.testid === 'human-turn' || el.dataset.messageAuthorRole === 'human'
        ? 'human' : 'assistant',
      content: nodeMd(el).trim(),
    })),
  }
}

interface ScrapedFile { name: string; base64: string; mime: string }
interface FileStatus { name: string; status: 'ok' | 'unavailable'; reason?: string }
interface ScrapedProject { projectName: string; files: ScrapedFile[]; report: FileStatus[] }

async function scrapeProjectFiles(): Promise<ScrapedProject> {
  const projectName = document.title.replace(/\s*[-–|]?\s*Claude\s*$/i, '').trim() || 'project'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function bail(reason: string): ScrapedProject {
    return { projectName, files: [], report: [{ name: '_diagnostic', status: 'unavailable', reason }] }
  }
  try {
    const projectId = window.location.pathname.match(/\/project\/([^/]+)/)?.[1]
    if (!projectId) return bail('Could not read project ID from URL: ' + window.location.href)
    const orgCandidates: string[] = []
    const syncOrg = localStorage.getItem('ccd-sync-org')
    if (syncOrg) orgCandidates.push(syncOrg)
    try {
      const ho = JSON.parse(sessionStorage.getItem('history-organizations') ?? '{}')
      if (ho.current) orgCandidates.push(ho.current)
    } catch { /* ignore */ }
    try {
      const r = await fetch('/api/organizations', { credentials: 'include' })
      if (r.ok) {
        const orgs = await r.json()
        if (Array.isArray(orgs)) orgs.forEach((o: { uuid?: string }) => { if (o.uuid) orgCandidates.push(o.uuid) })
      }
    } catch { /* ignore */ }
    if (!orgCandidates.length) return bail('Could not determine org ID — not logged in?')
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
    let orgId = '', docsBase = '', filesBase = ''
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let docsList: any[] | null = null, filesList: any[] | null = null
    for (const oid of [...new Set(orgCandidates)]) {
      const db = `/api/organizations/${oid}/projects/${projectId}/docs`
      const fl = `/api/organizations/${oid}/projects/${projectId}/files`
      const dl = await fetchJson(db), fll = await fetchJson(fl)
      const hasContent = (Array.isArray(dl) && dl.length > 0) || (Array.isArray(fll) && fll.length > 0)
      if (hasContent) {
        orgId = oid; docsBase = db; filesBase = fl
        docsList = Array.isArray(dl) ? dl : null
        filesList = Array.isArray(fll) ? fll : null
        break
      }
    }
    if (!orgId) return bail(`No files found for any org. Tried: ${[...new Set(orgCandidates)].join(', ')}`)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allEntries: any[] = []
    if (Array.isArray(docsList)) allEntries.push(...docsList)
    if (Array.isArray(filesList)) allEntries.push(...filesList)
    const seenNames = new Set<string>()
    const uniqueEntries = allEntries.filter((e) => {
      const n = (e.file_name ?? e.filename ?? e.name ?? '').toLowerCase()
      if (seenNames.has(n)) return false
      seenNames.add(n); return true
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function deepFindUrls(obj: any, depth = 0): string[] {
      if (depth > 6 || obj == null) return []
      if (typeof obj === 'string') return /^https?:\/\//.test(obj) ? [obj] : []
      if (Array.isArray(obj)) return obj.flatMap(v => deepFindUrls(v, depth + 1))
      if (typeof obj === 'object') return Object.values(obj).flatMap(v => deepFindUrls(v, depth + 1))
      return []
    }
    const results: ScrapedFile[] = [], report: FileStatus[] = []
    for (const entry of uniqueEntries) {
      const entryId: string = entry.uuid ?? entry.id ?? ''
      const name: string = entry.file_name ?? entry.filename ?? entry.name ?? 'untitled'
      if (!entryId) continue
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const isDoc = !!docsList?.find((d: any) => (d.uuid ?? d.id) === entryId)
      const detailUrl = isDoc ? `${docsBase}/${entryId}` : `${filesBase}/${entryId}`
      const full = (await fetchJson(detailUrl)) ?? entry
      const fileUuid: string = full.file_uuid ?? entry.file_uuid ?? ''
      const candidates: string[] = []
      if (typeof full.path === 'string') candidates.push(full.path)
      if (typeof entry.path === 'string') candidates.push(entry.path)
      for (const asset of [full.document_asset, full.preview_asset, full.thumbnail_asset]) {
        if (typeof asset === 'string') candidates.push(asset)
        else if (asset && typeof asset === 'object') candidates.push(...deepFindUrls(asset))
      }
      if (fileUuid) {
        candidates.push(`/api/${orgId}/files/${fileUuid}/download`)
        candidates.push(`/api/${orgId}/files/${fileUuid}`)
        candidates.push(`/api/files/${fileUuid}/download`)
        candidates.push(`/api/files/${fileUuid}`)
      }
      for (const asset of [full.document_asset, full.preview_asset, full.thumbnail_asset]) {
        const assetUrl: string | undefined = typeof asset === 'string' ? asset : asset?.url
        if (typeof assetUrl === 'string' && assetUrl.startsWith('/')) {
          candidates.push(assetUrl)
          const base = assetUrl.replace(/\/[^/]+$/, '')
          for (const suffix of ['document_pdf','download','content','original','pdf','raw','file','document'])
            candidates.push(`${base}/${suffix}`)
        }
      }
      candidates.push(`${detailUrl}/download`, `${detailUrl}/content`, ...deepFindUrls(full))
      let fetched = false
      for (const raw of candidates) {
        if (!raw || typeof raw !== 'string' || !raw.trim()) continue
        const url = raw.startsWith('http') ? raw : `${window.location.origin}${raw.startsWith('/') ? '' : '/'}${raw}`
        const b64 = await fetchBinary(url)
        if (b64) {
          const mime = name.endsWith('.pdf') ? 'application/pdf' :
            name.endsWith('.xlsx') ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' :
            name.endsWith('.docx') ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' :
            'application/octet-stream'
          results.push({ name, base64: b64, mime }); report.push({ name, status: 'ok' }); fetched = true; break
        }
      }
      if (fetched) continue
      const text: string | null = full.content ?? full.text ?? full.extracted_content ?? null
      if (text !== null) {
        results.push({ name, base64: btoa(unescape(encodeURIComponent(text))), mime: 'text/plain' })
        report.push({ name, status: 'ok' }); continue
      }
      report.push({ name, status: 'unavailable', reason: `All ${candidates.filter(Boolean).length} candidates failed. API: ${JSON.stringify(full).slice(0, 2000)}` })
    }
    return { projectName, files: results, report }
  } catch (err) { return bail(`Unhandled error: ${String(err)}`) }
}

interface ScrapedInstructions { projectName: string; instructions: string | null }

async function scrapeProjectInstructions(): Promise<ScrapedInstructions> {
  const projectName = document.title.replace(/\s*[-–|]?\s*Claude\s*$/i, '').trim() || 'project'
  const projectId = window.location.pathname.match(/\/project\/([^/]+)/)?.[1]
  if (!projectId) return { projectName, instructions: null }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function fetchJson(url: string): Promise<any | null> {
    try { const r = await fetch(url, { credentials: 'include' }); return r.ok ? await r.json() : null }
    catch { return null }
  }
  const orgCandidates: string[] = []
  const syncOrg = localStorage.getItem('ccd-sync-org')
  if (syncOrg) orgCandidates.push(syncOrg)
  try {
    const ho = JSON.parse(sessionStorage.getItem('history-organizations') ?? '{}')
    if (ho.current) orgCandidates.push(ho.current)
  } catch { /* ignore */ }
  try {
    const r = await fetch('/api/organizations', { credentials: 'include' })
    if (r.ok) {
      const orgs = await r.json()
      if (Array.isArray(orgs)) orgs.forEach((o: { uuid?: string }) => { if (o.uuid) orgCandidates.push(o.uuid) })
    }
  } catch { /* ignore */ }
  for (const oid of [...new Set(orgCandidates)]) {
    const data = await fetchJson(`/api/organizations/${oid}/projects/${projectId}`)
    if (!data) continue
    const instructions: unknown = data.prompt_template ?? data.instructions ?? data.description ?? data.system_prompt
    if (typeof instructions === 'string' && instructions.trim()) return { projectName, instructions }
  }
  return { projectName, instructions: null }
}

interface ScrapedConversation { title: string; id: string; messages: ScrapedMessage[] }
interface ScrapedConversations { projectName: string; conversations: ScrapedConversation[]; diagnostic?: string }

async function scrapeAllConversations(): Promise<ScrapedConversations> {
  const projectName = document.title.replace(/\s*[-–|]?\s*Claude\s*$/i, '').trim() || 'project'
  const projectId = window.location.pathname.match(/\/project\/([^/]+)/)?.[1]
  const diag: string[] = [`url=${window.location.href}`, `projectId=${projectId ?? 'NOT_FOUND'}`]
  if (!projectId) return { projectName, conversations: [], diagnostic: diag.join(' | ') }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function fetchJson(url: string): Promise<{ ok: boolean; status: number; body: any }> {
    try {
      const r = await fetch(url, { credentials: 'include' })
      let body = null
      try { body = await r.json() } catch { /* ignore */ }
      return { ok: r.ok, status: r.status, body }
    } catch (e) { return { ok: false, status: 0, body: String(e) } }
  }
  const orgCandidates: string[] = []
  const syncOrg = localStorage.getItem('ccd-sync-org')
  if (syncOrg) orgCandidates.push(syncOrg)
  try {
    const ho = JSON.parse(sessionStorage.getItem('history-organizations') ?? '{}')
    if (ho.current) orgCandidates.push(ho.current)
  } catch { /* ignore */ }
  try {
    const r = await fetch('/api/organizations', { credentials: 'include' })
    if (r.ok) {
      const orgs = await r.json()
      if (Array.isArray(orgs)) orgs.forEach((o: { uuid?: string }) => { if (o.uuid) orgCandidates.push(o.uuid) })
    }
  } catch { /* ignore */ }
  const uniqueOrgs = [...new Set(orgCandidates)]
  diag.push(`orgs=[${uniqueOrgs.join(',')}]`)
  for (const oid of uniqueOrgs) {
    const endpoints = [
      `/api/organizations/${oid}/projects/${projectId}/conversations`,
      `/api/organizations/${oid}/projects/${projectId}/chat_conversations`,
    ]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let rawList: any = null
    for (const ep of endpoints) {
      const res = await fetchJson(ep)
      diag.push(`GET ${ep} → ${res.status} body=${JSON.stringify(res.body).slice(0, 200)}`)
      if (res.ok && res.body) { rawList = res.body; break }
    }
    if (!rawList) continue
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const list: any[] | null =
      Array.isArray(rawList) ? rawList :
      Array.isArray(rawList?.conversations) ? rawList.conversations :
      Array.isArray(rawList?.results) ? rawList.results :
      Array.isArray(rawList?.data) ? rawList.data : null
    if (!list) { diag.push(`list_unwrap_failed keys=${Object.keys(rawList ?? {}).join(',')}`); continue }
    diag.push(`list_count=${list.length}`)
    const conversations: ScrapedConversation[] = []
    for (const conv of list) {
      const convId: string = conv.uuid ?? conv.id ?? ''
      const title: string = conv.name ?? conv.title ?? 'Untitled'
      if (!convId) continue
      const detailEndpoints = [
        `/api/organizations/${oid}/chat_conversations/${convId}?rendering_mode=messages`,
        `/api/organizations/${oid}/chat_conversations/${convId}`,
        `/api/organizations/${oid}/conversations/${convId}`,
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let detail: any = null
      for (const dep of detailEndpoints) {
        const res = await fetchJson(dep)
        if (res.ok && res.body) { detail = res.body; break }
      }
      if (!detail) continue
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawMessages: any[] = detail.chat_messages ?? detail.messages ?? []
      const messages: ScrapedMessage[] = rawMessages.flatMap((m) => {
        const role: 'human' | 'assistant' =
          (m.sender === 'human' || m.sender === 'user' || m.role === 'user') ? 'human' : 'assistant'
        let content = ''
        if (typeof m.text === 'string') content = m.text
        else if (Array.isArray(m.content))
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          content = m.content.filter((b: any) => b.type === 'text').map((b: any) => b.text ?? '').join('\n')
        else if (typeof m.content === 'string') content = m.content
        return content.trim() ? [{ role, content: content.trim() }] : []
      })
      conversations.push({ id: convId, title, messages })
    }
    return { projectName, conversations, diagnostic: diag.join(' | ') }
  }
  return { projectName, conversations: [], diagnostic: diag.join(' | ') }
}

// ── Job runners ───────────────────────────────────────────────────────────────

async function runConversation(tabId: number, format: ExportFormat): Promise<string> {
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: scrapeConversation })
  if (!result || result.messages.length === 0)
    throw new Error('No conversation found. Try scrolling through the full chat first.')
  const md = buildMarkdown(result.messages, result.title)
  const baseName = buildBaseName(result.title)
  if (format === 'zip') {
    const zip = new JSZip(); zip.file(`${baseName}.md`, md)
    const b64 = await blobToB64(await zip.generateAsync({ type: 'blob' }))
    await downloadInTab(tabId, b64, `${baseName}.zip`, 'application/zip')
    return `Saved as ${baseName}.zip`
  }
  await downloadInTab(tabId, btoa(unescape(encodeURIComponent(md))), `${baseName}.md`, 'text/markdown')
  return `Saved as ${baseName}.md`
}

async function runFiles(tabId: number): Promise<string> {
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: scrapeProjectFiles })
  if (!result) throw new Error('Script returned no result — try reloading the Claude tab.')
  const zip = new JSZip()
  for (const file of result.files)
    zip.file(file.name, Uint8Array.from(atob(file.base64), c => c.charCodeAt(0)))
  const okF = result.report.filter(r => r.status === 'ok')
  const failF = result.report.filter(r => r.status === 'unavailable')
  const date = new Date().toISOString().slice(0, 10)
  zip.file('_report.md', [
    `# Export Report — ${result.projectName}`,
    `_${date} · ${okF.length} downloaded, ${failF.length} unavailable_`,
    '', `## Downloaded (${okF.length})`, ...okF.map(r => `- ${r.name}`), '',
    ...(failF.length ? [`## Unavailable (${failF.length})`, ...failF.map(r => `- **${r.name}**  \n  ${r.reason ?? ''}`)] : []),
  ].join('\n'))
  const b64 = await blobToB64(await zip.generateAsync({ type: 'blob' }))
  await downloadInTab(tabId, b64, `${buildBaseName(result.projectName)}-files.zip`, 'application/zip')
  return failF.length
    ? `${okF.length} files downloaded, ${failF.length} unavailable — see _report.md`
    : `${okF.length} file${okF.length !== 1 ? 's' : ''} downloaded`
}

async function runInstructions(tabId: number): Promise<string> {
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: scrapeProjectInstructions })
  if (!result) throw new Error('Script returned no result — try reloading the Claude tab.')
  if (!result.instructions) throw new Error('No instructions found for this project.')
  const filename = `${buildBaseName(result.projectName)}-instructions.txt`
  await downloadInTab(tabId, btoa(unescape(encodeURIComponent(result.instructions))), filename, 'text/plain')
  return `Saved as ${filename}`
}

async function runChats(tabId: number): Promise<string> {
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: scrapeAllConversations })
  if (!result) throw new Error('Script returned no result — try reloading the Claude tab.')
  if (!result.conversations.length)
    throw new Error(`No conversations found. Debug: ${result.diagnostic ?? 'no diagnostic'}`)
  const zip = new JSZip()
  const slugCount: Record<string, number> = {}
  for (const conv of result.conversations) {
    const base = toSlug(conv.title)
    slugCount[base] = (slugCount[base] ?? 0) + 1
    const filename = slugCount[base] > 1 ? `${base}-${slugCount[base]}.md` : `${base}.md`
    zip.file(filename, buildMarkdown(conv.messages, conv.title))
  }
  const b64 = await blobToB64(await zip.generateAsync({ type: 'blob' }))
  await downloadInTab(tabId, b64, `${buildBaseName(result.projectName)}-chats.zip`, 'application/zip')
  return `${result.conversations.length} chat${result.conversations.length !== 1 ? 's' : ''} downloaded`
}

async function runFull(tabId: number): Promise<string> {
  const [filesRes, instrRes, chatsRes] = await Promise.all([
    chrome.scripting.executeScript({ target: { tabId }, func: scrapeProjectFiles }),
    chrome.scripting.executeScript({ target: { tabId }, func: scrapeProjectInstructions }),
    chrome.scripting.executeScript({ target: { tabId }, func: scrapeAllConversations }),
  ])
  const files = filesRes[0]?.result, instr = instrRes[0]?.result, chats = chatsRes[0]?.result
  if (!files && !instr && !chats) throw new Error('Nothing could be fetched — try reloading the Claude tab.')
  const zip = new JSZip()
  const projectName = files?.projectName ?? instr?.projectName ?? chats?.projectName ?? 'project'
  const date = new Date().toISOString().slice(0, 10)
  if (instr?.instructions) zip.file('instructions.txt', instr.instructions)
  if (files?.files.length) {
    const folder = zip.folder('files')!
    for (const file of files.files)
      folder.file(file.name, Uint8Array.from(atob(file.base64), c => c.charCodeAt(0)))
    const okF = files.report.filter(r => r.status === 'ok'), failF = files.report.filter(r => r.status === 'unavailable')
    folder.file('_report.md', [
      `# Files Report — ${projectName}`,
      `_${date} · ${okF.length} downloaded, ${failF.length} unavailable_`,
      '', `## Downloaded (${okF.length})`, ...okF.map(r => `- ${r.name}`), '',
      ...(failF.length ? [`## Unavailable (${failF.length})`, ...failF.map(r => `- **${r.name}**  \n  ${r.reason ?? ''}`)] : []),
    ].join('\n'))
  }
  if (chats?.conversations.length) {
    const folder = zip.folder('chats')!
    const slugCount: Record<string, number> = {}
    for (const conv of chats.conversations) {
      const base = toSlug(conv.title)
      slugCount[base] = (slugCount[base] ?? 0) + 1
      const filename = slugCount[base] > 1 ? `${base}-${slugCount[base]}.md` : `${base}.md`
      folder.file(filename, buildMarkdown(conv.messages, conv.title))
    }
  }
  const b64 = await blobToB64(await zip.generateAsync({ type: 'blob' }))
  await downloadInTab(tabId, b64, `${buildBaseName(projectName)}-full.zip`, 'application/zip')
  const parts = [
    files?.files.length ? `${files.files.length} files` : null,
    instr?.instructions ? 'instructions' : null,
    chats?.conversations.length ? `${chats.conversations.length} chats` : null,
  ].filter(Boolean)
  return `Downloaded: ${parts.join(', ')}`
}

// ── Dispatcher + message listener ─────────────────────────────────────────────

async function dispatch(job: JobType, tabId: number, format: ExportFormat) {
  try {
    const msg = await (
      job === 'conversation' ? runConversation(tabId, format) :
      job === 'files'        ? runFiles(tabId) :
      job === 'instructions' ? runInstructions(tabId) :
      job === 'chats'        ? runChats(tabId) :
      runFull(tabId)
    )
    pushState({ running: null, lastResult: { success: true, msg } })
  } catch (e) {
    pushState({ running: null, lastResult: { success: false, msg: e instanceof Error ? e.message : String(e) } })
  }
}

chrome.runtime.onMessage.addListener((msg: StartJobMsg | GetStateMsg, _sender, sendResponse) => {
  if (msg.type === 'GET_STATE') {
    sendResponse(jobState)
    return false
  }
  if (msg.type === 'START_JOB') {
    if (jobState.running) { sendResponse({ accepted: false }); return false }
    pushState({ running: msg.job, lastResult: null })
    sendResponse({ accepted: true })
    dispatch(msg.job, msg.tabId, msg.format)
    return false
  }
})
