#!/usr/bin/env node
// =============================================================================
// OpenClaw Setup UI — Web-based setup wizard (one-time)
// Xac thuc bang PAM (root password), dung 1 lan roi tu huy
// Port: 9999 | Chay bang root | Systemd: openclaw-setup.service
// =============================================================================

const http = require('http');
const { execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');

const PORT = 9999;
const SESSION_TTL = 15 * 60 * 1000;      // 15 phut
const AUTO_SHUTDOWN = 60 * 60 * 1000;     // 1 gio
const MAX_LOGIN_ATTEMPTS = 5;
const BLOCK_DURATION = 15 * 60 * 1000;    // 15 phut

const sessions = {};
const loginAttempts = {};
let shutdownTimer = null;

// --- Helpers ---
function getClientIP(req) {
  return req.socket.remoteAddress.replace('::ffff:', '');
}

function isBlocked(ip) {
  const r = loginAttempts[ip];
  if (!r) return false;
  if (r.blockedUntil && Date.now() < r.blockedUntil) return true;
  if (r.blockedUntil && Date.now() >= r.blockedUntil) { delete loginAttempts[ip]; return false; }
  return false;
}

function recordFailedLogin(ip) {
  if (!loginAttempts[ip]) loginAttempts[ip] = { count: 0, blockedUntil: null };
  loginAttempts[ip].count++;
  if (loginAttempts[ip].count >= MAX_LOGIN_ATTEMPTS) {
    loginAttempts[ip].blockedUntil = Date.now() + BLOCK_DURATION;
  }
}

function verifyPassword(username, password) {
  try {
    const out = execSync(
      `echo '${password.replace(/'/g, "'\\''")}' | su -c 'echo __AUTH_OK__' ${username} 2>/dev/null`,
      { timeout: 5000, stdio: 'pipe' }
    ).toString();
    return out.includes('__AUTH_OK__');
  } catch { return false; }
}

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions[token] = { created: Date.now() };
  return token;
}

function isValidSession(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/session=([a-f0-9]{64})/);
  if (!match) return false;
  const s = sessions[match[1]];
  if (!s) return false;
  if (Date.now() - s.created > SESSION_TTL) { delete sessions[match[1]]; return false; }
  return true;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e5) { req.destroy(); reject(new Error('Too large')); } });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid JSON')); } });
  });
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function getServerIP() {
  try { return execSync("hostname -I | awk '{print $1}'", { stdio: 'pipe' }).toString().trim(); }
  catch { return 'localhost'; }
}

function getGatewayToken() {
  try { return execSync("grep '^OPENCLAW_GATEWAY_TOKEN=' /opt/openclaw.env | cut -d= -f2", { stdio: 'pipe' }).toString().trim(); }
  catch { return ''; }
}

// --- Provider configs ---
const PROVIDERS = {
  anthropic: {
    name: 'Anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    configFile: '/etc/config/anthropic.json',
    testFn: (apiKey) => {
      try {
        const r = execSync(`curl -s -o /dev/null -w '%{http_code}' -X POST https://api.anthropic.com/v1/messages \
          -H 'x-api-key: ${apiKey.replace(/'/g, "'\\''")}' \
          -H 'anthropic-version: 2023-06-01' \
          -H 'content-type: application/json' \
          -d '{"model":"claude-sonnet-4-20250514","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}'`,
          { timeout: 15000, stdio: 'pipe' }).toString().trim();
        return r === '200';
      } catch { return false; }
    }
  },
  openai: {
    name: 'OpenAI',
    envKey: 'OPENAI_API_KEY',
    configFile: '/etc/config/openai.json',
    testFn: (apiKey) => {
      try {
        const r = execSync(`curl -s -o /dev/null -w '%{http_code}' https://api.openai.com/v1/models \
          -H 'Authorization: Bearer ${apiKey.replace(/'/g, "'\\''")}' `,
          { timeout: 15000, stdio: 'pipe' }).toString().trim();
        return r === '200';
      } catch { return false; }
    }
  }
};

// --- Self-destruct ---
function selfDestruct() {
  console.log('[Setup UI] Setup hoan tat. Tu huy...');
  try {
    execSync('ufw deny 9999 2>/dev/null || true');
    execSync('ufw delete allow 9999 2>/dev/null || true');
    execSync('systemctl disable openclaw-setup 2>/dev/null || true');
    execSync('rm -f /etc/systemd/system/openclaw-setup.service 2>/dev/null || true');
    execSync('systemctl daemon-reload 2>/dev/null || true');
    execSync('rm -rf /opt/openclaw-setup 2>/dev/null || true');
  } catch (e) { console.error('[Setup UI] Loi khi tu huy:', e.message); }
  process.exit(0);
}

// --- HTML: Login ---
function loginPage() {
  return `<!DOCTYPE html>
<html lang="vi"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenClaw Setup</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center}
.container{width:100%;max-width:420px;padding:20px}
.logo{text-align:center;margin-bottom:32px} .logo h1{font-size:28px;color:#38bdf8} .logo p{color:#94a3b8;margin-top:8px;font-size:14px}
.card{background:#1e293b;border-radius:12px;padding:32px;box-shadow:0 4px 24px rgba(0,0,0,.3)} .card h2{font-size:18px;margin-bottom:24px;color:#f1f5f9}
.field{margin-bottom:16px} .field label{display:block;font-size:13px;color:#94a3b8;margin-bottom:6px;font-weight:500}
.field input{width:100%;padding:10px 14px;background:#0f172a;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:15px;outline:none;transition:border .2s} .field input:focus{border-color:#38bdf8}
.btn{width:100%;padding:12px;background:#2563eb;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;transition:background .2s} .btn:hover{background:#1d4ed8} .btn:disabled{opacity:.5;cursor:not-allowed}
.error{color:#f87171;font-size:13px;margin-top:12px;display:none} .error.show{display:block}
</style></head><body>
<div class="container">
  <div class="logo"><h1>&#x1f43e; OpenClaw</h1><p>Dang nhap de cau hinh server</p></div>
  <div class="card">
    <h2>Dang nhap he thong</h2>
    <form id="f">
      <div class="field"><label>Username</label><input type="text" id="u" value="root" autocomplete="username"></div>
      <div class="field"><label>Password</label><input type="password" id="p" placeholder="Nhap mat khau root" autocomplete="current-password" autofocus></div>
      <button type="submit" class="btn" id="b">Dang nhap</button>
      <div class="error" id="e"></div>
    </form>
  </div>
</div>
<script>
document.getElementById('f').addEventListener('submit',async e=>{
  e.preventDefault();const b=document.getElementById('b'),err=document.getElementById('e');
  b.disabled=true;b.textContent='Dang xac thuc...';err.classList.remove('show');
  try{const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:document.getElementById('u').value,password:document.getElementById('p').value})});
  const d=await r.json();if(d.ok)window.location.href='/setup';else{err.textContent=d.error;err.classList.add('show')}}
  catch(x){err.textContent='Loi ket noi server';err.classList.add('show')}
  b.disabled=false;b.textContent='Dang nhap'});
</script></body></html>`;
}

// --- HTML: Setup ---
function setupPage() {
  return `<!DOCTYPE html>
<html lang="vi"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenClaw Setup</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh;padding:40px 20px}
.container{max-width:600px;margin:0 auto}
.logo{text-align:center;margin-bottom:32px} .logo h1{font-size:28px;color:#38bdf8}
.card{background:#1e293b;border-radius:12px;padding:32px;box-shadow:0 4px 24px rgba(0,0,0,.3);margin-bottom:24px}
.card h2{font-size:18px;margin-bottom:8px;color:#f1f5f9} .card p{color:#94a3b8;font-size:14px;margin-bottom:20px}
.step{display:none} .step.active{display:block}
.providers{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.provider{padding:20px;background:#0f172a;border:2px solid #334155;border-radius:10px;cursor:pointer;text-align:center;transition:all .2s}
.provider:hover{border-color:#38bdf8} .provider.selected{border-color:#2563eb;background:#1e3a5f}
.provider .icon{font-size:32px;margin-bottom:8px} .provider .name{font-size:15px;font-weight:600}
.field{margin-bottom:16px} .field label{display:block;font-size:13px;color:#94a3b8;margin-bottom:6px;font-weight:500}
.field input{width:100%;padding:10px 14px;background:#0f172a;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:15px;outline:none;transition:border .2s} .field input:focus{border-color:#38bdf8}
.btn{padding:12px 24px;background:#2563eb;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;transition:background .2s} .btn:hover{background:#1d4ed8} .btn:disabled{opacity:.5;cursor:not-allowed}
.btn-outline{background:transparent;border:1px solid #334155;color:#94a3b8} .btn-outline:hover{border-color:#38bdf8;color:#38bdf8;background:transparent}
.btn-success{background:#16a34a} .btn-success:hover{background:#15803d}
.btn-row{display:flex;gap:12px;justify-content:flex-end;margin-top:20px}
.status{padding:12px 16px;border-radius:8px;font-size:14px;margin-top:16px;display:none}
.status.ok{display:block;background:#052e16;border:1px solid #16a34a;color:#4ade80}
.status.fail{display:block;background:#310413;border:1px solid #dc2626;color:#f87171}
.status.loading{display:block;background:#172554;border:1px solid #2563eb;color:#60a5fa}
.done-box{text-align:center;padding:40px} .done-box .check{font-size:64px;margin-bottom:16px}
.done-box h2{font-size:22px;color:#4ade80;margin-bottom:12px} .done-box p{color:#94a3b8;margin-bottom:8px;font-size:14px}
.done-box a{color:#38bdf8;text-decoration:none;font-weight:600;font-size:16px} .done-box a:hover{text-decoration:underline}
.done-box .url-box{background:#0f172a;border:1px solid #334155;border-radius:8px;padding:12px 16px;margin:16px 0;word-break:break-all;font-family:monospace;font-size:14px;color:#38bdf8}
</style></head><body>
<div class="container">
  <div class="logo"><h1>&#x1f43e; OpenClaw Setup</h1></div>

  <!-- Step 1 -->
  <div class="step active" id="step1"><div class="card">
    <h2>Buoc 1: Chon nha cung cap AI</h2>
    <p>Chon nha cung cap LLM ma ban muon su dung</p>
    <div class="providers">
      <div class="provider" data-provider="anthropic" onclick="selectProvider(this)">
        <div class="icon">&#x1f7e0;</div><div class="name">Anthropic</div>
        <div style="color:#94a3b8;font-size:12px;margin-top:4px">Claude Opus 4.5</div>
      </div>
      <div class="provider" data-provider="openai" onclick="selectProvider(this)">
        <div class="icon">&#x1f7e2;</div><div class="name">OpenAI</div>
        <div style="color:#94a3b8;font-size:12px;margin-top:4px">GPT-5.2</div>
      </div>
    </div>
    <div class="btn-row"><button class="btn" id="nextStep1" disabled onclick="goStep(2)">Tiep tuc</button></div>
  </div></div>

  <!-- Step 2 -->
  <div class="step" id="step2"><div class="card">
    <h2>Buoc 2: Nhap API Key</h2>
    <p id="step2desc">Nhap API key cua nha cung cap</p>
    <div class="field"><label id="keyLabel">API Key</label><input type="password" id="apiKey" placeholder="sk-..."></div>
    <div class="btn-row">
      <button class="btn btn-outline" onclick="goStep(1)">Quay lai</button>
      <button class="btn" id="testBtn" onclick="testKey()">Kiem tra ket noi</button>
    </div>
    <div class="status" id="testStatus"></div>
  </div></div>

  <!-- Step 3 -->
  <div class="step" id="step3"><div class="card">
    <h2>Buoc 3: Xac nhan cau hinh</h2>
    <p>Kiem tra lai thong tin truoc khi hoan tat</p>
    <div style="background:#0f172a;border-radius:8px;padding:16px;margin-bottom:16px">
      <div style="display:flex;justify-content:space-between;margin-bottom:8px"><span style="color:#94a3b8">Nha cung cap:</span><span id="confirmProvider" style="font-weight:600"></span></div>
      <div style="display:flex;justify-content:space-between"><span style="color:#94a3b8">API Key:</span><span id="confirmKey" style="font-family:monospace"></span></div>
    </div>
    <div class="btn-row">
      <button class="btn btn-outline" onclick="goStep(2)">Quay lai</button>
      <button class="btn btn-success" id="finishBtn" onclick="finish()">Hoan tat cai dat</button>
    </div>
    <div class="status" id="finishStatus"></div>
  </div></div>

  <!-- Step 4: Pairing -->
  <div class="step" id="step4"><div class="card">
    <h2>Buoc 4: Ghep noi Dashboard</h2>
    <p>Mo link dashboard ben duoi trong <strong>tab moi</strong>, doi trang tai xong (se thay loi ghep noi - dieu nay binh thuong), roi quay lai day bam nut ghep noi.</p>
    <div class="url-box" id="pairingUrl" style="background:#0f172a;border:1px solid #334155;border-radius:8px;padding:12px 16px;margin:16px 0;word-break:break-all;font-family:monospace;font-size:14px;color:#38bdf8;cursor:pointer" onclick="window.open(this.textContent,'_blank')"></div>
    <p style="font-size:13px;color:#94a3b8;margin-bottom:16px">&#x261d; Bam vao link tren de mo trong tab moi</p>
    <div class="btn-row">
      <button class="btn" id="pairBtn" onclick="doPairing()">Da mo Dashboard - Ghep noi ngay</button>
    </div>
    <div class="status" id="pairStatus"></div>
  </div></div>

  <!-- Step 5: Done -->
  <div class="step" id="step5"><div class="card"><div class="done-box">
    <div class="check">&#x2705;</div>
    <h2>OpenClaw da san sang!</h2>
    <p>Server cua ban da duoc cau hinh va ghep noi thanh cong.</p>
    <p>Lam moi trang dashboard hoac truy cap tai:</p>
    <div class="url-box" id="dashboardUrl" style="background:#0f172a;border:1px solid #334155;border-radius:8px;padding:12px 16px;margin:16px 0;word-break:break-all;font-family:monospace;font-size:14px;color:#38bdf8"></div>
    <a id="dashboardLink" href="#">Mo Dashboard &#x2192;</a>
    <p style="margin-top:24px;color:#64748b;font-size:12px">Trang setup nay se tu dong dong sau 10 giay...</p>
  </div></div></div>
</div>

<script>
let selectedProvider=null,keyVerified=false;
const names={anthropic:'Anthropic',openai:'OpenAI'};

function selectProvider(el){
  document.querySelectorAll('.provider').forEach(p=>p.classList.remove('selected'));
  el.classList.add('selected');selectedProvider=el.dataset.provider;
  document.getElementById('nextStep1').disabled=false;
}
function goStep(n){
  document.querySelectorAll('.step').forEach(s=>s.classList.remove('active'));
  document.getElementById('step'+n).classList.add('active');
  if(n===2){document.getElementById('step2desc').textContent='Nhap '+names[selectedProvider]+' API key cua ban';document.getElementById('keyLabel').textContent=names[selectedProvider]+' API Key';document.getElementById('testStatus').className='status';keyVerified=false}
  if(n===3){document.getElementById('confirmProvider').textContent=names[selectedProvider];const k=document.getElementById('apiKey').value;document.getElementById('confirmKey').textContent=k.substring(0,8)+'...'+k.substring(k.length-4)}
}
async function testKey(){
  const btn=document.getElementById('testBtn'),st=document.getElementById('testStatus'),k=document.getElementById('apiKey').value.trim();
  if(!k){st.className='status fail';st.textContent='Vui long nhap API key';return}
  btn.disabled=true;btn.textContent='Dang kiem tra...';st.className='status loading';st.textContent='Dang ket noi...';
  try{const r=await fetch('/api/test-key',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:selectedProvider,apiKey:k})});const d=await r.json();
  if(d.ok){st.className='status ok';st.textContent='\\u2705 Ket noi thanh cong! API key hop le.';keyVerified=true;setTimeout(()=>goStep(3),1500)}
  else{st.className='status fail';st.textContent='\\u274c '+(d.error||'API key khong hop le')}}
  catch(x){st.className='status fail';st.textContent='\\u274c Loi ket noi server'}
  btn.disabled=false;btn.textContent='Kiem tra ket noi';
}
let dashboardUrlGlobal='';
async function finish(){
  const btn=document.getElementById('finishBtn'),st=document.getElementById('finishStatus');
  btn.disabled=true;btn.textContent='Dang cau hinh...';st.className='status loading';st.textContent='Dang ghi cau hinh va khoi dong OpenClaw...';
  try{const r=await fetch('/api/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:selectedProvider,apiKey:document.getElementById('apiKey').value.trim()})});const d=await r.json();
  if(d.ok){dashboardUrlGlobal=d.dashboardUrl;goStep(4);document.getElementById('pairingUrl').textContent=d.dashboardUrl}
  else{st.className='status fail';st.textContent='\\u274c '+(d.error||'Loi khi cau hinh');btn.disabled=false;btn.textContent='Hoan tat cai dat'}}
  catch(x){st.className='status fail';st.textContent='\\u274c Loi ket noi server';btn.disabled=false;btn.textContent='Hoan tat cai dat'}
}
async function doPairing(){
  const btn=document.getElementById('pairBtn'),st=document.getElementById('pairStatus');
  btn.disabled=true;btn.textContent='Dang tim yeu cau ghep noi...';st.className='status loading';st.textContent='Dang kiem tra...';
  try{const r=await fetch('/api/pair',{method:'POST',headers:{'Content-Type':'application/json'}});const d=await r.json();
  if(d.ok){goStep(5);document.getElementById('dashboardUrl').textContent=dashboardUrlGlobal;document.getElementById('dashboardLink').href=dashboardUrlGlobal}
  else{st.className='status fail';st.textContent='\\u274c '+(d.error||'Khong tim thay yeu cau ghep noi');btn.disabled=false;btn.textContent='Thu lai ghep noi'}}
  catch(x){st.className='status fail';st.textContent='\\u274c Loi ket noi server';btn.disabled=false;btn.textContent='Thu lai ghep noi'}
}
</script></body></html>`;
}

// --- HTTP Server ---
const server = http.createServer(async (req, res) => {
  const ip = getClientIP(req);
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/login')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(loginPage());
  }

  if (req.method === 'GET' && url.pathname === '/setup') {
    if (!isValidSession(req)) { res.writeHead(302, { Location: '/' }); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(setupPage());
  }

  // --- API: Login ---
  if (req.method === 'POST' && url.pathname === '/api/login') {
    if (isBlocked(ip)) return json(res, 429, { ok: false, error: 'Qua nhieu lan thu. Vui long doi 15 phut.' });
    try {
      const body = await parseBody(req);
      if (!body.username || !body.password) return json(res, 400, { ok: false, error: 'Thieu username hoac password' });
      if (verifyPassword(body.username, body.password)) {
        const token = createSession();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}` });
        return res.end(JSON.stringify({ ok: true }));
      } else {
        recordFailedLogin(ip);
        const remaining = MAX_LOGIN_ATTEMPTS - (loginAttempts[ip]?.count || 0);
        return json(res, 401, { ok: false, error: `Sai mat khau. Con ${Math.max(0, remaining)} lan thu.` });
      }
    } catch { return json(res, 400, { ok: false, error: 'Request khong hop le' }); }
  }

  // --- API: Test Key ---
  if (req.method === 'POST' && url.pathname === '/api/test-key') {
    if (!isValidSession(req)) return json(res, 401, { ok: false, error: 'Chua dang nhap' });
    try {
      const body = await parseBody(req);
      const provider = PROVIDERS[body.provider];
      if (!provider) return json(res, 400, { ok: false, error: 'Provider khong hop le' });
      const ok = provider.testFn(body.apiKey);
      return json(res, 200, { ok, error: ok ? null : 'API key khong hop le hoac het han' });
    } catch { return json(res, 500, { ok: false, error: 'Loi khi kiem tra API key' }); }
  }

  // --- API: Setup (apply config + start openclaw + self-destruct) ---
  if (req.method === 'POST' && url.pathname === '/api/setup') {
    if (!isValidSession(req)) return json(res, 401, { ok: false, error: 'Chua dang nhap' });
    try {
      const body = await parseBody(req);
      const provider = PROVIDERS[body.provider];
      if (!provider) return json(res, 400, { ok: false, error: 'Provider khong hop le' });

      const gatewayToken = getGatewayToken();
      const serverIP = getServerIP();

      // 1. Ghi API key vao /opt/openclaw.env
      let envContent = fs.readFileSync('/opt/openclaw.env', 'utf8');
      envContent = envContent.replace(new RegExp(`^${provider.envKey}=.*$`, 'm'), '').trim();
      envContent += `\n${provider.envKey}=${body.apiKey}\n`;
      fs.writeFileSync('/opt/openclaw.env', envContent, 'utf8');

      // 2. Copy config JSON va thay gateway token
      const config = JSON.parse(fs.readFileSync(provider.configFile, 'utf8'));
      config.gateway.auth.token = gatewayToken;
      const configDir = '/home/openclaw/.openclaw';
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(`${configDir}/openclaw.json`, JSON.stringify(config, null, 2), 'utf8');
      execSync(`chown openclaw:openclaw ${configDir}/openclaw.json`);
      execSync(`chmod 0600 ${configDir}/openclaw.json`);

      // 3. Restart openclaw
      execSync('systemctl restart openclaw', { timeout: 15000 });
      execSync('sleep 2');

      let running = false;
      try { execSync('systemctl is-active --quiet openclaw'); running = true; } catch { running = false; }

      const dashboardUrl = `https://${serverIP}?token=${gatewayToken}`;

      if (running) {
        // Khong tu huy ngay — doi user hoan tat pairing truoc
        return json(res, 200, { ok: true, dashboardUrl });
      } else {
        return json(res, 500, { ok: false, error: 'OpenClaw khoi dong that bai. Kiem tra: journalctl -u openclaw -xe' });
      }
    } catch (e) { return json(res, 500, { ok: false, error: `Loi: ${e.message}` }); }
  }

  // --- API: Pair (tim va approve pending pairing request) ---
  if (req.method === 'POST' && url.pathname === '/api/pair') {
    if (!isValidSession(req)) return json(res, 401, { ok: false, error: 'Chua dang nhap' });
    try {
      const gatewayToken = getGatewayToken();

      // Tim pending pairing requests
      let output = '';
      try {
        output = execSync(
          `/opt/openclaw-cli.sh devices list --token=${gatewayToken} 2>/dev/null`,
          { timeout: 15000, stdio: 'pipe' }
        ).toString();
      } catch (e) {
        output = e.stdout ? e.stdout.toString() : '';
      }

      // Lay phan Pending
      const pendingSection = output.match(/Pending[\s\S]*?(?=Paired|$)/i);
      if (!pendingSection) {
        return json(res, 200, { ok: false, error: 'Khong tim thay yeu cau ghep noi. Hay mo dashboard truoc roi thu lai.' });
      }

      // Tim UUID trong phan pending
      const uuids = pendingSection[0].match(/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/g);
      if (!uuids || uuids.length === 0) {
        return json(res, 200, { ok: false, error: 'Khong tim thay yeu cau ghep noi. Hay mo dashboard truoc roi thu lai.' });
      }

      if (uuids.length > 1) {
        return json(res, 200, { ok: false, error: `Tim thay ${uuids.length} yeu cau. Co nguoi khac dang ket noi. Hay thu lai sau.` });
      }

      // Approve request
      execSync(
        `/opt/openclaw-cli.sh devices approve "${uuids[0]}" --token=${gatewayToken}`,
        { timeout: 15000, stdio: 'pipe' }
      );

      // Ghep noi thanh cong — tu huy sau 5 giay
      setTimeout(() => selfDestruct(), 5000);
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 500, { ok: false, error: `Loi ghep noi: ${e.message}` });
    }
  }

  json(res, 404, { error: 'Not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Setup UI] Dang chay tai http://0.0.0.0:${PORT}`);
  console.log(`[Setup UI] Tu dong tat sau ${AUTO_SHUTDOWN / 60000} phut.`);
  shutdownTimer = setTimeout(() => { console.log('[Setup UI] Timeout — tu dong tat.'); process.exit(0); }, AUTO_SHUTDOWN);
});
