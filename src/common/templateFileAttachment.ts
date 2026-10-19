import { parseYaml, stringifyYaml } from 'obsidian'
import { calculateHexMD5 } from './vaultStore'

export interface TemplateFileAttachment {
  version: 1
  url: string
  folder: string
  fileName: string
  savedAt?: string
  placeholder: string
}
export interface TemplateFileReference extends TemplateFileAttachment { marker: string }

/** A local path until verified bytes are available; the source stays in the note. */
export function prepareTemplateFileAttachment(input: Omit<TemplateFileAttachment, 'version' | 'placeholder'>, revision: string): TemplateFileAttachment {
  const identity = calculateHexMD5(new TextEncoder().encode(JSON.stringify([input, revision])))
  return { ...input, version: 1, placeholder: `notehelper-pending/${identity}.pdf` }
}

export function withTemplateFileAttachment(content: string, reference?: TemplateFileAttachment): string {
  if (!reference || !content.includes(reference.placeholder)) return content
  return `${content}\n<!-- notehelper-file:${encodeURIComponent(JSON.stringify(reference))} -->\n`
}

export function scanTemplateFileAttachments(content: string): TemplateFileReference[] {
  const result: TemplateFileReference[] = []
  for (const match of content.matchAll(/<!-- notehelper-file:([^\s]+) -->/g)) {
    try {
      const value = JSON.parse(decodeURIComponent(match[1])) as TemplateFileAttachment
      if (value.version !== 1 || typeof value.url !== 'string' || !/^https?:\/\//i.test(value.url)) continue
      if (typeof value.placeholder !== 'string' || !/^notehelper-pending\/[0-9a-f]{32}\.pdf$/.test(value.placeholder)) continue
      if (typeof value.folder !== 'string' || /^(?:\/|[a-z]:)/i.test(value.folder) || value.folder.split(/[\\/]/).includes('..')) continue
      if (typeof value.fileName !== 'string' || !value.fileName || /[\\/]/.test(value.fileName)) continue
      if (!content.includes(value.placeholder)) continue
      result.push({ ...value, marker: match[0] })
    } catch { /* A malformed/user-edited descriptor is never a download instruction. */ }
  }
  return result
}

/** Preserve latest editor content; replace only the descriptor's unique path. */
export function replaceTemplateFileAttachment(content: string, reference: TemplateFileReference, target: string): string {
  if (!content.includes(reference.marker)) return content
  const replace = (value: string) => value.split(reference.placeholder).join(target)
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (fm?.[1].includes(reference.placeholder)) {
    const walk = (value: unknown): unknown => {
      if (typeof value === 'string') return replace(value)
      if (Array.isArray(value)) return value.map(walk)
      if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
        return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, walk(v)]))
      }
      return value
    }
    const yaml = stringifyYaml(walk(parseYaml(fm[1])))
    content = `---\n${yaml.trimEnd()}\n---\n${content.slice(fm[0].length)}`
  }
  return replace(content).split(reference.marker).join('')
}
