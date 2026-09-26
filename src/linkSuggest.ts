import {
  App,
  Editor,
  EditorPosition,
  EditorSuggest,
  EditorSuggestContext,
  EditorSuggestTriggerInfo,
  Pos,
  prepareFuzzySearch,
  renderMatches,
  SearchResult,
  TFile
} from 'obsidian'

const maxSuggestions = 50
const mediaExtensions = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', 'avif', 'mp4', 'webm', 'ogv', 'mov', 'mkv']

// Section types which can't be linked to as a block
const nonBlockSections = ['yaml', 'heading', 'thematicBreak']
const maxBlockTextLength = 300

const noteInstructions = [
  { command: 'Type #', purpose: 'to link heading' },
  { command: 'Type ^', purpose: 'to link blocks' },
  { command: 'Type |', purpose: 'to change display text' }
]
const acceptInstructions = [{ command: '↵', purpose: 'to accept' }]

interface BlockInfo {
  // The existing block ID, if the block already has one
  id?: string;
  startLine: number;
  endLine: number;
  // The text of the last line, to find the block again if lines have moved since
  lastLine: string;
  // Paragraphs and list items take the ID at the end of their last line; other blocks,
  // such as tables and quotes, need it on its own line after the block
  inline: boolean;
}

interface LinkSuggestion {
  file: TFile;
  heading?: string;
  level?: number;
  block?: BlockInfo;
  title: string;
  match: SearchResult | null;
}

interface ParsedQuery {
  kind: 'note' | 'heading' | 'block';
  linkpath: string;
  // The text typed after # or ^
  search: string;
}

/**
 * Split what's been typed after << into the note name and any heading or block search:
 * "Note", "Note#Heading", or "Note^block" / "Note#^block".
 */
function parseQuery (query: string): ParsedQuery {
  const hash = query.indexOf('#')
  const caret = query.indexOf('^')
  if (caret !== -1 && (hash === -1 || caret <= hash + 1)) {
    const linkpath = query.slice(0, hash !== -1 && hash < caret ? hash : caret)
    return { kind: 'block', linkpath, search: query.slice(caret + 1) }
  } else if (hash !== -1) {
    return { kind: 'heading', linkpath: query.slice(0, hash), search: query.slice(hash + 1) }
  }
  return { kind: 'note', linkpath: query, search: '' }
}

/**
 * Suggest notes after `<<` is typed in an image caption, headings after `#`, and blocks after `^`,
 * the same way Obsidian suggests them after `[[` elsewhere. Wikilinks in captions have to be written with
 * angle brackets, e.g. ![[image.jpg|See <<My note>>]], which Obsidian's own suggestions don't cover.
 */
export class CaptionLinkSuggest extends EditorSuggest<LinkSuggestion> {
  constructor (app: App) {
    super(app)
    this.limit = maxSuggestions
    this.setInstructions(noteInstructions)
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
    if (query.includes('>>') || query.includes('|')) return null
    // Only when # or ^ has just been typed, not when moving the cursor into an existing <<Note#Heading>>
    const linkpath = query.slice(0, -1)
    if (linkpath && /[#^]$/.test(query) && !/[#^]/.test(linkpath) && /^(>>|\\?\||\]\]|$)/.test(line.slice(cursor.ch))) {
      this.completeNoteName(editor, cursor, linkpath, file)
    }
    // When editing an existing <<link>>, replace the rest of it as well
    const rest = line.slice(cursor.ch).match(/^[^<>|\]]*>>/)
    return {
      start: { line: cursor.line, ch: linkStart },
      end: { line: cursor.line, ch: cursor.ch + (rest ? rest[0].length : 0) },
      query
    }
  }

  /**
   * Like Obsidian's own suggestions, typing # or ^ straight after a partial note name completes
   * the name, e.g. <<loops# becomes <<Loops - Thinking Outside Your Head#
   */
  completeNoteName (editor: Editor, cursor: EditorPosition, linkpath: string, currentFile: TFile | null) {
    const sourcePath = currentFile?.path ?? ''
    if (this.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath)) return
    const note = this.getBestNote(linkpath)
    if (!note) return
    const linktext = this.app.metadataCache.fileToLinktext(note, sourcePath, true)
    const from = { line: cursor.line, ch: cursor.ch - 1 - linkpath.length }
    const to = { line: cursor.line, ch: cursor.ch - 1 }
    // The editor can't be changed while it is still processing the keystroke that triggered this
    window.setTimeout(() => {
      if (editor.getRange(from, to) === linkpath) editor.replaceRange(linktext, from, to)
    })
  }

  /**
   * The note suggested first for a partial name. Attachments are skipped, as they have no headings.
   */
  getBestNote (linkpath: string): TFile | undefined {
    return this.getFileSuggestions(linkpath).find(suggestion => suggestion.file.extension === 'md')?.file
  }

  /**
   * The note whose headings or blocks to suggest. An empty name, as in <<#Heading, means the
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
    if (query.kind === 'heading') {
      return this.getHeadingSuggestions(query.linkpath, query.search, context.file)
    } else if (query.kind === 'block') {
      return this.getBlockSuggestions(query.linkpath, query.search, context)
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
    if (!file) return []
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

  /**
   * Suggest the paragraphs, list items and other blocks of a note, using their text.
   */
  async getBlockSuggestions (linkpath: string, query: string, context: EditorSuggestContext): Promise<LinkSuggestion[]> {
    const file = this.resolveNote(linkpath, context.file)
    if (!file || file.extension !== 'md') return []
    const cache = this.app.metadataCache.getFileCache(file)
    const content = await this.app.vault.cachedRead(file)
    const inCurrentNote = file.path === context.file?.path
    const blocks: { block: BlockInfo, text: string }[] = []
    const addBlock = (position: Pos, id: string | undefined, inline: boolean) => {
      const lastLine = content.split('\n')[position.end.line] ?? ''
      const block = { id, startLine: position.start.line, endLine: position.end.line, lastLine, inline }
      // Skip the block with the caption being typed, which can't sensibly link to itself
      if (inCurrentNote && block.startLine <= context.start.line && context.start.line <= block.endLine) return
      const text = content.slice(position.start.offset, position.end.offset)
        .replace(/\s\^[\w-]+\s*$/, '')
        .replace(/^\s*([-*+]|\d+[.)])\s+(\[.\]\s+)?/, '')
        .replace(/^\s*>\s?/gm, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxBlockTextLength)
      if (text) blocks.push({ block, text })
    }
    for (const section of cache?.sections ?? []) {
      if (nonBlockSections.includes(section.type)) continue
      if (section.type === 'list') {
        // Each list item can be linked to on its own
        for (const item of cache?.listItems ?? []) {
          if (item.position.start.line >= section.position.start.line && item.position.end.line <= section.position.end.line) {
            addBlock(item.position, item.id, true)
          }
        }
      } else {
        addBlock(section.position, section.id, section.type === 'paragraph')
      }
    }
    const search = query.trim() ? prepareFuzzySearch(query.trim()) : null
    const results: LinkSuggestion[] = []
    for (const { block, text } of blocks) {
      const match = search ? search(text) : null
      if (!search || match) results.push({ file, block, title: text, match })
    }
    if (search) results.sort((a, b) => (b.match?.score ?? 0) - (a.match?.score ?? 0))
    return results.slice(0, maxSuggestions)
  }

  renderSuggestion (suggestion: LinkSuggestion, el: HTMLElement) {
    el.addClass('mod-complex')
    const content = el.createDiv({ cls: 'suggestion-content' })
    renderMatches(content.createDiv({ cls: 'suggestion-title' }), suggestion.title, suggestion.match?.matches ?? null)
    if (suggestion.heading !== undefined) {
      // Headings show their level on the right, e.g. H2, as in Obsidian's own suggestions
      el.createDiv({ cls: 'suggestion-aux' }).createSpan({ cls: 'suggestion-flair', text: 'H' + suggestion.level })
    } else if (!suggestion.block && suggestion.file.parent && !suggestion.file.parent.isRoot()) {
      content.createDiv({ cls: 'suggestion-note', text: suggestion.file.parent.path + '/' })
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
    if (suggestion.block) linktext += '#^' + (suggestion.block.id ?? this.addBlockId(suggestion.file, suggestion.block, editor, file))
    const link = `<<${linktext}>>`
    editor.replaceRange(link, start, end)
    editor.setCursor({ line: start.line, ch: start.ch + link.length })
  }

  /**
   * Blocks without an ID get a new random one written into the note, as Obsidian does when
   * linking to a block. Returns the new ID.
   */
  addBlockId (target: TFile, block: BlockInfo, editor: Editor, currentFile: TFile | null): string {
    const existing = this.app.metadataCache.getFileCache(target)?.blocks ?? {}
    let id = ''
    while (!id || existing[id]) id = Math.random().toString(36).slice(2, 8)
    // If lines have moved since the suggestions were made, find the block again by its last line
    const findLine = (lines: string[]) => lines[block.endLine] === block.lastLine ? block.endLine : lines.indexOf(block.lastLine)
    if (target.path === currentFile?.path) {
      // For the note being edited, change it through the editor so the edit isn't lost
      const line = findLine(editor.getValue().split('\n'))
      if (line === -1) return id
      const insert = blockIdInsertion(editor.getLine(line), editor.getLine(line + 1), block.inline, id)
      editor.replaceRange(insert.text, { line, ch: insert.from }, { line, ch: insert.to })
    } else {
      void this.app.vault.process(target, data => {
        const lines = data.split('\n')
        const line = findLine(lines)
        if (line === -1) return data
        const insert = blockIdInsertion(lines[line], lines[line + 1], block.inline, id)
        lines[line] = lines[line].slice(0, insert.from) + insert.text + lines[line].slice(insert.to)
        return lines.join('\n')
      })
    }
    return id
  }
}

/**
 * Where and what to insert on a block's last line to give it an ID. Paragraphs and list items
 * take it at the end of the line; other blocks get it on its own line after the block, with a
 * blank line so it doesn't join the block, or the one after it.
 */
export function blockIdInsertion (lastLine: string, nextLine: string | undefined, inline: boolean, id: string): { from: number, to: number, text: string } {
  const lineEnding = lastLine.endsWith('\r') ? '\r' : ''
  const content = lastLine.slice(0, lastLine.length - lineEnding.length)
  if (inline) {
    const trimmed = content.replace(/\s*$/, '')
    return { from: trimmed.length, to: content.length, text: ' ^' + id }
  }
  const newline = lineEnding + '\n'
  const text = newline + newline + '^' + id + (nextLine?.trim() ? newline : '')
  return { from: content.length, to: content.length, text }
}
