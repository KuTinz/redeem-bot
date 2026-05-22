import { access, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface RedeemServerConfig {
    host: string
    port: number
    apiKey: string
    rootDir: string
    runtimeDir: string
    proxyApp: 'v2rayng' | 'superproxy'
    ldplayer: {
        ldconsolePath: string
        adbPath: string
        profileNameMode: 'email' | 'prefixed-email' | 'safe'
        profilePrefix: string
        newProfile: {
            resolution: string
            cpu: number
            memory: number
        }
        serialByProfile: Record<string, string>
        bootTimeoutMs: number
    }
    appium: {
        url: string
        commandTimeoutMs: number
    }
    captcha: {
        provider: '' | '2captcha'
        apiKey: string
        apiBaseUrl: string
        timeoutMs: number
        pollIntervalMs: number
    }
    apks: {
        bing: string
        v2rayng: string
        superProxy: string
        appiumSettings: string
    }
    packages: {
        bing: string
        v2rayng: string
        superProxy: string
        appiumSettings: string
    }
    queue: {
        taskTimeoutMs: number
        manualTimeoutMs: number
        codeTimeoutMs: number
    }
}

type PartialDeep<T> = {
    [K in keyof T]?: T[K] extends Record<string, unknown> ? PartialDeep<T[K]> : T[K]
}

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const configPath = path.resolve(process.env.REDEEM_SERVER_CONFIG || path.join(process.cwd(), 'redeem-server.config.json'))

function defaultConfig(rootDir: string): RedeemServerConfig {
    return {
        host: '127.0.0.1',
        port: 8787,
        apiKey: '',
        rootDir,
        runtimeDir: path.join(rootDir, 'runtime'),
        proxyApp: 'v2rayng',
        ldplayer: {
            ldconsolePath: '',
            adbPath: '',
            profileNameMode: 'email',
            profilePrefix: 'redeem-',
            newProfile: {
                resolution: '540,960,240',
                cpu: 2,
                memory: 2048,
            },
            serialByProfile: {},
            bootTimeoutMs: 300000,
        },
        appium: {
            url: 'http://127.0.0.1:4723',
            commandTimeoutMs: 120000,
        },
        captcha: {
            provider: '',
            apiKey: '',
            apiBaseUrl: 'https://2captcha.com',
            timeoutMs: 120000,
            pollIntervalMs: 5000,
        },
        apks: {
            bing: path.join(rootDir, 'apks', 'bing.apk'),
            v2rayng: path.join(rootDir, 'apks', 'v2rayng.apk'),
            superProxy: path.join(rootDir, 'apks', 'superproxy.apk'),
            appiumSettings: path.join(rootDir, 'apks', 'appium-settings.apk'),
        },
        packages: {
            bing: 'com.microsoft.bing',
            v2rayng: 'com.v2ray.ang',
            superProxy: 'com.scheler.superproxy',
            appiumSettings: 'io.appium.settings',
        },
        queue: {
            taskTimeoutMs: 600000,
            manualTimeoutMs: 600000,
            codeTimeoutMs: 300000,
        },
    }
}

function merge<T>(base: T, override: PartialDeep<T>): T {
    const output: Record<string, unknown> = { ...(base as Record<string, unknown>) }
    for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
        if (value === undefined) continue
        const oldValue = output[key]
        if (isObject(oldValue) && isObject(value)) {
            output[key] = merge(oldValue, value)
        } else {
            output[key] = value
        }
    }
    return output as T
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function resolveConfiguredPaths(config: RedeemServerConfig, baseDir: string): RedeemServerConfig {
    config.runtimeDir = absoluteFrom(baseDir, config.runtimeDir)
    config.apks.bing = absoluteFrom(baseDir, config.apks.bing)
    config.apks.v2rayng = absoluteFrom(baseDir, config.apks.v2rayng)
    config.apks.superProxy = absoluteFrom(baseDir, config.apks.superProxy)
    config.apks.appiumSettings = absoluteFrom(baseDir, config.apks.appiumSettings)
    if (config.ldplayer.ldconsolePath) config.ldplayer.ldconsolePath = absoluteFrom(baseDir, config.ldplayer.ldconsolePath)
    if (config.ldplayer.adbPath) config.ldplayer.adbPath = absoluteFrom(baseDir, config.ldplayer.adbPath)
    return config
}

function absoluteFrom(baseDir: string, value: string): string {
    return path.isAbsolute(value) ? value : path.resolve(baseDir, value)
}

export async function loadConfig(): Promise<RedeemServerConfig> {
    let baseDir = sourceRoot
    let override: PartialDeep<RedeemServerConfig> = {}
    try {
        const raw = await readFile(configPath, 'utf8')
        const parsed = JSON.parse(raw) as PartialDeep<RedeemServerConfig>
        override = parsed
        baseDir = path.dirname(configPath)
    } catch (error) {
        const nodeError = error as NodeJS.ErrnoException
        if (nodeError.code !== 'ENOENT') throw error
    }
    const config = resolveConfiguredPaths(merge(defaultConfig(baseDir), override), baseDir)
    await mkdir(config.runtimeDir, { recursive: true })
    return config
}

export async function fileExists(filePath: string): Promise<boolean> {
    try {
        await access(filePath)
        return true
    } catch {
        return false
    }
}

export function currentConfigPath(): string {
    return configPath
}
