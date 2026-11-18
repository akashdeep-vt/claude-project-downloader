# Claude Project Downloader

A Chrome extension to export Claude conversations as Markdown and download all files from Claude projects as a ZIP.

---

## Features

- **Export conversations** — saves any Claude chat as a `.md` or `.zip` file
- **Download project files** — bulk-downloads all context files from a Claude project into a ZIP
- **Export report** — includes a `_report.md` inside every project ZIP listing what downloaded and what didn't

---

## Installation (from ZIP)

> No Chrome Web Store required — install directly in developer mode.

1. **Download** the latest `claude-md-exporter.zip` from the [Releases](../../releases) page
2. **Unzip** it anywhere on your computer — you'll get a folder called `dist` (or similar)
3. Open Chrome and go to `chrome://extensions`
4. Enable **Developer mode** using the toggle in the top-right corner
5. Click **Load unpacked**
6. Select the unzipped folder
7. The extension icon will appear in your Chrome toolbar

> If Chrome shows a warning about developer mode extensions on startup, click **Keep** to dismiss it.

---

## Usage

### Export a Conversation

1. Open any conversation on [claude.ai](https://claude.ai)
2. Click the extension icon in the toolbar
3. Choose **Markdown** or **ZIP** as the export format
4. Click **Export**
5. The file downloads automatically to your Downloads folder

### Download Project Files

1. Open a Claude project on [claude.ai/project/...](https://claude.ai)
   - Make sure you are on the **project page**, not inside a conversation
2. Click the extension icon
3. Click **Export**
4. A ZIP file is downloaded containing all project context files and a `_report.md` summary

---

## Updating

1. Download the new ZIP from the [Releases](../../releases) page
2. Unzip and replace the contents of your existing folder
3. Go to `chrome://extensions` and click the **reload** icon on the extension card

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "No conversation found" | Scroll through the full chat once, then try again |
| Project ZIP is empty | Make sure you are on the project page (URL contains `/project/`) and are logged in to Claude |
| Extension not visible in toolbar | Click the puzzle icon in Chrome toolbar and pin the extension |
| Files show as unavailable in `_report.md` | Claude may restrict downloading certain file types — text content is always extracted as a fallback |

---

## Permissions Used

| Permission | Reason |
|---|---|
| `activeTab` | Read the current Claude tab's URL to detect page type |
| `scripting` | Inject a script into the Claude page to scrape conversation and project data |
| `https://claude.ai/*` | Restrict access to Claude pages only |

---

## License

MIT
