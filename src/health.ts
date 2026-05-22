import { currentConfigPath, loadConfig } from './config.js'
import { runHealthChecks } from './healthChecks.js'

const config = await loadConfig()
const checks = await runHealthChecks(config)
console.log(JSON.stringify({ configPath: currentConfigPath(), checks }, null, 2))
if (checks.some(check => !check.ok)) process.exitCode = 1
