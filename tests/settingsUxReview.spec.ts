const notices: string[] = []
jest.mock('obsidian', () => ({
  ...jest.requireActual('../src/__mocks__/obsidian'),
  Notice: class { constructor(message: string) { notices.push(message) } },
  FuzzySuggestModal: class {},
  ButtonComponent: class {},
  PluginSettingTab: class {},
  Setting: class {
    descEl = { createDiv: () => ({}) }
    setName() { return this }
    setDesc() { return this }
    addText() { return this }
    setHeading() { return this }
  },
}))
import { validateTemplate, validateDateFormat, flushValidationNotice } from '../src/settings/validation'
import { templateVariables } from '../src/settings/variable-controls'
import { OmnivoreSettingTab } from '../src/settingsTab'
import { DEFAULT_SETTINGS } from '../src/settings'
import { fetchVipStatus, verifyApiKey } from '../src/api'

jest.mock('../src/api', () => ({
  ...jest.requireActual('../src/api'),
  verifyApiKey: jest.fn(),
  fetchVipStatus: jest.fn(),
}))

const field = (tagName: string) => ({ tagName }) as unknown as Element
const focus = (el: Element | null) => {
  ;(globalThis as unknown as { document: { activeElement: Element | null } }).document = { activeElement: el }
}

describe('validation notices wait until the field loses focus', () => {
  beforeEach(() => { notices.length = 0; flushValidationNotice(); notices.length = 0 })
  afterAll(() => { delete (globalThis as { document?: unknown }).document })

  test('typing an invalid value is silent; leaving the field shows the error once', () => {
    const input = field('INPUT')
    focus(input)
    expect(validateTemplate('{{#a}}', 'F')).toBe(false)
    expect(notices).toEqual([])
    flushValidationNotice(field('TEXTAREA'))
    expect(notices).toEqual([])
    flushValidationNotice(input)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('F')
    flushValidationNotice(input)
    expect(notices).toHaveLength(1)
  })

  test('fixing or clearing the value before leaving drops the pending error', () => {
    const input = field('TEXTAREA')
    focus(input)
    validateTemplate('{{#a}}', 'F')
    validateTemplate('{{{title}}}', 'F')
    validateDateFormat('yyyy', 'D')
    validateTemplate('{{#a}}', 'F')
    validateTemplate('', 'F')
    flushValidationNotice(input)
    expect(notices).toEqual([])
  })

  test('without a focused text field the error shows immediately', () => {
    focus(null)
    expect(validateTemplate('{{#a}}', 'F')).toBe(false)
    expect(notices).toHaveLength(1)
  })

  test('closing settings shows every held error', () => {
    const a = field('INPUT'); const b = field('INPUT')
    focus(a); validateTemplate('{{#a}}', 'A')
    focus(b); validateTemplate('{{#b}}', 'B')
    flushValidationNotice()
    expect(notices).toHaveLength(2)
  })
})

describe('membership stays hidden without a verified key', () => {
  type TabHarness = {
    display(): void
    queueKeyValidation(value: string, status: HTMLElement): void
    plugin: { settings: typeof DEFAULT_SETTINGS }
    vipStatusContainer: HTMLElement
    renderVipStatus: jest.Mock
    createSection: jest.Mock
    containerEl: unknown
  }
  const makeTab = () => {
    const classes = new Set(['is-hidden'])
    const child = { setText: jest.fn(), addClass: jest.fn() }
    const container = {
      addClass: (name: string) => classes.add(name),
      removeClass: (name: string) => classes.delete(name),
      toggleClass: (name: string, enabled: boolean) => enabled ? classes.add(name) : classes.delete(name),
      querySelector: () => child,
    } as unknown as HTMLElement
    const tab = Object.assign(Object.create(OmnivoreSettingTab.prototype) as TabHarness, {
      plugin: { settings: { ...DEFAULT_SETTINGS } },
      vipStatusContainer: container,
      vipStatusReqSeq: 0,
      keySequence: 0,
      keyCache: new Map(),
      pathDisposers: [],
      renderVipStatus: jest.fn(),
    })
    const status = { setText: jest.fn(), dataset: {}, isConnected: true } as unknown as HTMLElement
    return { tab, classes, status }
  }
  beforeEach(() => { jest.useFakeTimers(); jest.clearAllMocks() })
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers() })

  test('initial render creates a hidden membership container before verification', () => {
    const { tab } = makeTab()
    tab.containerEl = { closest: () => null, scrollTop: 0, empty: jest.fn() }
    const stop = new Error('membership container captured')
    const createDiv = jest.fn(() => { throw stop })
    tab.createSection = jest.fn(() => ({ createDiv }))
    expect(() => tab.display()).toThrow(stop)
    expect(createDiv).toHaveBeenCalledWith({ cls: 'vip-status-container is-hidden' })
  })

  test('a valid key shows membership; clearing it hides it and ignores the late membership response', async () => {
    const { tab, classes, status } = makeTab()
    let resolveMembership!: (value: Awaited<ReturnType<typeof fetchVipStatus>>) => void
    jest.mocked(verifyApiKey).mockResolvedValue({ status: 'valid', count: 1 })
    jest.mocked(fetchVipStatus).mockImplementation(() => new Promise(resolve => { resolveMembership = resolve }))
    tab.plugin.settings.apiKey = 'o' + 'a'.repeat(27)
    tab.queueKeyValidation(tab.plugin.settings.apiKey, status)
    await jest.advanceTimersByTimeAsync(600)
    expect(classes.has('is-hidden')).toBe(false)
    expect(fetchVipStatus).toHaveBeenCalledTimes(1)
    tab.plugin.settings.apiKey = ''
    tab.queueKeyValidation('', status)
    expect(classes.has('is-hidden')).toBe(true)
    expect(classes.has('is-pending')).toBe(false)
    resolveMembership({ displayText: 'stale membership' } as Awaited<ReturnType<typeof fetchVipStatus>>)
    await Promise.resolve()
    expect(tab.renderVipStatus).not.toHaveBeenCalled()
    expect(classes.has('is-hidden')).toBe(true)
  })

  test('clearing the key also invalidates an outstanding verification', async () => {
    const { tab, classes, status } = makeTab()
    let resolveVerification!: (value: Awaited<ReturnType<typeof verifyApiKey>>) => void
    jest.mocked(verifyApiKey).mockImplementation(() => new Promise(resolve => { resolveVerification = resolve }))
    tab.plugin.settings.apiKey = 'o' + 'a'.repeat(27)
    tab.queueKeyValidation(tab.plugin.settings.apiKey, status)
    await jest.advanceTimersByTimeAsync(600)
    tab.plugin.settings.apiKey = ''
    tab.queueKeyValidation('', status)
    resolveVerification({ status: 'valid', count: 1 })
    await Promise.resolve()
    expect(fetchVipStatus).not.toHaveBeenCalled()
    expect(status.dataset.state).toBe('empty')
    expect(classes.has('is-hidden')).toBe(true)
  })
})

test('template variable pickers list common variables first and hide rarely filled date groups', () => {
  for (const kind of ['diary', 'assistant', 'timestamp', 'note'] as const) {
    const values = templateVariables(kind).map(v => v.value)
    expect(values.join(' ')).not.toMatch(/Published|Read|Archived|Updated/)
    expect(new Set(templateVariables(kind).map(v => v.name + v.value)).size).toBe(values.length)
  }
  expect(templateVariables('note').map(v => v.value).join(' ')).not.toContain('savedAt')
  expect(templateVariables('assistant')[0].value).toBe('{{{content}}}')
  expect(templateVariables('diary')[0].value).toBe('{{{link}}}')
  expect(templateVariables('note').slice(0, 2).map(v => v.value)).toEqual(['{{{title}}}', '{{{content}}}'])
})
