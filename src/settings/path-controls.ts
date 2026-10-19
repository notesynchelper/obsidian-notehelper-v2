import { App, ExtraButtonComponent, Menu, TextComponent } from 'obsidian'
import type { Item } from '@omnivore-app/api'
import { FolderPickerModal } from './folder-picker'
import { render } from './template'
import { FolderSuggest } from './file-suggest'
import { addVariableButton, caretSelection } from './variable-controls'
import { t, tf } from '../i18n'
import {
  insertAtCursor,
  insertFolderVariable,
  pathVariableName,
  pathVariables,
  renderPathPreview,
  templateVariablesIn,
} from './path-variables'
export function addPathControls(
  app: App,
  text: TextComponent,
  opts: {
    key: string
    kind: 'folder' | 'filename'
    dateFormat: () => string
    item: () => Item
    /** Invented item shown (marked as example) when a variable is empty on the real one. */
    sample: () => Item
    fallback: () => string
  },
): () => void {
  const row = text.inputEl.closest('.setting-item') as HTMLElement
  const controls = row.querySelector('.setting-item-control') as HTMLElement
  row.dataset.pathKey = opts.key
  const info = row.querySelector('.setting-item-info')!
  const preview = info.createDiv({ cls: 'notehelper-path-preview' })
  const hint = info.createDiv({ cls: 'notehelper-path-hint' })
  const refresh = () => {
    hint.setText('')
    try {
      const path = renderPathPreview(
        opts.item(),
        text.getValue() || opts.fallback(),
        opts.dateFormat(),
        opts.kind,
      )
      preview.setText(
        tf('pathControls.preview', { path: path || t('pathControls.previewRoot') }),
      )
      preview.removeClass('is-error')
    } catch {
      preview.setText(t('pathControls.previewError'))
      preview.addClass('is-error')
    }
  }
  const selection = caretSelection(text.inputEl)
  const update = (value: string, cursor?: number) => {
    text.setValue(value)
    text.inputEl.dispatchEvent(new Event('input', { bubbles: true }))
    text.inputEl.focus()
    if (cursor !== undefined) text.inputEl.setSelectionRange(cursor, cursor)
    // Folder: a caret left by the code is not the user's, so the next variable becomes a new level again.
    if (opts.kind === 'folder') selection.forget()
    refresh()
  }
  if (opts.kind === 'folder') {
    new FolderSuggest(app, text.inputEl)
    new ExtraButtonComponent(controls)
      .setIcon('folder-open')
      .setTooltip(t('pathControls.pickFolder'))
      .onClick(() =>
        new FolderPickerModal(app, (path) => {
          const replaced = templateVariablesIn(text.getValue()).filter(
            (v) => !path.includes(v),
          )
          update(path)
          if (replaced.length)
            hint.setText(tf('pathControls.replacedVars', { vars: replaced.join(' ') }))
        }).open(),
      )
      .extraSettingsEl.addClass('notehelper-pick-folder')
  }
  const sampleOf = (value: string): string => {
    const renderWith = (item: Item) =>
      render(item, value, opts.dateFormat()).trim()
        ? renderPathPreview(item, value, opts.dateFormat(), opts.kind)
        : ''
    try {
      const real = renderWith(opts.item())
      if (real) return real
      const invented = renderWith(opts.sample())
      return invented ? invented + t('pathControls.sampleMark') : ''
    } catch {
      return ''
    }
  }
  addVariableButton(controls, () => {
    const current = text.getValue()
    const caret = selection.get()
    const menu = new Menu()
    let group = ''
    for (const variable of pathVariables()) {
      if (opts.kind === 'folder' && variable.group === 'title') continue
      if (group && group !== variable.group) menu.addSeparator()
      group = variable.group
      const sample = sampleOf(variable.value)
      menu.addItem((item) =>
        item
          .setTitle(sample ? `${pathVariableName(variable)} · ${sample}` : pathVariableName(variable))
          .onClick(() => {
            const inserted =
              opts.kind === 'folder'
                ? insertFolderVariable(current, variable.value, caret)
                : insertAtCursor(
                    current,
                    variable.value,
                    caret?.start ?? current.length,
                    caret?.end ?? current.length,
                  )
            update(inserted.value, inserted.cursor)
          }),
      )
    }
    const rect = text.inputEl.getBoundingClientRect()
    menu.showAtPosition({ x: rect.left, y: rect.bottom })
  })
  text.inputEl.addEventListener('input', refresh)
  // Bubble from any date-format input refreshes all examples in this settings view.
  const container = row.closest('.vertical-tab-content')
  container?.addEventListener('input', refresh)
  window.queueMicrotask(refresh)
  return () => container?.removeEventListener('input', refresh)
}
