import { spawn } from 'node:child_process'
import http from 'node:http'
import https from 'node:https'

export interface CommandResult {
    command: string
    args: string[]
    code: number
    stdout: string
    stderr: string
}

export class CommandError extends Error {
    readonly result: CommandResult

    constructor(result: CommandResult) {
        super(`${result.command} ${result.args.join(' ')} exited with ${result.code}: ${result.stderr || result.stdout}`)
        this.result = result
    }
}

export async function runCommand(
    command: string,
    args: string[],
    options: { timeoutMs?: number; allowFailure?: boolean; cwd?: string } = {},
): Promise<CommandResult> {
    return await new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: options.cwd,
            windowsHide: true,
            shell: false,
        })
        let stdout = ''
        let stderr = ''
        let timedOut = false
        const timer = options.timeoutMs
            ? setTimeout(() => {
                  timedOut = true
                  child.kill()
              }, options.timeoutMs)
            : null

        child.stdout?.on('data', (chunk: Buffer) => {
            stdout += chunk.toString()
        })
        child.stderr?.on('data', (chunk: Buffer) => {
            stderr += chunk.toString()
        })
        child.on('error', reject)
        child.on('close', code => {
            if (timer) clearTimeout(timer)
            const result: CommandResult = {
                command,
                args,
                code: timedOut ? 124 : code ?? 1,
                stdout: stdout.trim(),
                stderr: timedOut ? `${stderr}\nCommand timed out`.trim() : stderr.trim(),
            }
            if (!options.allowFailure && result.code !== 0) {
                reject(new CommandError(result))
                return
            }
            resolve(result)
        })
    })
}

export async function sleep(ms: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms))
}

export function sanitizeProfileName(prefix: string, email: string): string {
    const stem = email
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48)
    return `${prefix}${stem || 'account'}`
}

export function newId(prefix = 'task'): string {
    const random = Math.random().toString(36).slice(2, 9)
    return `${prefix}_${Date.now().toString(36)}_${random}`
}

export function asErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

export function jsonRequest<T>(
    rawUrl: string,
    options: {
        method?: string
        headers?: Record<string, string>
        body?: unknown
        timeoutMs?: number
        allowStatus?: number[]
    } = {},
): Promise<{ status: number; body: T }> {
    const url = new URL(rawUrl)
    const transport = url.protocol === 'https:' ? https : http
    const payload = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body))
    return new Promise((resolve, reject) => {
        const req = transport.request(
            url,
            {
                method: options.method || 'GET',
                headers: {
                    ...(payload
                        ? {
                              'Content-Type': 'application/json',
                              'Content-Length': String(payload.byteLength),
                          }
                        : {}),
                    ...(options.headers || {}),
                },
            },
            response => {
                let raw = ''
                response.on('data', chunk => {
                    raw += chunk.toString()
                })
                response.on('end', () => {
                    const status = response.statusCode || 0
                    let parsed: unknown = {}
                    if (raw) {
                        try {
                            parsed = JSON.parse(raw)
                        } catch {
                            parsed = { value: raw }
                        }
                    }
                    const allowed = options.allowStatus || []
                    if ((status < 200 || status >= 300) && !allowed.includes(status)) {
                        reject(new Error(`${options.method || 'GET'} ${url.toString()} returned ${status}: ${raw.slice(0, 500)}`))
                        return
                    }
                    resolve({ status, body: parsed as T })
                })
            },
        )
        req.setTimeout(options.timeoutMs || 10000, () => req.destroy(new Error('Request timed out')))
        req.on('error', reject)
        if (payload) req.write(payload)
        req.end()
    })
}

export function consoleTime(): string {
    return new Date().toISOString()
}
