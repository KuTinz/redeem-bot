import { AdbClient } from './adb.js'
import { AppiumDriver } from './appium.js'
import { RedeemServerConfig } from './config.js'
import { ProxyPayload, StepLogger } from './types.js'
import { sleep } from './util.js'

type ManualProtocol = 'HTTP' | 'SOCKS'

export class V2rayNgManager {
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

        log('processing', 'Clearing existing v2rayNG configs before adding task proxy')
        await this.adb.forceStop(serial, this.config.packages.v2rayng)
        await this.adb.clearPackage(serial, this.config.packages.v2rayng)
        log('success', 'Existing v2rayNG configs cleared')

        await this.adb.startPackage(serial, this.config.packages.v2rayng)
        await sleep(3000)

        const added = await this.tryAddManualProxy(profileName, proxy, driver, log)
        if (!added) {
            throw new Error('v2rayNG manual proxy add did not finish. Add the HTTP/SOCKS proxy in v2rayNG, connect it, then Resume.')
        }

        const connected = await this.tryConnect(driver, log)
        if (!connected) {
            throw new Error('v2rayNG config was added but VPN start was not detected. Connect it in LDPlayer, then Resume.')
        }
        await this.acceptVpnPrompt(driver)
        log('success', 'v2rayNG connect action sent')
    }

    private async tryAddManualProxy(
        profileName: string,
        proxy: ProxyPayload,
        driver: AppiumDriver,
        log: StepLogger,
    ): Promise<boolean> {
        const protocol = manualProtocol(proxy)
        const remarks = `redeem-${proxy.host}-${proxy.port}`
        const source = await driver.source()

        if (isAnyProxyForm(source) && !isProxyForm(source, protocol)) {
            await driver.back()
            await sleep(700)
        }

        if (!isProxyForm(await driver.source(), protocol)) {
            const openedAdd =
                (await driver.clickContentDescription(['Add', 'add', 'New'])) ||
                (await driver.clickText(['Add config', 'Add', '+']))
            if (!openedAdd) {
                log('processing', 'v2rayNG add menu was not detected')
                return false
            }
            await sleep(800)

            const selected =
                protocol === 'HTTP'
                    ? await driver.clickText(['HTTP', 'Http', 'http'])
                    : await driver.clickText(['SOCKS', 'Socks', 'socks', 'SOCKS5', 'Socks5'])
            if (!selected) {
                log('processing', `v2rayNG ${protocol} menu item was not detected`)
                return false
            }
            await sleep(1000)
        }

        const filled = await this.fillManualProxyForm(driver, {
            remarks,
            address: proxy.host,
            port: String(proxy.port),
            user: proxy.user || '',
            pass: proxy.pass || '',
        })
        if (!filled) {
            log('processing', 'v2rayNG manual proxy form fields were not detected')
            return false
        }

        await this.saveManualProxyForm(driver)
        await sleep(1200)
        await driver.clickText([remarks, remarks.slice(0, 28)])
        log('success', `v2rayNG ${protocol} proxy added manually for ${profileName}`)
        return true
    }

    private async fillManualProxyForm(
        driver: AppiumDriver,
        values: {
            remarks: string
            address: string
            port: string
            user: string
            pass: string
        },
    ): Promise<boolean> {
        const fields = await driver.findAll('//android.widget.EditText')
        if (fields.length < 3) return false

        const orderedValues = [values.remarks, values.address, values.port, values.user, values.pass]
        for (let index = 0; index < Math.min(fields.length, orderedValues.length); index += 1) {
            await driver.click(fields[index])
            await driver.clear(fields[index])
            if (orderedValues[index]) await driver.type(fields[index], orderedValues[index])
            await driver.hideKeyboard()
            await sleep(250)
        }
        return true
    }

    private async saveManualProxyForm(driver: AppiumDriver): Promise<void> {
        const saved =
            (await driver.clickContentDescription(['Save', 'save', 'Done', 'done', 'Confirm'])) ||
            (await driver.clickText(['Save', 'Done', 'OK']))
        if (saved) return

        const rect = await driver.windowRect()
        await driver.tap(rect.x + Math.floor(rect.width * 0.93), rect.y + Math.floor(rect.height * 0.11))
    }

    private async tryConnect(driver: AppiumDriver, log: StepLogger): Promise<boolean> {
        await sleep(1000)
        await this.acceptVpnPrompt(driver)
        const clicked =
            (await driver.clickContentDescription(['Connect', 'connect', 'Start', 'start'])) ||
            (await driver.clickText(['Connect', 'Start']))
        if (clicked) {
            log('processing', 'v2rayNG connect button clicked by selector')
            await sleep(1200)
            await this.acceptVpnPrompt(driver)
            if (await this.isVpnStarted(driver, log)) return true
            log('processing', 'v2rayNG still reports not connected after selector click; trying fallback tap')
        }

        return await this.tapConnectFallback(driver, log)
    }

    private async tapConnectFallback(driver: AppiumDriver, log: StepLogger): Promise<boolean> {
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            try {
                const rect = await driver.windowRect()
                const x = rect.x + Math.floor(rect.width * 0.9)
                const y = rect.y + Math.floor(rect.height * 0.87)
                await driver.tap(x, y)
                log('processing', `v2rayNG fallback tapped start button at ${x},${y} (attempt ${attempt})`)
                await sleep(1200)
                await this.acceptVpnPrompt(driver)
                if (await this.isVpnStarted(driver, log)) return true
            } catch {
                return false
            }
        }
        return false
    }

    private async isVpnStarted(driver: AppiumDriver, log: StepLogger): Promise<boolean> {
        try {
            const source = (await driver.source()).toLowerCase()
            if (source.includes('fail to detect internet connection') || source.includes('context deadline exceeded')) {
                log('processing', 'v2rayNG VPN service started, but its internet check failed; continuing with task')
                return true
            }
            if (source.includes('not connected') || source.includes('disconnected')) return false
            return source.includes('connected') || source.includes('stop')
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

function manualProtocol(proxy: ProxyPayload): ManualProtocol {
    return String(proxy.method || 'http')
        .toLowerCase()
        .startsWith('socks')
        ? 'SOCKS'
        : 'HTTP'
}

function isProxyForm(source: string, protocol: ManualProtocol): boolean {
    const lower = source.toLowerCase()
    return lower.includes(protocol.toLowerCase()) && lower.includes('address') && lower.includes('port')
}

function isAnyProxyForm(source: string): boolean {
    const lower = source.toLowerCase()
    return (lower.includes('http') || lower.includes('socks')) && lower.includes('address') && lower.includes('port')
}
