import { useState, useEffect } from 'react'
import { Download, FileText, Archive, AlertCircle, CheckCircle, Loader2, FolderOpen, MessageSquare, BookOpen, Info } from 'lucide-react'
import './App.css'
import type { JobState } from './background'

type ExportFormat = 'md' | 'zip'
type PageType = 'detecting' | 'project' | 'conversation' | 'other'
type JobType = 'conversation' | 'files' | 'instructions' | 'chats' | 'full'

function App() {
  const [format, setFormat] = useState<ExportFormat>('md')
  const [pageType, setPageType] = useState<PageType>('detecting')
  const [tabId, setTabId] = useState<number | null>(null)
  const [bgState, setBgState] = useState<JobState>({ running: null, lastResult: null })

  useEffect(() => {
    // Detect page type
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0]
      const url = tab?.url ?? ''
      setTabId(tab?.id ?? null)
      if (url.includes('claude.ai/chat/')) setPageType('conversation')
      else if (url.includes('claude.ai/project/') && url.includes('/chat/')) setPageType('conversation')
      else if (url.includes('claude.ai/project/')) setPageType('project')
      else setPageType('other')
    })

    // Sync with background state on open
    chrome.runtime.sendMessage({ type: 'GET_STATE' })
      .then((s: JobState) => setBgState(s))
      .catch(() => {})

    // Listen for state updates while popup is open
    const handler = (msg: Record<string, unknown>) => {
      if (msg.type === 'JOB_STATE') {
        setBgState({ running: msg.running as JobType | null, lastResult: msg.lastResult as JobState['lastResult'] })
      }
    }
    chrome.runtime.onMessage.addListener(handler)
    return () => chrome.runtime.onMessage.removeListener(handler)
  }, [])

  async function startJob(job: JobType) {
    if (!tabId) return
    chrome.runtime.sendMessage({ type: 'START_JOB', job, tabId, format })
  }

  const isDetecting = pageType === 'detecting'
  const isReady = pageType === 'project' || pageType === 'conversation'
  const isBusy = bgState.running !== null

  const statusLabel = isDetecting
    ? 'Detecting page…'
    : pageType === 'project'      ? 'Claude project detected'
    : pageType === 'conversation' ? 'Claude conversation detected'
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
            pageType === 'project' ? <FolderOpen size={13} /> : <CheckCircle size={13} />
          ) : (
            <AlertCircle size={13} />
          )}
          <span>{statusLabel}</span>
        </div>

        {/* Running in background banner */}
        {isBusy && (
          <p className="feedback info">
            <Info size={12} />
            Downloading in background — safe to switch tabs
          </p>
        )}

        {/* ── Conversation page ── */}
        {pageType === 'conversation' && (
          <>
            <div className="format-group">
              <label className="format-label">Export as</label>
              <div className="format-options">
                <button className={`format-btn${format === 'md' ? ' active' : ''}`} onClick={() => setFormat('md')} disabled={isBusy}>
                  <FileText size={13} /> Markdown
                </button>
                <button className={`format-btn${format === 'zip' ? ' active' : ''}`} onClick={() => setFormat('zip')} disabled={isBusy}>
                  <Archive size={13} /> ZIP
                </button>
              </div>
            </div>
            <button className="export-btn" onClick={() => startJob('conversation')} disabled={isBusy}>
              {bgState.running === 'conversation' ? <Loader2 size={15} className="spin" /> : <Download size={15} />}
              {bgState.running === 'conversation' ? 'Exporting…' : 'Export'}
            </button>
          </>
        )}

        {/* ── Project page ── */}
        {pageType === 'project' && (
          <>
            <div className="action-grid">
              <button className="action-btn" onClick={() => startJob('files')} disabled={isBusy}>
                {bgState.running === 'files' ? <Loader2 size={13} className="spin" /> : <Archive size={13} />}
                {bgState.running === 'files' ? 'Downloading…' : 'Download Files'}
              </button>
              <button className="action-btn" onClick={() => startJob('instructions')} disabled={isBusy}>
                {bgState.running === 'instructions' ? <Loader2 size={13} className="spin" /> : <BookOpen size={13} />}
                {bgState.running === 'instructions' ? 'Downloading…' : 'Instructions'}
              </button>
              <button className="action-btn" onClick={() => startJob('chats')} disabled={isBusy}>
                {bgState.running === 'chats' ? <Loader2 size={13} className="spin" /> : <MessageSquare size={13} />}
                {bgState.running === 'chats' ? 'Downloading…' : 'All Chats'}
              </button>
            </div>
            <button className="export-btn" onClick={() => startJob('full')} disabled={isBusy}>
              {bgState.running === 'full' ? <Loader2 size={15} className="spin" /> : <Download size={15} />}
              {bgState.running === 'full' ? 'Building…' : 'Download Full Project'}
            </button>
          </>
        )}

        {bgState.lastResult?.success && (
          <p className="feedback success"><CheckCircle size={12} />{bgState.lastResult.msg}</p>
        )}
        {bgState.lastResult?.success === false && (
          <p className="feedback error"><AlertCircle size={12} />{bgState.lastResult.msg}</p>
        )}
      </main>
    </div>
  )
}

export default App
