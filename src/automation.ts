import { AdbClient } from './adb.js'
import { AppiumClient, AppiumDriver, bestEffortBingLogin, enterVerificationCode } from './appium.js'
import { RedeemServerConfig } from './config.js'
import { LdPlayerManager } from './ldplayer.js'
import { TaskStore } from './tasks.js'
import { RedeemPayload, StepLogger, TaskRecord } from './types.js'
import { asErrorMessage, sleep } from './util.js'
import { V2rayNgManager } from './v2rayng.js'

export class RedeemAutomation {
    private readonly config: RedeemServerConfig
    private readonly store: TaskStore
    private readonly ldplayer: LdPlayerManager
    private readonly appium: AppiumClient

    constructor(config: RedeemServerConfig, store: TaskStore) {
        this.config = config
        this.store = store
        this.ldplayer = new LdPlayerManager(config)
        this.appium = new AppiumClient(config)
    }

    async run(task: TaskRecord): Promise<void> {
        if (task.type === 'auto_phone') {
            task.manualReason = 'autoPhone queue compatibility exists, but phone redemption automation is not implemented in v1.'
            this.store.status(task, 'manual', task.manualReason)
            return
        }

        const payload = task.payload as RedeemPayload
        const log: StepLogger = (status, message) => this.store.log(task, status, message)
        this.store.status(task, 'processing', `Starting redeem automation for ${payload.email}`)
        const adb = new AdbClient(await this.ldplayer.resolveAdbPath())
        let driver: AppiumDriver | null = null

        try {
            const instance = await this.ldplayer.ensureProfile(payload.email, adb, log)
            task.profileName = instance.profileName
            task.deviceSerial = instance.serial
            log('success', `Using LDPlayer profile ${instance.profileName} on ${instance.serial}`)

            await adb.installIfMissing(instance.serial, this.config.packages.bing, this.config.apks.bing, 'Bing', log)
            await adb.installIfMissing(instance.serial, this.config.packages.v2rayng, this.config.apks.v2rayng, 'v2rayNG', log)
            await adb.installIfMissing(
                instance.serial,
                this.config.packages.appiumSettings,
                this.config.apks.appiumSettings,
                'Appium Settings',
                log,
                true,
            )

            await this.appium.probe()
            driver = await this.appium.createAndroidSession(instance.serial)
            log('success', 'Appium UiAutomator2 session created')

            try {
                const v2ray = new V2rayNgManager(this.config, adb)
                await v2ray.prepareProxy(instance.serial, instance.profileName, payload.proxy, driver, log)
            } catch (error) {
                await this.pauseForManual(
                    task,
                    `Proxy setup needs manual recovery: ${asErrorMessage(error)}`,
                    this.config.queue.manualTimeoutMs,
                )
                if (this.finished(task)) return
            }

            await adb.startPackage(instance.serial, this.config.packages.bing)
            await sleep(2500)
            const loggedIn = await bestEffortBingLogin(driver, payload.email, payload.pass, payload.totpSecret, log)
            if (!loggedIn) {
                await this.pauseForManual(
                    task,
                    'Bing login needs manual recovery in LDPlayer. Complete login, then Resume in viewer.',
                    this.config.queue.manualTimeoutMs,
                )
                if (this.finished(task)) return
            }

            log('processing', 'Opening Bing app redeem verification link')
            await adb.openUrl(instance.serial, payload.urlRedem)
            await sleep(3500)
            this.store.status(
                task,
                'waiting_code',
                payload.captcha
                    ? 'Waiting for six digit code from viewer; captcha image is attached to task.'
                    : 'Waiting for six digit code from viewer.',
            )
            const code = await this.waitForCode(task, this.config.queue.codeTimeoutMs)
            if (this.finished(task)) return

            if (!code || !(await enterVerificationCode(driver, code, log))) {
                await this.pauseForManual(
                    task,
                    'Could not find Bing code input. Finish verify in LDPlayer and mark Done in viewer.',
                    this.config.queue.manualTimeoutMs,
                )
                if (this.finished(task)) return
                this.store.status(task, 'done', 'Manual Bing verification resumed from viewer', 'done')
                return
            }

            await sleep(2500)
            this.store.status(task, 'done', 'Redeem verification code submitted to Bing app', 'done')
        } finally {
            await driver?.close().catch(() => undefined)
        }
    }

    private async waitForCode(task: TaskRecord, timeoutMs: number): Promise<string | null> {
        const start = Date.now()
        while (Date.now() - start < timeoutMs) {
            if (this.finished(task) || task.cancelRequested) return null
            if (task.verificationCode) return task.verificationCode
            await sleep(1000)
        }
        return null
    }

    private async pauseForManual(task: TaskRecord, reason: string, timeoutMs: number): Promise<void> {
        task.manualReason = reason
        task.resumeRequested = false
        this.store.status(task, 'manual', reason)
        const start = Date.now()
        while (Date.now() - start < timeoutMs) {
            if (this.finished(task) || task.cancelRequested) return
            if (task.resumeRequested) {
                task.resumeRequested = false
                task.manualReason = undefined
                this.store.status(task, 'processing', 'Continuing after manual recovery')
                return
            }
            await sleep(1000)
        }
        throw new Error(`Manual recovery timed out: ${reason}`)
    }

    private finished(task: TaskRecord): boolean {
        return ['done', 'failed', 'cancelled'].includes(task.status)
    }
}
