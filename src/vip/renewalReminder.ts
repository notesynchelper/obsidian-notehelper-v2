// 会员续费提醒（右上角同步 Notice 的第二行）—— 纯逻辑，不碰 DOM。
//
// 规则（2026-08-31 用户拍板）：
//   • 正式会员 / 头等舱会员：到期前 30 天起提醒，一直提醒到「到期后 7 天」。
//   • 试用会员：只在到期前 2 天、1 天（含到期当天）以及到期后 1–7 天提醒。
//   • 从未开通（vipType='none'）/ 没有到期时间 / 网络异常：不提醒（没有可信的到期日）。
// 展示节奏：每个自然日最多提醒一次（见 shouldRemindToday）。
//
// 为什么把「天数」按【自然日】算而不是按 24h 差：用户读到的是「还有 3 天到期」，
// 心里对的是日历上的那一格。按毫秒差取整会出现「今天下午 5 点到期」却显示「还有 0 天」
// 这类别扭措辞，也无法稳定区分「今天到期」与「已到期」。

import type { VipStatus } from '../api'
import { getLang, t } from '../i18n'

/** 正式/头等舱会员：到期前多少天开始提醒 */
export const MEMBER_LEAD_DAYS = 30
/** 试用会员：到期前多少天开始提醒 */
export const TRIAL_LEAD_DAYS = 2
/** 到期后还提醒多少天（两类会员一致） */
export const GRACE_DAYS = 7

/** 提醒对象：试用 or 正式/头等舱（文案与弹窗标题按它分流） */
export type RenewalAudience = 'trial' | 'member'
/** 提醒阶段：到期前 / 到期当天（未过） / 已到期 */
export type RenewalPhase = 'before' | 'today' | 'expired'

export interface RenewalReminder {
  audience: RenewalAudience
  phase: RenewalPhase
  /** before: 距到期的自然日数（≥1）；today: 0；expired: 已过的自然日数（≥0） */
  days: number
  /** 右上角 Notice 的第二行（可点击） */
  noticeText: string
  /** 点开后弹窗的标题 */
  modalTitle: string
  /** 弹窗里「当前：」后面那行，直接复用会员状态接口的展示文本 */
  statusText: string
}

/** 本地时区的自然日键，形如 2026-08-31。提醒去重按它比对 */
export function localDateKey(date: Date): string {
  const y = date.getFullYear()
  const m = `${date.getMonth() + 1}`.padStart(2, '0')
  const d = `${date.getDate()}`.padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 今天是否还没提醒过（lastShown 为空/非今天 → 可以提醒） */
export function shouldRemindToday(
  lastShown: string | undefined | null,
  now: Date,
): boolean {
  if (!lastShown) return true
  return lastShown !== localDateKey(now)
}

function startOfLocalDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** later 与 earlier 相差几个【自然日】（本地时区，同一天=0） */
export function calendarDayDiff(later: Date, earlier: Date): number {
  return Math.round((startOfLocalDay(later) - startOfLocalDay(earlier)) / 86400000)
}

function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole,
  )
}

// 英文有单复数（1 day / 2 days），中文没有——两边都用「单数一条、复数一条」的
// 双 key，中文两条填一样的话即可，省掉一套复数规则。
function noticeText(
  audience: RenewalAudience,
  phase: RenewalPhase,
  days: number,
): string {
  if (audience === 'trial') {
    if (phase === 'before') {
      return fill(
        days === 1 ? t('vipRenewal.notice.trialBeforeOne') : t('vipRenewal.notice.trialBefore'),
        { days },
      )
    }
    if (phase === 'today') return t('vipRenewal.notice.trialToday')
    if (days === 0) return t('vipRenewal.notice.trialExpiredToday')
    return fill(
      days === 1 ? t('vipRenewal.notice.trialExpiredOne') : t('vipRenewal.notice.trialExpired'),
      { days },
    )
  }
  if (phase === 'before') {
    return fill(
      days === 1 ? t('vipRenewal.notice.memberBeforeOne') : t('vipRenewal.notice.memberBefore'),
      { days },
    )
  }
  if (phase === 'today') return t('vipRenewal.notice.memberToday')
  if (days === 0) return t('vipRenewal.notice.memberExpiredToday')
  return fill(
    days === 1 ? t('vipRenewal.notice.memberExpiredOne') : t('vipRenewal.notice.memberExpired'),
    { days },
  )
}

/**
 * 弹窗里「当前：」那行。
 *
 * 不能直接用 VipStatus.displayText —— 它在 api.ts 里是写死的中文（试用会员 |
 * 到期时间：…），英文界面会中英混排。这里按档位 + 到期时间用当前语言重新拼，
 * 中文输出与 displayText 逐字一致（零观感变化），英文才真正变成英文。
 */
export function buildVipStatusText(vip: VipStatus, now: Date): string {
  // 'none' 分两种：压根没有会员记录（没到期时间）→「未开通会员」；
  // 有到期时间但档位不认识（服务端加了新类型）→「未知类型」，与旧 displayText 一致。
  // 绝不能把它们默认成「正式会员」——那是在告诉用户一个他并不拥有的身份。
  if (vip.vipType === 'none') {
    if (!vip.endTime) return t('vipRenewal.modal.tierNone')
  }
  const tierKey =
    vip.vipType === 'obtrail'
      ? 'vipRenewal.modal.tierTrial'
      : vip.vipType === 'obvvip'
        ? 'vipRenewal.modal.tierPremium'
        : vip.vipType === 'obvip'
          ? 'vipRenewal.modal.tierMember'
          : 'vipRenewal.modal.tierUnknown'
  const tier = t(tierKey)

  if (!vip.endTime) return tier
  const end = new Date(vip.endTime)
  if (Number.isNaN(end.getTime())) return tier

  const expired = end.getTime() <= now.getTime() ? t('vipRenewal.modal.expiredSuffix') : ''
  const timeStr = end.toLocaleString(getLang() === 'zh' ? 'zh-CN' : 'en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
  return `${tier}${expired}${t('vipRenewal.modal.expiresLabel')}${timeStr}`
}

/**
 * 算出本次同步该不该提醒续费、提醒什么。
 *
 * @param vip  会员状态（fetchVipStatus 的返回）
 * @param now  当前时间（注入以便测试；生产传 new Date()）
 * @returns    需要提醒时返回提醒内容；不在提醒窗口 / 数据不可信 → null
 */
export function computeRenewalReminder(
  vip: VipStatus | null | undefined,
  now: Date,
): RenewalReminder | null {
  // 网络异常 / 限流返回的是占位状态，vipType 会退化成 'none'，到期时间也不可信 → 不提醒。
  if (!vip || vip.networkError || vip.rateLimited) return null
  if (vip.vipType !== 'obtrail' && vip.vipType !== 'obvip' && vip.vipType !== 'obvvip') {
    return null
  }
  if (!vip.endTime) return null

  const end = new Date(vip.endTime)
  if (Number.isNaN(end.getTime())) return null

  const audience: RenewalAudience = vip.vipType === 'obtrail' ? 'trial' : 'member'
  const leadDays = audience === 'trial' ? TRIAL_LEAD_DAYS : MEMBER_LEAD_DAYS

  let phase: RenewalPhase
  let days: number
  if (end.getTime() > now.getTime()) {
    days = calendarDayDiff(end, now)
    if (days > leadDays) return null
    phase = days === 0 ? 'today' : 'before'
  } else {
    days = calendarDayDiff(now, end)
    if (days > GRACE_DAYS) return null
    phase = 'expired'
  }

  return {
    audience,
    phase,
    days,
    noticeText: noticeText(audience, phase, days),
    modalTitle:
      audience === 'trial'
        ? t('vipRenewal.modal.titleSubscribe')
        : t('vipRenewal.modal.titleRenew'),
    statusText: buildVipStatusText(vip, now),
  }
}
