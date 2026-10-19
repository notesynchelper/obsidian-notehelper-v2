import { requestUrl } from 'obsidian'
import { downloadAttachment } from '../src/attachmentLocalizer/attachmentDownloader'

jest.mock('obsidian', () => ({ ...jest.requireActual('obsidian'), requestUrl: jest.fn() }))

const html = '<!doctype html><html><head><title>Rewritten library report</title></head><body><table><tr><td>QY-111</td></tr></table></body></html>'
const response = () => ({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, text: html, arrayBuffer: new TextEncoder().encode(html).buffer })
beforeEach(() => (requestUrl as jest.Mock).mockReset())

test.each(['https://files.example.invalid/reports/library.html', 'https://files.example.invalid/report.HTM?download=1', 'https://files.example.invalid/report.xhtml'])('explicit HTML attachment is saved: %s', async url => {
  ;(requestUrl as jest.Mock).mockResolvedValue(response())
  const result = await downloadAttachment(url, 0, 0)
  expect(result.success).toBe(true)
  expect(new TextDecoder().decode(result.data)).toBe(html)
})

test.each(['https://files.example.invalid/report.pdf', 'https://files.example.invalid/report.pdf?filename=report.html', 'https://files.example.invalid/report.docx'])('HTML masquerading as a document remains rejected: %s', async url => {
  ;(requestUrl as jest.Mock).mockResolvedValue(response())
  const result = await downloadAttachment(url, 0, 0)
  expect(result.success).toBe(false)
  expect(result.error).toContain('占位/登录页')
})

test('HTML download redirected to a network login remains retryable', async () => {
  const portal = '<!doctype html><html><head><title>Wi-Fi Login</title></head><body><form action="/portal/login"><input name="username"><input type="password" name="password"><button>Sign in to network</button></form></body></html>'
  ;(requestUrl as jest.Mock).mockResolvedValue({ ...response(), text: portal, arrayBuffer: new TextEncoder().encode(portal).buffer })
  const result = await downloadAttachment('https://portal.example.invalid/download.html', 0, 0)
  expect(result.success).toBe(false)
  expect(result.expired).not.toBe(true)
  expect(result.error).toContain('占位/登录页')
})

test('login analytics and password examples in an HTML report remain valid', async () => {
  const report = '<!doctype html><html><head><title>Login analytics report</title></head><body><h1>Login metrics</h1><table><tr><td>Successful logins</td><td>47</td></tr></table><pre>&lt;form&gt;&lt;input type="password"&gt;&lt;/form&gt;</pre></body></html>'
  ;(requestUrl as jest.Mock).mockResolvedValue({ ...response(), text: report, arrayBuffer: new TextEncoder().encode(report).buffer })
  const result = await downloadAttachment('https://report.example.invalid/report.html', 0, 0)
  expect(result.success).toBe(true)
  expect(new TextDecoder().decode(result.data)).toBe(report)
})
