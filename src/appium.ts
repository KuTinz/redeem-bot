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

    async back(): Promise<void> {
        await this.request(`/session/${this.sessionId}/back`, { method: 'POST', body: {} })
    }

    async hideKeyboard(): Promise<void> {
        try {
            await this.request(`/session/${this.sessionId}/appium/device/hide_keyboard`, {
                method: 'POST',
                body: {},
                allowStatus: [404],
            })
        } catch {
            // Some Android keyboards report an error when already hidden.
        }
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

    async swipe(startX: number, startY: number, endX: number, endY: number): Promise<void> {
        await this.request(`/session/${this.sessionId}/actions`, {
            method: 'POST',
            body: {
                actions: [
                    {
                        type: 'pointer',
                        id: 'finger1',
                        parameters: { pointerType: 'touch' },
                        actions: [
                            { type: 'pointerMove', duration: 0, x: startX, y: startY },
                            { type: 'pointerDown', button: 0 },
                            { type: 'pause', duration: 100 },
                            { type: 'pointerMove', duration: 450, x: endX, y: endY },
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
        if (await this.clickExactText(labels)) return true
        for (const label of labels) {
            const id = await this.find(textXpath(label))
            if (!id) continue
            await this.click(id)
            return true
        }
        return false
    }

    async clickExactText(labels: string[]): Promise<boolean> {
        for (const label of labels) {
            const id = await this.find(exactTextXpath(label))
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

    async findEditTextByText(labels: string[]): Promise<string | null> {
        for (const label of labels) {
            const exact = await this.find(exactTextXpath(label, 'android.widget.EditText'))
            if (exact) return exact
        }
        return null
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
    options: { requireRedeemCodeScreen?: boolean } = {},
): Promise<boolean> {
    await dismissBingStartup(driver)

    let touchedLoginUi = false
    for (let attempt = 0; attempt < 7; attempt += 1) {
        const source = await driver.source()
        if (isRedeemCodeScreen(source)) {
            log('success', 'Bing redeem verification screen is ready')
            return true
        }
        if (!isMicrosoftLoginPrompt(source)) {
            if (options.requireRedeemCodeScreen) {
                const fallbackClicked = await tapMicrosoftAuthFallback(driver, attempt)
                if (fallbackClicked) {
                    touchedLoginUi = true
                    await sleep(1800)
                    continue
                }
                log('processing', 'Bing redeem verification screen was not detected after opening link')
                return false
            }
            log('success', 'Bing login prompt not visible; reusing existing app session')
            return true
        }

        const passwordChoiceVisible =
            mentionsAny(source, ['Use your password', 'Use password']) ||
            (mentionsAny(source, ['Send code']) && !mentionsAny(source, ['Enter password']))
        if (passwordChoiceVisible) {
            if ((await clickUsePassword(driver)) || (await tapUsePasswordFallback(driver))) touchedLoginUi = true
            await sleep(1500)
            continue
        }

        if (mentionsAny(source, ['password']) && password) {
            const passwordField = await driver.waitForEditText(8000)
            if (passwordField) {
                await driver.clear(passwordField)
                await driver.type(passwordField, password)
                await driver.clickExactText(['Sign in', 'Next', 'Continue'])
                touchedLoginUi = true
                log('processing', 'Submitted Microsoft account password in Bing app')
                await sleep(3500)
                continue
            }
        }

        if (mentionsAny(source, ['email', 'phone', 'skype']) && email) {
            const emailField = await driver.waitForEditText(8000)
            if (emailField) {
                await driver.clear(emailField)
                await driver.type(emailField, email)
                await driver.clickExactText(['Next', 'Continue'])
                touchedLoginUi = true
                log('processing', 'Submitted Microsoft account email in Bing app')
                await sleep(2500)
                continue
            }
        }

        if (await clickMicrosoftSignIn(driver)) {
            touchedLoginUi = true
            await sleep(1800)
            continue
        }

        break
    }

    const afterPassword = await driver.source()
    if (totpSecret && mentionsAny(afterPassword, ['authenticator', 'two-step', 'two step', 'approve sign in'])) {
        const otpField = await driver.waitForEditText(4000)
        if (otpField) {
            await driver.clear(otpField)
            await driver.type(otpField, totp(totpSecret))
            await driver.clickExactText(['Verify', 'Next', 'Continue'])
            log('processing', 'Submitted TOTP in Bing app')
            await sleep(3000)
        }
    }

    await driver.clickText(['Yes', 'OK', 'Continue', 'Accept'])
    const finalSource = await driver.source()
    if (mentionsAny(finalSource, ['wrong password', 'try again', 'Help us protect', 'Approve sign in request'])) {
        return false
    }
    if (options.requireRedeemCodeScreen && !isRedeemCodeScreen(finalSource)) {
        log('processing', touchedLoginUi ? 'Bing login flow has not reached the redeem code screen yet' : 'Bing redeem code screen was not detected')
        return false
    }
    log('success', 'Bing login best-effort flow finished')
    return true
}

async function dismissBingStartup(driver: AppiumDriver): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const clicked = await driver.clickExactText(['Maybe later', 'Not now', 'Skip', 'Continue without sign in', 'Later'])
        if (!clicked) break
        await sleep(1000)
    }
}

async function clickMicrosoftSignIn(driver: AppiumDriver): Promise<boolean> {
    if (await driver.clickExactText(['Sign in', 'Sign In', 'Login', 'Log in'])) return true
    const source = await driver.source()
    if (!mentionsAny(source, ['Sign in to verify'])) return false
    return await driver.clickText(['Sign in'])
}

async function clickUsePassword(driver: AppiumDriver): Promise<boolean> {
    return await driver.clickExactText(['Use your password', 'Use password', 'Use your Password'])
}

async function tapUsePasswordFallback(driver: AppiumDriver): Promise<boolean> {
    const rect = await driver.windowRect()
    await driver.tap(rect.x + Math.floor(rect.width * 0.5), rect.y + Math.floor(rect.height * 0.72))
    return true
}

async function tapMicrosoftAuthFallback(driver: AppiumDriver, attempt: number): Promise<boolean> {
    if (attempt > 2) return false
    const rect = await driver.windowRect()
    const yRatios = [0.72, 0.64, 0.8]
    await driver.tap(rect.x + Math.floor(rect.width * 0.5), rect.y + Math.floor(rect.height * yRatios[attempt]))
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

function textXpath(label: string, className = '*'): string {
    const literal = xpathLiteral(label)
    return `//${className}[contains(@text, ${literal}) or contains(@hint, ${literal}) or contains(@content-desc, ${literal}) or contains(@resource-id, ${literal})]`
}

function exactTextXpath(label: string, className = '*'): string {
    const literal = xpathLiteral(label)
    return `//${className}[@text = ${literal} or @hint = ${literal} or @content-desc = ${literal} or @resource-id = ${literal}]`
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

function isMicrosoftLoginPrompt(source: string): boolean {
    return mentionsAny(source, [
        'sign in to verify',
        'sign in',
        'enter password',
        'use your password',
        'send code',
        'email',
        'phone',
        'skype',
    ])
}

function isRedeemCodeScreen(source: string): boolean {
    return (
        mentionsAny(source, ['six digit', 'six-digit', '6 digit', '6-digit']) ||
        (mentionsAny(source, ['verification code', 'security code']) && !isMicrosoftLoginPrompt(source))
    )
}
