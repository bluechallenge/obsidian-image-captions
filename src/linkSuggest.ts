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
  setIcon,
  TFile
} from 'obsidian'

const maxSuggestions = 50
const mediaExtensions = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', 'avif', 'mp4', 'webm', 'ogv', 'mov', 'mkv']

const noteInstructions = [
  { command: 'Type #', purpose: 'to link heading' },
  { command: 'Type |', purpose: 'to change display text' }
]
const acceptInstructions = [{ command: '↵', purpose: 'to accept' }]

interface LinkSuggestion {
  // Null only for display text on a link to a note which doesn't exist yet
  file: TFile | null;
  heading?: string;
  level?: number;
  // For display text, the link target (e.g. "Note#Heading") and the text typed after |
  alias?: { target: string, text: string };
  title: string;
  match: SearchResult | null;
}

interface ParsedQuery {
  kind: 'note' | 'heading' | 'alias';
  // The note name, or for display text the whole link target, e.g. "Note#Heading"
  linkpath: string;
  // The text typed after # or |
  search: string;
}

/**
 * Split what's been typed after << into the note name and any heading search or display text:
 * "Note", "Note#Heading", or "Note#Heading|Display text".
 */
function parseQuery (query: string): ParsedQuery {
  const pipe = query.indexOf('|')
  if (pipe !== -1) return { kind: 'alias', linkpath: query.slice(0, pipe), search: query.slice(pipe + 1) }
  const hash = query.indexOf('#')
  if (hash !== -1) {
    return { kind: 'heading', linkpath: query.slice(0, hash), search: query.slice(hash + 1) }
  }
  return { kind: 'note', linkpath: query, search: '' }
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
    this.setInstructions(noteInstructions)
    // Tab completes a partial note name and moves on to the display text, like typing |
    this.scope.register([], 'Tab', () => {
      if (!this.context) return
      const { editor, start, file } = this.context
      const query = parseQuery(this.context.query)
      if (query.kind !== 'note' || !query.linkpath) return
      const from = start.ch + 2
      this.completeNoteName(editor, start.line, from, from + query.linkpath.length, query.linkpath, file, true)
      const cursor = editor.getCursor()
      editor.replaceRange('|', cursor)
      editor.setCursor({ line: cursor.line, ch: cursor.ch + 1 })
      return false
    })
  }

  onTrigger (cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTriggerInfo | null {
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
    /*
    Typing # or | straight after a partial note name completes the name, as in Obsidian's own
    suggestions - but not when moving the cursor into an existing <<Note#Heading>>
    */
    const linkpath = query.slice(0, -1)
    if (linkpath && /[#|]$/.test(query) && !/[#|>]/.test(linkpath) && /^(>>|\\?\||\]\]|$)/.test(line.slice(cursor.ch))) {
      const from = linkStart + 2
      // Headings need a note, but a display text can be given for any file
      window.setTimeout(() => this.completeNoteName(editor, cursor.line, from, from + linkpath.length, linkpath, file, query.endsWith('|')))
    }
    if (query.includes('>>') || query.split('|').length > 2) return null
    // When editing an existing <<link>>, replace the rest of it as well
    const rest = line.slice(cursor.ch).match(/^[^<>|\]]*>>/)
    return {
      start: { line: cursor.line, ch: linkStart },
      end: { line: cursor.line, ch: cursor.ch + (rest ? rest[0].length : 0) },
      query
    }
  }

  /**
   * Replace a partial note name with the full name of the best match, e.g. "loops" becomes
   * "Loops - Thinking Outside Your Head". Names which already match a file are left alone.
   * This can't run while the editor is still processing a keystroke, so onTrigger delays it.
   */
  completeNoteName (editor: Editor, line: number, from: number, to: number, linkpath: string, currentFile: TFile | null, anyFile: boolean) {
    const sourcePath = currentFile?.path ?? ''
    if (this.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath)) return
    const file = anyFile ? this.getFileSuggestions(linkpath)[0]?.file : this.getBestNote(linkpath)
    if (!file) return
    const range = { from: { line, ch: from }, to: { line, ch: to } }
    if (editor.getRange(range.from, range.to) !== linkpath) return
    editor.replaceRange(this.app.metadataCache.fileToLinktext(file, sourcePath, true), range.from, range.to)
  }

  /**
   * The note suggested first for a partial name, skipping attachments as they have no headings.
   */
  getBestNote (linkpath: string): TFile | undefined {
    return this.getFileSuggestions(linkpath).find(suggestion => suggestion.file?.extension === 'md')?.file ?? undefined
  }

  /**
   * The note whose headings to suggest. An empty name, as in <<#Heading, means the
   * current note. A partial name, such as <<loo#Head, uses the best matching note, in case the
   * name wasn't completed when # was typed.
   */
  resolveNote (linkpath: string, currentFile: TFile | null): TFile | null | undefined {
    return linkpath
      ? this.app.metadataCache.getFirstLinkpathDest(linkpath, currentFile?.path ?? '') ?? this.getBestNote(linkpath)
      : currentFile
  }

  getSuggestions (context: EditorSuggestContext): LinkSuggestion[] | Promise<LinkSuggestion[]> {
    const query = parseQuery(context.query)
    this.setInstructions(query.kind === 'note' ? noteInstructions : acceptInstructions)
    if (query.kind === 'alias') {
      const file = this.app.metadataCache.getFirstLinkpathDest(query.linkpath.replace(/#.*$/, ''), context.file?.path ?? '')
      const text = query.search.trim()
      return [{ file, alias: { target: query.linkpath, text }, title: text || 'Display text', match: null }]
    } else if (query.kind === 'heading') {
      return this.getHeadingSuggestions(query.linkpath, query.search, context.file)
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
    const file = this.resolveNote(linkpath, currentFile)
    // Block links (^) aren't suggested
    if (!file || query.startsWith('^')) return []
    const headings = this.app.metadataCache.getFileCache(file)?.headings ?? []
    const search = query.trim() ? prepareFuzzySearch(query.trim()) : null
    const results: LinkSuggestion[] = []
    for (const { heading, level } of headings) {
      const match = search ? search(heading) : null
      if (!search || match) results.push({ file, heading, level, title: heading, match })
    }
    if (search) results.sort((a, b) => (b.match?.score ?? 0) - (a.match?.score ?? 0))
    return results
  }

  renderSuggestion (suggestion: LinkSuggestion, el: HTMLElement) {
    el.addClass('mod-complex')
    const content = el.createDiv({ cls: 'suggestion-content' })
    renderMatches(content.createDiv({ cls: 'suggestion-title' }), suggestion.title, suggestion.match?.matches ?? null)
    if (suggestion.alias) {
      // Display text shows the link target underneath, and an arrow, as in Obsidian's own suggestions
      content.createDiv({ cls: 'suggestion-note', text: suggestion.alias.target })
      setIcon(el.createDiv({ cls: 'suggestion-aux' }).createSpan({ cls: 'suggestion-flair' }), 'forward')
    } else if (suggestion.heading !== undefined) {
      // Headings show their level on the right, e.g. H2, as in Obsidian's own suggestions
      el.createDiv({ cls: 'suggestion-aux' }).createSpan({ cls: 'suggestion-flair', text: 'H' + suggestion.level })
    } else if (suggestion.file?.parent && !suggestion.file.parent.isRoot()) {
      content.createDiv({ cls: 'suggestion-note', text: suggestion.file.parent.path + '/' })
    }
  }

  selectSuggestion (suggestion: LinkSuggestion) {
    if (!this.context) return
    const { editor, start, end, file } = this.context
    if (suggestion.alias) {
      const { target, text } = suggestion.alias
      this.insertLink(editor, start, end, text ? `${target}|${text}` : target)
      return
    }
    if (!suggestion.file) return
    /*
    Always include the note name, even for headings in the current note: in Live Preview,
    captions are rendered without knowing which note they're in, so <<#Heading>> can't resolve.
    */
    let linktext = this.app.metadataCache.fileToLinktext(suggestion.file, file?.path ?? '', true)
    if (suggestion.heading !== undefined) linktext += '#' + suggestion.heading
    this.insertLink(editor, start, end, linktext)
  }

  insertLink (editor: Editor, start: EditorPosition, end: EditorPosition, linktext: string) {
    const link = `<<${linktext}>>`
    editor.replaceRange(link, start, end)
    editor.setCursor({ line: start.line, ch: start.ch + link.length })
  }
}
