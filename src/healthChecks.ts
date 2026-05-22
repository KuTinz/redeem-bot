import { AdbClient } from './adb.js'
import { AppiumClient } from './appium.js'
import { fileExists, RedeemServerConfig } from './config.js'
import { LdPlayerManager } from './ldplayer.js'
import { HealthCheck } from './types.js'
import { asErrorMessage } from './util.js'

export async function runHealthChecks(config: RedeemServerConfig): Promise<HealthCheck[]> {
    const results: HealthCheck[] = []
    await check(results, 'bing-apk', async () => {
        if (!(await fileExists(config.apks.bing))) throw new Error(`Missing ${config.apks.bing}`)
        return config.apks.bing
    })
    await check(results, 'v2rayng-apk', async () => {
        if (!(await fileExists(config.apks.v2rayng))) throw new Error(`Missing ${config.apks.v2rayng}`)
        return config.apks.v2rayng
    })
    await check(results, 'ldconsole', async () => await new LdPlayerManager(config).resolveConsolePath())
    await check(results, 'adb', async () => {
        const ldplayer = new LdPlayerManager(config)
        const adb = new AdbClient(await ldplayer.resolveAdbPath())
        const devices = await adb.devices()
        return devices.length ? `Online devices: ${devices.join(', ')}` : 'ADB available; no online device yet'
    })
    await check(results, 'appium', async () => {
        await new AppiumClient(config).probe()
        return config.appium.url
    })
    return results
}

async function check(results: HealthCheck[], name: string, action: () => Promise<string>): Promise<void> {
    try {
        results.push({ name, ok: true, detail: await action() })
    } catch (error) {
        results.push({ name, ok: false, detail: asErrorMessage(error) })
    }
}
