import { AdbClient } from './adb.js'
import { AppiumClient, AppiumDriver, bestEffortBingLogin, enterVerificationCode } from './appium.js'
import { CaptchaSolver } from './captcha.js'
import { RedeemServerConfig } from './config.js'
import { LdPlayerManager } from './ldplayer.js'
import { SuperProxyManager } from './superproxy.js'
import { TaskStore } from './tasks.js'
import { RedeemPayload, StepLogger, TaskRecord } from './types.js'
import { asErrorMessage, sleep } from './util.js'
import { V2rayNgManager } from './v2rayng.js'

export class RedeemAutomation {
    private readonly config: RedeemServerConfig
    private readonly store: TaskStore
    private readonly ldplayer: LdPlayerManager
    private readonly appium: AppiumClient
    private readonly captcha: CaptchaSolver

    constructor(config: RedeemServerConfig, store: TaskStore) {
        this.config = config
        this.store = store
        this.ldplayer = new LdPlayerManager(config)
        this.appium = new AppiumClient(config)
        this.captcha = new CaptchaSolver(config)
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
            if (this.config.proxyApp === 'superproxy') {
                await adb.installIfMissing(
                    instance.serial,
                    this.config.packages.superProxy,
                    this.config.apks.superProxy,
                    'Super Proxy',
                    log,
                )
            } else {
                await adb.installIfMissing(instance.serial, this.config.packages.v2rayng, this.config.apks.v2rayng, 'v2rayNG', log)
            }
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
                driver = await this.prepareProxyWithAppiumRetry(
                    adb,
                    driver,
                    instance.serial,
                    instance.profileName,
                    payload.proxy,
                    log,
                )
            } catch (error) {
                await this.pauseForManual(
                    task,
                    `Proxy setup needs manual recovery: ${asErrorMessage(error)}`,
                    this.config.queue.manualTimeoutMs,
                )
                if (this.finished(task)) return
            }

            const liveSerial = await adb.resolveLiveSerial(instance.serial)
            if (liveSerial !== instance.serial) {
                task.deviceSerial = liveSerial
                log('processing', `ADB serial changed from ${instance.serial} to ${liveSerial}; continuing with live device`)
            }

            await adb.startPackage(instance.serial, this.config.packages.bing)
            await sleep(2500)
            const loginResult = await this.withAppiumRetry(
                driver,
                liveSerial,
                'Bing login',
                retryDriver => bestEffortBingLogin(retryDriver, payload.email, payload.pass, payload.totpSecret, log),
                log,
            )
            driver = loginResult.driver
            const loggedIn = loginResult.value
            if (!loggedIn) {
                await this.pauseForManual(
                    task,
                    'Bing login needs manual recovery in LDPlayer. Complete login, then Resume in viewer.',
                    this.config.queue.manualTimeoutMs,
                )
                if (this.finished(task)) return
            }

            log('processing', 'Opening Bing app redeem verification link')
            await adb.openUrl(instance.serial, payload.urlRedem, this.config.packages.bing)
            await sleep(3500)
            const verifyLoginResult = await this.withAppiumRetry(
                driver,
                liveSerial,
                'Bing redeem sign in',
                retryDriver => bestEffortBingLogin(retryDriver, payload.email, payload.pass, payload.totpSecret, log, {
                    requireRedeemCodeScreen: true,
                }),
                log,
            )
            driver = verifyLoginResult.driver
            let redeemLoginReady = verifyLoginResult.value
            if (!redeemLoginReady) {
                const adbRecoveryResult = await this.recoverBingRedeemSignInWithAdb(
                    adb,
                    driver,
                    liveSerial,
                    payload,
                    log,
                )
                driver = adbRecoveryResult.driver
                redeemLoginReady = adbRecoveryResult.value
            }
            if (!redeemLoginReady) {
                await this.pauseForManual(
                    task,
                    'Bing redeem sign-in needs manual recovery in LDPlayer. Complete login, then Resume in viewer.',
                    this.config.queue.manualTimeoutMs,
                )
                if (this.finished(task)) return
            }

            let code = await this.solveCaptcha(task, payload.captcha, log)
            if (!code) {
                this.store.status(
                    task,
                    'waiting_code',
                    payload.captcha
                        ? 'Waiting for six digit code from viewer; captcha image is attached to task.'
                        : 'Waiting for six digit code from viewer.',
                )
                code = await this.waitForCode(task, this.config.queue.codeTimeoutMs)
            }
            if (this.finished(task)) return

            let submitted = false
            if (code) {
                const submitResult = await this.withAppiumRetry(
                    driver,
                    liveSerial,
                    'Bing verification code entry',
                    retryDriver => enterVerificationCode(retryDriver, code, log),
                    log,
                )
                driver = submitResult.driver
                submitted = submitResult.value
            }

            if (!submitted) {
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

    private async prepareProxyWithAppiumRetry(
        adb: AdbClient,
        driver: AppiumDriver,
        serial: string,
        profileName: string,
        proxy: RedeemPayload['proxy'],
        log: StepLogger,
    ): Promise<AppiumDriver> {
        const manager = this.proxyManager(adb)
        try {
            await manager.prepareProxy(serial, profileName, proxy, driver, log)
            return driver
        } catch (error) {
            if (!isAppiumInstrumentationCrash(error)) throw error
            log('processing', 'Appium UiAutomator2 instrumentation crashed during proxy setup; recreating session and retrying once')
            await driver.close().catch(() => undefined)
        }

        const retryDriver = await this.appium.createAndroidSession(serial)
        log('success', 'Appium UiAutomator2 session recreated')
        await this.proxyManager(adb).prepareProxy(serial, profileName, proxy, retryDriver, log)
        return retryDriver
    }

    private proxyManager(adb: AdbClient): V2rayNgManager | SuperProxyManager {
        return this.config.proxyApp === 'superproxy' ? new SuperProxyManager(this.config, adb) : new V2rayNgManager(this.config, adb)
    }

    private async recoverBingRedeemSignInWithAdb(
        adb: AdbClient,
        driver: AppiumDriver,
        serial: string,
        payload: RedeemPayload,
        log: StepLogger,
    ): Promise<{ driver: AppiumDriver; value: boolean }> {
        log('processing', 'Bing password option was not selectable by Appium; trying ADB tap recovery')
        const tapPoints = [
            [0.5, 0.68],
            [0.5, 0.66],
            [0.5, 0.7],
            [0.5, 0.64],
            [0.5, 0.72],
        ]
        let currentDriver = driver
        for (let index = 0; index < tapPoints.length; index += 1) {
            const [xRatio, yRatio] = tapPoints[index]
            await adb.tapRatio(serial, xRatio, yRatio)
            log('processing', `ADB tapped Microsoft password option area (${index + 1}/${tapPoints.length})`)
            await sleep(1600)
            const result = await this.withAppiumRetry(
                currentDriver,
                serial,
                'Bing redeem sign in after ADB tap',
                retryDriver => bestEffortBingLogin(retryDriver, payload.email, payload.pass, payload.totpSecret, log, {
                    requireRedeemCodeScreen: true,
                }),
                log,
            )
            currentDriver = result.driver
            if (result.value) return { driver: currentDriver, value: true }
        }
        return { driver: currentDriver, value: false }
    }

    private async withAppiumRetry<T>(
        driver: AppiumDriver,
        serial: string,
        label: string,
        action: (driver: AppiumDriver) => Promise<T>,
        log: StepLogger,
    ): Promise<{ driver: AppiumDriver; value: T }> {
        try {
            return { driver, value: await action(driver) }
        } catch (error) {
            if (!isAppiumInstrumentationCrash(error)) throw error
            log('processing', `Appium UiAutomator2 instrumentation crashed during ${label}; recreating session and retrying once`)
            await driver.close().catch(() => undefined)
        }

        const retryDriver = await this.appium.createAndroidSession(serial)
        log('success', 'Appium UiAutomator2 session recreated')
        return { driver: retryDriver, value: await action(retryDriver) }
    }

    private async solveCaptcha(task: TaskRecord, captcha: string | undefined, log: StepLogger): Promise<string | null> {
        if (!this.captcha.enabled()) return null
        try {
            const code = await this.captcha.solveImage(captcha, log)
            if (code) this.store.status(task, 'processing', 'Using captcha code from 2Captcha')
            return code
        } catch (error) {
            log('processing', `Captcha auto-solve failed: ${asErrorMessage(error)}; waiting for viewer input`)
            return null
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

function isAppiumInstrumentationCrash(error: unknown): boolean {
    const message = asErrorMessage(error).toLowerCase()
    return (
        message.includes('uiautomator2 server') ||
        message.includes('instrumentation process is not running') ||
        message.includes('probably crashed') ||
        message.includes('socket hang up')
    )
}
