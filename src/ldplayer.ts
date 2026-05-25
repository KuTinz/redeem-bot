import path from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { fileExists, RedeemServerConfig } from './config.js'
import { AdbClient } from './adb.js'
import { CommandError, runCommand, sanitizeProfileName, sleep } from './util.js'
import { StepLogger } from './types.js'

interface LdProfile {
    index: number
    name: string
}

export interface LdInstance {
    profileName: string
    serial: string
    index: number
    created: boolean
}

export class LdPlayerManager {
    private readonly config: RedeemServerConfig
    private consolePath: string | null = null

    constructor(config: RedeemServerConfig) {
        this.config = config
    }

    async resolveConsolePath(): Promise<string> {
        if (this.consolePath) return this.consolePath
        for (const candidate of this.consoleCandidates()) {
            if (await fileExists(candidate)) {
                this.consolePath = candidate
                return candidate
            }
        }
        throw new Error(
            'ldconsole.exe was not found. Set ldplayer.ldconsolePath in redeem-server.config.json for the Windows LDPlayer install.',
        )
    }

    async resolveAdbPath(): Promise<string> {
        if (this.config.ldplayer.adbPath) return this.config.ldplayer.adbPath
        try {
            const consolePath = await this.resolveConsolePath()
            const bundledAdb = path.join(path.dirname(consolePath), 'adb.exe')
            if (await fileExists(bundledAdb)) return bundledAdb
        } catch {
            // A standalone adb on PATH remains a valid fallback.
        }
        return 'adb'
    }

    async ensureProfile(email: string, adb: AdbClient, log: StepLogger): Promise<LdInstance> {
        const profileName = this.profileNameForEmail(email)
        let profiles = await this.listProfiles()
        let profile = this.selectProfile(profiles, profileName, log)
        let created = false
        if (!profile) {
            log('processing', `Creating LDPlayer profile ${profileName}`)
            await this.createProfile(profileName, profiles, log)
            profiles = await this.listProfiles()
            profile = this.selectProfile(profiles, profileName, log)
            created = true
            await this.modifyNewProfile(profileName, log)
        }
        if (!profile) throw new Error(`LDPlayer did not expose profile ${profileName} after add`)
        await this.enableAdbDebug(profile, log)

        log('processing', `Launching LDPlayer profile ${profileName} (index ${profile.index})`)
        await this.run(['launch', '--index', String(profile.index)])
        const serial = await this.waitForSerial(profile, adb)
        await adb.waitForBoot(serial, this.config.ldplayer.bootTimeoutMs, log)
        return {
            profileName,
            serial,
            index: profile.index,
            created,
        }
    }

    async listProfiles(): Promise<LdProfile[]> {
        const result = await this.run(['list2'])
        return result.stdout
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean)
            .map(line => line.split(','))
            .filter(fields => fields.length >= 2 && Number.isFinite(Number.parseInt(fields[0], 10)))
            .map(fields => ({
                index: Number.parseInt(fields[0], 10),
                name: fields[1],
            }))
    }

    async quitProfile(instance: Pick<LdInstance, 'profileName' | 'index'>): Promise<void> {
        try {
            await this.run(['quit', '--index', String(instance.index)])
            return
        } catch {
            await this.run(['quit', '--name', instance.profileName])
        }
    }

    private async waitForSerial(profile: LdProfile, adb: AdbClient): Promise<string> {
        const configured = this.config.ldplayer.serialByProfile[profile.name]
        if (configured) return configured

        const emulatorSerial = `emulator-${5554 + profile.index * 2}`
        const tcpSerial = this.tcpSerialForIndex(profile.index)
        const start = Date.now()
        while (Date.now() - start < this.config.ldplayer.bootTimeoutMs) {
            await adb.connect(tcpSerial)
            const devices = await adb.devices()
            if (devices.includes(tcpSerial)) return tcpSerial
            if (devices.includes(emulatorSerial)) return emulatorSerial
            if (devices.length === 1) return devices[0]
            await sleep(2000)
        }
        const devices = await adb.devices()
        throw new Error(
            `Could not map LDPlayer profile ${profile.name} to ADB. Devices: ${devices.join(', ') || '(none)'}. ` +
                `Enable LDPlayer ADB/local connection, or configure ldplayer.serialByProfile for this profile.`,
        )
    }

    private tcpSerialForIndex(index: number): string {
        return `127.0.0.1:${5555 + index * 2}`
    }

    private async createProfile(profileName: string, existingProfiles: LdProfile[], log: StepLogger): Promise<void> {
        try {
            await this.run(['add', '--name', profileName])
            return
        } catch (error) {
            const message = error instanceof CommandError ? commandFailureDetail(error) : String(error)
            const created = await this.profileCreatedDespiteExitCode(profileName, 'add', log)
            if (created) return
            log('processing', `LDPlayer add failed; trying copy fallback from index 0. ${message}`)
        }

        const source = existingProfiles.find(profile => profile.index === 0) || existingProfiles[0]
        if (!source) throw new Error('LDPlayer add failed and no existing instance is available for copy fallback')
        try {
            await this.run(['copy', '--name', profileName, '--from', String(source.index)])
        } catch (error) {
            const created = await this.profileCreatedDespiteExitCode(profileName, 'copy', log)
            if (created) return
            throw error
        }
    }

    private selectProfile(profiles: LdProfile[], profileName: string, log: StepLogger): LdProfile | undefined {
        const matches = profiles.filter(item => item.name === profileName)
        const profile = matches[0]
        if (profile && matches.length > 1) {
            log(
                'processing',
                `Multiple LDPlayer profiles named ${profileName} were found; using index ${profile.index}. Remove duplicates later to avoid confusion.`,
            )
        }
        return profile
    }

    private async profileCreatedDespiteExitCode(profileName: string, action: 'add' | 'copy', log: StepLogger): Promise<boolean> {
        const profile = (await this.listProfiles()).find(item => item.name === profileName)
        if (!profile) return false
        log('success', `LDPlayer ${action} returned a non-zero exit code, but profile ${profileName} exists at index ${profile.index}`)
        return true
    }

    private async modifyNewProfile(profileName: string, log: StepLogger): Promise<void> {
        const settings = this.config.ldplayer.newProfile
        log(
            'processing',
            `Applying LDPlayer profile settings | resolution=${settings.resolution} | cpu=${settings.cpu} | memory=${settings.memory}`,
        )
        await this.run([
            'modify',
            '--name',
            profileName,
            '--resolution',
            settings.resolution,
            '--cpu',
            String(settings.cpu),
            '--memory',
            String(settings.memory),
        ])
    }

    private async enableAdbDebug(profile: LdProfile, log: StepLogger): Promise<void> {
        const mode = this.config.ldplayer.adbDebugMode
        if (mode === 'off') return

        const configPath = await this.profileConfigPath(profile.index)
        if (!configPath) {
            log(
                'processing',
                `LDPlayer config for profile ${profile.name} was not found; enable ADB debugging manually if ADB mapping fails.`,
            )
            return
        }

        const raw = await readFile(configPath, 'utf8')
        const next = setLdConfigNumber(raw, 'basicSettings.adbDebug', adbDebugValue(mode))
        if (next === raw) {
            log('success', `LDPlayer ADB debugging already enabled for ${profile.name}`)
            return
        }

        await writeFile(configPath, next, 'utf8')
        log('success', `Enabled LDPlayer ADB debugging (${mode}) for ${profile.name}`)
    }

    private async profileConfigPath(index: number): Promise<string | null> {
        const consolePath = await this.resolveConsolePath()
        const root = path.dirname(consolePath)
        const candidates = [
            path.join(root, 'vms', 'config', `leidian${index}.config`),
            path.join(root, 'vms', `leidian${index}`, 'config.ini'),
        ]
        for (const candidate of candidates) {
            if (await fileExists(candidate)) return candidate
        }
        return null
    }

    private profileNameForEmail(email: string): string {
        const cleanEmail = email.trim()
        if (this.config.ldplayer.profileNameMode === 'email') return cleanEmail
        if (this.config.ldplayer.profileNameMode === 'prefixed-email') return `${this.config.ldplayer.profilePrefix}${cleanEmail}`
        return sanitizeProfileName(this.config.ldplayer.profilePrefix, cleanEmail)
    }

    private async run(args: string[]) {
        const consolePath = await this.resolveConsolePath()
        return await runCommand(consolePath, args, {
            timeoutMs: 120000,
            cwd: path.dirname(consolePath),
        })
    }

    private consoleCandidates(): string[] {
        const configured = this.config.ldplayer.ldconsolePath ? [this.config.ldplayer.ldconsolePath] : []
        const roots = [
            process.env.LDPLAYER_HOME,
            process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'LDPlayer', 'LDPlayer9') : '',
            process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'] || '', 'LDPlayer', 'LDPlayer9') : '',
            'C:\\LDPlayer\\LDPlayer9',
            'C:\\Program Files\\LDPlayer\\LDPlayer9',
            'C:\\Program Files (x86)\\LDPlayer\\LDPlayer9',
        ].filter((root): root is string => Boolean(root))
        return [...configured, ...roots.map(root => path.join(root, 'ldconsole.exe'))]
    }
}

function commandFailureDetail(error: CommandError): string {
    const { code, stdout, stderr } = error.result
    const output = stderr || stdout || '(no stdout/stderr)'
    return `exit=${code}; output=${output}`
}

function adbDebugValue(mode: RedeemServerConfig['ldplayer']['adbDebugMode']): number {
    if (mode === 'remote' || mode === 'local') return 1
    return 0
}

function setLdConfigNumber(raw: string, key: string, value: number): string {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`("${escaped}"\\s*:\\s*)\\d+`)
    if (pattern.test(raw)) return raw.replace(pattern, `$1${value}`)

    const lastBrace = raw.lastIndexOf('}')
    const line = `${raw.trimEnd().endsWith('{') ? '' : ','}\n    "${key}": ${value}\n`
    if (lastBrace >= 0) return `${raw.slice(0, lastBrace).trimEnd()}${line}${raw.slice(lastBrace)}`
    return `${raw.trimEnd()}\n"${key}": ${value}\n`
}
