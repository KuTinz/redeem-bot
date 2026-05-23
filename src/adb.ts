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

    async inputTap(serial: string, x: number, y: number): Promise<void> {
        await this.run(await this.resolveLiveSerial(serial), ['shell', 'input', 'tap', String(x), String(y)], true)
    }

    async tapRatio(serial: string, xRatio: number, yRatio: number): Promise<void> {
        const size = await this.screenSize(serial)
        await this.inputTap(serial, Math.floor(size.width * xRatio), Math.floor(size.height * yRatio))
    }

    async screenSize(serial: string): Promise<{ width: number; height: number }> {
        const result = await this.run(await this.resolveLiveSerial(serial), ['shell', 'wm', 'size'], true)
        const match = `${result.stdout}\n${result.stderr}`.match(/Physical size:\s*(\d+)x(\d+)/i)
        if (!match) return { width: 540, height: 960 }
        return {
            width: Number.parseInt(match[1], 10),
            height: Number.parseInt(match[2], 10),
        }
    }

    async forceStop(serial: string, packageName: string): Promise<void> {
        await this.run(await this.resolveLiveSerial(serial), ['shell', 'am', 'force-stop', packageName], true)
    }

    async clearPackage(serial: string, packageName: string): Promise<void> {
        let lastOutput = ''
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            const liveSerial = await this.resolveLiveSerial(serial)
            const result = await this.run(liveSerial, ['shell', 'pm', 'clear', packageName], true)
            lastOutput = result.stderr || result.stdout
            if (result.code === 0 && /Success/i.test(`${result.stdout}\n${result.stderr}`)) return
            if (!isTransientAdbFailure(lastOutput)) break
            await sleep(1500)
        }
        throw new Error(`Could not clear ${packageName}: ${asErrorMessage(lastOutput)}`)
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
        if (/^127\.0\.0\.1:\d+$/.test(serial)) {
            await this.connect(serial)
            if ((await this.devices()).includes(serial)) return serial
        }
        if (devices.length === 1) return devices[0]
        throw new Error(`ADB device ${serial} not found. Online devices: ${devices.join(', ') || '(none)'}`)
    }
}

function isTransientAdbFailure(output: string): boolean {
    const lower = output.toLowerCase()
    return lower.includes('device offline') || lower.includes('device unauthorized') || lower.includes('not found')
}

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`
}
