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

    async recoverConnectedProxy(serial: string, driver: AppiumDriver, log: StepLogger): Promise<boolean> {
        await this.adb.startPackage(serial, this.config.packages.superProxy)
        await sleep(2000)
        await this.dismissStartupPrompts(driver)
        await this.acceptVpnPrompt(driver)
        if (await this.isStarted(driver)) {
            log('success', 'Super Proxy is already connected after Appium session recovery')
            return true
        }

        const started = await this.tryStart(driver, log)
        if (!started) return false
        await this.acceptVpnPrompt(driver)
        log('success', 'Super Proxy connect action sent')
        return true
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
        await this.acceptWarningIfPresent(driver)

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
        await this.acceptWarningIfPresent(driver)
    }

    private async acceptWarningIfPresent(driver: AppiumDriver): Promise<void> {
        const source = (await driver.source()).toLowerCase()
        const warningVisible =
            source.includes('warning') ||
            source.includes('do not use this app') ||
            source.includes('superproxy is an app') ||
            source.includes('proxy server')
        if (!warningVisible) return

        await driver.clickText(['Do not show this warning again'])
        await sleep(6000)
        if (await driver.clickText(['OK'])) return

        const rect = await driver.windowRect()
        await driver.tap(rect.x + Math.floor(rect.width * 0.74), rect.y + Math.floor(rect.height * 0.94))
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

    private async selectAuthentication(driver: AppiumDriver, enabled: boolean): Promise<boolean> {
        for (let attempt = 0; attempt < 4; attempt += 1) {
            const source = (await driver.source()).toLowerCase()
            if (source.includes('authentication method')) {
                if (enabled && (source.includes('basic') || source.includes('username/password'))) return true
                if (!enabled && source.includes('none')) return true

                const targetLabels = enabled ? ['Username/Password', 'Basic', 'User/password', 'Username/password', 'Password'] : ['None']
                if (!(await driver.clickText(['None', 'Basic', 'Authentication method']))) return false
                await sleep(500)
                await driver.clickText(targetLabels)
                await sleep(700)
                return true
            }
            await this.scrollDown(driver)
        }
        return false
    }

    private async scrollDown(driver: AppiumDriver): Promise<void> {
        const rect = await driver.windowRect()
        const x = rect.x + Math.floor(rect.width * 0.5)
        const y1 = rect.y + Math.floor(rect.height * 0.66)
        const y2 = rect.y + Math.floor(rect.height * 0.28)
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
        const fields = await driver.findAll('//android.widget.EditText')
        if (fields.length < 3) return false

        await this.fillFields(driver, fields.slice(0, 3), [values.name, values.host, values.port])
        if (values.user || values.pass) {
            if (!(await this.selectAuthentication(driver, true))) return false
            await sleep(900)
            await this.scrollDown(driver)
            if (!(await this.fillAuthenticationFields(driver, values.user, values.pass))) return false
        }
        return true
    }

    private async fillAuthenticationFields(driver: AppiumDriver, user: string, pass: string): Promise<boolean> {
        for (let attempt = 0; attempt < 5; attempt += 1) {
            const authFields = await this.findAuthenticationFields(driver)
            if (authFields) {
                await this.fillField(driver, authFields.username, user)
                const authFieldsAfterUsername = await this.findAuthenticationFields(driver)
                if (!authFieldsAfterUsername) return false
                await this.fillField(driver, authFieldsAfterUsername.password, pass)
                return true
            }
            await this.scrollDown(driver)
        }
        return false
    }

    private async findAuthenticationFields(driver: AppiumDriver): Promise<{ username: string; password: string } | null> {
        const usernameField = await driver.findEditTextByText(['Username', 'username', 'User', 'user'])
        const passwordField = await driver.findEditTextByText(['Password', 'password'])
        if (usernameField && passwordField) return { username: usernameField, password: passwordField }

        const source = (await driver.source()).toLowerCase()
        const indexedFields = await this.findAuthenticationFieldsBySource(driver, source)
        if (indexedFields) return indexedFields

        const sourceWithoutMethod = source.replace(/username\s*\/\s*password/g, '')
        const authFieldsVisible = sourceWithoutMethod.includes('username') && sourceWithoutMethod.includes('password')
        if (!authFieldsVisible) return null

        const fields = await driver.findAll('//android.widget.EditText')
        if (fields.length < 2) return null
        const [username, password] = fields.slice(-2)
        return { username, password }
    }

    private async findAuthenticationFieldsBySource(
        driver: AppiumDriver,
        source: string,
    ): Promise<{ username: string; password: string } | null> {
        const editTextTags = Array.from(source.matchAll(/<[^>]*class="android\.widget\.edittext"[^>]*>/g))
        let usernameIndex = -1
        let passwordIndex = -1
        for (let index = 0; index < editTextTags.length; index += 1) {
            const searchable = ['text', 'hint', 'content-desc', 'resource-id']
                .map(attribute => xmlAttr(editTextTags[index][0], attribute))
                .join(' ')
            const normalized = searchable.replace(/username\s*\/\s*password/g, '')
            if (usernameIndex < 0 && (normalized.includes('username') || /\buser\b/.test(normalized))) {
                usernameIndex = index + 1
            }
            if (passwordIndex < 0 && normalized.includes('password')) {
                passwordIndex = index + 1
            }
        }
        if (usernameIndex < 1 || passwordIndex < 1) return null
        const username = await driver.find(`(//android.widget.EditText)[${usernameIndex}]`)
        const password = await driver.find(`(//android.widget.EditText)[${passwordIndex}]`)
        if (!username || !password) return null
        return { username, password }
    }

    private async fillFields(driver: AppiumDriver, fields: string[], values: string[]): Promise<void> {
        for (let index = 0; index < Math.min(fields.length, values.length); index += 1) {
            await this.fillField(driver, fields[index], values[index])
        }
    }

    private async fillField(driver: AppiumDriver, field: string, value: string): Promise<void> {
        await driver.click(field)
        await sleep(150)
        await driver.clear(field)
        await sleep(100)
        if (value) await driver.type(field, value)
        await driver.hideKeyboard()
        await sleep(350)
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

function xmlAttr(tag: string, name: string): string {
    const match = tag.match(new RegExp(`${name}="([^"]*)"`, 'i'))
    return match?.[1] || ''
}
