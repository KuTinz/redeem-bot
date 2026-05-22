# Redeem Server

Standalone redeem task server for the local Microsoft Rewards dashboard. It runs on
the Windows machine that has LDPlayer, ADB, Appium, Bing, and v2rayNG available.

The existing dashboard sends `redem_bing` tasks to this server. The server keeps
one in-memory task queue, creates one LDPlayer profile per email when needed,
installs missing APKs, prepares v2rayNG, opens the Bing app verification link,
and returns task logs for the dashboard overlay.

## Files

Put APKs in this directory before bootstrapping a new LDPlayer profile:

```text
apks/
  bing.apk
  v2rayng.apk
  appium-settings.apk
```

`bing.apk` and `v2rayng.apk` are required for a new profile. The Appium Settings
APK is optional. Appium UiAutomator2 server APKs are normally installed by the
Appium driver itself when it creates a session.

## Windows Setup

1. Install Node.js 18 or newer on the Windows machine.
2. Install LDPlayer 9 and confirm `ldconsole.exe` works.
3. Install Appium and its Android driver:

```powershell
npm install -g appium
appium driver install uiautomator2
appium
```

4. Copy the config example and edit values:

```powershell
Copy-Item .\redeem-server.config.example.json .\redeem-server.config.json
```

Set `apiKey`. Set `ldplayer.ldconsolePath` and `ldplayer.adbPath` if the
auto-detected LDPlayer install path is wrong. New profiles default to the exact
email as the LDPlayer name, with `540x960`, `2` CPU cores, and `2048` MB RAM.
If more than one emulator is online and auto mapping cannot identify a profile,
put its serial in `ldplayer.serialByProfile`.

To auto-solve the six digit image captcha, set `captcha.provider` to
`2captcha` and put your 2Captcha API key in `captcha.apiKey`. If captcha
solving fails or is not configured, the task falls back to manual code entry in
`/viewer`.

5. Install project dependencies and build:

```powershell
npm install
npm run build
npm run health
npm start
```

The default listener is `http://127.0.0.1:8787`. Use the reachable Windows host
address as the dashboard `Redeem Server URL` and use the same `apiKey` as the
dashboard `Redeem API Key`.

## Task Flow

- Dashboard opens the Rewards redeem session.
- Its verify watcher detects the Bing app challenge and sends
  `POST /api/sendTask`.
- Redeem Server queues the task and creates/reuses an LDPlayer profile named
  from the exact email, for example `name@example.com`.
- New LDPlayer profiles are modified before first launch with resolution
  `540,960,240`, CPU `2`, and memory `2048`.
- Missing Bing/v2rayNG APKs are installed into that profile.
- Server uses Appium UI actions to add the task HTTP/SOCKS proxy through the
  v2rayNG `+` menu, fills host/port/user/password, saves it, and starts VPN.
- If the v2rayNG UI labels differ, the task pauses in viewer for manual proxy
  setup/connect.
- Server opens the Bing verification link in the Android profile.
- Open `/viewer`, read the captcha image from the task, and send the six digit
  code. The server types it into Bing when Appium finds the code field.
- When the task reports `done`, the original browser session continues waiting
  for Rewards `Next` and keeps its existing order-history/gift-link flow.

## Viewer

Open `/viewer` on the Redeem Server host. Enter the same API key used by the
dashboard. The viewer shows queue status, logs, captcha image, six digit code
input, Resume, Done, Fail, and Cancel controls.

Use `Resume` after fixing a paused v2rayNG proxy setup or Bing login manually in
LDPlayer. Use `Done` only after Bing verification has actually finished.

## API

All `/api/*` routes require `X-Api-Key` when `apiKey` is configured.

### `POST /api/sendTask`

```json
{
  "type": "redem_bing",
  "priority": 5,
  "payload": {
    "email": "account@example.com",
    "pass": "password",
    "totpSecret": "BASE32SECRET",
    "proxy": {
      "host": "127.0.0.1",
      "port": 1080,
      "user": "proxy-user",
      "pass": "proxy-pass",
      "method": "socks5"
    },
    "urlRedem": "https://aka.ms/SappApp...",
    "captcha": "data:image/png;base64,..."
  }
}
```

Response includes `id`, `task_id`, and `taskId` for dashboard compatibility.

### `GET /api/getTaskLogs/:taskId`

Returns:

```json
{
  "id": "redeem_xxx",
  "task_id": "redeem_xxx",
  "status": "processing",
  "logs": [
    {
      "status": "processing",
      "message": "Opening Bing app redeem verification link",
      "time": "2026-05-22T00:00:00.000Z"
    }
  ]
}
```

### Other routes

- `GET /health`
- `GET /viewer`
- `GET /api/tasks`
- `POST /api/tasks/:id/code`
- `POST /api/tasks/:id/resume`
- `POST /api/tasks/:id/done`
- `POST /api/tasks/:id/fail`
- `POST /api/tasks/:id/cancel`
- `POST /api/autoPhone`

`/api/autoPhone` is only a compatibility queue entry in v1. It appears in the
viewer but does not run phone redemption automation yet.

## Known Limits

- v2rayNG add/connect is best effort because it depends on the installed v2rayNG
  version and UI language.
- The captcha is an image from the Rewards browser challenge. The server can
  send it to 2Captcha when configured; otherwise the viewer sends the six digit
  code to Appium.
- The Bing login automation is selector based and pauses for manual recovery
  when Microsoft shows an unexpected approval, recovery, or risk screen.
- Task state is in memory in v1. Restarting this server clears the task queue.
