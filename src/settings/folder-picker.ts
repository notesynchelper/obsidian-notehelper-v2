import {
  App,
  FuzzyMatch,
  FuzzySuggestModal,
  Notice,
  TFolder,
  normalizePath,
} from 'obsidian'
import { t, tf } from '../i18n'
interface NewFolder {
  path: string
  create: boolean
}
export class FolderPickerModal extends FuzzySuggestModal<TFolder | NewFolder> {
  constructor(
    app: App,
    private readonly pick: (path: string) => void,
  ) {
    super(app)
    this.setPlaceholder(t('pathControls.pickerPlaceholder'))
  }
  getItems(): (TFolder | NewFolder)[] {
    return this.app.vault
      .getAllLoadedFiles()
      .filter((f): f is TFolder => f instanceof TFolder)
  }
  getItemText(item: TFolder | NewFolder): string {
    return item.path || '/'
  }
  getSuggestions(query: string): FuzzyMatch<TFolder | NewFolder>[] {
    const matches = super.getSuggestions(query)
    const path = normalizePath(query.trim())
    if (path && path !== '/' && !this.app.vault.getAbstractFileByPath(path)) {
      const match = { score: 0, matches: [] }
      matches.push({ item: { path, create: false }, match })
      // A path containing variables is only meaningful as a template, never as a real folder.
      if (!path.includes('{{'))
        matches.push({ item: { path, create: true }, match })
    }
    return matches
  }
  renderSuggestion(
    result: FuzzyMatch<TFolder | NewFolder>,
    el: HTMLElement,
  ): void {
    const item = result.item
    if (item instanceof TFolder) super.renderSuggestion(result, el)
    else
      el.setText(
        tf(item.create ? 'pathControls.createFolder' : 'pathControls.useNewPath', {
          path: item.path,
        }),
      )
  }
  onChooseItem(item: TFolder | NewFolder): void {
    if (item instanceof TFolder || !item.create) {
      this.pick(item.path === '/' ? '' : item.path)
      return
    }
    this.app.vault.createFolder(item.path).then(
      () => this.pick(item.path),
      (e: unknown) =>
        new Notice(
          tf('pathControls.createFailed', {
            error: e instanceof Error ? e.message : String(e),
          }),
        ),
    )
  }
}
