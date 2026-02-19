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
let finalizing = false;

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

// --- Helper exec ---
function safeExec(cmd, t) { try { return execSync(cmd, { timeout: t || 15000, stdio: 'pipe' }).toString().trim(); } catch { return ''; } }

// --- Caddy + Firewall helpers ---
function writeCaddyfile(domain, email) {
  const BIND = '127.0.0.1', GW_PORT = 18789, PANEL_PORT = 9999;
  let cfg = '';
  if (domain) {
    const el = email ? `email ${email}\n` : '';
    const tlsBlock = `    tls {\n        issuer acme {\n            dir https://acme-v02.api.letsencrypt.org/directory\n            profile shortlived\n        }\n    }`;
    cfg = `${el}${domain} {\n${tlsBlock}\n    reverse_proxy ${BIND}:${GW_PORT}\n}\n\n${domain}:9443 {\n${tlsBlock}\n    reverse_proxy ${BIND}:${PANEL_PORT}\n}\n`;
    try { execSync('ufw allow 9443/tcp comment "OpenClaw Panel HTTPS" 2>/dev/null', { stdio: 'ignore' }); } catch {}
    try { execSync('ufw delete allow 9999/tcp 2>/dev/null', { stdio: 'ignore' }); } catch {}
  } else {
    const serverIP = getServerIP();
    cfg = `${serverIP} {\n    tls internal\n    reverse_proxy ${BIND}:${GW_PORT}\n}\n`;
    try { execSync('ufw allow 9999/tcp comment "OpenClaw Panel HTTP" 2>/dev/null', { stdio: 'ignore' }); } catch {}
    try { execSync('ufw delete allow 9443/tcp 2>/dev/null', { stdio: 'ignore' }); } catch {}
  }
  fs.writeFileSync('/etc/caddy/Caddyfile', cfg, 'utf8');
}

// --- Provider configs ---
const PROVIDERS = {
  // ====== CLOUD PROVIDERS ======
  anthropic: {
    name: 'Anthropic', envKey: 'ANTHROPIC_API_KEY', configFile: '/etc/config/anthropic.json',
    color: '#d97706', icon: '&#x2728;', category: 'cloud',
    models: [
      { id: 'anthropic/claude-opus-4-6', name: 'Claude Opus 4.6', desc: 'Flagship — smartest' },
      { id: 'anthropic/claude-opus-4-5', name: 'Claude Opus 4.5', desc: 'Powerful — deep thinking' },
      { id: 'anthropic/claude-sonnet-4-20250514', name: 'Claude Sonnet 4', desc: 'Balanced — fast' },
      { id: 'anthropic/claude-haiku-3-5-20241022', name: 'Claude Haiku 3.5', desc: 'Fastest — low cost' }
    ],
    testFn: (k) => { try { return safeExec(`curl -s -o /dev/null -w '%{http_code}' -X POST https://api.anthropic.com/v1/messages -H 'x-api-key: ${k.replace(/'/g,"'\\''")}' -H 'anthropic-version: 2023-06-01' -H 'content-type: application/json' -d '{"model":"claude-sonnet-4-20250514","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}'`, 15000) === '200'; } catch { return false; } }
  },
  openai: {
    name: 'OpenAI', envKey: 'OPENAI_API_KEY', configFile: '/etc/config/openai.json',
    color: '#10a37f', icon: '&#x1f9e0;', category: 'cloud',
    models: [
      { id: 'openai/gpt-5.1-codex', name: 'GPT-5.1 Codex', desc: 'Latest — code + reasoning' },
      { id: 'openai/gpt-5.2', name: 'GPT-5.2', desc: 'Powerful — general purpose' },
      { id: 'openai/o3', name: 'o3', desc: 'Reasoning — logic & math' },
      { id: 'openai/gpt-4.1', name: 'GPT-4.1', desc: 'Balanced — fast' },
      { id: 'openai/gpt-4.1-mini', name: 'GPT-4.1 Mini', desc: 'Lightweight — low cost' }
    ],
    testFn: (k) => { try { return safeExec(`curl -s -o /dev/null -w '%{http_code}' https://api.openai.com/v1/models -H 'Authorization: Bearer ${k.replace(/'/g,"'\\''")}' `, 15000) === '200'; } catch { return false; } }
  },
  gemini: {
    name: 'Google Gemini', envKey: 'GOOGLE_API_KEY', configFile: '/etc/config/gemini.json',
    color: '#4285f4', icon: '&#x1f48e;', category: 'cloud',
    models: [
      { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro', desc: 'Flagship — reasoning & coding' },
      { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash', desc: 'Balanced — fast thinking' },
      { id: 'google/gemini-2.0-flash', name: 'Gemini 2.0 Flash', desc: 'Speed — low latency' },
      { id: 'google/gemini-2.0-flash-lite', name: 'Gemini 2.0 Flash Lite', desc: 'Lightweight — cost efficient' }
    ],
    testFn: (k) => { try { return safeExec(`curl -s -o /dev/null -w '%{http_code}' "https://generativelanguage.googleapis.com/v1beta/models?key=${k.replace(/'/g,"'\\''")}"`  , 15000) === '200'; } catch { return false; } }
  },
  xai: {
    name: 'xAI (Grok)', envKey: 'XAI_API_KEY', configFile: '/etc/config/openai.json',
    color: '#1d1d1f', icon: '&#x1f680;', category: 'cloud',
    models: [
      { id: 'xai/grok-4-1-fast-reasoning', name: 'Grok 4.1 Fast', desc: 'Reasoning — 2M context' },
      { id: 'xai/grok-4-1-fast-non-reasoning', name: 'Grok 4.1 Instant', desc: 'Non-reasoning — 2M context' },
      { id: 'xai/grok-4-0709', name: 'Grok 4', desc: 'Flagship — strongest reasoning' },
      { id: 'xai/grok-3', name: 'Grok 3', desc: 'Stable — 131K context' },
      { id: 'xai/grok-3-mini', name: 'Grok 3 Mini', desc: 'Light reasoning — low cost' },
      { id: 'xai/grok-code-fast-1', name: 'Grok Code', desc: 'Code optimized — 256K context' }
    ],
    testFn: (k) => { try { return safeExec(`curl -s -o /dev/null -w '%{http_code}' https://api.x.ai/v1/models -H 'Authorization: Bearer ${k.replace(/'/g,"'\\''")}' `, 15000) === '200'; } catch { return false; } }
  },
  minimax: {
    name: 'MiniMax', envKey: 'MINIMAX_API_KEY', configFile: '/etc/config/openai.json',
    color: '#6366f1', icon: '&#x26a1;', category: 'cloud',
    models: [
      { id: 'minimax/MiniMax-M2.5', name: 'MiniMax M2.5', desc: 'Latest — most capable' },
      { id: 'minimax/MiniMax-M2.1', name: 'MiniMax M2.1', desc: 'Balanced — reliable' },
      { id: 'minimax/MiniMax-M2.1-lightning', name: 'M2.1 Lightning', desc: 'Fast — low latency' },
      { id: 'minimax/MiniMax-M2', name: 'MiniMax M2', desc: 'Base — cost efficient' }
    ],
    testFn: (k) => { try { return safeExec(`curl -s -o /dev/null -w '%{http_code}' https://api.minimax.io/v1/models -H 'Authorization: Bearer ${k.replace(/'/g,"'\\''")}' `, 15000) === '200'; } catch { return false; } }
  },
  moonshot: {
    name: 'Moonshot AI', envKey: 'MOONSHOT_API_KEY', configFile: '/etc/config/openai.json',
    color: '#7c3aed', icon: '&#x1f319;', category: 'cloud',
    models: [
      { id: 'moonshot/kimi-k2.5', name: 'Kimi K2.5', desc: 'Latest — most powerful' },
      { id: 'moonshot/kimi-k2-thinking', name: 'Kimi K2 Thinking', desc: 'Reasoning — deep thinking' },
      { id: 'moonshot/kimi-k2-thinking-turbo', name: 'K2 Thinking Turbo', desc: 'Fast reasoning' },
      { id: 'moonshot/kimi-k2-0905-preview', name: 'Kimi K2 Preview', desc: 'Balanced — stable' },
      { id: 'moonshot/kimi-k2-turbo-preview', name: 'K2 Turbo Preview', desc: 'Fast — low latency' }
    ],
    testFn: (k) => { try { return safeExec(`curl -s -o /dev/null -w '%{http_code}' https://api.moonshot.ai/v1/models -H 'Authorization: Bearer ${k.replace(/'/g,"'\\''")}' `, 15000) === '200'; } catch { return false; } }
  },
  zai: {
    name: 'Z.AI (GLM)', envKey: 'ZAI_API_KEY', configFile: '/etc/config/openai.json',
    color: '#0ea5e9', icon: '&#x1f916;', category: 'cloud',
    models: [
      { id: 'zai/glm-5', name: 'GLM-5', desc: 'Latest — most powerful' },
      { id: 'zai/glm-4.7', name: 'GLM-4.7', desc: 'Balanced — reliable' },
      { id: 'zai/glm-4.6', name: 'GLM-4.6', desc: 'Stable — cost efficient' }
    ],
    testFn: (k) => { try { return safeExec(`curl -s -o /dev/null -w '%{http_code}' https://api.z.ai/v1/models -H 'Authorization: Bearer ${k.replace(/'/g,"'\\''")}' `, 15000) === '200'; } catch { return false; } }
  },
  venice: {
    name: 'Venice AI', envKey: 'VENICE_API_KEY', configFile: '/etc/config/openai.json',
    color: '#f43f5e', icon: '&#x1f3ad;', category: 'cloud',
    models: [
      { id: 'venice/deepseek-v3.2', name: 'DeepSeek V3.2', desc: 'Powerful — open source' },
      { id: 'venice/qwen3-235b-a22b-thinking-2507', name: 'Qwen3 235B Thinking', desc: 'Reasoning — large' },
      { id: 'venice/llama-3.3-70b', name: 'Llama 3.3 70B', desc: 'Meta — balanced' },
      { id: 'venice/venice-uncensored', name: 'Venice Uncensored', desc: 'Uncensored — private' }
    ],
    testFn: (k) => { try { return safeExec(`curl -s -o /dev/null -w '%{http_code}' https://api.venice.ai/api/v1/models -H 'Authorization: Bearer ${k.replace(/'/g,"'\\''")}' `, 15000) === '200'; } catch { return false; } }
  },
  xiaomi: {
    name: 'Xiaomi MiMo', envKey: 'XIAOMI_API_KEY', configFile: '/etc/config/openai.json',
    color: '#ff6900', icon: '&#x1f4f1;', category: 'cloud',
    models: [
      { id: 'xiaomi/mimo-v2-flash', name: 'MiMo V2 Flash', desc: '262K context — fast' }
    ],
    testFn: (k) => { try { return safeExec(`curl -s -o /dev/null -w '%{http_code}' https://api.xiaomimimo.com/anthropic/v1/models -H 'Authorization: Bearer ${k.replace(/'/g,"'\\''")}' `, 15000) === '200'; } catch { return false; } }
  },
  nvidia: {
    name: 'NVIDIA', envKey: 'NVIDIA_API_KEY', configFile: '/etc/config/openai.json',
    color: '#76b900', icon: '&#x1f7e2;', category: 'cloud',
    models: [
      { id: 'nvidia/nvidia/llama-3.1-nemotron-70b-instruct', name: 'Nemotron 70B', desc: 'Instruct — 131K context' },
      { id: 'nvidia/meta/llama-3.3-70b-instruct', name: 'Llama 3.3 70B', desc: 'Meta — balanced' }
    ],
    testFn: (k) => { try { return safeExec(`curl -s -o /dev/null -w '%{http_code}' https://integrate.api.nvidia.com/v1/models -H 'Authorization: Bearer ${k.replace(/'/g,"'\\''")}' `, 15000) === '200'; } catch { return false; } }
  },
  synthetic: {
    name: 'Synthetic', envKey: 'SYNTHETIC_API_KEY', configFile: '/etc/config/openai.json',
    color: '#a855f7', icon: '&#x1f9ec;', category: 'cloud',
    models: [
      { id: 'synthetic/hf:MiniMaxAI/MiniMax-M2.1', name: 'MiniMax M2.1', desc: 'Via Synthetic' },
      { id: 'synthetic/hf:deepseek-ai/DeepSeek-V3.2', name: 'DeepSeek V3.2', desc: 'Open source via Synthetic' },
      { id: 'synthetic/hf:openai/gpt-oss-120b', name: 'GPT-OSS 120B', desc: 'Open source GPT' }
    ],
    testFn: (k) => { try { return safeExec(`curl -s -o /dev/null -w '%{http_code}' https://api.synthetic.new/anthropic/v1/models -H 'Authorization: Bearer ${k.replace(/'/g,"'\\''")}' `, 15000) === '200'; } catch { return false; } }
  },
  huggingface: {
    name: 'Hugging Face', envKey: 'HF_TOKEN', configFile: '/etc/config/openai.json',
    color: '#ff9d00', icon: '&#x1f917;', category: 'cloud',
    models: [
      { id: 'huggingface/deepseek-ai/DeepSeek-R1', name: 'DeepSeek R1', desc: 'Reasoning — open source' },
      { id: 'huggingface/deepseek-ai/DeepSeek-V3.2', name: 'DeepSeek V3.2', desc: 'Powerful — open source' },
      { id: 'huggingface/meta-llama/Llama-3.3-70B-Instruct', name: 'Llama 3.3 70B', desc: 'Meta — balanced' },
      { id: 'huggingface/openai/gpt-oss-120b', name: 'GPT-OSS 120B', desc: 'Open source GPT' }
    ],
    testFn: (k) => { try { return safeExec(`curl -s -o /dev/null -w '%{http_code}' https://router.huggingface.co/v1/models -H 'Authorization: Bearer ${k.replace(/'/g,"'\\''")}' `, 15000) === '200'; } catch { return false; } }
  },
  together: {
    name: 'Together AI', envKey: 'TOGETHER_API_KEY', configFile: '/etc/config/openai.json',
    color: '#0066ff', icon: '&#x1f91d;', category: 'cloud',
    models: [
      { id: 'together/moonshotai/Kimi-K2.5', name: 'Kimi K2.5', desc: 'Latest Moonshot via Together' },
      { id: 'together/meta-llama/Llama-3.3-70B-Instruct-Turbo', name: 'Llama 3.3 70B Turbo', desc: 'Meta — fast' },
      { id: 'together/deepseek/DeepSeek-V3.1', name: 'DeepSeek V3.1', desc: 'Open source — powerful' },
      { id: 'together/deepseek/DeepSeek-R1', name: 'DeepSeek R1', desc: 'Reasoning — open source' }
    ],
    testFn: (k) => { try { return safeExec(`curl -s -o /dev/null -w '%{http_code}' https://api.together.xyz/v1/models -H 'Authorization: Bearer ${k.replace(/'/g,"'\\''")}' `, 15000) === '200'; } catch { return false; } }
  },
  // ====== GATEWAY / PROXY ======
  openrouter: {
    name: 'OpenRouter', envKey: 'OPENROUTER_API_KEY', configFile: '/etc/config/openai.json',
    color: '#6d28d9', icon: '&#x1f500;', category: 'gateway',
    models: [
      { id: 'openrouter/anthropic/claude-opus-4', name: 'Claude Opus 4', desc: 'Anthropic via OpenRouter' },
      { id: 'openrouter/openai/gpt-5.2', name: 'GPT-5.2', desc: 'OpenAI via OpenRouter' },
      { id: 'openrouter/google/gemini-2.5-pro', name: 'Gemini 2.5 Pro', desc: 'Google via OpenRouter' },
      { id: 'openrouter/deepseek/deepseek-r1', name: 'DeepSeek R1', desc: 'Reasoning via OpenRouter' }
    ],
    testFn: (k) => { try { return safeExec(`curl -s -o /dev/null -w '%{http_code}' https://openrouter.ai/api/v1/models -H 'Authorization: Bearer ${k.replace(/'/g,"'\\''")}' `, 15000) === '200'; } catch { return false; } }
  }
};

// --- Channel configs (giong panel.js) ---
const CHANNELS = {
  telegram: { name: 'Telegram', icon: '&#x1f4e8;', envKeys: ['TELEGRAM_BOT_TOKEN'], pairCmd: 'telegram', desc: 'Tao bot tai @BotFather', canPair: true },
  discord: { name: 'Discord', icon: '&#x1f3ae;', envKeys: ['DISCORD_BOT_TOKEN'], pairCmd: 'discord', desc: 'Tao bot tai discord.com/developers', canPair: true },
  slack: { name: 'Slack', icon: '&#x1f4bc;', envKeys: ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'], pairCmd: null, desc: 'Tao app tai api.slack.com/apps', canPair: false },
  line: { name: 'LINE', icon: '&#x1f7e2;', envKeys: ['LINE_CHANNEL_ACCESS_TOKEN', 'LINE_CHANNEL_SECRET'], pairCmd: null, desc: 'Plugin — tao bot tai developers.line.biz', canPair: false },
  matrix: { name: 'Matrix', icon: '&#x1f310;', envKeys: ['MATRIX_HOMESERVER', 'MATRIX_ACCESS_TOKEN'], pairCmd: null, desc: 'Plugin — cau hinh homeserver + token', canPair: false }
};

// --- Self-destruct ---
function selfDestruct() {
  console.log('[Setup UI] Setup hoan tat. Chuyen giao sang Management Panel...');
  try {
    const { spawn } = require('child_process');

    // 1. Enable Panel service (de sau nay reboot tu start)
    execSync('systemctl enable openclaw-panel 2>/dev/null || true');

    // 2. Disable Setup UI service (khong auto-restart khi exit)
    execSync('systemctl disable openclaw-setup 2>/dev/null || true');

    // 3. DONG SERVER TRUOC — giai phong port 9999 ngay lap tuc
    console.log('[Setup UI] Dong server de giai phong port 9999...');
    try { server.close(); } catch {}

    // 4. Doi port thuc su free, roi start Panel TRUC TIEP (khong can handoff script)
    setTimeout(() => {
      try {
        console.log('[Setup UI] Starting Management Panel...');
        execSync('systemctl start openclaw-panel', { timeout: 10000, stdio: 'ignore' });

        // Verify
        try { execSync('systemctl is-active --quiet openclaw-panel'); console.log('[Setup UI] Panel OK!'); }
        catch { try { execSync('systemctl restart openclaw-panel', { timeout: 10000, stdio: 'ignore' }); } catch {} }

        // Cleanup bang systemd-run — tach hoan toan, chay doc lap, khong bi kill khi process exit
        try {
          execSync('systemd-run --no-block --unit=openclaw-cleanup /bin/bash -c "sleep 2; systemctl stop openclaw-setup 2>/dev/null; rm -rf /opt/openclaw-setup 2>/dev/null; rm -f /etc/systemd/system/openclaw-setup.service 2>/dev/null; systemctl daemon-reload 2>/dev/null" 2>/dev/null', { stdio: 'ignore' });
        } catch {}
      } catch (e) { console.error('[Setup UI] Loi start Panel:', e.message); }

      process.exit(0);
    }, 500);
  } catch (e) {
    console.error('[Setup UI] Loi selfDestruct:', e.message);
    // Fallback: dong server + exit de khong block
    try { server.close(); } catch {}
    setTimeout(() => process.exit(1), 500);
  }
}

// --- HTML: Login ---
function loginPage() {
  return `<!DOCTYPE html>
<html lang="vi"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenClaw Setup</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',Roboto,-apple-system,BlinkMacSystemFont,sans-serif;background:linear-gradient(135deg,#f0f4ff 0%,#e8f5e9 50%,#f3e5f5 100%);color:#1a1a2e;min-height:100vh;display:flex;align-items:center;justify-content:center}
.container{width:100%;max-width:440px;padding:20px}
.logo{text-align:center;margin-bottom:36px} .logo img{height:48px;margin-bottom:12px} .logo h1{font-size:32px;background:linear-gradient(135deg,#4285f4,#34a853);-webkit-background-clip:text;-webkit-text-fill-color:transparent;font-weight:800;margin-top:4px} .logo p{color:#5f6368;margin-top:8px;font-size:14px}
.card{background:linear-gradient(135deg,#ffffff 0%,#f9fafb 100%);border-radius:16px;padding:36px;box-shadow:0 10px 40px rgba(0,0,0,.08);border:1px solid rgba(0,0,0,.06);position:relative;overflow:hidden} .card::before{content:'';position:absolute;top:0;left:0;right:0;height:4px;background:linear-gradient(90deg,#4285f4,#34a853,#fbbc05,#ea4335)} .card h2{font-size:20px;margin-bottom:24px;color:#1a1a2e;font-weight:700}
.field{margin-bottom:20px} .field label{display:block;font-size:13px;color:#5f6368;margin-bottom:8px;font-weight:600;text-transform:uppercase;letter-spacing:.5px}
.field input{width:100%;padding:12px 16px;background:#f8f9fa;border:2px solid #e8eaed;border-radius:10px;color:#1a1a2e;font-size:15px;outline:none;transition:all .3s ease} .field input:focus{border-color:#4285f4;background:#fff;box-shadow:0 0 0 4px rgba(66,133,244,.1)}
.btn{width:100%;padding:14px;background:linear-gradient(135deg,#4285f4,#34a853);color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;transition:all .3s ease;box-shadow:0 4px 15px rgba(66,133,244,.3)} .btn:hover{transform:translateY(-2px);box-shadow:0 8px 25px rgba(66,133,244,.4)} .btn:disabled{opacity:.5;cursor:not-allowed;transform:none;box-shadow:none}
.error{color:#ea4335;font-size:13px;margin-top:14px;display:none;padding:10px 14px;background:#fce8e6;border-radius:8px;border:1px solid #f5c6cb} .error.show{display:block}
</style></head><body>
<div class="container">
  <div class="logo"><img src="https://tino.vn/assets/logo/logo-mobile-light.png" alt="Logo"><h1>OpenClaw</h1><p>Dang nhap de cau hinh server</p></div>
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
body{font-family:'Segoe UI',Roboto,-apple-system,BlinkMacSystemFont,sans-serif;background:linear-gradient(135deg,#f0f4ff 0%,#e8f5e9 50%,#f3e5f5 100%);color:#1a1a2e;min-height:100vh;padding:40px 20px}
.container{max-width:640px;margin:0 auto}
.logo{text-align:center;margin-bottom:12px} .logo img{height:48px;margin-bottom:8px} .logo h1{font-size:32px;background:linear-gradient(135deg,#4285f4,#34a853);-webkit-background-clip:text;-webkit-text-fill-color:transparent;font-weight:800;margin-top:4px}
.steps-bar{display:flex;justify-content:center;gap:8px;margin-bottom:32px;flex-wrap:wrap}
.step-dot{width:36px;height:36px;border-radius:50%;background:#e8eaed;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:#9aa0a6;transition:all .3s ease;border:2px solid transparent}
.step-dot.active{background:linear-gradient(135deg,#4285f4,#34a853);color:#fff;box-shadow:0 4px 15px rgba(66,133,244,.3)}
.step-dot.done{background:#34a853;color:#fff}
.card{background:linear-gradient(135deg,#ffffff 0%,#f9fafb 100%);border-radius:16px;padding:36px;box-shadow:0 10px 40px rgba(0,0,0,.08);margin-bottom:24px;border:1px solid rgba(0,0,0,.06);position:relative;overflow:hidden} .card::before{content:'';position:absolute;top:0;left:0;right:0;height:4px;background:linear-gradient(90deg,#4285f4,#34a853,#fbbc05,#ea4335)}
.card h2{font-size:20px;margin-bottom:8px;color:#1a1a2e;font-weight:700} .card p{color:#5f6368;font-size:14px;margin-bottom:20px;line-height:1.6}
.step{display:none} .step.active{display:block}
.providers{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;max-height:420px;overflow-y:auto;padding-right:4px}
.providers::-webkit-scrollbar{width:5px} .providers::-webkit-scrollbar-track{background:#f1f1f1;border-radius:4px} .providers::-webkit-scrollbar-thumb{background:#c1c1c1;border-radius:4px}
.provider{padding:14px 12px;background:#f8f9fa;border:2px solid #e8eaed;border-radius:12px;cursor:pointer;text-align:center;transition:all .3s ease}
.provider:hover{border-color:#4285f4;transform:translateY(-2px);box-shadow:0 8px 25px rgba(66,133,244,.12)} .provider.selected{border-color:#4285f4;background:linear-gradient(135deg,#e8f0fe,#e6f4ea);box-shadow:0 4px 20px rgba(66,133,244,.15)}
.provider .icon{font-size:28px;margin-bottom:6px} .provider .name{font-size:13px;font-weight:700;color:#1a1a2e}
.field{margin-bottom:18px} .field label{display:block;font-size:13px;color:#5f6368;margin-bottom:8px;font-weight:600;text-transform:uppercase;letter-spacing:.5px}
.field input{width:100%;padding:12px 16px;background:#f8f9fa;border:2px solid #e8eaed;border-radius:10px;color:#1a1a2e;font-size:15px;outline:none;transition:all .3s ease} .field input:focus{border-color:#4285f4;background:#fff;box-shadow:0 0 0 4px rgba(66,133,244,.1)}
.btn{padding:12px 28px;background:linear-gradient(135deg,#4285f4,#34a853);color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;transition:all .3s ease;box-shadow:0 4px 15px rgba(66,133,244,.3)} .btn:hover{transform:translateY(-2px);box-shadow:0 8px 25px rgba(66,133,244,.4)} .btn:disabled{opacity:.5;cursor:not-allowed;transform:none;box-shadow:none}
.btn-outline{background:#fff;border:2px solid #e8eaed;color:#5f6368;box-shadow:none} .btn-outline:hover{border-color:#4285f4;color:#4285f4;background:#f8f9fa;transform:translateY(-1px);box-shadow:0 4px 12px rgba(0,0,0,.06)}
.btn-success{background:linear-gradient(135deg,#34a853,#1e8e3e)} .btn-success:hover{box-shadow:0 8px 25px rgba(52,168,83,.4)}
.btn-row{display:flex;gap:12px;justify-content:flex-end;margin-top:24px}
.status{padding:14px 18px;border-radius:10px;font-size:14px;margin-top:16px;display:none;font-weight:500}
.status.ok{display:block;background:#e6f4ea;border:1px solid #34a853;color:#1e8e3e}
.status.fail{display:block;background:#fce8e6;border:1px solid #ea4335;color:#c5221f}
.status.loading{display:block;background:#e8f0fe;border:1px solid #4285f4;color:#1967d2}
.done-box{text-align:center;padding:40px} .done-box .check{font-size:64px;margin-bottom:16px}
.done-box h2{font-size:24px;color:#34a853;margin-bottom:12px;font-weight:800} .done-box p{color:#5f6368;margin-bottom:8px;font-size:14px}
.done-box a{color:#4285f4;text-decoration:none;font-weight:700;font-size:16px;padding:10px 24px;background:linear-gradient(135deg,#e8f0fe,#e6f4ea);border-radius:10px;display:inline-block;transition:all .3s ease} .done-box a:hover{transform:translateY(-2px);box-shadow:0 4px 15px rgba(66,133,244,.2)}
.done-box .url-box,.url-box{background:#f8f9fa;border:2px solid #e8eaed;border-radius:10px;padding:14px 18px;margin:16px 0;word-break:break-all;font-family:'Courier New',monospace;font-size:14px;color:#4285f4;font-weight:600}
</style></head><body>
<div class="container">
  <div class="logo"><img src="https://tino.vn/assets/logo/logo-mobile-light.png" alt="Logo"><h1>OpenClaw Setup</h1></div>
  <div class="steps-bar" id="stepsBar">
    <div class="step-dot active" data-step="1">1</div>
    <div class="step-dot" data-step="2">2</div>
    <div class="step-dot" data-step="3">3</div>
    <div class="step-dot" data-step="4">4</div>
    <div class="step-dot" data-step="5">5</div>
    <div class="step-dot" data-step="6">6</div>
    <div class="step-dot" data-step="7">7</div>
  </div>

  <!-- Step 1: Domain -->
  <div class="step active" id="step1"><div class="card">
    <h2>Buoc 1: Ten mien &amp; SSL (tuy chon)</h2>
    <p>Nhap ten mien de su dung HTTPS voi chung chi Let's Encrypt hop le. Neu chua co ten mien, bam Bo qua — se dung self-signed cert voi IP.</p>
    <div class="field">
      <label>&#x1f310; Ten mien (domain)</label>
      <input type="text" id="domainInput" placeholder="bot.example.com">
      <p style="font-size:12px;color:#9aa0a6;margin-top:4px">Tro DNS (A record) cua ten mien ve IP server nay truoc khi tiep tuc</p>
    </div>
    <div class="field">
      <label>&#x1f4e7; Email Let's Encrypt (tuy chon)</label>
      <input type="email" id="domainEmail" placeholder="admin@example.com">
      <p style="font-size:12px;color:#9aa0a6;margin-top:4px">Nhan thong bao khi cert sap het han</p>
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
    <div id="providerGrid" class="providers" style="grid-template-columns:1fr 1fr 1fr">
    </div>
    <div id="modelSection" style="display:none;margin-top:20px">
      <div class="field">
        <label>&#x1f916; Chon model</label>
        <select id="modelSelect" style="width:100%;padding:12px 16px;background:#f8f9fa;border:2px solid #e8eaed;border-radius:10px;color:#1a1a2e;font-size:15px;outline:none;cursor:pointer;transition:all .3s ease">
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
    <div style="background:#f8f9fa;border-radius:12px;padding:20px;margin-bottom:16px;border:2px solid #e8eaed">
      <div style="display:flex;justify-content:space-between;margin-bottom:12px"><span style="color:#5f6368;font-weight:500">Nha cung cap:</span><span id="confirmProvider" style="font-weight:700;color:#1a1a2e"></span></div>
      <div style="display:flex;justify-content:space-between;margin-bottom:12px"><span style="color:#5f6368;font-weight:500">Model:</span><span id="confirmModel" style="font-weight:700;color:#4285f4"></span></div>
      <div style="display:flex;justify-content:space-between"><span style="color:#5f6368;font-weight:500">API Key:</span><span id="confirmKey" style="font-family:'Courier New',monospace;color:#1a1a2e"></span></div>
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
    <p>Chon kenh nhan tin de ket noi voi AI. Co the bo qua va cau hinh sau.</p>
    <div class="providers" id="channelCards" style="grid-template-columns:1fr 1fr;max-height:none"></div>
    <div id="channelTokenSection" style="display:none;margin-top:20px"></div>
    <div class="status" id="channelStatus"></div>
    <div class="btn-row" id="channelBtnRow">
      <button class="btn btn-outline" onclick="goStep(6)">Bo qua</button>
      <button class="btn" id="channelBtn" style="display:none" onclick="saveChannels()">Luu kenh nhan tin</button>
    </div>
    <div id="channelPairSection" style="display:none;margin-top:24px;border-top:2px solid #e8eaed;padding-top:20px">
      <h3 style="font-size:16px;color:#1a1a2e;margin-bottom:8px;font-weight:700">&#x1f517; Ghep noi <span id="pairChannelName"></span></h3>
      <p style="color:#5f6368;font-size:13px;margin-bottom:16px;line-height:1.6">Mo <span id="pairChannelName2"></span>, gui tin nhan bat ky toi bot. Bot se tra ve <strong style="color:#4285f4">ma ghep noi (pairing code)</strong>. Nhap ma do vao ben duoi de ket noi.</p>
      <div class="field"><label>Ma ghep noi (Pairing Code)</label><input type="text" id="pairCode" placeholder="Nhap ma ghep noi tu bot"></div>
      <div class="status" id="pairCodeStatus"></div>
      <div class="btn-row">
        <button class="btn btn-outline" onclick="skipChannelPair()">Bo qua</button>
        <button class="btn btn-success" id="pairCodeBtn" onclick="approveChannelPair()">Ghep noi</button>
      </div>
    </div>
  </div></div>

  <!-- Step 6: Pairing -->
  <div class="step" id="step6"><div class="card">
    <h2>Buoc 6: Ghep noi Dashboard</h2>
    <p>Mo link dashboard ben duoi trong <strong>tab moi</strong>, doi trang tai xong (se thay loi ghep noi - dieu nay binh thuong), roi quay lai day bam nut ghep noi.</p>
    <div class="url-box" id="pairingUrl" style="cursor:pointer" onclick="window.open(this.textContent,'_blank')"></div>
    <p style="font-size:13px;color:#5f6368;margin-bottom:16px">&#x261d; Bam vao link tren de mo trong tab moi</p>
    <div class="btn-row">
      <button class="btn btn-outline" onclick="skipPairing()">Bo qua (ghep sau)</button>
      <button class="btn" id="pairBtn" onclick="doPairing()">Da mo Dashboard - Ghep noi ngay</button>
    </div>
    <div class="status" id="pairStatus"></div>
  </div></div>

  <!-- Step 7: Done -->
  <div class="step" id="step7"><div class="card"><div class="done-box">
    <div class="check">&#x2705;</div>
    <h2>OpenClaw da san sang!</h2>
    <p>Server cua ban da duoc cau hinh thanh cong.</p>
    <p>Truy cap dashboard tai:</p>
    <div class="url-box" id="dashboardUrl"></div>
    <a id="dashboardLink" href="#">Mo Dashboard &#x2192;</a>
    <div style="margin-top:24px;padding:16px;background:#e8f0fe;border-radius:10px;border:1px solid #a4c2f4">
      <p style="color:#1967d2;font-size:13px;font-weight:600;margin-bottom:8px">&#x1f504; Dang chuyen sang Management Panel...</p>
      <p style="color:#5f6368;font-size:12px;margin:0">Setup UI se tu dong dong va chuyen sang <strong>Management Panel</strong> (cung port 9999). Trang se tu reload sau <span id="countdown">15</span> giay.</p>
    </div>
  </div></div></div>
</div>

<script>
let selectedProvider=null,selectedModel='',keyVerified=false,configuredDomain='';
const providerData=${JSON.stringify(Object.entries(PROVIDERS).map(([k,v])=>({id:k,name:v.name,icon:v.icon,color:v.color,category:v.category||'cloud',models:v.models})))};
const channelData=${JSON.stringify(Object.entries(CHANNELS).map(([k,v])=>({id:k,name:v.name,icon:v.icon,desc:v.desc,envKeys:v.envKeys,canPair:v.canPair})))};

// Build provider grid dynamically
(function(){
  const grid=document.getElementById('providerGrid');
  const cats={cloud:{label:'Cloud Providers',items:[]},gateway:{label:'Gateway / Proxy',items:[]}};
  providerData.forEach(p=>{(cats[p.category]||cats.cloud).items.push(p)});
  Object.values(cats).forEach(cat=>{
    if(!cat.items.length)return;
    const hdr=document.createElement('div');hdr.style.cssText='grid-column:1/-1;font-size:11px;font-weight:800;color:#9aa0a6;padding:8px 0 2px;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #e8eaed;margin-bottom:4px';hdr.textContent=cat.label;grid.appendChild(hdr);
    cat.items.forEach(p=>{
      const div=document.createElement('div');div.className='provider';div.dataset.provider=p.id;div.onclick=function(){selectProvider(this)};
      div.innerHTML='<div class="icon" style="color:'+p.color+'">'+p.icon+'</div><div class="name">'+p.name+'</div><div style="color:#9aa0a6;font-size:12px;margin-top:4px">'+p.models.length+' model'+(p.models.length>1?'s':'')+'</div>';
      grid.appendChild(div);
    });
  });
})();

function selectProvider(el){
  document.querySelectorAll('.provider').forEach(p=>p.classList.remove('selected'));
  el.classList.add('selected');selectedProvider=el.dataset.provider;
  const prov=providerData.find(p=>p.id===selectedProvider);
  if(!prov)return;
  // Render model list
  const sel=document.getElementById('modelSelect');
  sel.innerHTML=prov.models.map((m,i)=>'<option value="'+m.id+'"'+(i===0?' selected':'')+'>'+m.name+' \\u2014 '+m.desc+'</option>').join('');
  selectedModel=prov.models[0].id;
  sel.onchange=function(){selectedModel=this.value};
  document.getElementById('modelSection').style.display='block';
  document.getElementById('nextStep2').disabled=false;
}
function goStep(n){
  document.querySelectorAll('.step').forEach(s=>s.classList.remove('active'));
  document.getElementById('step'+n).classList.add('active');
  // Cap nhat step dots
  document.querySelectorAll('.step-dot').forEach(d=>{
    const s=parseInt(d.dataset.step);
    d.classList.remove('active','done');
    if(s<n)d.classList.add('done');
    if(s===n)d.classList.add('active');
  });
  if(n===3){const prov=providerData.find(p=>p.id===selectedProvider);const pName=prov?prov.name:selectedProvider;document.getElementById('step3desc').textContent='Nhap '+pName+' API key cua ban';document.getElementById('keyLabel').textContent=pName+' API Key';document.getElementById('testStatus').className='status';keyVerified=false}
  if(n===4){const prov=providerData.find(p=>p.id===selectedProvider);const pName=prov?prov.name:selectedProvider;document.getElementById('confirmProvider').textContent=pName;const m=prov?prov.models.find(x=>x.id===selectedModel):null;document.getElementById('confirmModel').textContent=m?m.name:selectedModel;const k=document.getElementById('apiKey').value;document.getElementById('confirmKey').textContent=k.substring(0,8)+'...'+k.substring(k.length-4)}
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
let selectedChannel=null,selectedChannelData=null;
// Build channel grid dynamically
(function(){
  const grid=document.getElementById('channelCards');
  channelData.forEach(ch=>{
    const div=document.createElement('div');div.className='provider';div.dataset.channel=ch.id;div.onclick=function(){selectChannel(this)};
    div.innerHTML='<div class="icon">'+ch.icon+'</div><div class="name">'+ch.name+'</div><div style="color:#9aa0a6;font-size:12px;margin-top:4px">'+ch.desc.substring(0,30)+'</div>';
    grid.appendChild(div);
  });
})();
function selectChannel(el){
  document.querySelectorAll('#channelCards .provider').forEach(p=>p.classList.remove('selected'));
  el.classList.add('selected');selectedChannel=el.dataset.channel;
  selectedChannelData=channelData.find(c=>c.id===selectedChannel);
  const sec=document.getElementById('channelTokenSection');
  let h='';selectedChannelData.envKeys.forEach(k=>{h+='<div class="field"><label>'+selectedChannelData.icon+' '+k+'</label><input type="text" id="chfield-'+k+'" placeholder="Nhap '+k+'"><p style="font-size:12px;color:#9aa0a6;margin-top:4px">'+selectedChannelData.desc+'</p></div>'});
  sec.innerHTML=h;sec.style.display='block';document.getElementById('channelBtn').style.display='inline-block';
}
async function saveChannels(){
  if(!selectedChannelData)return;
  const btn=document.getElementById('channelBtn'),st=document.getElementById('channelStatus');
  const tokens={};let hasToken=false;
  selectedChannelData.envKeys.forEach(k=>{const el=document.getElementById('chfield-'+k);if(el&&el.value.trim()){tokens[k]=el.value.trim();hasToken=true}});
  if(!hasToken){st.className='status fail';st.textContent='Vui long nhap token cua kenh da chon';return}
  btn.disabled=true;btn.textContent='Dang luu...';st.className='status loading';st.textContent='Dang cau hinh kenh nhan tin...';
  try{const r=await fetch('/api/channels',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({channel:selectedChannel,tokens})});const d=await r.json();
  if(d.ok){st.className='status ok';st.textContent='\\u2705 Da luu '+selectedChannelData.name+'!';
    if(selectedChannelData.canPair){
      setTimeout(()=>{
        st.className='status';document.getElementById('channelBtnRow').style.display='none';
        document.getElementById('channelCards').style.display='none';document.getElementById('channelTokenSection').style.display='none';
        document.getElementById('pairChannelName').textContent=selectedChannelData.name;
        document.getElementById('pairChannelName2').textContent=selectedChannelData.name;
        document.getElementById('pairCodeBtn').textContent='Ghep noi '+selectedChannelData.name;
        document.getElementById('channelPairSection').style.display='block';
      },1500);
    }else{setTimeout(()=>{goStep(6);document.getElementById('pairingUrl').textContent=dashboardUrlGlobal},1500)}
  }else{st.className='status fail';st.textContent='\\u274c '+(d.error||'Loi khi luu');btn.disabled=false;btn.textContent='Luu kenh nhan tin'}}
  catch(x){st.className='status fail';st.textContent='\\u274c Loi ket noi server';btn.disabled=false;btn.textContent='Luu kenh nhan tin'}
}
function skipChannelPair(){
  goStep(6);document.getElementById('pairingUrl').textContent=dashboardUrlGlobal;
}
async function approveChannelPair(){
  if(!selectedChannelData||!selectedChannelData.canPair)return;
  const btn=document.getElementById('pairCodeBtn'),st=document.getElementById('pairCodeStatus');
  const code=document.getElementById('pairCode').value.trim();
  if(!code){st.className='status fail';st.textContent='Vui long nhap ma ghep noi';return}
  btn.disabled=true;btn.textContent='Dang ghep noi...';st.className='status loading';st.textContent='Dang ket noi '+selectedChannelData.name+' bot...';
  try{const r=await fetch('/api/channel-pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({channel:selectedChannel,code})});const d=await r.json();
  if(d.ok){st.className='status ok';st.textContent='\\u2705 Ghep noi '+selectedChannelData.name+' thanh cong!';setTimeout(()=>{goStep(6);document.getElementById('pairingUrl').textContent=dashboardUrlGlobal},1500)}
  else{st.className='status fail';st.textContent='\\u274c '+(d.error||'Khong the ghep noi');btn.disabled=false;btn.textContent='Ghep noi '+selectedChannelData.name}}
  catch(x){st.className='status fail';st.textContent='\\u274c Loi ket noi server';btn.disabled=false;btn.textContent='Ghep noi '+selectedChannelData.name}
}
async function doPairing(){
  const btn=document.getElementById('pairBtn'),st=document.getElementById('pairStatus');
  btn.disabled=true;btn.textContent='Dang tim yeu cau ghep noi...';st.className='status loading';st.textContent='Dang kiem tra...';
  try{const r=await fetch('/api/pair',{method:'POST',headers:{'Content-Type':'application/json'}});const d=await r.json();
  if(d.ok){showDone()}
  else{st.className='status fail';st.textContent='\\u274c '+(d.error||'Khong tim thay yeu cau ghep noi');btn.disabled=false;btn.textContent='Thu lai ghep noi'}}
  catch(x){st.className='status fail';st.textContent='\\u274c Loi ket noi server';btn.disabled=false;btn.textContent='Thu lai ghep noi'}
}
function skipPairing(){showDone()}
function showDone(){
  goStep(7);
  document.getElementById('dashboardUrl').textContent=dashboardUrlGlobal;
  document.getElementById('dashboardLink').href=dashboardUrlGlobal;
  // Goi selfDestruct phia server (fire-and-forget)
  fetch('/api/finalize',{method:'POST',headers:{'Content-Type':'application/json'}}).catch(()=>{});
  // Countdown + polling: hien dem nguoc, dong thoi poll Panel san sang
  let sec=15,panelReady=false;
  const cd=document.getElementById('countdown');
  // Countdown hien thi
  const iv=setInterval(()=>{
    sec--;if(cd)cd.textContent=Math.max(0,sec);
    if(sec<=0&&panelReady){clearInterval(iv);window.location.href='/';}
    if(sec<=-5){clearInterval(iv);window.location.href='/';}// Force reload sau 20s
  },1000);
  // Poll Panel availability — khi Setup die va Panel start, / se tra HTML
  const poll=()=>{
    fetch('/',{method:'HEAD',signal:AbortSignal.timeout(2000)})
      .then(r=>{if(r.ok){panelReady=true;if(sec<=0){clearInterval(iv);window.location.href='/';}}else setTimeout(poll,2000)})
      .catch(()=>setTimeout(poll,2000));
  };
  // Bat dau poll sau 8 giay (doi Setup exit + Panel start)
  setTimeout(poll,8000);
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

      // Ghi Caddyfile (gateway + panel HTTPS)
      writeCaddyfile(domain, email);

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
        // Rollback ve config IP (khong co panel HTTPS)
        writeCaddyfile(null);
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
      let config;
      try { config = JSON.parse(fs.readFileSync(provider.configFile, 'utf8')); } catch { config = {}; }
      config.gateway = config.gateway || {}; config.gateway.auth = config.gateway.auth || {};
      config.gateway.auth.token = gatewayToken;
      config.gateway.mode = config.gateway.mode || 'local';
      config.gateway.bind = config.gateway.bind || 'loopback';
      config.gateway.trustedProxies = config.gateway.trustedProxies || ['127.0.0.1', '::1'];
      // Ghi model da chon
      const model = (body.model || '').trim();
      config.agents = config.agents || { defaults: { model: {} } };
      config.agents.defaults = config.agents.defaults || { model: {} };
      config.agents.defaults.model = config.agents.defaults.model || {};
      if (model) {
        config.agents.defaults.model.primary = model;
      }
      // Browser config (Chrome noSandbox cho root)
      config.browser = config.browser || { headless: true, executablePath: '/usr/bin/google-chrome', defaultProfile: 'openclaw', noSandbox: true };
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

  // --- API: Channels (luu token kenh nhan tin — generic) ---
  if (req.method === 'POST' && url.pathname === '/api/channels') {
    if (!isValidSession(req)) return json(res, 401, { ok: false, error: 'Chua dang nhap' });
    try {
      const body = await parseBody(req);
      const ch = CHANNELS[body.channel];
      if (!ch) return json(res, 400, { ok: false, error: 'Channel khong hop le' });

      let envContent = fs.readFileSync('/opt/openclaw.env', 'utf8');

      // Ghi tung env key cua channel
      for (const [key, val] of Object.entries(body.tokens || {})) {
        if (ch.envKeys.includes(key) && val) {
          envContent = envContent.replace(new RegExp(`^#?\\s*${key}=.*$`, 'm'), '').trim();
          envContent += `\n${key}=${val}`;
        }
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

  // --- API: Channel Pair (generic — ghep noi bat ky kenh co canPair) ---
  if (req.method === 'POST' && url.pathname === '/api/channel-pair') {
    if (!isValidSession(req)) return json(res, 401, { ok: false, error: 'Chua dang nhap' });
    try {
      const body = await parseBody(req);
      const ch = CHANNELS[body.channel];
      if (!ch || !ch.canPair) return json(res, 400, { ok: false, error: 'Kenh khong ho tro pairing qua web' });
      const code = (body.code || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
      if (!code) return json(res, 400, { ok: false, error: 'Thieu ma ghep noi' });

      try {
        execSync(
          `/opt/openclaw-cli.sh pairing approve ${ch.pairCmd} ${code}`,
          { timeout: 15000, stdio: 'pipe' }
        );
        return json(res, 200, { ok: true });
      } catch (e) {
        const stderr = e.stderr ? e.stderr.toString() : '';
        const stdout = e.stdout ? e.stdout.toString() : '';
        const errMsg = stderr || stdout || e.message;
        return json(res, 200, { ok: false, error: `Khong the ghep noi: ${errMsg.substring(0, 200)}` });
      }
    } catch (e) {
      return json(res, 500, { ok: false, error: `Loi: ${e.message}` });
    }
  }

  // --- API: Pair (tim va approve pending pairing request) ---
  if (req.method === 'POST' && url.pathname === '/api/pair') {
    if (!isValidSession(req)) return json(res, 401, { ok: false, error: 'Chua dang nhap' });
    try {
      const gatewayToken = getGatewayToken();

      // Tim pending pairing requests (dung --json de lay requestId)
      let output = '';
      try {
        output = execSync(
          `/opt/openclaw-cli.sh devices list --token=${gatewayToken} --json 2>/dev/null`,
          { timeout: 15000, stdio: 'pipe' }
        ).toString();
      } catch (e) {
        output = e.stdout ? e.stdout.toString() : '';
      }

      let data;
      try { data = JSON.parse(output); } catch { return json(res, 200, { ok: false, error: 'Khong doc duoc danh sach thiet bi' }); }
      const pending = data.pending || [];

      if (!pending.length) {
        return json(res, 200, { ok: false, error: 'Khong tim thay yeu cau ghep noi. Hay mo dashboard truoc roi thu lai.' });
      }

      if (pending.length > 1) {
        return json(res, 200, { ok: false, error: `Tim thay ${pending.length} yeu cau. Co nguoi khac dang ket noi. Hay thu lai sau.` });
      }

      const requestId = pending[0].requestId || '';
      if (!requestId) return json(res, 200, { ok: false, error: 'Khong lay duoc request ID' });

      // Approve request — KHONG selfDestruct o day, doi /api/finalize
      execSync(
        `/opt/openclaw-cli.sh devices approve "${requestId}" --token=${gatewayToken}`,
        { timeout: 15000, stdio: 'pipe' }
      );

      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 500, { ok: false, error: `Loi ghep noi: ${e.message}` });
    }
  }

  // --- API: Finalize (chuyen giao sang Management Panel) ---
  // Goi tu Step 7 sau khi pair xong (hoac skip pair)
  // Tra response truoc, roi selfDestruct sau 8 giay de Panel kip start
  if (req.method === 'POST' && url.pathname === '/api/finalize') {
    if (!isValidSession(req)) return json(res, 401, { ok: false, error: 'Chua dang nhap' });
    if (finalizing) return json(res, 200, { ok: true, message: 'Dang chuyen giao...' });
    finalizing = true;
    console.log('[Setup UI] /api/finalize — se chuyen giao sang Panel sau 2 giay...');
    json(res, 200, { ok: true });
    setTimeout(() => selfDestruct(), 2000);
    return;
  }

  json(res, 404, { error: 'Not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Setup UI] Dang chay tai http://0.0.0.0:${PORT}`);
  console.log('[Setup UI] Se tu huy khi setup hoan tat.');
});
