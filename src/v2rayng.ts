import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { AdbClient } from './adb.js'
import { AppiumDriver } from './appium.js'
import { RedeemServerConfig } from './config.js'
import { ProxyPayload, StepLogger } from './types.js'
import { sleep } from './util.js'

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
        const jsonPath = await this.writeConfig(profileName, proxy)
        const remotePath = `/sdcard/Download/${path.basename(jsonPath)}`
        await this.adb.push(serial, jsonPath, remotePath)
        await this.adb.chmod(serial, remotePath, '644')
        await this.adb.scanFile(serial, remotePath)
        if (!(await this.adb.fileExists(serial, remotePath))) {
            throw new Error(`Proxy custom config was pushed but is not visible at ${remotePath}`)
        }
        log('success', `Proxy custom config pushed to ${remotePath}`)

        await this.adb.startPackage(serial, this.config.packages.v2rayng)
        await sleep(2000)
        const imported = await this.tryImportLocalConfig(driver, path.basename(remotePath), log)
        if (!imported) {
            throw new Error(`v2rayNG UI import did not finish. Import ${remotePath} from Custom config in v2rayNG, connect it, then Resume.`)
        }
        const connected = await this.tryConnect(driver)
        if (!connected) {
            throw new Error('v2rayNG config was imported but connect button was not detected. Connect it in LDPlayer, then Resume.')
        }
        await driver.clickText(['OK', 'Allow'])
        log('success', 'v2rayNG connect action sent')
    }

    private async writeConfig(profileName: string, proxy: ProxyPayload): Promise<string> {
        const safeFile = profileName.replace(/[^a-z0-9_-]+/gi, '-')
        const folder = path.join(this.config.runtimeDir, 'proxy-configs')
        await mkdir(folder, { recursive: true })
        const filePath = path.join(folder, `${safeFile}.json`)
        await writeFile(filePath, JSON.stringify(v2rayConfig(proxy), null, 2), 'utf8')
        return filePath
    }

    private async tryImportLocalConfig(driver: AppiumDriver, fileName: string, log: StepLogger): Promise<boolean> {
        const openedAdd =
            (await driver.clickContentDescription(['Add', 'add', 'New'])) ||
            (await driver.clickText(['Add config', 'Add', '+']))
        if (!openedAdd) {
            log('processing', 'v2rayNG add menu was not detected')
            return false
        }
        await sleep(800)
        await driver.clickText(['Custom config'])
        await sleep(500)
        const local = await driver.clickText([
            'Import custom config from locally',
            'Import custom config from local',
            'Import from local',
        ])
        if (!local) return false
        await sleep(1200)
        if (!(await driver.clickText(['Download', 'Downloads']))) {
            log('processing', 'Android file picker did not expose Download label; searching config file directly')
        }
        await sleep(700)
        return await driver.clickText([fileName, fileName.replace(/\.json$/i, '')])
    }

    private async tryConnect(driver: AppiumDriver): Promise<boolean> {
        await sleep(1000)
        return (
            (await driver.clickContentDescription(['Connect', 'connect', 'Start'])) ||
            (await driver.clickText(['Connect', 'Start']))
        )
    }
}

function v2rayConfig(proxy: ProxyPayload): Record<string, unknown> {
    const protocol = String(proxy.method || 'http').toLowerCase().startsWith('socks') ? 'socks' : 'http'
    const user =
        proxy.user || proxy.pass
            ? {
                  level: 8,
                  user: proxy.user || '',
                  pass: proxy.pass || '',
              }
            : null
    return {
        dns: {
            servers: ['1.1.1.1', '8.8.8.8'],
            tag: 'dns-module',
        },
        remarks: `redeem-${proxy.host}-${proxy.port}`,
        log: {
            loglevel: 'warning',
        },
        inbounds: [
            {
                tag: 'socks',
                listen: '127.0.0.1',
                port: 10808,
                protocol: 'socks',
                settings: {
                    auth: 'noauth',
                    udp: true,
                    userLevel: 8,
                },
                sniffing: {
                    enabled: true,
                    destOverride: ['http', 'tls'],
                    routeOnly: false,
                },
            },
        ],
        outbounds: [
            {
                tag: 'proxy',
                protocol,
                mux: {
                    enabled: false,
                    concurrency: -1,
                },
                settings: {
                    servers: [
                        {
                            address: proxy.host,
                            level: 8,
                            port: Number(proxy.port),
                            ...(protocol === 'http' ? { ota: false } : {}),
                            ...(user ? { users: [user] } : {}),
                        },
                    ],
                },
                streamSettings: {
                    network: 'tcp',
                    sockopt: {
                        domainStrategy: 'UseIP',
                        happyEyeballs: {
                            interleave: 2,
                            maxConcurrentTry: 4,
                            prioritizeIPv6: false,
                            tryDelayMs: 250,
                        },
                    },
                },
            },
            {
                tag: 'direct',
                protocol: 'freedom',
                settings: {
                    domainStrategy: 'UseIP',
                },
            },
            {
                tag: 'block',
                protocol: 'blackhole',
                settings: {
                    response: {
                        type: 'http',
                    },
                },
            },
        ],
        routing: {
            domainStrategy: 'AsIs',
            rules: [
                {
                    type: 'field',
                    network: 'udp',
                    port: '443',
                    outboundTag: 'block',
                },
                {
                    type: 'field',
                    ip: ['geoip:private'],
                    outboundTag: 'direct',
                },
                {
                    type: 'field',
                    domain: ['geosite:private'],
                    outboundTag: 'direct',
                },
            ],
        },
    }
}
