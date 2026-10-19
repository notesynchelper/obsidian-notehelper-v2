import {
  App,
  ButtonComponent,
  FuzzySuggestModal,
  TextAreaComponent,
} from 'obsidian'
import { t, type TKey } from '../i18n'
import { insertAtCursor } from './path-variables'

export function addVariableButton(
  container: HTMLElement,
  onClick: () => void,
): ButtonComponent {
  const button = new ButtonComponent(container)
    .setButtonText(t('pathControls.variableButton'))
    .setTooltip(t('pathControls.variableTooltip'))
    .onClick(onClick)
  button.buttonEl.addClass('notehelper-insert-variable')
  button.buttonEl.type = 'button'
  return button
}

/**
 * Caret the user placed in the field, or null when they have not placed one —
 * callers then insert at the end. `forget()` after a programmatic edit so the
 * next insertion is not pinned to where the code left the caret.
 */
export function caretSelection(el: HTMLInputElement | HTMLTextAreaElement): {
  get: () => { start: number; end: number } | null
  forget: () => void
} {
  let placed = false
  el.addEventListener('focus', () => {
    placed = true
  })
  return {
    get: () =>
      placed && el.selectionStart !== null
        ? { start: el.selectionStart, end: el.selectionEnd ?? el.selectionStart }
        : null,
    forget: () => {
      placed = false
    },
  }
}

/** diary / assistant / timestamp: existing templates; note: standalone message front matter + body. */
export type TemplateKind = 'diary' | 'assistant' | 'timestamp' | 'note'
interface Variable {
  name: string
  value: string
}

export function templateVariables(kind: TemplateKind): Variable[] {
  const variables: Variable[] = []
  const add = (key: string, label: TKey, value = `{{{${key}}}}`) => {
    variables.push({ name: t(label), value })
  }
  const placeholder = t('templateVars.placeholder')
  const savedTime = () => {
    add('timeSaved', 'templateVars.timeSaved')
    add('timeSavedShort', 'templateVars.timeSavedShort')
    add('dateSaved', 'templateVars.dateSaved')
  }
  if (kind === 'diary') {
    add('link', 'templateVars.link')
    savedTime()
    add('title', 'templateVars.linkTitle')
    add('isMessage', 'templateVars.onlyMessage', `{{#isMessage}}${placeholder}{{/isMessage}}`)
    add('isMessage', 'templateVars.onlyArticle', `{{^isMessage}}${placeholder}{{/isMessage}}`)
    add('target', 'templateVars.target')
    add('anchor', 'templateVars.anchor')
    add('heading', 'templateVars.heading')
  } else if (kind === 'assistant') {
    add('content', 'templateVars.content')
    savedTime()
    add('title', 'templateVars.title')
    add('messageTitle', 'templateVars.messageTitle')
    add('messageType', 'templateVars.messageType')
    add('heading', 'templateVars.messageHeading')
    add('rawTitle', 'templateVars.rawTitle')
    add('labels', 'templateVars.labels', '{{#labels}}#{{{name}}} {{/labels}}')
    add('id', 'templateVars.id')
  } else if (kind === 'note') {
    add('title', 'templateVars.title')
    add('content', 'templateVars.noteContent')
    savedTime()
    add('messageType', 'templateVars.messageType')
    add('rawTitle', 'templateVars.rawTitle')
    add('author', 'templateVars.author')
    add('siteName', 'templateVars.siteName')
    add('originalUrl', 'templateVars.originalUrl')
    add('labels', 'templateVars.labels', '{{#labels}}#{{{name}}} {{/labels}}')
    add('id', 'templateVars.id')
  } else {
    add('time', 'templateVars.time')
    add('timeShort', 'templateVars.timeShort')
    add('date', 'templateVars.date')
    add('timestamp', 'templateVars.timestamp')
  }
  if (kind !== 'timestamp') {
    add('date', 'templateVars.dateAlias')
    add('yearSaved', 'templateVars.yearSaved')
    add('monthSaved', 'templateVars.monthSaved')
    add('daySaved', 'templateVars.daySaved')
  }
  // Note templates render through renderItemContent, whose view has no raw savedAt.
  if (kind === 'diary' || kind === 'assistant') add('savedAt', 'templateVars.savedAt')
  const date =
    kind === 'timestamp' ? 'timestamp' : kind === 'note' ? 'dateSaved' : 'savedAt'
  const text =
    kind === 'timestamp'
      ? 'timestamp'
      : kind === 'diary' || kind === 'note'
        ? 'title'
        : 'content'
  add('formatDate', 'templateVars.formatDate', `{{#formatDate}}{{${date}}},HH:mm{{/formatDate}}`)
  add('indent', 'templateVars.indent', `{{#indent}}{{{${text}}}}{{/indent}}`)
  add('oneLine', 'templateVars.oneLine', `{{#oneLine}}{{{${text}}}}{{/oneLine}}`)
  add('upperCase', 'templateVars.upperCase', `{{#upperCase}}{{{${text}}}}{{/upperCase}}`)
  add('lowerCase', 'templateVars.lowerCase', `{{#lowerCase}}{{{${text}}}}{{/lowerCase}}`)
  add(
    'upperCaseFirst',
    'templateVars.upperCaseFirst',
    `{{#upperCaseFirst}}{{{${text}}}}{{/upperCaseFirst}}`,
  )
  add(
    'mapValue',
    'templateVars.mapValue',
    `{{#mapValue}}{{{${text}}}}|${t('templateVars.mapRule')}{{/mapValue}}`,
  )
  add('extract', 'templateVars.extract', `{{#extract}}{{{${text}}}}|(.+)|$1{{/extract}}`)
  return variables
}

class TemplateVariablePicker extends FuzzySuggestModal<Variable> {
  constructor(
    app: App,
    private variables: Variable[],
    private select: (value: string) => void,
  ) {
    super(app)
    this.setPlaceholder(t('pathControls.variableSearch'))
  }
  getItems(): Variable[] {
    return this.variables
  }
  getItemText(item: Variable): string {
    return `${item.name} · ${item.value}`
  }
  onChooseItem(item: Variable): void {
    this.select(item.value)
  }
}

export function addTemplateVariableButton(
  app: App,
  text: TextAreaComponent,
  kind: TemplateKind,
): void {
  const row = text.inputEl.closest('.setting-item') as HTMLElement
  row.addClass('notehelper-template-variable-row')
  row.dataset.templateKind = kind
  const selection = caretSelection(text.inputEl)
  addVariableButton(
    row.querySelector('.setting-item-control') as HTMLElement,
    () => {
      const current = text.getValue()
      const caret = selection.get()
      new TemplateVariablePicker(app, templateVariables(kind), (value) => {
        const inserted = insertAtCursor(
          current,
          value,
          caret?.start ?? current.length,
          caret?.end ?? current.length,
        )
        text.setValue(inserted.value)
        text.inputEl.dispatchEvent(new Event('input', { bubbles: true }))
        text.inputEl.focus()
        text.inputEl.setSelectionRange(inserted.cursor, inserted.cursor)
      }).open()
    },
  )
}
