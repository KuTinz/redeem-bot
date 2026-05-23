import http from 'node:http'
import https from 'node:https'
import { RedeemServerConfig } from './config.js'
import { StepLogger } from './types.js'
import { sleep } from './util.js'

interface TwoCaptchaResponse {
    status?: number
    request?: string
}

export class CaptchaSolver {
    private readonly config: RedeemServerConfig['captcha']
    private readonly maxAttempts = 3

    constructor(config: RedeemServerConfig) {
        this.config = config.captcha
    }

    enabled(): boolean {
        return this.config.provider === '2captcha' && Boolean(this.config.apiKey)
    }

    async solveImage(captcha: string | undefined, log: StepLogger): Promise<string | null> {
        if (!this.enabled() || !captcha) return null
        const body = base64Body(captcha)
        if (!body) {
            log('processing', 'Captcha auto-solve skipped because captcha image is not base64 data')
            return null
        }

        let lastInvalidCode = ''
        for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
            log('processing', `Submitting captcha image to 2Captcha (attempt ${attempt}/${this.maxAttempts})`)
            const captchaId = await this.submitImage(body)

            const code = await this.pollResult(captchaId)
            if (!code) throw new Error(`2Captcha timed out after ${this.config.timeoutMs}ms`)
            const normalized = normalizeVerificationCode(code)
            if (isVerificationCode(normalized)) {
                log('success', '2Captcha returned a six character code')
                return normalized
            }

            lastInvalidCode = code
            log('processing', `2Captcha returned invalid code '${code}'; reporting bad and retrying`)
            await this.reportBad(captchaId)
        }

        throw new Error(`2Captcha returned invalid code after ${this.maxAttempts} attempts: ${lastInvalidCode}`)
    }

    private async submitImage(body: string): Promise<string> {
        const submit = await this.postForm<TwoCaptchaResponse>('/in.php', {
            key: this.config.apiKey,
            method: 'base64',
            body,
            regsense: '1',
            min_len: '6',
            max_len: '6',
            json: '1',
        })
        if (submit.status !== 1 || !submit.request) throw new Error(`2Captcha submit failed: ${submit.request || 'empty response'}`)
        return submit.request
    }

    private async reportBad(id: string): Promise<void> {
        try {
            await this.getJson<TwoCaptchaResponse>('/res.php', {
                key: this.config.apiKey,
                action: 'reportbad',
                id,
                json: '1',
            })
        } catch {
            // Reporting bad solves is best effort; the next attempt is more important.
        }
    }

    private async pollResult(id: string): Promise<string | null> {
        const start = Date.now()
        while (Date.now() - start < this.config.timeoutMs) {
            await sleep(this.config.pollIntervalMs)
            const result = await this.getJson<TwoCaptchaResponse>('/res.php', {
                key: this.config.apiKey,
                action: 'get',
                id,
                json: '1',
            })
            if (result.status === 1 && result.request) return result.request
            if (result.request !== 'CAPCHA_NOT_READY') throw new Error(`2Captcha solve failed: ${result.request || 'empty response'}`)
        }
        return null
    }

    private async postForm<T>(path: string, fields: Record<string, string>): Promise<T> {
        const payload = Buffer.from(new URLSearchParams(fields).toString())
        return await this.request<T>(path, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': String(payload.byteLength),
            },
            payload,
        })
    }

    private async getJson<T>(path: string, params: Record<string, string>): Promise<T> {
        const query = new URLSearchParams(params).toString()
        return await this.request<T>(`${path}?${query}`, { method: 'GET' })
    }

    private async request<T>(
        pathWithQuery: string,
        options: {
            method: string
            headers?: Record<string, string>
            payload?: Buffer
        },
    ): Promise<T> {
        const url = new URL(pathWithQuery, this.config.apiBaseUrl.replace(/\/+$/, '') + '/')
        const transport = url.protocol === 'https:' ? https : http
        return await new Promise((resolve, reject) => {
            const req = transport.request(
                url,
                {
                    method: options.method,
                    headers: options.headers,
                },
                response => {
                    let raw = ''
                    response.on('data', chunk => {
                        raw += chunk.toString()
                    })
                    response.on('end', () => {
                        try {
                            resolve(JSON.parse(raw) as T)
                        } catch {
                            reject(new Error(`2Captcha returned non-JSON response: ${raw.slice(0, 200)}`))
                        }
                    })
                },
            )
            req.setTimeout(this.config.timeoutMs, () => req.destroy(new Error('2Captcha request timed out')))
            req.on('error', reject)
            if (options.payload) req.write(options.payload)
            req.end()
        })
    }
}

function base64Body(captcha: string): string | null {
    const trimmed = captcha.trim()
    const match = trimmed.match(/^data:image\/[^;]+;base64,(.+)$/i)
    return match ? match[1] : trimmed || null
}

function normalizeVerificationCode(code: string): string {
    return code.replace(/\s+/g, '').trim()
}

function isVerificationCode(code: string): boolean {
    return /^[a-z0-9]{6}$/i.test(code)
}
