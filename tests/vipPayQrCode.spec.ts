/**
 * 续费弹窗里的付款二维码用的是哪张图（市场版）。
 *
 * 背景：这张码一度复用设置页那张「购买高级权益」二维码 —— 而那张的内容是
 * `http://weixin.qq.com/q/…`（公众号带参二维码），扫出来是「关注公众号」，
 * 根本走不到付款。现在它必须是收银台页 https://pay.bijitongbu.site/obsidian.html
 * 的二维码。
 *
 * 市场版与主项目的差别：主项目那张图从服务端 HTTPS 拉；市场版**打包内置**成
 * 静态 data URI（政策禁止从网络动态加载推广内容），所以这里钉的不变式是
 * 「是内置 PNG、不是公众号那张、正文里不出现网络地址」。
 */

import { VIP_PAY_QR_DATA_URI, VIP_PAY_PAGE_URL } from '../src/assets/vipPayQrImage'
import { VIP_QR_DATA_URI } from '../src/assets/vipQrImage'

describe('会员续费付款二维码', () => {
  it('付款页地址就是收银台那条 URL', () => {
    expect(VIP_PAY_PAGE_URL).toBe('https://pay.bijitongbu.site/obsidian.html')
  })

  it('付款码是打包内置的 PNG data URI（零网络请求）', () => {
    expect(VIP_PAY_QR_DATA_URI.startsWith('data:image/png;base64,')).toBe(true)
    expect(VIP_PAY_QR_DATA_URI).not.toContain('http://')
    expect(VIP_PAY_QR_DATA_URI.replace('data:image/png;base64,', '')).not.toContain('https://')
  })

  it('付款码不是设置页那张公众号带参码', () => {
    expect(VIP_PAY_QR_DATA_URI).not.toBe(VIP_QR_DATA_URI)
  })

  it('续费弹窗引用的是付款码资产，不是公众号码', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../src/vip/RenewalModal.ts'),
      'utf-8',
    ) as string
    expect(src).toContain('VIP_PAY_QR_DATA_URI')
    expect(src).not.toContain('VIP_QR_DATA_URI')
  })
})
