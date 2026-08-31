/**
 * 会员类型别名：Cosmos 里的 vip_type 有长短两套写法。
 *
 * 权威口径来自 wecom-consumer/utils/vip-checker.js 的 VIP_TYPE_MAP：
 *   试用   obtrail / trail
 *   正式   obvip   / vip
 *   头等舱 obvvip  / vvip / vvvip
 *
 * 插件此前只认 ob* 三个，短写变体会显示成「未知类型」、二维码给错、
 * 也拿不到续费提醒（真实存在：测试账号 vip_info 就是 vvip）。
 */

import { parseVipConfigResponse } from '../src/api'
import { computeRenewalReminder } from '../src/vip/renewalReminder'

const resp = (vip_type: string, endtime: string) => ({
  success: true,
  data: [{ id: 'u', pt: 'vip_info', vip_type, endtime }],
})

const FUTURE = '2026-09-12T10:00:00.000Z'
const NOW = new Date('2026-08-31T09:00:00.000Z')

describe('vip_type 别名归一', () => {
  it.each([
    ['obtrail', 'obtrail', '试用会员'],
    ['trail', 'obtrail', '试用会员'],
    ['obvip', 'obvip', '正式会员'],
    ['vip', 'obvip', '正式会员'],
    ['obvvip', 'obvvip', '头等舱会员'],
    ['vvip', 'obvvip', '头等舱会员'],
    ['vvvip', 'obvvip', '头等舱会员'],
  ])('%s → %s（显示「%s」，不再是「未知类型」）', (raw, canonical, name) => {
    const status = parseVipConfigResponse(resp(raw, FUTURE) as never)
    expect(status.vipType).toBe(canonical)
    expect(status.displayText).toContain(name)
    expect(status.displayText).not.toContain('未知类型')
  })

  it('认不出来的类型仍然退回 none，绝不冒充会员', () => {
    const status = parseVipConfigResponse(resp('something-new', FUTURE) as never)
    expect(status.vipType).toBe('none')
  })

  it('短写变体同样能拿到续费提醒', () => {
    expect(
      computeRenewalReminder(parseVipConfigResponse(resp('vvip', FUTURE) as never), NOW)?.noticeText,
    ).toBe('⏳ 会员还有 12 天到期 · 点此续费')
    expect(
      computeRenewalReminder(
        parseVipConfigResponse(resp('trail', '2026-09-02T10:00:00.000Z') as never),
        NOW,
      )?.noticeText,
    ).toBe('⏳ 试用还有 2 天到期 · 点此开通会员')
  })
})
