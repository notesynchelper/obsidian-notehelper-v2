// 续费 / 开通会员弹窗：右上角同步提醒第二行点开后出现。
//
// 内容（2026-08-31 用户确认的「信息版 + 刷新按钮」）：
//   标题：续费会员 / 开通会员
//   当前：<会员状态接口的展示文本>
//   一句扫码引导 + 二维码（市场版复用设置页那张【打包内置】的静态二维码，零网络请求）
//   底部：[已完成续费，刷新状态]（走不缓存的实时接口）+ [关闭]
//
// 刷新按钮复用设置页那条实时链路（/user-config/refresh），所以「刚付完钱状态没变」
// 这类追问在弹窗里就能自助解决，不用再让用户翻到设置页。

import { App, Modal, Notice } from 'obsidian'
import { fetchVipStatusFresh, type VipStatus } from '../api'
import { VIP_QR_DATA_URI } from '../assets/vipQrImage'
import { t } from '../i18n'
import type { RenewalReminder } from './renewalReminder'

export interface RenewalModalOptions {
  apiKey: string
  /** 仅测试用：覆盖会员状态接口基址（生产恒为 undefined） */
  vipApiBase?: string
}

export class VipRenewalModal extends Modal {
  private reminder: RenewalReminder
  private options: RenewalModalOptions
  private statusEl: HTMLElement | null = null

  constructor(app: App, reminder: RenewalReminder, options: RenewalModalOptions) {
    super(app)
    this.reminder = reminder
    this.options = options
  }

  onOpen(): void {
    const { contentEl, titleEl } = this
    const isTrial = this.reminder.audience === 'trial'
    this.modalEl.addClass('notehelper-renewal-modal')
    titleEl.setText(this.reminder.modalTitle)

    // 当前会员状态（档位 + 到期时间），让用户确认自己在续哪一份
    this.statusEl = contentEl.createEl('p', {
      cls: 'notehelper-renewal-status',
      text: `${t('vipRenewal.modal.currentLabel')}${this.reminder.statusText}`,
    })

    contentEl.createEl('p', {
      cls: 'notehelper-renewal-hint',
      text: isTrial
        ? t('vipRenewal.modal.scanHintSubscribe')
        : t('vipRenewal.modal.scanHintRenew'),
    })

    const qrWrap = contentEl.createDiv({ cls: 'notehelper-renewal-qr' })
    const qrImg = qrWrap.createEl('img', { attr: { alt: t('vipRenewal.modal.qrLabel') } })
    this.loadQrCode(qrImg, qrWrap)
    qrWrap.createEl('div', {
      cls: 'notehelper-renewal-qr-label',
      text: t('vipRenewal.modal.qrLabel'),
    })

    contentEl.createEl('p', {
      cls: 'notehelper-renewal-refresh-hint',
      text: isTrial
        ? t('vipRenewal.modal.refreshHintSubscribe')
        : t('vipRenewal.modal.refreshHintRenew'),
    })

    const btnRow = contentEl.createDiv({ cls: 'modal-button-container' })
    const refreshBtn = btnRow.createEl('button', {
      cls: 'mod-cta notehelper-renewal-refresh-btn',
      text: isTrial
        ? t('vipRenewal.modal.refreshBtnSubscribe')
        : t('vipRenewal.modal.refreshBtnRenew'),
    })
    refreshBtn.addEventListener('click', () => {
      void this.refreshStatus(refreshBtn)
    })
    const closeBtn = btnRow.createEl('button', {
      cls: 'notehelper-renewal-close-btn',
      text: t('vipRenewal.modal.closeBtn'),
    })
    closeBtn.addEventListener('click', () => this.close())
  }

  onClose(): void {
    this.contentEl.empty()
  }

  // 主域名 → 备用域名，与设置页同一套兜底；两次都失败就明说，别留一个破图。
  /**
   * 市场版：二维码是打包进插件的静态 data URI，**零网络请求**
   *（Obsidian 开发者政策禁止从网络动态加载推广内容；静态 + README 披露才允许）。
   * 与设置页「购买高级权益」用的是同一份快照，见 src/assets/vipQrImage.ts。
   */
  private loadQrCode(img: HTMLImageElement, wrap: HTMLElement): void {
    img.onerror = () => {
      img.onerror = null
      img.addClass('is-hidden')
      wrap.createEl('div', {
        cls: 'notehelper-renewal-qr-fail',
        text: t('vipRenewal.modal.qrLoadFail'),
      })
    }
    img.src = VIP_QR_DATA_URI
  }

  // 「已完成续费，刷新状态」：走不缓存的实时接口，直接把最新状态写回弹窗。
  private async refreshStatus(button: HTMLButtonElement): Promise<void> {
    const apiKey = this.options.apiKey
    if (!apiKey || apiKey.trim() === '') {
      new Notice(t('settings.vip.needKey'))
      return
    }
    const originalText = button.textContent || ''
    button.disabled = true
    button.textContent = t('common.refreshing')
    try {
      const fresh: VipStatus = await fetchVipStatusFresh(apiKey, this.options.vipApiBase)
      if (fresh.rateLimited) {
        new Notice(t('settings.vip.rateLimited'))
        return
      }
      if (fresh.networkError) {
        new Notice(t('settings.vip.refreshFailed'))
        return
      }
      if (this.statusEl) {
        this.statusEl.textContent = `${t('vipRenewal.modal.currentLabel')}${fresh.displayText}`
      }
      new Notice(t('settings.vip.refreshed'))
    } finally {
      button.disabled = false
      button.textContent = originalText
    }
  }
}
