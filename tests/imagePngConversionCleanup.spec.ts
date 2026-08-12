jest.mock('../src/logger', () => ({
  log: jest.fn(),
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  Logger: { setDevMode: jest.fn() },
}))

import { convertPngToJpeg } from '../src/imageLocalizer/imageProcessor'

class LoadedImage {
  width = 1
  height = 1
  onload: (() => void) | null = null
  onerror: (() => void) | null = null

  set src(_value: string) {
    this.onload?.()
  }
}

describe('PNG 转换失败路径释放 Blob URL', () => {
  const imageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Image')
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')

  beforeEach(() => {
    Object.defineProperty(globalThis, 'Image', {
      configurable: true,
      value: LoadedImage,
    })
    jest.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test')
    jest.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  })

  afterEach(() => {
    jest.restoreAllMocks()
    if (imageDescriptor) {
      Object.defineProperty(globalThis, 'Image', imageDescriptor)
    } else {
      delete (globalThis as { Image?: unknown }).Image
    }
    if (documentDescriptor) {
      Object.defineProperty(globalThis, 'document', documentDescriptor)
    } else {
      delete (globalThis as { document?: unknown }).document
    }
  })

  test('Canvas context 创建失败时仍 revoke', async () => {
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        createElement: jest.fn(() => ({
          width: 0,
          height: 0,
          getContext: () => null,
        })),
      },
    })

    await expect(convertPngToJpeg(new ArrayBuffer(8))).rejects.toThrow(
      '无法创建 Canvas 上下文',
    )
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test')
  })

  test('Canvas toBlob 返回 null 时仍 revoke', async () => {
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        createElement: jest.fn(() => ({
          width: 0,
          height: 0,
          getContext: () => ({
            fillStyle: '',
            fillRect: jest.fn(),
            drawImage: jest.fn(),
          }),
          toBlob: (callback: (blob: Blob | null) => void) => callback(null),
        })),
      },
    })

    await expect(convertPngToJpeg(new ArrayBuffer(8))).rejects.toThrow(
      '转换 JPEG 失败',
    )
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test')
  })
})
