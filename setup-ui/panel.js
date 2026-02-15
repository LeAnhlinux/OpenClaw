#!/usr/bin/env node
// =============================================================================
// OpenClaw Management Panel — Web-based admin panel
// Xac thuc bang PAM (root password), chay lau dai
// Port: 9999 | Chay bang root | Systemd: openclaw-panel.service
// =============================================================================

const http = require('http');
const { execSync, exec } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');

const PORT = 9999;
const SESSION_TTL = 60 * 60 * 1000;        // 60 phut
const MAX_LOGIN_ATTEMPTS = 5;
const BLOCK_DURATION = 15 * 60 * 1000;     // 15 phut

const ENV_FILE = '/opt/openclaw.env';
const CONFIG_FILE = '/home/openclaw/.openclaw/openclaw.json';
const CONFIG_DIR = '/etc/config';
const CADDYFILE = '/etc/caddy/Caddyfile';
const OPENCLAW_DIR = '/opt/openclaw';

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
  const match = cookie.match(/panel_session=([a-f0-9]{64})/);
  if (!match) return false;
  const s = sessions[match[1]];
  if (!s) return false;
  if (Date.now() - s.created > SESSION_TTL) { delete sessions[match[1]]; return false; }
  return true;
}
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) { req.destroy(); reject(new Error('Too large')); } });
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
function getEnvValue(key) {
  try {
    const content = fs.readFileSync(ENV_FILE, 'utf8');
    const m = content.match(new RegExp(`^${key}=(.*)$`, 'm'));
    return m ? m[1].trim() : '';
  } catch { return ''; }
}
function setEnvValue(key, value) {
  let content = '';
  try { content = fs.readFileSync(ENV_FILE, 'utf8'); } catch {}
  if (new RegExp(`^${key}=`, 'm').test(content)) {
    content = content.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);
  } else {
    content = content.trim() + `\n${key}=${value}\n`;
  }
  fs.writeFileSync(ENV_FILE, content.trim() + '\n', 'utf8');
}
function removeEnvValue(key) {
  try {
    let content = fs.readFileSync(ENV_FILE, 'utf8');
    content = content.replace(new RegExp(`^#?\\s*${key}=.*$`, 'm'), '').trim() + '\n';
    fs.writeFileSync(ENV_FILE, content, 'utf8');
  } catch {}
}
function getConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return {}; }
}
function saveConfig(config) {
  const dir = '/home/openclaw/.openclaw';
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  execSync(`chown openclaw:openclaw ${CONFIG_FILE}`);
  execSync(`chmod 0600 ${CONFIG_FILE}`);
}
function restartService(name) {
  try { execSync(`systemctl restart ${name}`, { timeout: 30000 }); return true; }
  catch { return false; }
}
function isServiceActive(name) {
  try { execSync(`systemctl is-active --quiet ${name}`); return true; }
  catch { return false; }
}
function safeExec(cmd, timeout) {
  try { return execSync(cmd, { timeout: timeout || 15000, stdio: 'pipe' }).toString().trim(); }
  catch { return ''; }
}

// --- Provider configs ---
const PROVIDERS = {
  anthropic: {
    name: 'Anthropic', envKey: 'ANTHROPIC_API_KEY', configFile: `${CONFIG_DIR}/anthropic.json`,
    models: [
      { id: 'anthropic/claude-opus-4-5', name: 'Claude Opus 4.5', desc: 'Flagship — smartest' },
      { id: 'anthropic/claude-sonnet-4-20250514', name: 'Claude Sonnet 4', desc: 'Balanced — fast' },
      { id: 'anthropic/claude-haiku-3-5-20241022', name: 'Claude Haiku 3.5', desc: 'Fastest — low cost' }
    ],
    testFn: (apiKey) => {
      try {
        const r = safeExec(`curl -s -o /dev/null -w '%{http_code}' -X POST https://api.anthropic.com/v1/messages -H 'x-api-key: ${apiKey.replace(/'/g, "'\\''")}' -H 'anthropic-version: 2023-06-01' -H 'content-type: application/json' -d '{"model":"claude-sonnet-4-20250514","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}'`, 15000);
        return r === '200';
      } catch { return false; }
    }
  },
  openai: {
    name: 'OpenAI', envKey: 'OPENAI_API_KEY', configFile: `${CONFIG_DIR}/openai.json`,
    models: [
      { id: 'openai/gpt-5.2', name: 'GPT-5.2', desc: 'Latest — most powerful' },
      { id: 'openai/o3', name: 'o3', desc: 'Reasoning — logic & math' },
      { id: 'openai/gpt-4.1', name: 'GPT-4.1', desc: 'Balanced — fast' },
      { id: 'openai/gpt-4.1-mini', name: 'GPT-4.1 Mini', desc: 'Lightweight — low cost' }
    ],
    testFn: (apiKey) => {
      try {
        const r = safeExec(`curl -s -o /dev/null -w '%{http_code}' https://api.openai.com/v1/models -H 'Authorization: Bearer ${apiKey.replace(/'/g, "'\\''")}' `, 15000);
        return r === '200';
      } catch { return false; }
    }
  },
  gemini: {
    name: 'Google Gemini', envKey: 'GOOGLE_API_KEY', configFile: `${CONFIG_DIR}/gemini.json`,
    models: [
      { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro', desc: 'Flagship — reasoning & coding' },
      { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash', desc: 'Balanced — fast thinking' },
      { id: 'google/gemini-2.0-flash', name: 'Gemini 2.0 Flash', desc: 'Speed — low latency' },
      { id: 'google/gemini-2.0-flash-lite', name: 'Gemini 2.0 Flash Lite', desc: 'Lightweight — cost efficient' }
    ],
    testFn: (apiKey) => {
      try {
        const r = safeExec(`curl -s -o /dev/null -w '%{http_code}' "https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey.replace(/'/g, "'\\''")}"`, 15000);
        return r === '200';
      } catch { return false; }
    }
  },
  xai: {
    name: 'xAI (Grok)', envKey: 'XAI_API_KEY', configFile: `${CONFIG_DIR}/openai.json`,
    models: [
      { id: 'xai/grok-4-1-fast-reasoning', name: 'Grok 4.1 Fast Reasoning', desc: 'Latest — reasoning' },
      { id: 'xai/grok-3', name: 'Grok 3', desc: 'Flagship — most capable' },
      { id: 'xai/grok-3-mini', name: 'Grok 3 Mini', desc: 'Balanced — efficient' },
      { id: 'xai/grok-code-fast-1', name: 'Grok Code Fast 1', desc: 'Code — optimized' }
    ],
    testFn: (apiKey) => {
      try {
        const r = safeExec(`curl -s -o /dev/null -w '%{http_code}' https://api.x.ai/v1/models -H 'Authorization: Bearer ${apiKey.replace(/'/g, "'\\''")}' `, 15000);
        return r === '200';
      } catch { return false; }
    }
  },
  minimax: {
    name: 'MiniMax', envKey: 'MINIMAX_API_KEY', configFile: `${CONFIG_DIR}/openai.json`,
    models: [
      { id: 'minimax/MiniMax-M2.5', name: 'MiniMax M2.5', desc: 'Latest — most capable' },
      { id: 'minimax/MiniMax-M2.1', name: 'MiniMax M2.1', desc: 'Balanced — reliable' },
      { id: 'minimax/MiniMax-M2', name: 'MiniMax M2', desc: 'Base — cost efficient' }
    ],
    testFn: (apiKey) => {
      try {
        const r = safeExec(`curl -s -o /dev/null -w '%{http_code}' https://api.minimax.io/v1/models -H 'Authorization: Bearer ${apiKey.replace(/'/g, "'\\''")}' `, 15000);
        return r === '200';
      } catch { return false; }
    }
  }
};

// --- Channel configs ---
const CHANNELS = {
  telegram: { name: 'Telegram', icon: '\ud83d\udce8', envKeys: ['TELEGRAM_BOT_TOKEN'], pairCmd: 'telegram', desc: 'Tao bot tai @BotFather', canPair: true },
  zalo: { name: 'Zalo', icon: '\ud83d\udcac', envKeys: ['ZALO_BOT_TOKEN'], pairCmd: 'zalo', desc: 'Tao bot tai bot.zaloplatforms.com', canPair: true },
  discord: { name: 'Discord', icon: '\ud83c\udfae', envKeys: ['DISCORD_BOT_TOKEN'], pairCmd: 'discord', desc: 'Tao bot tai discord.com/developers', canPair: true },
  slack: { name: 'Slack', icon: '\ud83d\udcbc', envKeys: ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'], pairCmd: null, desc: 'Tao app tai api.slack.com/apps', canPair: false },
  whatsapp: { name: 'WhatsApp', icon: '\ud83d\udcf1', envKeys: [], pairCmd: null, desc: 'Chay: openclaw whatsapp pair', canPair: false, cliOnly: true },
  line: { name: 'LINE', icon: '\ud83d\udfe2', envKeys: ['LINE_CHANNEL_ACCESS_TOKEN', 'LINE_CHANNEL_SECRET'], pairCmd: null, desc: 'Plugin — tao bot tai developers.line.biz', canPair: false },
  signal: { name: 'Signal', icon: '\ud83d\udd12', envKeys: [], pairCmd: null, desc: 'Chay: openclaw signal link', canPair: false, cliOnly: true },
  matrix: { name: 'Matrix', icon: '\ud83c\udf10', envKeys: ['MATRIX_HOMESERVER', 'MATRIX_ACCESS_TOKEN'], pairCmd: null, desc: 'Plugin — cau hinh homeserver + token', canPair: false }
};

// --- CSS ---
const CSS = `*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',Roboto,-apple-system,sans-serif;background:linear-gradient(135deg,#f0f4ff 0%,#e8f5e9 50%,#f3e5f5 100%);color:#1a1a2e;min-height:100vh}
.container{max-width:960px;margin:0 auto;padding:20px}
.logo{text-align:center;margin-bottom:16px} .logo img{height:42px;margin-bottom:4px} .logo h1{font-size:26px;background:linear-gradient(135deg,#4285f4,#34a853);-webkit-background-clip:text;-webkit-text-fill-color:transparent;font-weight:800} .logo p{color:#5f6368;font-size:13px}
.tabs{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-bottom:20px}
.tab{padding:10px 18px;background:#fff;border:2px solid #e8eaed;border-radius:10px;cursor:pointer;font-size:14px;font-weight:600;color:#5f6368;transition:all .2s} .tab:hover{border-color:#4285f4;color:#4285f4} .tab.active{background:linear-gradient(135deg,#4285f4,#34a853);color:#fff;border-color:transparent;box-shadow:0 4px 12px rgba(66,133,244,.3)}
.card{background:linear-gradient(135deg,#fff 0%,#f9fafb 100%);border-radius:14px;padding:28px;box-shadow:0 8px 30px rgba(0,0,0,.06);border:1px solid rgba(0,0,0,.05);margin-bottom:20px;position:relative;overflow:hidden} .card::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,#4285f4,#34a853,#fbbc05,#ea4335)}
.card h2{font-size:18px;margin-bottom:14px;font-weight:700} .card p{color:#5f6368;font-size:14px;margin-bottom:14px;line-height:1.5}
.field{margin-bottom:16px} .field label{display:block;font-size:12px;color:#5f6368;margin-bottom:6px;font-weight:600;text-transform:uppercase;letter-spacing:.5px}
.field input,.field select{width:100%;padding:10px 14px;background:#f8f9fa;border:2px solid #e8eaed;border-radius:8px;color:#1a1a2e;font-size:14px;outline:none;transition:all .2s} .field input:focus,.field select:focus{border-color:#4285f4;background:#fff;box-shadow:0 0 0 3px rgba(66,133,244,.1)}
.btn{padding:10px 22px;background:linear-gradient(135deg,#4285f4,#34a853);color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;transition:all .2s;box-shadow:0 3px 10px rgba(66,133,244,.25)} .btn:hover{transform:translateY(-1px);box-shadow:0 6px 20px rgba(66,133,244,.35)} .btn:disabled{opacity:.5;cursor:not-allowed;transform:none;box-shadow:none}
.btn-outline{background:#fff;border:2px solid #e8eaed;color:#5f6368;box-shadow:none} .btn-outline:hover{border-color:#4285f4;color:#4285f4}
.btn-danger{background:linear-gradient(135deg,#ea4335,#c5221f)} .btn-danger:hover{box-shadow:0 6px 20px rgba(234,67,53,.35)}
.btn-success{background:linear-gradient(135deg,#34a853,#1e8e3e)}
.btn-row{display:flex;gap:10px;margin-top:16px;flex-wrap:wrap}
.status{padding:12px 16px;border-radius:8px;font-size:13px;margin-top:12px;display:none;font-weight:500} .status.ok{display:block;background:#e6f4ea;border:1px solid #34a853;color:#1e8e3e} .status.fail{display:block;background:#fce8e6;border:1px solid #ea4335;color:#c5221f} .status.loading{display:block;background:#e8f0fe;border:1px solid #4285f4;color:#1967d2} .status.warn{display:block;background:#fef7e0;border:1px solid #fbbc05;color:#e37400}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;margin-bottom:16px}
.grid-item{padding:16px;background:#f8f9fa;border:2px solid #e8eaed;border-radius:10px;cursor:pointer;text-align:center;transition:all .2s} .grid-item:hover{border-color:#4285f4;transform:translateY(-2px);box-shadow:0 6px 20px rgba(66,133,244,.1)} .grid-item.selected{border-color:#4285f4;background:linear-gradient(135deg,#e8f0fe,#e6f4ea)} .grid-item.active{border-color:#34a853;background:#e6f4ea}
.grid-item .icon{font-size:28px;margin-bottom:6px} .grid-item .name{font-size:13px;font-weight:700} .grid-item .desc{font-size:11px;color:#9aa0a6;margin-top:2px}
.info-row{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #e8eaed} .info-row:last-child{border-bottom:none} .info-label{color:#5f6368;font-size:13px;font-weight:500} .info-value{font-weight:600;color:#1a1a2e;font-size:13px;word-break:break-all;text-align:right;max-width:60%}
.badge{display:inline-block;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:700} .badge-green{background:#e6f4ea;color:#1e8e3e} .badge-red{background:#fce8e6;color:#c5221f} .badge-yellow{background:#fef7e0;color:#e37400}
.log-box{background:#1a1a2e;color:#e8eaed;border-radius:8px;padding:14px;font-family:'Courier New',monospace;font-size:12px;max-height:400px;overflow-y:auto;white-space:pre-wrap;line-height:1.5}
.section{display:none} .section.active{display:block}
.pane{margin-top:16px;padding:16px;background:#f8f9fa;border:2px solid #e8eaed;border-radius:10px}
@media(max-width:640px){.container{padding:10px} .tabs{gap:4px} .tab{padding:8px 12px;font-size:12px} .card{padding:18px} .grid{grid-template-columns:repeat(auto-fill,minmax(110px,1fr))}}`;

// --- Login HTML ---
function loginPage() {
  return `<!DOCTYPE html>
<html lang="vi"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenClaw Panel</title>
<style>${CSS}</style></head><body>
<div class="container" style="max-width:440px;margin-top:10vh">
  <div class="logo"><img src="https://tino.vn/assets/logo/logo-mobile-light.png" alt="Logo"><h1>OpenClaw</h1><p>Management Panel</p></div>
  <div class="card">
    <h2>Dang nhap</h2>
    <form id="f">
      <div class="field"><label>Username</label><input type="text" id="u" value="root" autocomplete="username"></div>
      <div class="field"><label>Password</label><input type="password" id="p" placeholder="Nhap mat khau root" autocomplete="current-password" autofocus></div>
      <button type="submit" class="btn" style="width:100%" id="b">Dang nhap</button>
      <div class="status" id="e"></div>
    </form>
  </div>
</div>
<script>
document.getElementById('f').addEventListener('submit',async e=>{
  e.preventDefault();const b=document.getElementById('b'),err=document.getElementById('e');
  b.disabled=true;b.textContent='Dang xac thuc...';err.classList.remove('show');err.className='status';
  try{const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:document.getElementById('u').value,password:document.getElementById('p').value})});
  const d=await r.json();if(d.ok)window.location.href='/panel';else{err.className='status fail';err.textContent=d.error}}
  catch(x){err.className='status fail';err.textContent='Loi ket noi server'}
  b.disabled=false;b.textContent='Dang nhap'});
</script></body></html>`;
}

// --- Panel HTML ---
function panelPage() {
  return `<!DOCTYPE html>
<html lang="vi"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenClaw Panel</title>
<style>${CSS}</style></head><body>
<div class="container">
  <div class="logo"><img src="https://tino.vn/assets/logo/logo-mobile-light.png" alt="Logo"><h1>OpenClaw</h1><p>Management Panel</p></div>

  <div class="tabs">
    <div class="tab active" onclick="showTab('provider')">AI Provider</div>
    <div class="tab" onclick="showTab('channels')">Channels</div>
    <div class="tab" onclick="showTab('gateway')">Gateway</div>
    <div class="tab" onclick="showTab('domain')">Domain</div>
    <div class="tab" onclick="showTab('update')">Update</div>
    <div class="tab" onclick="showTab('status')">Status</div>
  </div>

  <!-- TAB 1: AI Provider -->
  <div class="section active" id="sec-provider"><div class="card">
    <h2>AI Provider & Model</h2>
    <p>Chon nha cung cap AI va model. Thay doi se restart OpenClaw.</p>
    <div id="currentProvider" style="margin-bottom:16px"></div>
    <div class="grid" id="providerGrid"></div>
    <div id="providerConfig" style="display:none">
      <div class="field"><label>Model</label><select id="provModel"></select></div>
      <div class="field"><label>API Key</label><input type="password" id="provKey" placeholder="Nhap API key"></div>
      <div class="btn-row">
        <button class="btn btn-outline" onclick="testProviderKey()">Kiem tra key</button>
        <button class="btn" onclick="applyProvider()">Ap dung</button>
      </div>
      <div class="status" id="provStatus"></div>
    </div>
  </div></div>

  <!-- TAB 2: Channels -->
  <div class="section" id="sec-channels"><div class="card">
    <h2>Kenh nhan tin</h2>
    <p>Cau hinh va ghep noi cac kenh nhan tin voi AI.</p>
    <div id="currentChannels" style="margin-bottom:16px"></div>
    <div class="grid" id="channelGrid"></div>
    <div id="channelConfig" style="display:none">
      <div id="channelFields"></div>
      <div class="btn-row">
        <button class="btn" onclick="saveChannel()">Luu & Restart</button>
        <button class="btn btn-outline" id="pairChannelBtn" style="display:none" onclick="showPairForm()">Ghep noi</button>
      </div>
      <div class="status" id="channelStatus"></div>
      <div id="pairForm" style="display:none;margin-top:16px">
        <div class="field"><label>Ma ghep noi (Pairing Code)</label><input type="text" id="pairCode" placeholder="Nhap ma tu bot"></div>
        <div class="btn-row"><button class="btn btn-success" onclick="pairChannel()">Ghep noi</button></div>
        <div class="status" id="pairStatus"></div>
      </div>
    </div>
  </div></div>

  <!-- TAB 3: Gateway -->
  <div class="section" id="sec-gateway"><div class="card">
    <h2>Gateway Token</h2>
    <p>Token xac thuc de truy cap dashboard va API.</p>
    <div id="gatewayInfo"></div>
    <div class="field" style="margin-top:16px"><label>Token moi (tu nhap)</label><input type="text" id="customToken" placeholder="De trong de tao tu dong"></div>
    <div class="btn-row">
      <button class="btn" onclick="generateToken()">Tao token moi</button>
      <button class="btn btn-outline" onclick="applyCustomToken()">Ap dung token tu nhap</button>
    </div>
    <div class="status" id="gatewayStatus"></div>
  </div></div>

  <!-- TAB 4: Domain -->
  <div class="section" id="sec-domain"><div class="card">
    <h2>Ten mien & SSL</h2>
    <p>Cau hinh ten mien voi chung chi Let's Encrypt hop le.</p>
    <div id="domainInfo"></div>
    <div class="field" style="margin-top:16px"><label>Ten mien</label><input type="text" id="domainInput" placeholder="bot.example.com"></div>
    <div class="field"><label>Email Let's Encrypt (tuy chon)</label><input type="email" id="domainEmail" placeholder="admin@example.com"></div>
    <div class="btn-row">
      <button class="btn" onclick="saveDomain()">Cau hinh SSL</button>
      <button class="btn btn-outline" onclick="resetDomainToIP()">Dung IP (tu ky)</button>
    </div>
    <div class="status" id="domainStatus"></div>
  </div></div>

  <!-- TAB 5: Update -->
  <div class="section" id="sec-update"><div class="card">
    <h2>Cap nhat OpenClaw</h2>
    <p>Cap nhat phien ban OpenClaw tu GitHub.</p>
    <div id="updateInfo"></div>
    <div class="btn-row" style="margin-top:16px">
      <button class="btn btn-outline" onclick="checkUpdate()">Kiem tra ban moi</button>
      <button class="btn" id="doUpdateBtn" style="display:none" onclick="doUpdate()">Cap nhat</button>
    </div>
    <div class="status" id="updateStatus"></div>
    <div id="updateLog" style="display:none;margin-top:16px"><div class="log-box" id="updateLogBox"></div></div>
  </div></div>

  <!-- TAB 6: Status -->
  <div class="section" id="sec-status"><div class="card">
    <h2>Trang thai he thong</h2>
    <div id="statusInfo"></div>
    <div class="btn-row" style="margin-top:16px">
      <button class="btn btn-outline" onclick="loadStatus()">Lam moi</button>
      <button class="btn" onclick="restartSvc('openclaw')">Restart OpenClaw</button>
      <button class="btn btn-outline" onclick="restartSvc('caddy')">Restart Caddy</button>
    </div>
    <div class="status" id="statusMsg"></div>
    <div style="margin-top:16px"><h3 style="font-size:14px;margin-bottom:8px">Log OpenClaw (50 dong gan nhat)</h3><div class="log-box" id="logsBox">Dang tai...</div></div>
  </div></div>
</div>

<script>
let selectedProvider=null,selectedChannel=null,availVersions=[];

// --- Tab navigation ---
function showTab(name){
  document.querySelectorAll('.section').forEach(s=>s.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.getElementById('sec-'+name).classList.add('active');
  document.querySelectorAll('.tab').forEach(t=>{if(t.textContent.toLowerCase().includes(name.substring(0,4)))t.classList.add('active')});
  if(name==='provider')loadProvider();
  if(name==='channels')loadChannels();
  if(name==='gateway')loadGateway();
  if(name==='domain')loadDomain();
  if(name==='update')loadUpdate();
  if(name==='status'){loadStatus();loadLogs();}
}

// --- API helper ---
async function api(path,method,body){
  const opts={method:method||'GET',headers:{'Content-Type':'application/json'}};
  if(body)opts.body=JSON.stringify(body);
  const r=await fetch(path,opts);
  return r.json();
}

// === TAB 1: Provider ===
async function loadProvider(){
  const d=await api('/api/current-config');
  const el=document.getElementById('currentProvider');
  if(d.provider){
    el.innerHTML='<div class="info-row"><span class="info-label">Provider hien tai</span><span class="info-value">'+d.providerName+'</span></div><div class="info-row"><span class="info-label">Model</span><span class="info-value">'+d.model+'</span></div>';
  } else el.innerHTML='<p style="color:#e37400">Chua cau hinh provider.</p>';
  // Render grid
  const grid=document.getElementById('providerGrid');
  grid.innerHTML='';
  const providers=${JSON.stringify(Object.entries(PROVIDERS).map(([k,v])=>({id:k,name:v.name,models:v.models})))};
  providers.forEach(p=>{
    const div=document.createElement('div');div.className='grid-item'+(d.provider===p.id?' active':'');
    div.innerHTML='<div class="name">'+p.name+'</div><div class="desc">'+p.models.length+' models</div>';
    div.onclick=()=>selectProv(p);grid.appendChild(div);
  });
}
function selectProv(p){
  selectedProvider=p.id;
  document.querySelectorAll('#providerGrid .grid-item').forEach(i=>i.classList.remove('selected'));
  event.currentTarget.classList.add('selected');
  const sel=document.getElementById('provModel');
  sel.innerHTML=p.models.map((m,i)=>'<option value="'+m.id+'">'+m.name+' — '+m.desc+'</option>').join('');
  document.getElementById('providerConfig').style.display='block';
  document.getElementById('provStatus').className='status';
}
async function testProviderKey(){
  const st=document.getElementById('provStatus');
  const key=document.getElementById('provKey').value.trim();
  if(!key){st.className='status fail';st.textContent='Nhap API key';return}
  st.className='status loading';st.textContent='Dang kiem tra...';
  const d=await api('/api/test-key','POST',{provider:selectedProvider,apiKey:key});
  st.className=d.ok?'status ok':'status fail';
  st.textContent=d.ok?'API key hop le!':d.error||'Key khong hop le';
}
async function applyProvider(){
  const st=document.getElementById('provStatus');
  const key=document.getElementById('provKey').value.trim();
  const model=document.getElementById('provModel').value;
  if(!selectedProvider){st.className='status fail';st.textContent='Chon provider truoc';return}
  if(!key){st.className='status fail';st.textContent='Nhap API key';return}
  st.className='status loading';st.textContent='Dang ap dung...';
  const d=await api('/api/provider','POST',{provider:selectedProvider,model,apiKey:key});
  st.className=d.ok?'status ok':'status fail';
  st.textContent=d.ok?'Da ap dung thanh cong! OpenClaw da restart.':d.error||'Loi';
  if(d.ok)setTimeout(loadProvider,1500);
}

// === TAB 2: Channels ===
async function loadChannels(){
  const d=await api('/api/current-config');
  const el=document.getElementById('currentChannels');
  let html='';
  if(d.channels&&d.channels.length>0){
    d.channels.forEach(c=>{html+='<div class="info-row"><span class="info-label">'+c.name+'</span><span class="info-value"><span class="badge badge-green">Active</span></span></div>'});
  } else html='<p style="color:#9aa0a6">Chua co kenh nao duoc cau hinh.</p>';
  el.innerHTML=html;
  // Render grid
  const grid=document.getElementById('channelGrid');grid.innerHTML='';
  const channels=${JSON.stringify(Object.entries(CHANNELS).map(([k,v])=>({id:k,name:v.name,icon:v.icon,desc:v.desc,envKeys:v.envKeys,canPair:v.canPair,cliOnly:v.cliOnly||false})))};
  channels.forEach(c=>{
    const isActive=d.channels&&d.channels.some(x=>x.id===c.id);
    const div=document.createElement('div');div.className='grid-item'+(isActive?' active':'');
    div.innerHTML='<div class="icon">'+c.icon+'</div><div class="name">'+c.name+'</div><div class="desc">'+c.desc.substring(0,30)+'</div>';
    div.onclick=()=>selectCh(c);grid.appendChild(div);
  });
}
function selectCh(c){
  selectedChannel=c;
  document.querySelectorAll('#channelGrid .grid-item').forEach(i=>i.classList.remove('selected'));
  event.currentTarget.classList.add('selected');
  const fields=document.getElementById('channelFields');
  const pairBtn=document.getElementById('pairChannelBtn');
  document.getElementById('pairForm').style.display='none';
  document.getElementById('channelStatus').className='status';
  if(c.cliOnly){
    fields.innerHTML='<div class="status warn" style="display:block">'+c.name+' chi ho tro qua CLI. '+c.desc+'</div>';
    pairBtn.style.display='none';
  } else {
    fields.innerHTML=c.envKeys.map(k=>'<div class="field"><label>'+k+'</label><input type="text" id="chfield-'+k+'" placeholder="Nhap '+k+'"></div>').join('');
    pairBtn.style.display=c.canPair?'inline-block':'none';
  }
  document.getElementById('channelConfig').style.display=c.cliOnly?'block':'block';
}
async function saveChannel(){
  if(!selectedChannel)return;
  const st=document.getElementById('channelStatus');
  const data={channel:selectedChannel.id,tokens:{}};
  selectedChannel.envKeys.forEach(k=>{
    const el=document.getElementById('chfield-'+k);
    if(el)data.tokens[k]=el.value.trim();
  });
  st.className='status loading';st.textContent='Dang luu...';
  const d=await api('/api/channels','POST',data);
  st.className=d.ok?'status ok':'status fail';
  st.textContent=d.ok?'Da luu! OpenClaw da restart.':d.error||'Loi';
  if(d.ok)setTimeout(loadChannels,1500);
}
function showPairForm(){document.getElementById('pairForm').style.display='block'}
async function pairChannel(){
  if(!selectedChannel||!selectedChannel.canPair)return;
  const st=document.getElementById('pairStatus');
  const code=document.getElementById('pairCode').value.trim();
  if(!code){st.className='status fail';st.textContent='Nhap ma ghep noi';return}
  st.className='status loading';st.textContent='Dang ghep noi...';
  const d=await api('/api/channel-pair','POST',{channel:selectedChannel.id,code});
  st.className=d.ok?'status ok':'status fail';
  st.textContent=d.ok?'Ghep noi thanh cong!':d.error||'Loi ghep noi';
}

// === TAB 3: Gateway ===
async function loadGateway(){
  const d=await api('/api/current-config');
  const el=document.getElementById('gatewayInfo');
  const host=d.domain||d.serverIP||'localhost';
  el.innerHTML='<div class="info-row"><span class="info-label">Gateway Token</span><span class="info-value" style="font-family:monospace;font-size:11px">'+d.token+'</span></div><div class="info-row"><span class="info-label">Dashboard URL</span><span class="info-value"><a href="https://'+host+'?token='+d.token+'" target="_blank" style="color:#4285f4">https://'+host+'?token='+d.token+'</a></span></div>';
}
async function generateToken(){
  const st=document.getElementById('gatewayStatus');
  st.className='status loading';st.textContent='Dang tao token moi...';
  const d=await api('/api/gateway-token','POST',{action:'generate'});
  st.className=d.ok?'status ok':'status fail';
  st.textContent=d.ok?'Token moi: '+d.token:d.error||'Loi';
  if(d.ok)loadGateway();
}
async function applyCustomToken(){
  const st=document.getElementById('gatewayStatus');
  const token=document.getElementById('customToken').value.trim();
  if(!token){st.className='status fail';st.textContent='Nhap token';return}
  if(token.length<16){st.className='status fail';st.textContent='Token qua ngan (toi thieu 16 ky tu)';return}
  st.className='status loading';st.textContent='Dang cap nhat...';
  const d=await api('/api/gateway-token','POST',{action:'custom',token});
  st.className=d.ok?'status ok':'status fail';
  st.textContent=d.ok?'Da cap nhat token!':d.error||'Loi';
  if(d.ok)loadGateway();
}

// === TAB 4: Domain ===
async function loadDomain(){
  const d=await api('/api/current-config');
  const el=document.getElementById('domainInfo');
  el.innerHTML='<div class="info-row"><span class="info-label">Domain/IP hien tai</span><span class="info-value">'+(d.domain||d.serverIP)+'</span></div><div class="info-row"><span class="info-label">SSL</span><span class="info-value">'+(d.domain?'Let\\'s Encrypt':'Self-signed (IP)')+'</span></div>';
}
async function saveDomain(){
  const st=document.getElementById('domainStatus');
  const domain=document.getElementById('domainInput').value.trim();
  const email=document.getElementById('domainEmail').value.trim();
  if(!domain){st.className='status fail';st.textContent='Nhap ten mien';return}
  st.className='status loading';st.textContent='Dang cau hinh Caddy + SSL...';
  const d=await api('/api/domain','POST',{domain,email});
  st.className=d.ok?'status ok':'status fail';
  st.textContent=d.ok?'Da cau hinh SSL cho '+domain+'!':d.error||'Loi';
  if(d.ok)setTimeout(loadDomain,1500);
}
async function resetDomainToIP(){
  const st=document.getElementById('domainStatus');
  st.className='status loading';st.textContent='Dang chuyen ve IP...';
  const d=await api('/api/domain','POST',{resetToIP:true});
  st.className=d.ok?'status ok':'status fail';
  st.textContent=d.ok?'Da chuyen ve IP voi self-signed cert!':d.error||'Loi';
  if(d.ok)setTimeout(loadDomain,1500);
}

// === TAB 5: Update ===
async function loadUpdate(){
  const d=await api('/api/current-config');
  const el=document.getElementById('updateInfo');
  el.innerHTML='<div class="info-row"><span class="info-label">Phien ban hien tai</span><span class="info-value">'+(d.version||'N/A')+'</span></div>';
  document.getElementById('doUpdateBtn').style.display='none';
  document.getElementById('updateLog').style.display='none';
}
async function checkUpdate(){
  const st=document.getElementById('updateStatus');
  st.className='status loading';st.textContent='Dang kiem tra...';
  const d=await api('/api/update-check');
  if(d.ok){
    availVersions=d.versions||[];
    if(availVersions.length>0){
      st.className='status ok';st.textContent='Co '+availVersions.length+' phien ban. Moi nhat: '+availVersions[0];
      document.getElementById('doUpdateBtn').style.display='inline-block';
    } else {
      st.className='status ok';st.textContent='Dang chay phien ban moi nhat!';
    }
  } else {
    st.className='status fail';st.textContent=d.error||'Loi kiem tra';
  }
}
async function doUpdate(){
  const st=document.getElementById('updateStatus');
  const version=availVersions.length>0?availVersions[0]:'latest';
  st.className='status loading';st.textContent='Dang cap nhat len '+version+'...';
  document.getElementById('updateLog').style.display='block';
  document.getElementById('updateLogBox').textContent='Bat dau cap nhat...\\n';
  const d=await api('/api/update','POST',{version});
  if(d.ok){
    st.className='status ok';st.textContent='Cap nhat thanh cong!';
    document.getElementById('updateLogBox').textContent+=d.log||'Done.';
    loadUpdate();
  } else {
    st.className='status fail';st.textContent=d.error||'Loi cap nhat';
    document.getElementById('updateLogBox').textContent+=d.log||d.error||'Error.';
  }
}

// === TAB 6: Status ===
async function loadStatus(){
  const d=await api('/api/status');
  const el=document.getElementById('statusInfo');
  if(!d.ok){el.innerHTML='<p style="color:red">Loi tai status</p>';return}
  let html='<h3 style="font-size:14px;margin-bottom:10px">Services</h3>';
  (d.services||[]).forEach(s=>{
    html+='<div class="info-row"><span class="info-label">'+s.name+'</span><span class="info-value"><span class="badge '+(s.active?'badge-green':'badge-red')+'">'+(s.active?'Running':'Stopped')+'</span></span></div>';
  });
  html+='<h3 style="font-size:14px;margin:16px 0 10px">System</h3>';
  html+='<div class="info-row"><span class="info-label">Uptime</span><span class="info-value">'+(d.uptime||'-')+'</span></div>';
  html+='<div class="info-row"><span class="info-label">RAM</span><span class="info-value">'+(d.memory||'-')+'</span></div>';
  html+='<div class="info-row"><span class="info-label">Disk</span><span class="info-value">'+(d.disk||'-')+'</span></div>';
  html+='<div class="info-row"><span class="info-label">CPU</span><span class="info-value">'+(d.cpu||'-')+'</span></div>';
  html+='<div class="info-row"><span class="info-label">Phien ban</span><span class="info-value">'+(d.version||'-')+'</span></div>';
  html+='<div class="info-row"><span class="info-label">Gateway Token</span><span class="info-value" style="font-family:monospace;font-size:10px">'+(d.token||'-')+'</span></div>';
  el.innerHTML=html;
}
async function loadLogs(){
  const d=await api('/api/logs');
  document.getElementById('logsBox').textContent=d.ok?d.logs:'Loi tai logs';
}
async function restartSvc(name){
  const st=document.getElementById('statusMsg');
  st.className='status loading';st.textContent='Dang restart '+name+'...';
  const d=await api('/api/restart','POST',{service:name});
  st.className=d.ok?'status ok':'status fail';
  st.textContent=d.ok?name+' da restart thanh cong!':d.error||'Loi restart';
  setTimeout(()=>{loadStatus();loadLogs()},2000);
}

// Init
showTab('provider');
</script></body></html>`;
}

// --- HTTP Server ---
const server = http.createServer(async (req, res) => {
  const ip = getClientIP(req);
  const url = new URL(req.url, `http://${req.headers.host}`);

  // --- Pages ---
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/login')) {
    if (isValidSession(req)) { res.writeHead(302, { Location: '/panel' }); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(loginPage());
  }
  if (req.method === 'GET' && url.pathname === '/panel') {
    if (!isValidSession(req)) { res.writeHead(302, { Location: '/' }); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(panelPage());
  }

  // --- API: Login ---
  if (req.method === 'POST' && url.pathname === '/api/login') {
    if (isBlocked(ip)) return json(res, 429, { ok: false, error: 'Qua nhieu lan thu. Doi 15 phut.' });
    try {
      const body = await parseBody(req);
      if (!body.username || !body.password) return json(res, 400, { ok: false, error: 'Thieu username hoac password' });
      if (verifyPassword(body.username, body.password)) {
        const token = createSession();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `panel_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}` });
        return res.end(JSON.stringify({ ok: true }));
      } else {
        recordFailedLogin(ip);
        const remaining = MAX_LOGIN_ATTEMPTS - (loginAttempts[ip]?.count || 0);
        return json(res, 401, { ok: false, error: `Sai mat khau. Con ${Math.max(0, remaining)} lan thu.` });
      }
    } catch { return json(res, 400, { ok: false, error: 'Request khong hop le' }); }
  }

  // --- AUTH CHECK for all /api/* below ---
  if (url.pathname.startsWith('/api/') && url.pathname !== '/api/login') {
    if (!isValidSession(req)) return json(res, 401, { ok: false, error: 'Chua dang nhap' });
  }

  // --- API: Current Config ---
  if (req.method === 'GET' && url.pathname === '/api/current-config') {
    try {
      const config = getConfig();
      const model = config?.agents?.defaults?.model?.primary || '';
      const providerKey = model.split('/')[0] || '';
      const providerInfo = Object.entries(PROVIDERS).find(([k, v]) => {
        // Match by model prefix or envKey
        if (model.startsWith(k + '/')) return true;
        if (k === 'xai' && model.startsWith('xai/')) return true;
        if (k === 'minimax' && model.startsWith('minimax/')) return true;
        if (k === 'gemini' && model.startsWith('google/')) return true;
        return false;
      });
      const provider = providerInfo ? providerInfo[0] : '';
      const providerName = providerInfo ? providerInfo[1].name : '';

      // Channels
      const activeChannels = [];
      for (const [id, ch] of Object.entries(CHANNELS)) {
        if (ch.envKeys.length === 0) continue;
        const hasAll = ch.envKeys.every(k => {
          const val = getEnvValue(k);
          return val && val !== '' && !val.startsWith('#');
        });
        if (hasAll) activeChannels.push({ id, name: ch.name });
      }

      // Domain
      let domain = '';
      try {
        const caddy = fs.readFileSync(CADDYFILE, 'utf8');
        const m = caddy.match(/^([a-z0-9][a-z0-9.-]+\.[a-z]{2,})\s*\{/m);
        if (m) domain = m[1];
      } catch {}

      const token = getEnvValue('OPENCLAW_GATEWAY_TOKEN');
      const version = getEnvValue('OPENCLAW_VERSION');
      const serverIP = getServerIP();

      return json(res, 200, { ok: true, provider, providerName, model, channels: activeChannels, domain, token, version, serverIP });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // --- API: Test Key ---
  if (req.method === 'POST' && url.pathname === '/api/test-key') {
    try {
      const body = await parseBody(req);
      const provider = PROVIDERS[body.provider];
      if (!provider) return json(res, 400, { ok: false, error: 'Provider khong hop le' });
      const ok = provider.testFn(body.apiKey);
      return json(res, 200, { ok, error: ok ? null : 'API key khong hop le' });
    } catch { return json(res, 500, { ok: false, error: 'Loi kiem tra' }); }
  }

  // --- API: Apply Provider ---
  if (req.method === 'POST' && url.pathname === '/api/provider') {
    try {
      const body = await parseBody(req);
      const prov = PROVIDERS[body.provider];
      if (!prov) return json(res, 400, { ok: false, error: 'Provider khong hop le' });

      const token = getEnvValue('OPENCLAW_GATEWAY_TOKEN');

      // 1. Set API key in env
      // Clear all other provider keys first
      for (const [, p] of Object.entries(PROVIDERS)) {
        if (p.envKey !== prov.envKey) removeEnvValue(p.envKey);
      }
      setEnvValue(prov.envKey, body.apiKey);

      // 2. Update config JSON
      let config;
      try { config = JSON.parse(fs.readFileSync(prov.configFile, 'utf8')); } catch { config = getConfig(); }
      config.gateway = config.gateway || {};
      config.gateway.auth = config.gateway.auth || {};
      config.gateway.auth.token = token;
      config.agents = config.agents || { defaults: { model: {} } };
      config.agents.defaults = config.agents.defaults || { model: {} };
      config.agents.defaults.model = config.agents.defaults.model || {};
      if (body.model) config.agents.defaults.model.primary = body.model;
      // Ensure browser config
      config.browser = config.browser || { headless: true, executablePath: '/usr/bin/google-chrome', defaultProfile: 'openclaw', noSandbox: true };
      // Ensure gateway fields
      config.gateway.mode = config.gateway.mode || 'local';
      config.gateway.bind = config.gateway.bind || 'loopback';
      config.gateway.trustedProxies = config.gateway.trustedProxies || ['127.0.0.1', '::1'];

      saveConfig(config);

      // 3. Restart
      restartService('openclaw');
      await new Promise(r => setTimeout(r, 2000));
      const running = isServiceActive('openclaw');

      return json(res, 200, { ok: running, error: running ? null : 'OpenClaw khong khoi dong duoc' });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // --- API: Channels ---
  if (req.method === 'POST' && url.pathname === '/api/channels') {
    try {
      const body = await parseBody(req);
      const ch = CHANNELS[body.channel];
      if (!ch) return json(res, 400, { ok: false, error: 'Channel khong hop le' });

      // Save env vars
      for (const [key, val] of Object.entries(body.tokens || {})) {
        if (ch.envKeys.includes(key) && val) {
          setEnvValue(key, val);
        }
      }

      // Restart
      restartService('openclaw');
      await new Promise(r => setTimeout(r, 2000));

      return json(res, 200, { ok: true });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // --- API: Channel Pair ---
  if (req.method === 'POST' && url.pathname === '/api/channel-pair') {
    try {
      const body = await parseBody(req);
      const ch = CHANNELS[body.channel];
      if (!ch || !ch.canPair) return json(res, 400, { ok: false, error: 'Channel nay khong ho tro pairing qua web' });
      const code = (body.code || '').replace(/[^a-zA-Z0-9_-]/g, '');
      if (!code) return json(res, 400, { ok: false, error: 'Thieu ma ghep noi' });
      try {
        execSync(`/opt/openclaw-cli.sh pairing approve ${ch.pairCmd} ${code}`, { timeout: 15000, stdio: 'pipe' });
        return json(res, 200, { ok: true });
      } catch (e) {
        const err = (e.stderr || e.stdout || '').toString().substring(0, 200);
        return json(res, 200, { ok: false, error: 'Loi: ' + (err || e.message) });
      }
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // --- API: Gateway Token ---
  if (req.method === 'POST' && url.pathname === '/api/gateway-token') {
    try {
      const body = await parseBody(req);
      let newToken;
      if (body.action === 'custom' && body.token) {
        newToken = body.token.replace(/[^a-zA-Z0-9_-]/g, '');
      } else {
        newToken = crypto.randomBytes(32).toString('hex');
      }

      // Update env
      setEnvValue('OPENCLAW_GATEWAY_TOKEN', newToken);

      // Update config JSON
      const config = getConfig();
      if (config.gateway && config.gateway.auth) {
        config.gateway.auth.token = newToken;
        saveConfig(config);
      }

      // Restart
      restartService('openclaw');
      await new Promise(r => setTimeout(r, 2000));

      return json(res, 200, { ok: true, token: newToken });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // --- API: Domain ---
  if (req.method === 'POST' && url.pathname === '/api/domain') {
    try {
      const body = await parseBody(req);
      const serverIP = getServerIP();

      // Reset to IP
      if (body.resetToIP) {
        const fallback = `${serverIP} {\n    tls internal\n    reverse_proxy localhost:18789\n}\n`;
        fs.writeFileSync(CADDYFILE, fallback, 'utf8');
        restartService('caddy');
        await new Promise(r => setTimeout(r, 2000));
        return json(res, 200, { ok: true });
      }

      const domain = (body.domain || '').trim().toLowerCase();
      const email = (body.email || '').trim();
      if (!domain) return json(res, 400, { ok: false, error: 'Thieu ten mien' });
      if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
        return json(res, 400, { ok: false, error: 'Ten mien khong hop le' });
      }

      // DNS check
      let resolvedIPs = [];
      try {
        const out = safeExec(`dig +short A ${domain}`, 10000);
        if (out) resolvedIPs = out.split('\n').map(i => i.trim()).filter(i => /^\d+\.\d+\.\d+\.\d+$/.test(i));
      } catch {}
      if (resolvedIPs.length === 0) {
        try {
          const out = safeExec(`host ${domain}`, 10000);
          const m = out.match(/has address (\d+\.\d+\.\d+\.\d+)/g);
          if (m) resolvedIPs = m.map(s => s.replace('has address ', ''));
        } catch {}
      }
      if (resolvedIPs.length === 0) {
        try {
          const out = safeExec(`python3 -c "import socket; print(socket.gethostbyname('${domain}'))"`, 10000);
          if (out && /^\d+\.\d+\.\d+\.\d+$/.test(out)) resolvedIPs = [out];
        } catch {}
      }

      if (resolvedIPs.length === 0) return json(res, 400, { ok: false, error: `Khong phan giai DNS cho ${domain}. Tro A record ve ${serverIP}.` });
      if (!resolvedIPs.includes(serverIP)) return json(res, 400, { ok: false, error: `DNS tro ve ${resolvedIPs.join(', ')} — khong phai ${serverIP}.` });

      // Write Caddyfile
      const emailLine = email ? `email ${email}\n` : '';
      const caddyConfig = `${emailLine}${domain} {\n    tls {\n        issuer acme {\n            dir https://acme-v02.api.letsencrypt.org/directory\n            profile shortlived\n        }\n    }\n    reverse_proxy localhost:18789\n}\n`;
      fs.writeFileSync(CADDYFILE, caddyConfig, 'utf8');

      execSync('systemctl enable caddy 2>/dev/null || true', { timeout: 10000 });
      restartService('caddy');
      await new Promise(r => setTimeout(r, 3000));

      if (isServiceActive('caddy')) {
        return json(res, 200, { ok: true, domain });
      } else {
        // Rollback
        const fallback = `${serverIP} {\n    tls internal\n    reverse_proxy localhost:18789\n}\n`;
        fs.writeFileSync(CADDYFILE, fallback, 'utf8');
        restartService('caddy');
        return json(res, 500, { ok: false, error: 'Caddy loi voi domain nay. Da rollback ve IP.' });
      }
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // --- API: Update Check ---
  if (req.method === 'GET' && url.pathname === '/api/update-check') {
    try {
      const currentVersion = getEnvValue('OPENCLAW_VERSION') || '';
      safeExec(`cd ${OPENCLAW_DIR} && git fetch --tags 2>/dev/null`, 30000);
      const tagsRaw = safeExec(`cd ${OPENCLAW_DIR} && git tag --sort=-version:refname 2>/dev/null`, 10000);
      const tags = tagsRaw.split('\n').filter(t => t.trim() && t.startsWith('v')).slice(0, 20);
      const newer = tags.filter(t => t !== currentVersion);
      return json(res, 200, { ok: true, current: currentVersion, versions: newer, allVersions: tags });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // --- API: Update ---
  if (req.method === 'POST' && url.pathname === '/api/update') {
    try {
      const body = await parseBody(req);
      const version = (body.version || 'latest').trim();
      let log = '';

      log += 'Dung OpenClaw...\n';
      safeExec('systemctl stop openclaw', 30000);

      log += 'Fetch code moi...\n';
      safeExec(`cd ${OPENCLAW_DIR} && git stash 2>/dev/null`, 15000);
      safeExec(`cd ${OPENCLAW_DIR} && git fetch --tags --all`, 30000);

      if (version === 'latest') {
        safeExec(`cd ${OPENCLAW_DIR} && git checkout main && git pull origin main`, 30000);
        log += 'Checkout main branch.\n';
      } else {
        safeExec(`cd ${OPENCLAW_DIR} && git checkout ${version.replace(/[^a-zA-Z0-9._-]/g, '')}`, 15000);
        log += `Checkout ${version}.\n`;
      }

      log += 'Build lai OpenClaw...\n';
      const buildOut = safeExec(`cd ${OPENCLAW_DIR} && su - openclaw -c "cd ${OPENCLAW_DIR} && pnpm install --frozen-lockfile 2>&1 && pnpm build 2>&1 && pnpm ui:install 2>&1 && pnpm ui:build 2>&1"`, 300000);
      log += buildOut ? (buildOut.substring(buildOut.length - 500) + '\n') : 'Build done.\n';

      // Update version in env
      if (version !== 'latest') setEnvValue('OPENCLAW_VERSION', version);

      log += 'Khoi dong lai OpenClaw...\n';
      restartService('openclaw');
      await new Promise(r => setTimeout(r, 3000));
      const running = isServiceActive('openclaw');
      log += running ? 'OpenClaw da chay!\n' : 'CANH BAO: OpenClaw khong khoi dong duoc.\n';

      return json(res, 200, { ok: running, log, error: running ? null : 'OpenClaw khong khoi dong sau update' });
    } catch (e) { return json(res, 500, { ok: false, error: e.message, log: e.message }); }
  }

  // --- API: Status ---
  if (req.method === 'GET' && url.pathname === '/api/status') {
    try {
      const services = [
        { name: 'OpenClaw Gateway', active: isServiceActive('openclaw') },
        { name: 'Caddy (Reverse Proxy)', active: isServiceActive('caddy') },
        { name: 'Management Panel', active: isServiceActive('openclaw-panel') },
        { name: 'Fail2ban', active: isServiceActive('fail2ban') }
      ];
      const uptime = safeExec('uptime -p') || '-';
      const memory = safeExec("free -h | awk '/^Mem:/{print $3\"/\"$2}'") || '-';
      const disk = safeExec("df -h / | awk 'NR==2{print $3\"/\"$2\" (\"$5\" used)\"}'") || '-';
      const cpu = safeExec("top -bn1 | grep 'Cpu(s)' | awk '{print $2\"%\"}'") || safeExec("nproc") + ' cores';
      const version = getEnvValue('OPENCLAW_VERSION') || '-';
      const token = getEnvValue('OPENCLAW_GATEWAY_TOKEN') || '-';

      return json(res, 200, { ok: true, services, uptime, memory, disk, cpu, version, token });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // --- API: Logs ---
  if (req.method === 'GET' && url.pathname === '/api/logs') {
    try {
      const logs = safeExec('journalctl -u openclaw -n 50 --no-pager 2>/dev/null', 10000) || 'Khong co log.';
      return json(res, 200, { ok: true, logs });
    } catch (e) { return json(res, 200, { ok: true, logs: 'Loi doc log: ' + e.message }); }
  }

  // --- API: Restart Service ---
  if (req.method === 'POST' && url.pathname === '/api/restart') {
    try {
      const body = await parseBody(req);
      const allowed = ['openclaw', 'caddy'];
      const svc = (body.service || '').replace(/[^a-z-]/g, '');
      if (!allowed.includes(svc)) return json(res, 400, { ok: false, error: 'Service khong hop le' });
      const ok = restartService(svc);
      await new Promise(r => setTimeout(r, 2000));
      return json(res, 200, { ok, error: ok ? null : 'Restart that bai' });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  json(res, 404, { error: 'Not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Management Panel] Dang chay tai http://0.0.0.0:${PORT}`);
});
