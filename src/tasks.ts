import { AutoPhonePayload, PublicTask, SendTaskRequest, TaskLogStatus, TaskRecord, TaskStatus } from './types.js'
import { newId } from './util.js'

export class TaskStore {
    private readonly tasks = new Map<string, TaskRecord>()

    createRedeem(request: SendTaskRequest): TaskRecord {
        validateRedeemRequest(request)
        const now = new Date().toISOString()
        const task: TaskRecord = {
            id: newId('redeem'),
            type: request.type,
            payload: request.payload,
            priority: Number.isFinite(request.priority) ? Number(request.priority) : 5,
            status: 'pending',
            logs: [],
            createdAt: now,
            updatedAt: now,
        }
        this.tasks.set(task.id, task)
        this.log(task, 'pending', `Queued redeem task for ${request.payload.email}`)
        return task
    }

    createAutoPhone(payload: AutoPhonePayload): TaskRecord {
        if (!payload.email) throw new Error('autoPhone email is required')
        const now = new Date().toISOString()
        const task: TaskRecord = {
            id: newId('phone'),
            type: 'auto_phone',
            payload,
            priority: 5,
            status: 'pending',
            logs: [],
            createdAt: now,
            updatedAt: now,
        }
        this.tasks.set(task.id, task)
        this.log(task, 'pending', `Queued autoPhone task for ${payload.email}`)
        return task
    }

    get(id: string): TaskRecord | undefined {
        return this.tasks.get(id)
    }

    list(): TaskRecord[] {
        return [...this.tasks.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    }

    nextPending(): TaskRecord | undefined {
        return [...this.tasks.values()]
            .filter(task => task.status === 'pending')
            .sort((left, right) => right.priority - left.priority || left.createdAt.localeCompare(right.createdAt))[0]
    }

    log(task: TaskRecord, status: TaskLogStatus, message: string): void {
        task.logs.push({
            status,
            message,
            time: new Date().toISOString(),
        })
        if (task.logs.length > 200) task.logs.splice(0, task.logs.length - 200)
        task.updatedAt = new Date().toISOString()
        console.log(`[${task.updatedAt}] [${task.id}] [${status}] ${message}`)
    }

    status(task: TaskRecord, status: TaskStatus, message?: string, logStatus: TaskLogStatus = 'processing'): void {
        task.status = status
        task.updatedAt = new Date().toISOString()
        if (message) this.log(task, logStatus, message)
    }

    setCode(task: TaskRecord, code: string): void {
        const trimmed = code.replace(/\s+/g, '')
        if (!/^[a-z0-9]{6}$/i.test(trimmed)) throw new Error('Verification code must contain exactly six letters or numbers')
        task.verificationCode = trimmed
        task.resumeRequested = true
        this.status(task, 'processing', 'Viewer supplied a six character Bing verification code')
    }

    resume(task: TaskRecord): void {
        task.resumeRequested = true
        if (task.status === 'manual') this.status(task, 'processing', 'Viewer resumed the task')
    }

    done(task: TaskRecord): void {
        this.status(task, 'done', 'Viewer marked the task done', 'done')
    }

    fail(task: TaskRecord, reason: string): void {
        this.status(task, 'failed', reason || 'Viewer marked the task failed', 'failed')
    }

    cancel(task: TaskRecord): void {
        task.cancelRequested = true
        this.status(task, 'cancelled', 'Viewer cancelled the task', 'failed')
    }

    publicTask(task: TaskRecord): PublicTask {
        const payload =
            task.type === 'redem_bing'
                ? publicRedeemPayload(task.payload as SendTaskRequest['payload'])
                : publicAutoPhonePayload(task.payload as AutoPhonePayload)
        return {
            id: task.id,
            type: task.type,
            payload,
            priority: task.priority,
            status: task.status,
            logs: task.logs,
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
            manualReason: task.manualReason,
            profileName: task.profileName,
            deviceSerial: task.deviceSerial,
        }
    }
}

export class TaskQueue {
    private readonly store: TaskStore
    private readonly runner: (task: TaskRecord) => Promise<void>
    private draining = false

    constructor(store: TaskStore, runner: (task: TaskRecord) => Promise<void>) {
        this.store = store
        this.runner = runner
    }

    kick(): void {
        if (!this.draining) void this.drain()
    }

    private async drain(): Promise<void> {
        this.draining = true
        try {
            let task = this.store.nextPending()
            while (task) {
                try {
                    await this.runner(task)
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error)
                    this.store.status(task, 'failed', message, 'failed')
                }
                task = this.store.nextPending()
            }
        } finally {
            this.draining = false
            if (this.store.nextPending()) this.kick()
        }
    }
}

function validateRedeemRequest(request: SendTaskRequest): void {
    if (!request || request.type !== 'redem_bing') throw new Error('Only type=redem_bing is accepted by /api/sendTask')
    if (!request.payload?.email) throw new Error('payload.email is required')
    if (!request.payload?.urlRedem) throw new Error('payload.urlRedem is required')
    if (!request.payload?.proxy?.host || !request.payload.proxy.port) throw new Error('payload.proxy.host and payload.proxy.port are required')
}

function publicRedeemPayload(payload: SendTaskRequest['payload']): Record<string, unknown> {
    return {
        email: payload.email,
        urlRedem: payload.urlRedem,
        captcha: payload.captcha || '',
        proxy: payload.proxy
            ? {
                  host: payload.proxy.host,
                  port: payload.proxy.port,
                  method: payload.proxy.method || 'http',
                  user: payload.proxy.user ? 'configured' : '',
              }
            : null,
    }
}

function publicAutoPhonePayload(payload: AutoPhonePayload): Record<string, unknown> {
    return {
        email: payload.email,
        phone: payload.phone || '',
        note: payload.note || '',
        callbackUrl: payload.callbackUrl || '',
        proxy: payload.proxy ? 'configured' : '',
    }
}
