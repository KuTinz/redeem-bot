import { RedeemServerConfig } from './config.js'
import { totp } from './totp.js'
import { jsonRequest, sleep } from './util.js'
import { StepLogger } from './types.js'

const elementKey = 'element-6066-11e4-a52e-4f735466cecf'

type AppiumElementResponse = {
    value?: Record<string, string>
}

type AppiumElementsResponse = {
    value?: Array<Record<string, string>>
}

type AppiumWindowRectResponse = {
    value?: {
        width?: number
        height?: number
        x?: number
        y?: number
    }
}

export class AppiumClient {
    private readonly baseUrl: string
    private readonly timeoutMs: number

    constructor(config: RedeemServerConfig) {
        this.baseUrl = config.appium.url.replace(/\/+$/, '')
        this.timeoutMs = config.appium.commandTimeoutMs
    }

    async probe(): Promise<void> {
        await jsonRequest(`${this.baseUrl}/status`, { timeoutMs: 5000 })
    }

    async createAndroidSession(serial: string): Promise<AppiumDriver> {
        const response = await jsonRequest<{
            sessionId?: string
            value?: { sessionId?: string }
        }>(`${this.baseUrl}/session`, {
            method: 'POST',
            timeoutMs: this.timeoutMs,
            body: {
                capabilities: {
                    alwaysMatch: {
                        platformName: 'Android',
                        'appium:automationName': 'UiAutomator2',
                        'appium:deviceName': serial,
                        'appium:udid': serial,
                        'appium:noReset': true,
                        'appium:newCommandTimeout': 180,
                        'appium:autoGrantPermissions': true,
                    },
                    firstMatch: [{}],
                },
            },
        })
        const sessionId = response.body.value?.sessionId || response.body.sessionId
        if (!sessionId) throw new Error(`Appium did not return session id: ${JSON.stringify(response.body)}`)
        return new AppiumDriver(this.baseUrl, sessionId, this.timeoutMs)
    }
}

export class AppiumDriver {
    private readonly baseUrl: string
    private readonly sessionId: string
    private readonly timeoutMs: number

    constructor(baseUrl: string, sessionId: string, timeoutMs: number) {
        this.baseUrl = baseUrl
        this.sessionId = sessionId
        this.timeoutMs = timeoutMs
    }

    async close(): Promise<void> {
        await this.request(`/session/${this.sessionId}`, { method: 'DELETE', allowStatus: [404] })
    }

    async source(): Promise<string> {
        const response = await this.request<{ value?: string }>(`/session/${this.sessionId}/source`)
        return response.body.value || ''
    }

    async find(xpath: string): Promise<string | null> {
        try {
            const response = await this.request<AppiumElementResponse>(`/session/${this.sessionId}/element`, {
                method: 'POST',
                body: { using: 'xpath', value: xpath },
            })
            return elementId(response.body.value)
        } catch {
            return null
        }
    }

    async findAll(xpath: string): Promise<string[]> {
        try {
            const response = await this.request<AppiumElementsResponse>(`/session/${this.sessionId}/elements`, {
                method: 'POST',
                body: { using: 'xpath', value: xpath },
            })
            return (response.body.value || []).map(elementId).filter((id): id is string => Boolean(id))
        } catch {
            return []
        }
    }

    async click(id: string): Promise<void> {
        await this.request(`/session/${this.sessionId}/element/${id}/click`, { method: 'POST', body: {} })
    }

    async tap(x: number, y: number): Promise<void> {
        await this.request(`/session/${this.sessionId}/actions`, {
            method: 'POST',
            body: {
                actions: [
                    {
                        type: 'pointer',
                        id: 'finger1',
                        parameters: { pointerType: 'touch' },
                        actions: [
                            { type: 'pointerMove', duration: 0, x, y },
                            { type: 'pointerDown', button: 0 },
                            { type: 'pause', duration: 120 },
                            { type: 'pointerUp', button: 0 },
                        ],
                    },
                ],
            },
        })
    }

    async windowRect(): Promise<{ width: number; height: number; x: number; y: number }> {
        const response = await this.request<AppiumWindowRectResponse>(`/session/${this.sessionId}/window/rect`)
        const rect = response.body.value || {}
        return {
            width: rect.width || 540,
            height: rect.height || 960,
            x: rect.x || 0,
            y: rect.y || 0,
        }
    }

    async clear(id: string): Promise<void> {
        await this.request(`/session/${this.sessionId}/element/${id}/clear`, {
            method: 'POST',
            body: {},
            allowStatus: [404],
        })
    }

    async type(id: string, text: string): Promise<void> {
        await this.request(`/session/${this.sessionId}/element/${id}/value`, {
            method: 'POST',
            body: { text, value: [...text] },
        })
    }

    async clickText(labels: string[]): Promise<boolean> {
        for (const label of labels) {
            const id = await this.find(textXpath(label))
            if (!id) continue
            await this.click(id)
            return true
        }
        return false
    }

    async clickContentDescription(labels: string[]): Promise<boolean> {
        for (const label of labels) {
            const id = await this.find(`//*[contains(@content-desc, ${xpathLiteral(label)})]`)
            if (!id) continue
            await this.click(id)
            return true
        }
        return false
    }

    async firstEditText(): Promise<string | null> {
        return await this.find('(//android.widget.EditText)[1]')
    }

    async waitForEditText(timeoutMs: number): Promise<string | null> {
        const start = Date.now()
        while (Date.now() - start < timeoutMs) {
            const id = await this.firstEditText()
            if (id) return id
            await sleep(1000)
        }
        return null
    }

    private async request<T = unknown>(
        route: string,
        options: {
            method?: string
            body?: unknown
            allowStatus?: number[]
        } = {},
    ) {
        return await jsonRequest<T>(`${this.baseUrl}${route}`, {
            ...options,
            timeoutMs: this.timeoutMs,
        })
    }
}

export async function bestEffortBingLogin(
    driver: AppiumDriver,
    email: string,
    password: string,
    totpSecret: string | undefined,
    log: StepLogger,
): Promise<boolean> {
    await driver.clickText(['Sign in', 'Sign In', 'Login', 'Log in'])
    await sleep(1500)

    const sourceBefore = await driver.source()
    if (!mentionsAny(sourceBefore, ['Sign in', 'Enter password', 'Email', 'Microsoft'])) {
        log('success', 'Bing login prompt not visible; reusing existing app session')
        return true
    }

    const emailField = await driver.waitForEditText(8000)
    if (emailField && email) {
        await driver.clear(emailField)
        await driver.type(emailField, email)
        await driver.clickText(['Next', 'Continue'])
        log('processing', 'Submitted Microsoft account email in Bing app')
        await sleep(2500)
    }

    const passwordField = await driver.waitForEditText(8000)
    if (passwordField && password) {
        await driver.clear(passwordField)
        await driver.type(passwordField, password)
        await driver.clickText(['Sign in', 'Next', 'Continue'])
        log('processing', 'Submitted Microsoft account password in Bing app')
        await sleep(3500)
    }

    const afterPassword = await driver.source()
    if (totpSecret && mentionsAny(afterPassword, ['code', 'verification', 'Authenticator', 'Verify'])) {
        const otpField = await driver.waitForEditText(4000)
        if (otpField) {
            await driver.clear(otpField)
            await driver.type(otpField, totp(totpSecret))
            await driver.clickText(['Verify', 'Next', 'Continue'])
            log('processing', 'Submitted TOTP in Bing app')
            await sleep(3000)
        }
    }

    await driver.clickText(['Yes', 'OK', 'Continue', 'Accept'])
    const finalSource = await driver.source()
    if (mentionsAny(finalSource, ['wrong password', 'try again', 'Help us protect', 'Approve sign in request'])) {
        return false
    }
    log('success', 'Bing login best-effort flow finished')
    return true
}

export async function enterVerificationCode(driver: AppiumDriver, code: string, log: StepLogger): Promise<boolean> {
    const input = await driver.waitForEditText(10000)
    if (!input) return false
    await driver.clear(input)
    await driver.type(input, code)
    await driver.clickText(['Verify', 'Next', 'Continue', 'Submit'])
    log('success', 'Submitted six digit Bing verification code')
    return true
}

function elementId(value: Record<string, string> | undefined): string | null {
    return value?.[elementKey] || value?.ELEMENT || null
}

function textXpath(label: string): string {
    const literal = xpathLiteral(label)
    return `//*[contains(@text, ${literal}) or contains(@content-desc, ${literal})]`
}

function xpathLiteral(value: string): string {
    if (!value.includes("'")) return `'${value}'`
    if (!value.includes('"')) return `"${value}"`
    return `concat('${value.replace(/'/g, `',"'",'`)}')`
}

function mentionsAny(source: string, terms: string[]): boolean {
    const lower = source.toLowerCase()
    return terms.some(term => lower.includes(term.toLowerCase()))
}
