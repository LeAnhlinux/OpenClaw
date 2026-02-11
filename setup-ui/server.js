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
// Khong tu dong tat — chi tu huy khi setup hoan tat (selfDestruct)
const MAX_LOGIN_ATTEMPTS = 5;
const BLOCK_DURATION = 15 * 60 * 1000;    // 15 phut

const sessions = {};
const loginAttempts = {};

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
  },
  gemini: {
    name: 'Google Gemini',
    envKey: 'GOOGLE_API_KEY',
    configFile: '/etc/config/gemini.json',
    testFn: (apiKey) => {
      try {
        const r = execSync(`curl -s -o /dev/null -w '%{http_code}' \
          "https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey.replace(/'/g, "'\\''")}"`,
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

  <!-- Step 1: Domain -->
  <div class="step active" id="step1"><div class="card">
    <h2>Buoc 1: Ten mien &amp; SSL (tuy chon)</h2>
    <p>Nhap ten mien de su dung HTTPS voi chung chi Let's Encrypt hop le. Neu chua co ten mien, bam Bo qua — se dung self-signed cert voi IP.</p>
    <div class="field">
      <label>&#x1f310; Ten mien (domain)</label>
      <input type="text" id="domainInput" placeholder="bot.example.com">
      <p style="font-size:12px;color:#64748b;margin-top:4px">Tro DNS (A record) cua ten mien ve IP server nay truoc khi tiep tuc</p>
    </div>
    <div class="field">
      <label>&#x1f4e7; Email Let's Encrypt (tuy chon)</label>
      <input type="email" id="domainEmail" placeholder="admin@example.com">
      <p style="font-size:12px;color:#64748b;margin-top:4px">Nhan thong bao khi cert sap het han</p>
    </div>
    <div class="status" id="domainStatus"></div>
    <div class="btn-row">
      <button class="btn btn-outline" onclick="goStep(2)">Bo qua (dung IP)</button>
      <button class="btn" id="domainBtn" onclick="saveDomain()">Cau hinh SSL</button>
    </div>
  </div></div>

  <!-- Step 2: Choose AI Provider + Model -->
  <div class="step" id="step2"><div class="card">
    <h2>Buoc 2: Chon nha cung cap AI</h2>
    <p>Chon nha cung cap LLM ma ban muon su dung</p>
    <div class="providers" style="grid-template-columns:1fr 1fr 1fr">
      <div class="provider" data-provider="anthropic" onclick="selectProvider(this)">
        <div class="icon">&#x1f7e0;</div><div class="name">Anthropic</div>
        <div style="color:#94a3b8;font-size:12px;margin-top:4px">Claude</div>
      </div>
      <div class="provider" data-provider="openai" onclick="selectProvider(this)">
        <div class="icon">&#x1f7e2;</div><div class="name">OpenAI</div>
        <div style="color:#94a3b8;font-size:12px;margin-top:4px">GPT</div>
      </div>
      <div class="provider" data-provider="gemini" onclick="selectProvider(this)">
        <div class="icon">&#x1f535;</div><div class="name">Google</div>
        <div style="color:#94a3b8;font-size:12px;margin-top:4px">Gemini</div>
      </div>
    </div>
    <div id="modelSection" style="display:none;margin-top:20px">
      <div class="field">
        <label>&#x1f916; Chon model</label>
        <select id="modelSelect" style="width:100%;padding:10px 14px;background:#0f172a;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:15px;outline:none;cursor:pointer">
        </select>
      </div>
    </div>
    <div class="btn-row"><button class="btn" id="nextStep2" disabled onclick="goStep(3)">Tiep tuc</button></div>
  </div></div>

  <!-- Step 3: API Key -->
  <div class="step" id="step3"><div class="card">
    <h2>Buoc 3: Nhap API Key</h2>
    <p id="step3desc">Nhap API key cua nha cung cap</p>
    <div class="field"><label id="keyLabel">API Key</label><input type="password" id="apiKey" placeholder="sk-..."></div>
    <div class="btn-row">
      <button class="btn btn-outline" onclick="goStep(2)">Quay lai</button>
      <button class="btn" id="testBtn" onclick="testKey()">Kiem tra ket noi</button>
    </div>
    <div class="status" id="testStatus"></div>
  </div></div>

  <!-- Step 4: Confirm -->
  <div class="step" id="step4"><div class="card">
    <h2>Buoc 4: Xac nhan cau hinh</h2>
    <p>Kiem tra lai thong tin truoc khi hoan tat</p>
    <div style="background:#0f172a;border-radius:8px;padding:16px;margin-bottom:16px">
      <div style="display:flex;justify-content:space-between;margin-bottom:8px"><span style="color:#94a3b8">Nha cung cap:</span><span id="confirmProvider" style="font-weight:600"></span></div>
      <div style="display:flex;justify-content:space-between;margin-bottom:8px"><span style="color:#94a3b8">Model:</span><span id="confirmModel" style="font-weight:600;color:#38bdf8"></span></div>
      <div style="display:flex;justify-content:space-between"><span style="color:#94a3b8">API Key:</span><span id="confirmKey" style="font-family:monospace"></span></div>
    </div>
    <div class="btn-row">
      <button class="btn btn-outline" onclick="goStep(3)">Quay lai</button>
      <button class="btn btn-success" id="finishBtn" onclick="finish()">Hoan tat cai dat</button>
    </div>
    <div class="status" id="finishStatus"></div>
  </div></div>

  <!-- Step 5: Channels -->
  <div class="step" id="step5"><div class="card">
    <h2>Buoc 5: Kenh nhan tin (tuy chon)</h2>
    <p>Ket noi kenh nhan tin de chat voi AI. Co the bo qua va cau hinh sau.</p>
    <div class="field">
      <label>&#x1f4e8; Telegram Bot Token</label>
      <input type="text" id="telegramToken" placeholder="123456789:ABCdefghijklmnop">
      <p style="font-size:12px;color:#64748b;margin-top:4px">Tao bot tai <a href="https://t.me/BotFather" target="_blank" style="color:#38bdf8">@BotFather</a> tren Telegram, chay /newbot de lay token</p>
    </div>
    <div class="field">
      <label>&#x1f4ac; Zalo Bot Token</label>
      <input type="text" id="zaloToken" placeholder="12345689:abc-xyz">
      <p style="font-size:12px;color:#64748b;margin-top:4px">Tao bot tai <a href="https://bot.zaloplatforms.com" target="_blank" style="color:#38bdf8">bot.zaloplatforms.com</a> de lay token</p>
    </div>
    <div class="status" id="channelStatus"></div>
    <div class="btn-row">
      <button class="btn btn-outline" onclick="goStep(6)">Bo qua</button>
      <button class="btn" id="channelBtn" onclick="saveChannels()">Luu kenh nhan tin</button>
    </div>
  </div></div>

  <!-- Step 6: Pairing -->
  <div class="step" id="step6"><div class="card">
    <h2>Buoc 6: Ghep noi Dashboard</h2>
    <p>Mo link dashboard ben duoi trong <strong>tab moi</strong>, doi trang tai xong (se thay loi ghep noi - dieu nay binh thuong), roi quay lai day bam nut ghep noi.</p>
    <div class="url-box" id="pairingUrl" style="background:#0f172a;border:1px solid #334155;border-radius:8px;padding:12px 16px;margin:16px 0;word-break:break-all;font-family:monospace;font-size:14px;color:#38bdf8;cursor:pointer" onclick="window.open(this.textContent,'_blank')"></div>
    <p style="font-size:13px;color:#94a3b8;margin-bottom:16px">&#x261d; Bam vao link tren de mo trong tab moi</p>
    <div class="btn-row">
      <button class="btn" id="pairBtn" onclick="doPairing()">Da mo Dashboard - Ghep noi ngay</button>
    </div>
    <div class="status" id="pairStatus"></div>
  </div></div>

  <!-- Step 7: Done -->
  <div class="step" id="step7"><div class="card"><div class="done-box">
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
let selectedProvider=null,selectedModel='',keyVerified=false,configuredDomain='';
const names={anthropic:'Anthropic',openai:'OpenAI',gemini:'Google Gemini'};
const models={
  anthropic:[
    {id:'anthropic/claude-opus-4-5',name:'Claude Opus 4.5',desc:'Flagship — smartest, best for complex tasks'},
    {id:'anthropic/claude-sonnet-4-20250514',name:'Claude Sonnet 4',desc:'Balanced — fast and capable'},
    {id:'anthropic/claude-haiku-3-5-20241022',name:'Claude Haiku 3.5',desc:'Fastest — lightweight, low cost'}
  ],
  openai:[
    {id:'openai/gpt-5.2',name:'GPT-5.2',desc:'Latest — most powerful'},
    {id:'openai/o3',name:'o3',desc:'Reasoning — best for logic and math'},
    {id:'openai/gpt-4.1',name:'GPT-4.1',desc:'Balanced — fast and reliable'},
    {id:'openai/gpt-4.1-mini',name:'GPT-4.1 Mini',desc:'Lightweight — fast, low cost'}
  ],
  gemini:[
    {id:'google/gemini-2.5-pro',name:'Gemini 2.5 Pro',desc:'Flagship — best reasoning and coding'},
    {id:'google/gemini-2.5-flash',name:'Gemini 2.5 Flash',desc:'Balanced — fast with thinking'},
    {id:'google/gemini-2.0-flash',name:'Gemini 2.0 Flash',desc:'Speed — low latency, high throughput'},
    {id:'google/gemini-2.0-flash-lite',name:'Gemini 2.0 Flash Lite',desc:'Lightweight — cost efficient'}
  ]
};

function selectProvider(el){
  document.querySelectorAll('.provider').forEach(p=>p.classList.remove('selected'));
  el.classList.add('selected');selectedProvider=el.dataset.provider;
  // Render model list
  const sel=document.getElementById('modelSelect');
  sel.innerHTML=models[selectedProvider].map((m,i)=>'<option value="'+m.id+'"'+(i===0?' selected':'')+'>'+m.name+' — '+m.desc+'</option>').join('');
  selectedModel=models[selectedProvider][0].id;
  sel.onchange=function(){selectedModel=this.value};
  document.getElementById('modelSection').style.display='block';
  document.getElementById('nextStep2').disabled=false;
}
function goStep(n){
  document.querySelectorAll('.step').forEach(s=>s.classList.remove('active'));
  document.getElementById('step'+n).classList.add('active');
  if(n===3){document.getElementById('step3desc').textContent='Nhap '+names[selectedProvider]+' API key cua ban';document.getElementById('keyLabel').textContent=names[selectedProvider]+' API Key';document.getElementById('testStatus').className='status';keyVerified=false}
  if(n===4){document.getElementById('confirmProvider').textContent=names[selectedProvider];const m=models[selectedProvider].find(x=>x.id===selectedModel);document.getElementById('confirmModel').textContent=m?m.name:selectedModel;const k=document.getElementById('apiKey').value;document.getElementById('confirmKey').textContent=k.substring(0,8)+'...'+k.substring(k.length-4)}
  if(n===6){document.getElementById('pairingUrl').textContent=dashboardUrlGlobal}
}
async function saveDomain(){
  const btn=document.getElementById('domainBtn'),st=document.getElementById('domainStatus');
  const domain=document.getElementById('domainInput').value.trim();
  const email=document.getElementById('domainEmail').value.trim();
  if(!domain){st.className='status fail';st.textContent='Vui long nhap ten mien';return}
  btn.disabled=true;btn.textContent='Dang cau hinh SSL...';st.className='status loading';st.textContent='Dang cau hinh Caddy voi Let\\'s Encrypt...';
  try{const r=await fetch('/api/domain',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({domain,email})});const d=await r.json();
  if(d.ok){configuredDomain=domain;st.className='status ok';st.textContent='\\u2705 Da cau hinh SSL cho '+domain+' thanh cong!';setTimeout(()=>goStep(2),1500)}
  else{st.className='status fail';st.textContent='\\u274c '+(d.error||'Loi khi cau hinh domain');btn.disabled=false;btn.textContent='Cau hinh SSL'}}
  catch(x){st.className='status fail';st.textContent='\\u274c Loi ket noi server';btn.disabled=false;btn.textContent='Cau hinh SSL'}
}
async function testKey(){
  const btn=document.getElementById('testBtn'),st=document.getElementById('testStatus'),k=document.getElementById('apiKey').value.trim();
  if(!k){st.className='status fail';st.textContent='Vui long nhap API key';return}
  btn.disabled=true;btn.textContent='Dang kiem tra...';st.className='status loading';st.textContent='Dang ket noi...';
  try{const r=await fetch('/api/test-key',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:selectedProvider,apiKey:k})});const d=await r.json();
  if(d.ok){st.className='status ok';st.textContent='\\u2705 Ket noi thanh cong! API key hop le.';keyVerified=true;setTimeout(()=>goStep(4),1500)}
  else{st.className='status fail';st.textContent='\\u274c '+(d.error||'API key khong hop le')}}
  catch(x){st.className='status fail';st.textContent='\\u274c Loi ket noi server'}
  btn.disabled=false;btn.textContent='Kiem tra ket noi';
}
let dashboardUrlGlobal='';
async function finish(){
  const btn=document.getElementById('finishBtn'),st=document.getElementById('finishStatus');
  btn.disabled=true;btn.textContent='Dang cau hinh...';st.className='status loading';st.textContent='Dang ghi cau hinh va khoi dong OpenClaw...';
  try{const r=await fetch('/api/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:selectedProvider,model:selectedModel,apiKey:document.getElementById('apiKey').value.trim(),domain:configuredDomain})});const d=await r.json();
  if(d.ok){dashboardUrlGlobal=d.dashboardUrl;goStep(5)}
  else{st.className='status fail';st.textContent='\\u274c '+(d.error||'Loi khi cau hinh');btn.disabled=false;btn.textContent='Hoan tat cai dat'}}
  catch(x){st.className='status fail';st.textContent='\\u274c Loi ket noi server';btn.disabled=false;btn.textContent='Hoan tat cai dat'}
}
async function saveChannels(){
  const btn=document.getElementById('channelBtn'),st=document.getElementById('channelStatus');
  const tg=document.getElementById('telegramToken').value.trim();
  const zl=document.getElementById('zaloToken').value.trim();
  if(!tg&&!zl){st.className='status fail';st.textContent='Nhap it nhat 1 token hoac bam Bo qua';return}
  btn.disabled=true;btn.textContent='Dang luu...';st.className='status loading';st.textContent='Dang cau hinh kenh nhan tin...';
  try{const r=await fetch('/api/channels',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({telegram:tg,zalo:zl})});const d=await r.json();
  if(d.ok){st.className='status ok';st.textContent='\\u2705 Da luu kenh nhan tin!';setTimeout(()=>{goStep(6);document.getElementById('pairingUrl').textContent=dashboardUrlGlobal},1500)}
  else{st.className='status fail';st.textContent='\\u274c '+(d.error||'Loi khi luu');btn.disabled=false;btn.textContent='Luu kenh nhan tin'}}
  catch(x){st.className='status fail';st.textContent='\\u274c Loi ket noi server';btn.disabled=false;btn.textContent='Luu kenh nhan tin'}
}
async function doPairing(){
  const btn=document.getElementById('pairBtn'),st=document.getElementById('pairStatus');
  btn.disabled=true;btn.textContent='Dang tim yeu cau ghep noi...';st.className='status loading';st.textContent='Dang kiem tra...';
  try{const r=await fetch('/api/pair',{method:'POST',headers:{'Content-Type':'application/json'}});const d=await r.json();
  if(d.ok){goStep(7);document.getElementById('dashboardUrl').textContent=dashboardUrlGlobal;document.getElementById('dashboardLink').href=dashboardUrlGlobal}
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

  // --- API: Domain (cau hinh Caddy voi domain + Let's Encrypt) ---
  if (req.method === 'POST' && url.pathname === '/api/domain') {
    if (!isValidSession(req)) return json(res, 401, { ok: false, error: 'Chua dang nhap' });
    try {
      const body = await parseBody(req);
      const domain = (body.domain || '').trim().toLowerCase();
      const email = (body.email || '').trim();

      if (!domain) return json(res, 400, { ok: false, error: 'Thieu ten mien' });
      if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
        return json(res, 400, { ok: false, error: 'Ten mien khong hop le' });
      }

      // Kiem tra DNS: domain co tro ve IP server nay khong
      const serverIP = getServerIP();
      let resolvedIPs = [];
      // Thu dig truoc
      try {
        const out = execSync(`dig +short A ${domain} 2>/dev/null`, { timeout: 10000, stdio: 'pipe' }).toString().trim();
        if (out) resolvedIPs = out.split('\n').map(ip => ip.trim()).filter(ip => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
      } catch {}
      // Fallback: host
      if (resolvedIPs.length === 0) {
        try {
          const out = execSync(`host ${domain} 2>/dev/null`, { timeout: 10000, stdio: 'pipe' }).toString();
          const m = out.match(/has address (\d+\.\d+\.\d+\.\d+)/g);
          if (m) resolvedIPs = m.map(s => s.replace('has address ', ''));
        } catch {}
      }
      // Fallback: python3 socket (luon co tren Ubuntu)
      if (resolvedIPs.length === 0) {
        try {
          const out = execSync(`python3 -c "import socket; print(socket.gethostbyname('${domain}'))" 2>/dev/null`, { timeout: 10000, stdio: 'pipe' }).toString().trim();
          if (out && /^\d+\.\d+\.\d+\.\d+$/.test(out)) resolvedIPs = [out];
        } catch {}
      }

      if (resolvedIPs.length === 0) {
        return json(res, 400, { ok: false, error: `Khong the phan giai DNS cho ${domain}. Hay tro A record ve ${serverIP} truoc.` });
      }

      if (!resolvedIPs.includes(serverIP)) {
        return json(res, 400, { ok: false, error: `DNS cua ${domain} dang tro ve ${resolvedIPs.join(', ')} — khong khop voi IP server nay (${serverIP}). Hay cap nhat A record.` });
      }

      // Ghi OPENCLAW_GATEWAY_BIND vao env (giong setup-openclaw-domain.sh)
      const BIND_IP = '127.0.0.1';
      const PORT_GW = 18789;
      try {
        let envContent = fs.readFileSync('/opt/openclaw.env', 'utf8');
        if (/^OPENCLAW_GATEWAY_BIND=/m.test(envContent)) {
          envContent = envContent.replace(/^OPENCLAW_GATEWAY_BIND=.*/m, `OPENCLAW_GATEWAY_BIND=${BIND_IP}`);
        } else {
          envContent = envContent.trim() + `\nOPENCLAW_GATEWAY_BIND=${BIND_IP}\n`;
        }
        fs.writeFileSync('/opt/openclaw.env', envContent, 'utf8');
      } catch {}

      // Ghi Caddyfile giong setup-openclaw-domain.sh
      const emailLine = email ? `email ${email}\n` : '';
      const caddyConfig = `${emailLine}${domain} {
    tls {
        issuer acme {
            dir https://acme-v02.api.letsencrypt.org/directory
            profile shortlived
        }
    }
    reverse_proxy ${BIND_IP}:${PORT_GW}
}
`;
      fs.writeFileSync('/etc/caddy/Caddyfile', caddyConfig, 'utf8');

      // Enable + Restart Caddy
      execSync('systemctl enable caddy 2>/dev/null || true', { timeout: 10000 });
      execSync('systemctl restart caddy', { timeout: 30000 });
      execSync('sleep 3');

      // Kiem tra Caddy con chay khong
      let caddyOk = false;
      try { execSync('systemctl is-active --quiet caddy'); caddyOk = true; } catch { caddyOk = false; }

      if (caddyOk) {
        return json(res, 200, { ok: true, domain });
      } else {
        // Rollback ve config IP neu Caddy loi
        const fallbackConfig = `${serverIP} {
    tls internal
    reverse_proxy ${BIND_IP}:${PORT_GW}
}
`;
        fs.writeFileSync('/etc/caddy/Caddyfile', fallbackConfig, 'utf8');
        execSync('systemctl restart caddy 2>/dev/null || true', { timeout: 15000 });
        return json(res, 500, { ok: false, error: 'Caddy khoi dong that bai voi domain nay. Co the DNS chua tro dung. Da rollback ve config IP.' });
      }
    } catch (e) { return json(res, 500, { ok: false, error: `Loi: ${e.message}` }); }
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
      const domain = (body.domain || '').trim();

      // 1. Ghi API key vao /opt/openclaw.env
      let envContent = fs.readFileSync('/opt/openclaw.env', 'utf8');
      envContent = envContent.replace(new RegExp(`^${provider.envKey}=.*$`, 'm'), '').trim();
      envContent += `\n${provider.envKey}=${body.apiKey}\n`;
      fs.writeFileSync('/opt/openclaw.env', envContent, 'utf8');

      // 2. Copy config JSON va thay gateway token + model
      const config = JSON.parse(fs.readFileSync(provider.configFile, 'utf8'));
      config.gateway.auth.token = gatewayToken;
      // Ghi model da chon
      const model = (body.model || '').trim();
      if (model) {
        config.agents.defaults.model.primary = model;
      }
      // Gateway luon bind loopback — Caddy reverse proxy tu localhost
      // Khong can thay doi bind khi dung domain vi Caddy va OpenClaw cung server
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

      // Dung domain neu da cau hinh, khong thi dung IP
      const host = domain || serverIP;
      const dashboardUrl = `https://${host}?token=${gatewayToken}`;

      if (running) {
        // Khong tu huy ngay — doi user hoan tat pairing truoc
        return json(res, 200, { ok: true, dashboardUrl });
      } else {
        return json(res, 500, { ok: false, error: 'OpenClaw khoi dong that bai. Kiem tra: journalctl -u openclaw -xe' });
      }
    } catch (e) { return json(res, 500, { ok: false, error: `Loi: ${e.message}` }); }
  }

  // --- API: Channels (luu token kenh nhan tin) ---
  if (req.method === 'POST' && url.pathname === '/api/channels') {
    if (!isValidSession(req)) return json(res, 401, { ok: false, error: 'Chua dang nhap' });
    try {
      const body = await parseBody(req);
      let envContent = fs.readFileSync('/opt/openclaw.env', 'utf8');

      // Telegram
      if (body.telegram) {
        envContent = envContent.replace(/^#?\s*TELEGRAM_BOT_TOKEN=.*$/m, '').trim();
        envContent += `\nTELEGRAM_BOT_TOKEN=${body.telegram}`;
      }

      // Zalo
      if (body.zalo) {
        envContent = envContent.replace(/^#?\s*ZALO_BOT_TOKEN=.*$/m, '').trim();
        envContent += `\nZALO_BOT_TOKEN=${body.zalo}`;
      }

      envContent = envContent.trim() + '\n';
      fs.writeFileSync('/opt/openclaw.env', envContent, 'utf8');

      // Restart de nhan token moi
      execSync('systemctl restart openclaw', { timeout: 15000 });
      execSync('sleep 2');

      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 500, { ok: false, error: `Loi: ${e.message}` });
    }
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
  console.log('[Setup UI] Se tu huy khi setup hoan tat.');
});
