export type TaskStatus =
    | 'pending'
    | 'processing'
    | 'waiting_code'
    | 'manual'
    | 'done'
    | 'failed'
    | 'cancelled'

export type TaskLogStatus =
    | 'pending'
    | 'processing'
    | 'success'
    | 'done'
    | 'failed'
    | 'error'

export interface ProxyPayload {
    host: string
    port: string | number
    user?: string
    pass?: string
    method?: string
}

export interface RedeemPayload {
    email: string
    pass: string
    totpSecret?: string
    proxy: ProxyPayload | null
    urlRedem: string
    captcha?: string
}

export interface AutoPhonePayload {
    email: string
    pass?: string
    proxy?: string
    phone?: string
    note?: string
    callbackUrl?: string
}

export interface SendTaskRequest {
    type: string
    payload: RedeemPayload
    priority?: number
}

export interface TaskLog {
    status: TaskLogStatus
    message: string
    time: string
}

export interface TaskRecord {
    id: string
    type: string
    payload: RedeemPayload | AutoPhonePayload
    priority: number
    status: TaskStatus
    logs: TaskLog[]
    createdAt: string
    updatedAt: string
    verificationCode?: string
    resumeRequested?: boolean
    cancelRequested?: boolean
    manualReason?: string
    profileName?: string
    deviceSerial?: string
}

export interface PublicTask {
    id: string
    type: string
    payload: Record<string, unknown>
    priority: number
    status: TaskStatus
    logs: TaskLog[]
    createdAt: string
    updatedAt: string
    manualReason?: string
    profileName?: string
    deviceSerial?: string
}

export interface StepLogger {
    (status: TaskLogStatus, message: string): void
}

export interface HealthCheck {
    name: string
    ok: boolean
    detail: string
}
