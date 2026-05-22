import { fileExists } from './config.js'
import { asErrorMessage, runCommand, sleep } from './util.js'
import { StepLogger } from './types.js'

export class AdbClient {
    readonly executable: string

    constructor(executable = 'adb') {
        this.executable = executable || 'adb'
    }

    async run(serial: string | null, args: string[], allowFailure = false) {
        const serialArgs = serial ? ['-s', serial, ...args] : args
        return await runCommand(this.executable, serialArgs, {
            allowFailure,
            timeoutMs: 120000,
        })
    }

    async devices(): Promise<string[]> {
        const result = await this.run(null, ['devices'], false)
        return result.stdout
            .split(/\r?\n/)
            .slice(1)
            .map(line => line.trim().split(/\s+/))
            .filter(parts => parts[0] && parts[1] === 'device')
            .map(parts => parts[0])
    }

    async connect(hostAndPort: string): Promise<void> {
        await this.run(null, ['connect', hostAndPort], true)
    }

    async waitForBoot(serial: string, timeoutMs: number, log: StepLogger): Promise<void> {
        const start = Date.now()
        await this.run(serial, ['wait-for-device'], false)
        while (Date.now() - start < timeoutMs) {
            const result = await this.run(serial, ['shell', 'getprop', 'sys.boot_completed'], true)
            if (result.stdout.trim() === '1') {
                log('success', `ADB device ${serial} booted`)
                return
            }
            await sleep(2000)
        }
        throw new Error(`ADB device ${serial} did not report boot complete within ${timeoutMs}ms`)
    }

    async isPackageInstalled(serial: string, packageName: string): Promise<boolean> {
        const result = await this.run(serial, ['shell', 'pm', 'list', 'packages', packageName], true)
        return result.stdout.split(/\r?\n/).some(line => line.trim() === `package:${packageName}`)
    }

    async installIfMissing(
        serial: string,
        packageName: string,
        apkPath: string,
        label: string,
        log: StepLogger,
        optional = false,
    ): Promise<void> {
        if (await this.isPackageInstalled(serial, packageName)) {
            log('success', `${label} already installed`)
            return
        }
        if (!(await fileExists(apkPath))) {
            if (optional) {
                log('processing', `${label} APK not found at ${apkPath}; skipping optional install`)
                return
            }
            throw new Error(`${label} APK missing at ${apkPath}`)
        }
        log('processing', `Installing ${label} from ${apkPath}`)
        const result = await this.run(serial, ['install', '-r', apkPath], true)
        if (result.code !== 0 || !/Success/i.test(`${result.stdout}\n${result.stderr}`)) {
            throw new Error(`Failed to install ${label}: ${result.stderr || result.stdout}`)
        }
        log('success', `${label} installed`)
    }

    async push(serial: string, source: string, destination: string): Promise<void> {
        await this.run(serial, ['push', source, destination], false)
    }

    async fileExists(serial: string, filePath: string): Promise<boolean> {
        const result = await this.run(serial, ['shell', 'ls', '-l', filePath], true)
        return result.code === 0
    }

    async chmod(serial: string, filePath: string, mode: string): Promise<void> {
        await this.run(serial, ['shell', 'chmod', mode, filePath], true)
    }

    async scanFile(serial: string, filePath: string): Promise<void> {
        await this.run(
            serial,
            ['shell', 'am', 'broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE', '-d', shellQuote(`file://${filePath}`)],
            true,
        )
    }

    async openUrl(serial: string, url: string, packageName?: string): Promise<void> {
        const liveSerial = await this.resolveLiveSerial(serial)
        const args = ['shell', 'am', 'start', '-a', 'android.intent.action.VIEW']
        if (packageName) args.push('-p', packageName)
        args.push('-d', shellQuote(url))
        await this.run(liveSerial, args, false)
    }

    async forceStop(serial: string, packageName: string): Promise<void> {
        await this.run(serial, ['shell', 'am', 'force-stop', packageName], true)
    }

    async clearPackage(serial: string, packageName: string): Promise<void> {
        const result = await this.run(serial, ['shell', 'pm', 'clear', packageName], true)
        if (result.code !== 0 || !/Success/i.test(`${result.stdout}\n${result.stderr}`)) {
            throw new Error(`Could not clear ${packageName}: ${asErrorMessage(result.stderr || result.stdout)}`)
        }
    }

    async startPackage(serial: string, packageName: string): Promise<void> {
        const liveSerial = await this.resolveLiveSerial(serial)
        const result = await this.run(
            liveSerial,
            ['shell', 'monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1'],
            true,
        )
        if (result.code !== 0) throw new Error(`Could not start ${packageName}: ${asErrorMessage(result.stderr || result.stdout)}`)
    }

    async resolveLiveSerial(serial: string): Promise<string> {
        const devices = await this.devices()
        if (devices.includes(serial)) return serial
        const hostPort = serial.match(/^emulator-(\d+)$/)
        if (hostPort) {
            const port = Number.parseInt(hostPort[1], 10) + 1
            const loopback = `127.0.0.1:${port}`
            if (devices.includes(loopback)) return loopback
            await this.connect(loopback)
            if ((await this.devices()).includes(loopback)) return loopback
        }
        if (devices.length === 1) return devices[0]
        throw new Error(`ADB device ${serial} not found. Online devices: ${devices.join(', ') || '(none)'}`)
    }
}

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`
}
