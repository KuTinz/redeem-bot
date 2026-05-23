import { AdbClient } from './adb.js'
import { AppiumDriver } from './appium.js'
import { RedeemServerConfig } from './config.js'
import { ProxyPayload, StepLogger } from './types.js'
import { sleep } from './util.js'

type ProxyProtocol = 'HTTP' | 'SOCKS5'

export class SuperProxyManager {
    private readonly config: RedeemServerConfig
    private readonly adb: AdbClient

    constructor(config: RedeemServerConfig, adb: AdbClient) {
        this.config = config
        this.adb = adb
    }

    async prepareProxy(
        serial: string,
        profileName: string,
        proxy: ProxyPayload | null,
        driver: AppiumDriver,
        log: StepLogger,
    ): Promise<void> {
        if (!proxy?.host || !proxy.port) throw new Error('Redeem task has no proxy host or port')

        log('processing', 'Clearing existing Super Proxy configs before adding task proxy')
        await this.adb.forceStop(serial, this.config.packages.superProxy)
        await this.adb.clearPackage(serial, this.config.packages.superProxy)
        log('success', 'Existing Super Proxy configs cleared')

        await this.adb.startPackage(serial, this.config.packages.superProxy)
        await sleep(3000)
        await this.dismissStartupPrompts(driver)

        const added = await this.tryAddProxy(profileName, proxy, driver, log)
        if (!added) {
            throw new Error('Super Proxy add did not finish. Add the proxy in Super Proxy, connect it, then Resume.')
        }

        const started = await this.tryStart(driver, log)
        if (!started) {
            log('processing', 'Super Proxy start state could not be verified; continuing with task after start tap')
        }
        await this.acceptVpnPrompt(driver)
        log('success', 'Super Proxy connect action sent')
    }

    private async tryAddProxy(
        profileName: string,
        proxy: ProxyPayload,
        driver: AppiumDriver,
        log: StepLogger,
    ): Promise<boolean> {
        const protocol = proxyProtocol(proxy)
        if (!(await this.ensureProxyForm(driver, protocol, log))) return false

        const filled = await this.fillProxyForm(driver, {
            name: `redeem-${profileName}`,
            host: proxy.host,
            port: String(proxy.port),
            user: proxy.user || '',
            pass: proxy.pass || '',
        })
        if (!filled) {
            log('processing', 'Super Proxy form fields were not detected')
            return false
        }

        await this.saveProxyForm(driver)
        await sleep(1200)
        log('success', `Super Proxy ${protocol} proxy added for ${profileName}`)
        return true
    }

    private async ensureProxyForm(driver: AppiumDriver, protocol: ProxyProtocol, log: StepLogger): Promise<boolean> {
        await this.dismissStartupPrompts(driver)
        if (await this.hasProxyForm(driver)) {
            await this.selectProtocol(driver, protocol)
            return true
        }

        const openedAdd =
            (await driver.clickContentDescription(['Add', 'add', 'New', 'Create'])) ||
            (await driver.clickText(['Add proxy', 'Add Proxy', 'Add', 'New proxy', 'New Proxy', '+']))
        if (!openedAdd) {
            log('processing', 'Super Proxy add button was not detected')
            return false
        }
        await sleep(1000)

        await this.selectProtocol(driver, protocol)
        return await this.hasProxyForm(driver)
    }

    private async dismissStartupPrompts(driver: AppiumDriver): Promise<void> {
        await driver.clickText(['Không h.lại', 'Không h', 'Không hiện lại', 'Do not show this warning again'])
        await sleep(300)
        await driver.clickText(['OK'])
        await sleep(600)
        await driver.clickText(['Cancel', 'Huỷ', 'Hủy'])
        await sleep(300)

        const source = (await driver.source()).toLowerCase()
        if (!source.includes('gocmod') && !source.includes('warning')) return

        const rect = await driver.windowRect()
        await driver.tap(rect.x + Math.floor(rect.width * 0.75), rect.y + Math.floor(rect.height * 0.83))
        await sleep(500)
        await driver.tap(rect.x + Math.floor(rect.width * 0.72), rect.y + Math.floor(rect.height * 0.94))
        await sleep(800)
    }

    private async hasProxyForm(driver: AppiumDriver): Promise<boolean> {
        const source = (await driver.source()).toLowerCase()
        const fields = await driver.findAll('//android.widget.EditText')
        return fields.length >= 3 || (source.includes('host') && source.includes('port')) || (source.includes('server') && source.includes('port'))
    }

    private async selectProtocol(driver: AppiumDriver, protocol: ProxyProtocol): Promise<void> {
        const source = (await driver.source()).toLowerCase()
        if (source.includes(`protocol`) && source.includes(protocol.toLowerCase())) return
        const labels =
            protocol === 'SOCKS5'
                ? ['SOCKS5', 'Socks5', 'SOCKS', 'Socks']
                : ['HTTP', 'Http']
        if (!(await driver.clickText(labels))) return
        await sleep(500)
        await driver.clickText(labels)
        await sleep(500)
    }

    private async selectAuthentication(driver: AppiumDriver, enabled: boolean): Promise<void> {
        const source = (await driver.source()).toLowerCase()
        if (!source.includes('authentication method')) return

        const targetLabels = enabled ? ['Basic', 'User/password', 'Username/password', 'Password'] : ['None']
        if (!(await driver.clickText(['None', 'Basic', 'Authentication method']))) return
        await sleep(500)
        await driver.clickText(targetLabels)
        await sleep(700)
    }

    private async scrollDown(driver: AppiumDriver): Promise<void> {
        const rect = await driver.windowRect()
        const x = rect.x + Math.floor(rect.width * 0.5)
        const y1 = rect.y + Math.floor(rect.height * 0.78)
        const y2 = rect.y + Math.floor(rect.height * 0.38)
        await driver.swipe(x, y1, x, y2)
        await sleep(700)
    }

    private async fillProxyForm(
        driver: AppiumDriver,
        values: {
            name: string
            host: string
            port: string
            user: string
            pass: string
        },
    ): Promise<boolean> {
        await this.selectAuthentication(driver, Boolean(values.user || values.pass))
        const fields = await driver.findAll('//android.widget.EditText')
        if (fields.length < 3) return false

        await this.fillFields(driver, fields.slice(0, 3), [values.name, values.host, values.port])
        if (values.user || values.pass) {
            await this.scrollDown(driver)
            const authFields = await driver.findAll('//android.widget.EditText')
            if (authFields.length >= 2) await this.fillFields(driver, authFields.slice(-2), [values.user, values.pass])
        }
        return true
    }

    private async fillFields(driver: AppiumDriver, fields: string[], values: string[]): Promise<void> {
        for (let index = 0; index < Math.min(fields.length, values.length); index += 1) {
            await driver.click(fields[index])
            await driver.clear(fields[index])
            if (values[index]) await driver.type(fields[index], values[index])
            await driver.hideKeyboard()
            await sleep(250)
        }
    }

    private async saveProxyForm(driver: AppiumDriver): Promise<void> {
        const saved =
            (await driver.clickContentDescription(['Save', 'save', 'Done', 'done', 'Confirm', 'Apply'])) ||
            (await driver.clickText(['Save', 'Done', 'OK', 'Apply']))
        if (saved) return

        const rect = await driver.windowRect()
        await driver.tap(rect.x + Math.floor(rect.width * 0.92), rect.y + Math.floor(rect.height * 0.1))
    }

    private async tryStart(driver: AppiumDriver, log: StepLogger): Promise<boolean> {
        await sleep(1000)
        await this.acceptVpnPrompt(driver)
        const clicked =
            (await driver.clickContentDescription(['Start', 'start', 'Connect', 'connect', 'Play'])) ||
            (await driver.clickText(['Start', 'Connect', 'Tap to connect']))
        if (clicked) {
            log('processing', 'Super Proxy start button clicked by selector')
            await sleep(1200)
            await this.acceptVpnPrompt(driver)
            if (await this.isStarted(driver)) return true
        }

        for (let attempt = 1; attempt <= 2; attempt += 1) {
            const rect = await driver.windowRect()
            const x = rect.x + Math.floor(rect.width * 0.9)
            const y = rect.y + Math.floor(rect.height * 0.87)
            await driver.tap(x, y)
            log('processing', `Super Proxy fallback tapped start button at ${x},${y} (attempt ${attempt})`)
            await sleep(1200)
            await this.acceptVpnPrompt(driver)
            if (await this.isStarted(driver)) return true
        }
        return false
    }

    private async isStarted(driver: AppiumDriver): Promise<boolean> {
        try {
            const source = (await driver.source()).toLowerCase()
            if (source.includes('disconnect') || source.includes('stop') || source.includes('connected')) return true
            if (source.includes('not connected') || source.includes('disconnected')) return false
            return !source.includes('connect')
        } catch {
            return false
        }
    }

    private async acceptVpnPrompt(driver: AppiumDriver): Promise<void> {
        for (let index = 0; index < 3; index += 1) {
            const clicked = await driver.clickText(['OK', 'Allow', 'Cho phép', 'Đồng ý'])
            if (!clicked) return
            await sleep(700)
        }
    }
}

function proxyProtocol(proxy: ProxyPayload): ProxyProtocol {
    return String(proxy.method || 'http')
        .toLowerCase()
        .startsWith('socks')
        ? 'SOCKS5'
        : 'HTTP'
}
