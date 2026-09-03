/**
 * 会员续费提醒的窗口规则 + 文案 + 每日去重。
 *
 * 规则（用户拍板）：
 *   • 正式 / 头等舱会员：到期前 30 天 ~ 到期后 7 天。
 *   • 试用会员：到期前 2 天（含到期当天）~ 到期后 7 天。
 *   • 无到期时间 / 未开通 / 网络异常：不提醒。
 * 天数一律按【自然日】算，避免「今天下午到期」显示成「还有 0 天」。
 */

import type { VipStatus } from '../src/api'
import {
  buildVipStatusText,
  computeRenewalReminder,
  localDateKey,
  shouldRemindToday,
  calendarDayDiff,
} from '../src/vip/renewalReminder'

// jest.config.js 固定 TZ=UTC，下面的「本地时间」= UTC，天边界确定。
const at = (iso: string) => new Date(iso)

const vip = (
  vipType: VipStatus['vipType'],
  endTime?: string,
  extra: Partial<VipStatus> = {},
): VipStatus => ({
  vipType,
  endTime,
  isValid: endTime ? new Date(endTime) > new Date() : false,
  displayText: '正式会员 | 到期时间：2026-09-15 12:00',
  ...extra,
})

describe('computeRenewalReminder — 正式/头等舱会员', () => {
  it('到期前 12 天：提醒，文案带天数', () => {
    const r = computeRenewalReminder(
      vip('obvip', '2026-09-12T10:00:00.000Z'),
      at('2026-08-31T09:00:00.000Z'),
    )
    expect(r).not.toBeNull()
    expect(r?.audience).toBe('member')
    expect(r?.phase).toBe('before')
    expect(r?.days).toBe(12)
    expect(r?.noticeText).toBe('⏳ 会员还有 12 天到期 · 点此续费')
    expect(r?.modalTitle).toBe('续费会员')
  })

  it('到期前 30 天：仍在窗口内', () => {
    const r = computeRenewalReminder(
      vip('obvip', '2026-09-30T10:00:00.000Z'),
      at('2026-08-31T09:00:00.000Z'),
    )
    expect(r?.days).toBe(30)
  })

  it('到期前 31 天：不提醒', () => {
    expect(
      computeRenewalReminder(
        vip('obvip', '2026-10-01T10:00:00.000Z'),
        at('2026-08-31T09:00:00.000Z'),
      ),
    ).toBeNull()
  })

  it('今天到期（还没到时刻）：说「今天到期」而不是「还有 0 天」', () => {
    const r = computeRenewalReminder(
      vip('obvip', '2026-08-31T23:00:00.000Z'),
      at('2026-08-31T09:00:00.000Z'),
    )
    expect(r?.phase).toBe('today')
    expect(r?.days).toBe(0)
    expect(r?.noticeText).toBe('⏳ 会员今天到期 · 点此续费')
  })

  it('当天已过时刻：说「已到期」，不带天数', () => {
    const r = computeRenewalReminder(
      vip('obvip', '2026-08-31T08:00:00.000Z'),
      at('2026-08-31T09:00:00.000Z'),
    )
    expect(r?.phase).toBe('expired')
    expect(r?.days).toBe(0)
    expect(r?.noticeText).toBe('⌛ 会员已到期 · 点此续费')
  })

  it('到期后 3 天：带天数', () => {
    const r = computeRenewalReminder(
      vip('obvip', '2026-08-28T10:00:00.000Z'),
      at('2026-08-31T09:00:00.000Z'),
    )
    expect(r?.days).toBe(3)
    expect(r?.noticeText).toBe('⌛ 会员已到期 3 天 · 点此续费')
  })

  it('到期后 7 天仍提醒，第 8 天停止', () => {
    expect(
      computeRenewalReminder(
        vip('obvip', '2026-08-24T10:00:00.000Z'),
        at('2026-08-31T09:00:00.000Z'),
      )?.days,
    ).toBe(7)
    expect(
      computeRenewalReminder(
        vip('obvip', '2026-08-23T10:00:00.000Z'),
        at('2026-08-31T09:00:00.000Z'),
      ),
    ).toBeNull()
  })

  it('头等舱会员与正式会员同规则、同文案（统称「会员」）', () => {
    const r = computeRenewalReminder(
      vip('obvvip', '2026-09-20T10:00:00.000Z'),
      at('2026-08-31T09:00:00.000Z'),
    )
    expect(r?.audience).toBe('member')
    expect(r?.noticeText).toBe('⏳ 会员还有 20 天到期 · 点此续费')
  })
})

describe('computeRenewalReminder — 试用会员', () => {
  it('到期前 3 天：不提醒（试用只在最后 2 天提醒）', () => {
    expect(
      computeRenewalReminder(
        vip('obtrail', '2026-09-03T10:00:00.000Z'),
        at('2026-08-31T09:00:00.000Z'),
      ),
    ).toBeNull()
  })

  it('到期前 2 天 / 1 天：提醒，引导开通会员', () => {
    const d2 = computeRenewalReminder(
      vip('obtrail', '2026-09-02T10:00:00.000Z'),
      at('2026-08-31T09:00:00.000Z'),
    )
    expect(d2?.audience).toBe('trial')
    expect(d2?.noticeText).toBe('⏳ 试用还有 2 天到期 · 点此开通会员')
    expect(d2?.modalTitle).toBe('开通会员')

    const d1 = computeRenewalReminder(
      vip('obtrail', '2026-09-01T10:00:00.000Z'),
      at('2026-08-31T09:00:00.000Z'),
    )
    expect(d1?.noticeText).toBe('⏳ 试用还有 1 天到期 · 点此开通会员')
  })

  it('今天到期 / 到期后 5 天：提醒；到期后 8 天：停止', () => {
    expect(
      computeRenewalReminder(
        vip('obtrail', '2026-08-31T23:00:00.000Z'),
        at('2026-08-31T09:00:00.000Z'),
      )?.noticeText,
    ).toBe('⏳ 试用今天到期 · 点此开通会员')

    expect(
      computeRenewalReminder(
        vip('obtrail', '2026-08-26T10:00:00.000Z'),
        at('2026-08-31T09:00:00.000Z'),
      )?.noticeText,
    ).toBe('⌛ 试用已到期 5 天 · 点此开通会员')

    expect(
      computeRenewalReminder(
        vip('obtrail', '2026-08-23T10:00:00.000Z'),
        at('2026-08-31T09:00:00.000Z'),
      ),
    ).toBeNull()
  })
})

describe('computeRenewalReminder — 不提醒的情形', () => {
  const now = at('2026-08-31T09:00:00.000Z')

  it('未开通会员', () => {
    expect(computeRenewalReminder(vip('none'), now)).toBeNull()
  })

  it('有档位但缺到期时间', () => {
    expect(computeRenewalReminder(vip('obvip', undefined), now)).toBeNull()
  })

  it('到期时间无法解析', () => {
    expect(computeRenewalReminder(vip('obvip', '不是日期'), now)).toBeNull()
  })

  it('网络异常 / 刷新限流的占位状态', () => {
    expect(
      computeRenewalReminder(
        vip('obvip', '2026-09-05T10:00:00.000Z', { networkError: true }),
        now,
      ),
    ).toBeNull()
    expect(
      computeRenewalReminder(
        vip('obvip', '2026-09-05T10:00:00.000Z', { rateLimited: true }),
        now,
      ),
    ).toBeNull()
  })

  it('null / undefined 输入', () => {
    expect(computeRenewalReminder(null, now)).toBeNull()
    expect(computeRenewalReminder(undefined, now)).toBeNull()
  })
})

describe('每天最多提醒一次', () => {
  it('今天已提醒过 → 不再提醒；换一天 → 恢复', () => {
    const now = at('2026-08-31T09:00:00.000Z')
    expect(localDateKey(now)).toBe('2026-08-31')
    expect(shouldRemindToday('', now)).toBe(true)
    expect(shouldRemindToday(undefined, now)).toBe(true)
    expect(shouldRemindToday('2026-08-31', now)).toBe(false)
    expect(shouldRemindToday('2026-08-30', now)).toBe(true)
  })

  it('同一天的更晚时刻仍算「今天」', () => {
    expect(shouldRemindToday('2026-08-31', at('2026-08-31T23:59:00.000Z'))).toBe(false)
  })
})

describe('calendarDayDiff', () => {
  it('按自然日算，不受时刻影响', () => {
    expect(calendarDayDiff(at('2026-09-01T00:10:00.000Z'), at('2026-08-31T23:50:00.000Z'))).toBe(1)
    expect(calendarDayDiff(at('2026-08-31T23:50:00.000Z'), at('2026-08-31T00:10:00.000Z'))).toBe(0)
  })
})

describe('弹窗「当前：」那行的状态文案', () => {
  // 不能直接用 api.ts 的 displayText（写死中文）——英文界面会中英混排。
  // 中文输出必须与旧的 displayText 逐字一致，避免观感变化。
  it('未过期：档位 + 到期时间，与 displayText 同格式', () => {
    const text = buildVipStatusText(
      vip('obvip', '2026-09-12T10:00:00.000Z'),
      at('2026-08-31T09:00:00.000Z'),
    )
    expect(text).toBe('正式会员 | 到期时间：2026/09/12 10:00')
  })

  it('已过期：带（已过期）后缀', () => {
    const text = buildVipStatusText(
      vip('obvip', '2026-08-28T10:00:00.000Z'),
      at('2026-08-31T09:00:00.000Z'),
    )
    expect(text).toBe('正式会员（已过期） | 到期时间：2026/08/28 10:00')
  })

  it('档位名按 vipType 分流', () => {
    const now = at('2026-08-31T09:00:00.000Z')
    expect(buildVipStatusText(vip('obtrail', '2026-09-02T10:00:00.000Z'), now)).toContain('试用会员')
    expect(buildVipStatusText(vip('obvvip', '2026-09-02T10:00:00.000Z'), now)).toContain('头等舱会员')
  })

  it('缺到期时间 / 日期非法：只显示档位，不拼半截时间', () => {
    const now = at('2026-08-31T09:00:00.000Z')
    expect(buildVipStatusText(vip('obvip', undefined), now)).toBe('正式会员')
    expect(buildVipStatusText(vip('obvip', '不是日期'), now)).toBe('正式会员')
  })
})

describe('单复数（英文会显示 1 day / 2 days，中文两条一样）', () => {
  it('剩 1 天 / 已过 1 天走单数文案', () => {
    expect(
      computeRenewalReminder(
        vip('obvip', '2026-09-01T10:00:00.000Z'),
        at('2026-08-31T09:00:00.000Z'),
      )?.noticeText,
    ).toBe('⏳ 会员还有 1 天到期 · 点此续费')
    expect(
      computeRenewalReminder(
        vip('obvip', '2026-08-30T10:00:00.000Z'),
        at('2026-08-31T09:00:00.000Z'),
      )?.noticeText,
    ).toBe('⌛ 会员已到期 1 天 · 点此续费')
  })
})
