/**
 * 图片处理器
 * 负责 MD5 计算、格式检测、PNG→JPEG 转换
 */

import { calculateHexMD5 } from '../common/vaultStore'
const MD5_SAMPLE_SIZE = 15000
const MD5_SAMPLE_THRESHOLD = MD5_SAMPLE_SIZE * 3

/**
 * 计算向后兼容的图片摘要：不超过 45KB 时哈希整包，超过时只哈希头、中、尾
 * 各 15KB。采样摘要允许碰撞；saveImageToVault 会在复用同名文件前逐字节比对，
 * 并为不同内容生成确定性的碰撞文件名。
 *
 * 保留采样算法是为了让老用户已落盘附件的文件名跨版本不变，同时避免在移动端
 * 对每张大图执行纯 JS 整包哈希。完整内容哈希仅在确实发生同名碰撞时计算。
 */
export function calculateMD5(data: ArrayBuffer): string {
  const uint8Array = new Uint8Array(data)
  let hashData = uint8Array

  if (uint8Array.byteLength > MD5_SAMPLE_THRESHOLD) {
    const middleStart = Math.floor(
      (uint8Array.byteLength - MD5_SAMPLE_SIZE) / 2,
    )
    const sampled = new Uint8Array(MD5_SAMPLE_THRESHOLD)
    sampled.set(uint8Array.subarray(0, MD5_SAMPLE_SIZE), 0)
    sampled.set(
      uint8Array.subarray(middleStart, middleStart + MD5_SAMPLE_SIZE),
      MD5_SAMPLE_SIZE,
    )
    sampled.set(
      uint8Array.subarray(uint8Array.byteLength - MD5_SAMPLE_SIZE),
      MD5_SAMPLE_SIZE * 2,
    )
    hashData = sampled
  }

  return `${calculateHexMD5(hashData)}_MD5`
}

/**
 * 检测图片格式
 * 通过文件头魔数检测真实格式
 */
export function detectImageFormat(data: ArrayBuffer): string {
  const uint8Array = new Uint8Array(data)

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    uint8Array[0] === 0x89 &&
    uint8Array[1] === 0x50 &&
    uint8Array[2] === 0x4e &&
    uint8Array[3] === 0x47
  ) {
    return 'png'
  }

  // JPEG: FF D8 FF
  if (
    uint8Array[0] === 0xff &&
    uint8Array[1] === 0xd8 &&
    uint8Array[2] === 0xff
  ) {
    return 'jpg'
  }

  // GIF: 47 49 46 38
  if (
    uint8Array[0] === 0x47 &&
    uint8Array[1] === 0x49 &&
    uint8Array[2] === 0x46 &&
    uint8Array[3] === 0x38
  ) {
    return 'gif'
  }

  // WebP: 52 49 46 46 ... 57 45 42 50
  if (
    uint8Array[0] === 0x52 &&
    uint8Array[1] === 0x49 &&
    uint8Array[2] === 0x46 &&
    uint8Array[3] === 0x46 &&
    uint8Array[8] === 0x57 &&
    uint8Array[9] === 0x45 &&
    uint8Array[10] === 0x42 &&
    uint8Array[11] === 0x50
  ) {
    return 'webp'
  }

  // SVG: 检测文本内容
  try {
    const text = new TextDecoder('utf-8').decode(uint8Array.slice(0, 100))
    if (text.includes('<svg') || text.includes('<?xml')) {
      return 'svg'
    }
  } catch {
    // 忽略解码错误
  }

  // 默认返回 unknown
  return 'unknown'
}

/**
 * PNG 转 JPEG
 * 使用 Canvas API 进行转换
 */
export async function convertPngToJpeg(
  data: ArrayBuffer,
  quality: number = 0.85
): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    try {
      // 创建 Blob
      const blob = new Blob([data], { type: 'image/png' })

      // 创建 Image 对象
      const img = new Image()
      const url = URL.createObjectURL(blob)

      img.onload = () => {
        try {
          // 创建 Canvas
          const canvas = createEl('canvas')
          canvas.width = img.width
          canvas.height = img.height

          // 绘制图片
          const ctx = canvas.getContext('2d')
          if (!ctx) {
            URL.revokeObjectURL(url)
            reject(new Error('无法创建 Canvas 上下文'))
            return
          }

          // 填充白色背景（JPEG不支持透明度）
          ctx.fillStyle = '#FFFFFF'
          ctx.fillRect(0, 0, canvas.width, canvas.height)
          ctx.drawImage(img, 0, 0)

          // 转换为 JPEG Blob
          canvas.toBlob(
            (jpegBlob) => {
              if (!jpegBlob) {
                URL.revokeObjectURL(url)
                reject(new Error('转换 JPEG 失败'))
                return
              }

              // 转换为 ArrayBuffer
              jpegBlob.arrayBuffer().then((arrayBuffer) => {
                URL.revokeObjectURL(url)
                resolve(arrayBuffer)
              }).catch((err: unknown) => {
                URL.revokeObjectURL(url)
                reject(err instanceof Error ? err : new Error(String(err)))
              })
            },
            'image/jpeg',
            quality
          )
        } catch (error: unknown) {
          URL.revokeObjectURL(url)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      }

      img.onerror = () => {
        URL.revokeObjectURL(url)
        reject(new Error('图片加载失败'))
      }

      img.src = url
    } catch (error: unknown) {
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

/**
 * 保存图片到 Vault
 * @param vault Obsidian Vault 对象
 * @param folderPath 目标文件夹路径
 * @param fileName 文件名（含扩展名）
 * @param data 图片数据
 * @returns 保存后的文件路径
 */
export { saveContentAddressed as saveImageToVault, ensureFolderExists } from '../common/vaultStore'

/**
 * 从 URL 提取文件名
 */
export function extractFilenameFromUrl(url: string): string {
  try {
    const urlObj = new URL(url)
    const pathname = urlObj.pathname
    const filename = pathname.substring(pathname.lastIndexOf('/') + 1)

    // 移除查询参数
    return filename.split('?')[0] || 'image'
  } catch {
    return 'image'
  }
}

/**
 * 清理文件名中的非法字符
 */
export function sanitizeFilename(filename: string): string {
  // 移除或替换 Windows/macOS 非法字符
  return filename
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, '_')
    .substring(0, 200) // 限制长度
}
