export function viewerPage(): string {
    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Redeem Tasks</title>
    <style>
        :root { color-scheme: dark; --bg:#0f141a; --panel:#171f29; --line:#314050; --text:#eef3f8; --muted:#9fb0c0; --good:#2dc071; --warn:#f7b955; --bad:#ff6b72; }
        * { box-sizing:border-box; letter-spacing:0; }
        body { margin:0; background:var(--bg); color:var(--text); font:14px/1.4 system-ui,-apple-system,Segoe UI,sans-serif; }
        header, main { max-width:1280px; margin:0 auto; padding:18px; }
        header { display:flex; gap:12px; align-items:center; border-bottom:1px solid var(--line); }
        h1, h2 { margin:0; font-size:18px; }
        h2 { font-size:15px; }
        input, button { border:1px solid var(--line); border-radius:6px; background:#0d1218; color:var(--text); height:36px; padding:0 11px; }
        button { cursor:pointer; background:#223142; }
        button:hover { background:#2a3d53; }
        button.fail { border-color:#713438; color:#ffbdc1; }
        button.good { border-color:#285e47; color:#aef0ca; }
        main { display:grid; grid-template-columns:minmax(320px, .95fr) minmax(420px, 1.25fr); gap:14px; }
        section { min-width:0; border:1px solid var(--line); border-radius:8px; background:var(--panel); }
        .head { display:flex; justify-content:space-between; align-items:center; gap:10px; padding:13px; border-bottom:1px solid var(--line); }
        table { width:100%; border-collapse:collapse; table-layout:fixed; }
        th, td { padding:10px 12px; border-bottom:1px solid rgba(49,64,80,.55); text-align:left; overflow-wrap:anywhere; }
        th { color:var(--muted); font-size:12px; }
        tr.task { cursor:pointer; }
        tr.task:hover, tr.selected { background:#202d3b; }
        .detail { padding:14px; display:grid; gap:13px; }
        .row { display:flex; flex-wrap:wrap; gap:9px; align-items:center; }
        .meta { display:grid; gap:5px; color:var(--muted); }
        .status { display:inline-flex; min-width:92px; justify-content:center; padding:3px 8px; border:1px solid var(--line); border-radius:6px; color:var(--warn); }
        .status.done { color:var(--good); } .status.failed, .status.cancelled { color:var(--bad); }
        .captcha { max-width:100%; max-height:180px; background:#fff; border-radius:6px; padding:4px; }
        .logs { margin:0; padding:0; list-style:none; max-height:440px; overflow:auto; border:1px solid var(--line); border-radius:6px; }
        .logs li { padding:8px 10px; border-bottom:1px solid rgba(49,64,80,.55); }
        .logs time { color:var(--muted); display:inline-block; width:165px; }
        .logs .success, .logs .done { color:var(--good); }
        .logs .failed, .logs .error { color:var(--bad); }
        #key { width:min(320px, 48vw); }
        #code { width:128px; font-size:18px; font-variant-numeric:tabular-nums; }
        .empty { padding:26px; color:var(--muted); }
        @media (max-width:860px) { main { grid-template-columns:1fr; } header { flex-wrap:wrap; } }
    </style>
</head>
<body>
    <header>
        <h1>Redeem Tasks</h1>
        <input id="key" type="password" placeholder="X-Api-Key">
        <button id="saveKey">Save key</button>
        <button id="refresh">Refresh</button>
    </header>
    <main>
        <section>
            <div class="head"><h2>Queue</h2><span id="count"></span></div>
            <div id="queue"></div>
        </section>
        <section>
            <div class="head"><h2 id="taskTitle">Task</h2><span id="status"></span></div>
            <div id="detail" class="empty">No task selected.</div>
        </section>
    </main>
    <script>
        const state = { tasks: [], selected: null };
        const keyInput = document.getElementById('key');
        keyInput.value = localStorage.getItem('redeemApiKey') || '';
        document.getElementById('saveKey').onclick = () => { localStorage.setItem('redeemApiKey', keyInput.value); load(); };
        document.getElementById('refresh').onclick = load;
        async function api(url, options = {}) {
            const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
            if (keyInput.value) headers['X-Api-Key'] = keyInput.value;
            const response = await fetch(url, { ...options, headers });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || response.statusText);
            return data;
        }
        async function load() {
            try {
                const data = await api('/api/tasks');
                state.tasks = data.tasks || [];
                if (!state.selected && state.tasks[0]) state.selected = state.tasks[0].id;
                if (state.selected && !state.tasks.some(task => task.id === state.selected)) state.selected = state.tasks[0]?.id || null;
                render();
            } catch (error) {
                document.getElementById('queue').innerHTML = '<div class="empty">' + esc(error.message) + '</div>';
            }
        }
        function render() {
            document.getElementById('count').textContent = String(state.tasks.length);
            const rows = state.tasks.map(task => '<tr class="task ' + (task.id === state.selected ? 'selected' : '') + '" data-id="' + esc(task.id) + '"><td>' + esc(task.payload.email || '') + '</td><td>' + esc(task.status) + '</td><td>' + esc(task.type) + '</td></tr>').join('');
            document.getElementById('queue').innerHTML = state.tasks.length ? '<table><thead><tr><th>Email</th><th>Status</th><th>Type</th></tr></thead><tbody>' + rows + '</tbody></table>' : '<div class="empty">Queue is empty.</div>';
            document.querySelectorAll('tr.task').forEach(row => row.onclick = () => { state.selected = row.dataset.id; render(); });
            renderDetail(state.tasks.find(task => task.id === state.selected));
        }
        function renderDetail(task) {
            const title = document.getElementById('taskTitle');
            const status = document.getElementById('status');
            const detail = document.getElementById('detail');
            if (!task) {
                title.textContent = 'Task'; status.innerHTML = ''; detail.className = 'empty'; detail.textContent = 'No task selected.'; return;
            }
            title.textContent = task.payload.email || task.id;
            status.innerHTML = '<span class="status ' + esc(task.status) + '">' + esc(task.status) + '</span>';
            detail.className = 'detail';
            const captcha = task.payload.captcha ? '<img class="captcha" alt="Captcha" src="' + esc(task.payload.captcha) + '">' : '';
            const logs = (task.logs || []).slice().reverse().map(log => '<li><time>' + esc(log.time) + '</time><span class="' + esc(log.status) + '">[' + esc(log.status) + ']</span> ' + esc(log.message) + '</li>').join('');
            detail.innerHTML =
                '<div class="meta"><div>Id: ' + esc(task.id) + '</div><div>Profile: ' + esc(task.profileName || '-') + '</div><div>Device: ' + esc(task.deviceSerial || '-') + '</div><div>' + esc(task.manualReason || '') + '</div></div>' +
                captcha +
                '<div class="row"><input id="code" inputmode="text" maxlength="6" placeholder="6 chars"><button class="good" id="sendCode">Send code</button><button id="resume">Resume</button><button class="good" id="done">Done</button><button class="fail" id="fail">Fail</button><button class="fail" id="cancel">Cancel</button></div>' +
                '<ul class="logs">' + logs + '</ul>';
            document.getElementById('sendCode').onclick = () => action('code', { code: document.getElementById('code').value });
            document.getElementById('resume').onclick = () => action('resume', {});
            document.getElementById('done').onclick = () => action('done', {});
            document.getElementById('fail').onclick = () => action('fail', { reason: 'Viewer marked task failed' });
            document.getElementById('cancel').onclick = () => action('cancel', {});
        }
        async function action(name, body) {
            try { await api('/api/tasks/' + encodeURIComponent(state.selected) + '/' + name, { method:'POST', body:JSON.stringify(body) }); await load(); }
            catch (error) { alert(error.message); }
        }
        function esc(value) {
            return String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
        }
        load();
        setInterval(load, 2000);
    </script>
</body>
</html>`
}
