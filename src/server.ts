import http, { IncomingMessage, ServerResponse } from 'node:http'
import { RedeemAutomation } from './automation.js'
import { currentConfigPath, loadConfig, RedeemServerConfig } from './config.js'
import { runHealthChecks } from './healthChecks.js'
import { TaskQueue, TaskStore } from './tasks.js'
import { AutoPhonePayload, SendTaskRequest, TaskRecord } from './types.js'
import { asErrorMessage } from './util.js'
import { viewerPage } from './viewer.js'

const config = await loadConfig()
const store = new TaskStore()
const automation = new RedeemAutomation(config, store)
const queue = new TaskQueue(store, task => automation.run(task))
const server = http.createServer((request, response) => void route(request, response, config))

server.listen(config.port, config.host, () => {
    console.log(`[${new Date().toISOString()}] Redeem Server listening on http://${config.host}:${config.port}`)
    console.log(`[${new Date().toISOString()}] Config path: ${currentConfigPath()}`)
})

async function route(request: IncomingMessage, response: ServerResponse, serverConfig: RedeemServerConfig): Promise<void> {
    try {
        const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
        if (request.method === 'GET' && url.pathname === '/') {
            redirect(response, '/viewer')
            return
        }
        if (request.method === 'GET' && url.pathname === '/viewer') {
            html(response, viewerPage())
            return
        }
        if (request.method === 'GET' && url.pathname === '/health') {
            const checks = await runHealthChecks(serverConfig)
            json(response, 200, {
                ok: checks.every(check => check.ok),
                configPath: currentConfigPath(),
                checks,
            })
            return
        }
        if (url.pathname.startsWith('/api/')) requireApiKey(request, serverConfig)
        if (request.method === 'POST' && url.pathname === '/api/sendTask') {
            const task = store.createRedeem((await readJson(request)) as SendTaskRequest)
            queue.kick()
            json(response, 202, taskAccepted(task, 'Redeem task accepted'))
            return
        }
        if (request.method === 'POST' && url.pathname === '/api/autoPhone') {
            const task = store.createAutoPhone((await readJson(request)) as AutoPhonePayload)
            queue.kick()
            json(response, 202, {
                success: true,
                taskId: task.id,
                data: { taskId: task.id },
                status: task.status,
                message: 'autoPhone task accepted for viewer/manual handling',
            })
            return
        }
        if (request.method === 'GET' && url.pathname === '/api/tasks') {
            json(response, 200, { success: true, tasks: store.list().map(task => store.publicTask(task)) })
            return
        }
        const logsMatch = url.pathname.match(/^\/api\/getTaskLogs\/([^/]+)$/)
        if (request.method === 'GET' && logsMatch) {
            const task = needTask(decodeURIComponent(logsMatch[1]))
            json(response, 200, {
                id: task.id,
                task_id: task.id,
                status: task.status,
                logs: task.logs,
            })
            return
        }
        const actionMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/(code|resume|done|fail|cancel)$/)
        if (request.method === 'POST' && actionMatch) {
            const task = needTask(decodeURIComponent(actionMatch[1]))
            const body = (await readJson(request).catch(() => ({}))) as Record<string, unknown>
            applyAction(task, actionMatch[2], body)
            json(response, 200, { success: true, task: store.publicTask(task) })
            return
        }
        json(response, 404, { success: false, error: 'Not found' })
    } catch (error) {
        const status = error instanceof HttpError ? error.status : 500
        json(response, status, { success: false, error: asErrorMessage(error) })
    }
}

function applyAction(task: TaskRecord, action: string, body: Record<string, unknown>): void {
    switch (action) {
        case 'code':
            store.setCode(task, String(body.code || ''))
            break
        case 'resume':
            store.resume(task)
            break
        case 'done':
            store.done(task)
            break
        case 'fail':
            store.fail(task, String(body.reason || 'Viewer marked task failed'))
            break
        case 'cancel':
            store.cancel(task)
            break
        default:
            throw new HttpError(404, 'Unknown task action')
    }
}

function taskAccepted(task: TaskRecord, message: string) {
    return {
        success: true,
        id: task.id,
        task_id: task.id,
        taskId: task.id,
        status: task.status,
        message,
    }
}

function needTask(id: string): TaskRecord {
    const task = store.get(id)
    if (!task) throw new HttpError(404, `Task ${id} not found`)
    return task
}

function requireApiKey(request: IncomingMessage, serverConfig: RedeemServerConfig): void {
    if (!serverConfig.apiKey) return
    if (request.headers['x-api-key'] === serverConfig.apiKey) return
    throw new HttpError(401, 'Invalid X-Api-Key')
}

async function readJson(request: IncomingMessage): Promise<unknown> {
    const maxBytes = 12 * 1024 * 1024
    let raw = ''
    for await (const chunk of request) {
        raw += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk)
        if (Buffer.byteLength(raw) > maxBytes) throw new HttpError(413, 'JSON body too large')
    }
    if (!raw) return {}
    try {
        return JSON.parse(raw)
    } catch {
        throw new HttpError(400, 'Body must be valid JSON')
    }
}

function json(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
    })
    response.end(JSON.stringify(body))
}

function html(response: ServerResponse, body: string): void {
    response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
    })
    response.end(body)
}

function redirect(response: ServerResponse, location: string): void {
    response.writeHead(302, { Location: location })
    response.end()
}

class HttpError extends Error {
    readonly status: number

    constructor(status: number, message: string) {
        super(message)
        this.status = status
    }
}
