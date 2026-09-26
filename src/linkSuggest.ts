import {
  App,
  Editor,
  EditorPosition,
  EditorSuggest,
  EditorSuggestContext,
  EditorSuggestTriggerInfo,
  prepareFuzzySearch,
  renderMatches,
  SearchResult,
  TFile
} from 'obsidian'

const maxSuggestions = 50
const mediaExtensions = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', 'avif', 'mp4', 'webm', 'ogv', 'mov', 'mkv']

interface LinkSuggestion {
  file: TFile;
  heading?: string;
  title: string;
  match: SearchResult | null;
}

/**
 * Suggest notes after `<<` is typed in an image caption, and headings after `#`, the same way
 * Obsidian suggests them after `[[` elsewhere. Wikilinks in captions have to be written with
 * angle brackets, e.g. ![[image.jpg|See <<My note>>]], which Obsidian's own suggestions don't cover.
 */
export class CaptionLinkSuggest extends EditorSuggest<LinkSuggestion> {
  constructor (app: App) {
    super(app)
    this.limit = maxSuggestions
    this.setInstructions([
      { command: 'Type #', purpose: 'to link heading' },
      { command: 'Type |', purpose: 'to change display text' }
    ])
  }

  onTrigger (cursor: EditorPosition, editor: Editor): EditorSuggestTriggerInfo | null {
    const line = editor.getLine(cursor.line)
    const before = line.slice(0, cursor.ch)
    // The cursor must be in the caption of an image/video embed which is still open
    const embedStart = before.lastIndexOf('![[')
    if (embedStart === -1 || before.includes(']]', embedStart)) return null
    const embed = before.slice(embedStart + 3)
    const pipe = embed.search(/\\?\|/)
    if (pipe === -1) return null
    const extension = embed.slice(0, pipe).replace(/#.*$/, '').split('.').pop()?.toLowerCase() || ''
    if (!mediaExtensions.includes(extension)) return null
    // ...and inside an unclosed <<, before any | for the display text
    const linkStart = before.lastIndexOf('<<')
    if (linkStart < embedStart + 3 + pipe) return null
    const query = before.slice(linkStart + 2)
    if (query.includes('>>') || query.includes('|')) return null
    // When editing an existing <<link>>, replace the rest of it as well
    const rest = line.slice(cursor.ch).match(/^[^<>|\]]*>>/)
    return {
      start: { line: cursor.line, ch: linkStart },
      end: { line: cursor.line, ch: cursor.ch + (rest ? rest[0].length : 0) },
      query
    }
  }

  getSuggestions (context: EditorSuggestContext): LinkSuggestion[] {
    const hashIndex = context.query.indexOf('#')
    if (hashIndex !== -1) {
      return this.getHeadingSuggestions(context.query.slice(0, hashIndex), context.query.slice(hashIndex + 1), context.file)
    }
    return this.getFileSuggestions(context.query)
  }

  getFileSuggestions (query: string): LinkSuggestion[] {
    const files = this.app.vault.getFiles()
    const title = (file: TFile) => file.extension === 'md' ? file.basename : file.name
    if (!query.trim()) {
      // Nothing typed yet: recently opened files first, then the most recently modified
      const recent = this.app.workspace.getLastOpenFiles()
        .map(path => this.app.vault.getFileByPath(path))
        .filter((file): file is TFile => !!file)
      const others = files
        .filter(file => !recent.includes(file))
        .sort((a, b) => b.stat.mtime - a.stat.mtime)
      return [...recent, ...others]
        .slice(0, maxSuggestions)
        .map(file => ({ file, title: title(file), match: null }))
    }
    const search = prepareFuzzySearch(query.trim())
    const results: LinkSuggestion[] = []
    for (const file of files) {
      // Match on the name first so it can be highlighted, falling back to the full path
      const match = search(title(file))
      if (match) {
        results.push({ file, title: title(file), match })
      } else {
        const pathMatch = search(file.path)
        if (pathMatch) results.push({ file, title: title(file), match: { score: pathMatch.score - 1, matches: [] } })
      }
    }
    return results
      .sort((a, b) => (b.match?.score ?? 0) - (a.match?.score ?? 0))
      .slice(0, maxSuggestions)
  }

  getHeadingSuggestions (linkpath: string, query: string, currentFile: TFile | null): LinkSuggestion[] {
    // <<#Heading>> links to a heading in the current note
    const file = linkpath
      ? this.app.metadataCache.getFirstLinkpathDest(linkpath, currentFile?.path ?? '')
      : currentFile
    if (!file || query.startsWith('^')) return []
    const headings = this.app.metadataCache.getFileCache(file)?.headings ?? []
    const search = query.trim() ? prepareFuzzySearch(query.trim()) : null
    const results: LinkSuggestion[] = []
    for (const { heading } of headings) {
      const match = search ? search(heading) : null
      if (!search || match) results.push({ file, heading, title: heading, match })
    }
    if (search) results.sort((a, b) => (b.match?.score ?? 0) - (a.match?.score ?? 0))
    return results
  }

  renderSuggestion (suggestion: LinkSuggestion, el: HTMLElement) {
    const content = el.createDiv({ cls: 'suggestion-content' })
    renderMatches(content.createDiv({ cls: 'suggestion-title' }), suggestion.title, suggestion.match?.matches ?? null)
    const note = suggestion.heading ? suggestion.file.basename : suggestion.file.parent?.path
    if (note && note !== '/') {
      content.createDiv({ cls: 'suggestion-note', text: suggestion.heading ? note : note + '/' })
    }
  }

  selectSuggestion (suggestion: LinkSuggestion) {
    if (!this.context) return
    const { editor, start, end, file } = this.context
    /*
    Always include the note name, even for headings in the current note: in Live Preview,
    captions are rendered without knowing which note they're in, so <<#Heading>> can't resolve.
    */
    let linktext = this.app.metadataCache.fileToLinktext(suggestion.file, file?.path ?? '', true)
    if (suggestion.heading !== undefined) linktext += '#' + suggestion.heading
    const link = `<<${linktext}>>`
    editor.replaceRange(link, start, end)
    editor.setCursor({ line: start.line, ch: start.ch + link.length })
  }
}
