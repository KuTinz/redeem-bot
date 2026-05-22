import path from 'node:path'
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
        const profileName = sanitizeProfileName(this.config.ldplayer.profilePrefix, email)
        let profiles = await this.listProfiles()
        let profile = profiles.find(item => item.name === profileName)
        let created = false
        if (!profile) {
            log('processing', `Creating LDPlayer profile ${profileName}`)
            await this.createProfile(profileName, profiles, log)
            profiles = await this.listProfiles()
            profile = profiles.find(item => item.name === profileName)
            created = true
        }
        if (!profile) throw new Error(`LDPlayer did not expose profile ${profileName} after add`)

        log('processing', `Launching LDPlayer profile ${profileName}`)
        await this.run(['launch', '--name', profileName])
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

    private async waitForSerial(profile: LdProfile, adb: AdbClient): Promise<string> {
        const configured = this.config.ldplayer.serialByProfile[profile.name]
        if (configured) return configured

        const emulatorSerial = `emulator-${5554 + profile.index * 2}`
        const connectPort = 5555 + profile.index * 2
        const start = Date.now()
        while (Date.now() - start < this.config.ldplayer.bootTimeoutMs) {
            await adb.connect(`127.0.0.1:${connectPort}`)
            const devices = await adb.devices()
            if (devices.includes(emulatorSerial)) return emulatorSerial
            if (devices.includes(`127.0.0.1:${connectPort}`)) return `127.0.0.1:${connectPort}`
            if (devices.length === 1) return devices[0]
            await sleep(2000)
        }
        const devices = await adb.devices()
        throw new Error(
            `Could not map LDPlayer profile ${profile.name} to ADB. Devices: ${devices.join(', ') || '(none)'}. Configure ldplayer.serialByProfile.`,
        )
    }

    private async createProfile(profileName: string, existingProfiles: LdProfile[], log: StepLogger): Promise<void> {
        try {
            await this.run(['add', '--name', profileName])
            return
        } catch (error) {
            const message = error instanceof CommandError ? commandFailureDetail(error) : String(error)
            log('processing', `LDPlayer add failed; trying copy fallback from index 0. ${message}`)
        }

        const source = existingProfiles.find(profile => profile.index === 0) || existingProfiles[0]
        if (!source) throw new Error('LDPlayer add failed and no existing instance is available for copy fallback')
        await this.run(['copy', '--name', profileName, '--from', String(source.index)])
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
