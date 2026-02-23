#!/usr/bin/env node
// =============================================================================
// OpenClaw Management Panel — Web-based admin panel
// PAM authentication (root password), long-running service
// Port: 9999 | Runs as root | Systemd: openclaw-panel.service
// =============================================================================

const http = require('http');
const { execSync, exec } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');

const PORT = 9999;
const SESSION_TTL = 60 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;
const BLOCK_DURATION = 15 * 60 * 1000;

const ENV_FILE = '/opt/openclaw.env';
const CONFIG_FILE = '/home/openclaw/.openclaw/openclaw.json';
const CONFIG_DIR = '/etc/config';
const CADDYFILE = '/etc/caddy/Caddyfile';
const OPENCLAW_DIR = '/opt/openclaw';
const PANEL_VERSION = '2026.02.23.1';
const PANEL_UPDATE_URL = 'https://raw.githubusercontent.com/LeAnhlinux/OpenClaw/main/setup-ui/panel.js';
const PANEL_CHECK_URL = 'https://api.github.com/repos/LeAnhlinux/OpenClaw/contents/setup-ui/panel.js';
const PANEL_FILE = '/opt/openclaw-panel/panel.js';

const sessions = {};
const loginAttempts = {};

// --- Helpers ---
function getClientIP(req) { return req.socket.remoteAddress.replace('::ffff:', ''); }
function isBlocked(ip) {
  const r = loginAttempts[ip]; if (!r) return false;
  if (r.blockedUntil && Date.now() < r.blockedUntil) return true;
  if (r.blockedUntil && Date.now() >= r.blockedUntil) { delete loginAttempts[ip]; return false; }
  return false;
}
function recordFailedLogin(ip) {
  if (!loginAttempts[ip]) loginAttempts[ip] = { count: 0, blockedUntil: null };
  loginAttempts[ip].count++;
  if (loginAttempts[ip].count >= MAX_LOGIN_ATTEMPTS) loginAttempts[ip].blockedUntil = Date.now() + BLOCK_DURATION;
}
function escapeHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function verifyPassword(username, password) {
  try {
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(username)) return false;
    const out = execSync(`echo '${password.replace(/'/g, "'\\''")}' | su -c 'echo __AUTH_OK__' ${username} 2>/dev/null`, { timeout: 5000, stdio: 'pipe' }).toString();
    return out.includes('__AUTH_OK__');
  } catch { return false; }
}
function createSession() { const t = crypto.randomBytes(32).toString('hex'); sessions[t] = { created: Date.now() }; return t; }
setInterval(() => { const now = Date.now(); for (const [k, s] of Object.entries(sessions)) { if (now - s.created > SESSION_TTL) delete sessions[k]; } for (const [k, a] of Object.entries(loginAttempts)) { if (a.blockedUntil && now > a.blockedUntil) delete loginAttempts[k]; } }, 5 * 60 * 1000);
function isValidSession(req) {
  const m = (req.headers.cookie || '').match(/panel_session=([a-f0-9]{64})/);
  if (!m) return false; const s = sessions[m[1]]; if (!s) return false;
  if (Date.now() - s.created > SESSION_TTL) { delete sessions[m[1]]; return false; } return true;
}
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) { req.destroy(); reject(new Error('Too large')); } });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid JSON')); } });
  });
}
function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); }
function getServerIP() { try { return execSync("hostname -I | awk '{print $1}'", { stdio: 'pipe' }).toString().trim(); } catch { return 'localhost'; } }
function getEnvValue(key) {
  try { const c = fs.readFileSync(ENV_FILE, 'utf8'); const m = c.match(new RegExp(`^${key}=(.*)$`, 'm')); return m ? m[1].trim() : ''; } catch { return ''; }
}
function setEnvValue(key, value) {
  let c = ''; try { c = fs.readFileSync(ENV_FILE, 'utf8'); } catch {}
  if (new RegExp(`^${key}=`, 'm').test(c)) c = c.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);
  else c = c.trim() + `\n${key}=${value}\n`;
  fs.writeFileSync(ENV_FILE, c.trim() + '\n', 'utf8');
}
function removeEnvValue(key) { try { let c = fs.readFileSync(ENV_FILE, 'utf8'); c = c.replace(new RegExp(`^#?\\s*${key}=.*$`, 'm'), '').trim() + '\n'; fs.writeFileSync(ENV_FILE, c, 'utf8'); } catch {} }
function getConfig() { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; } }
function saveConfig(config) {
  const dir = '/home/openclaw/.openclaw'; fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  execSync(`chown openclaw:openclaw ${CONFIG_FILE}`); execSync(`chmod 0600 ${CONFIG_FILE}`);
}
function restartService(n) { try { execSync(`systemctl restart ${n}`, { timeout: 30000 }); return true; } catch { return false; } }
function isServiceActive(n) { try { execSync(`systemctl is-active --quiet ${n}`); return true; } catch { return false; } }
function safeExec(cmd, t) { try { return execSync(cmd, { timeout: t || 15000, stdio: 'pipe' }).toString().trim(); } catch { return ''; } }

// --- Caddy + Firewall helpers ---
function writeCaddyfile(domain, email) {
  const BIND = '127.0.0.1', GW_PORT = 18789, PANEL_PORT = 9999;
  let cfg = '';
  if (domain) {
    const el = email ? `email ${email}\n` : '';
    const tlsBlock = `    tls {\n        issuer acme {\n            dir https://acme-v02.api.letsencrypt.org/directory\n            profile shortlived\n        }\n    }`;
    cfg = `${el}${domain} {\n${tlsBlock}\n    reverse_proxy ${BIND}:${GW_PORT}\n}\n\n${domain}:9443 {\n${tlsBlock}\n    reverse_proxy ${BIND}:${PANEL_PORT}\n}\n`;
    // Firewall: mo 9443, dong 9999
    try { execSync('ufw allow 9443/tcp comment "OpenClaw Panel HTTPS" 2>/dev/null', { stdio: 'ignore' }); } catch {}
    try { execSync('ufw delete allow 9999/tcp 2>/dev/null', { stdio: 'ignore' }); } catch {}
  } else {
    const serverIP = getServerIP();
    cfg = `${serverIP} {\n    tls internal\n    reverse_proxy ${BIND}:${GW_PORT}\n}\n`;
    // Firewall: mo 9999, dong 9443
    try { execSync('ufw allow 9999/tcp comment "OpenClaw Panel HTTP" 2>/dev/null', { stdio: 'ignore' }); } catch {}
    try { execSync('ufw delete allow 9443/tcp 2>/dev/null', { stdio: 'ignore' }); } catch {}
  }
  fs.writeFileSync(CADDYFILE, cfg, 'utf8');
}

// --- Fallback helpers ---
const FALLBACK_FILE = '/opt/openclaw-fallback.json';
function getFallbackConfig() {
  try { return JSON.parse(fs.readFileSync(FALLBACK_FILE, 'utf8')); }
  catch { return { chain: [], settings: { rateLimitPerMinute: 60, cooldownSeconds: 300 }, rateState: {} }; }
}
function saveFallbackConfig(cfg) { fs.writeFileSync(FALLBACK_FILE, JSON.stringify(cfg, null, 2), 'utf8'); }
function getFallbackProviderKeys() {
  try { const cfg = getFallbackConfig(); return cfg.chain.map(c => c.provider); } catch { return []; }
}
function getProviderBaseUrl(provKey) {
  const urls = {
    xai:'https://api.x.ai/v1', minimax:'https://api.minimax.io/v1',
    moonshot:'https://api.moonshot.ai/v1', 'kimi-coding':'https://api.moonshot.ai/v1',
    zai:'https://api.z.ai/v1', venice:'https://api.venice.ai/api/v1',
    nvidia:'https://integrate.api.nvidia.com/v1', huggingface:'https://router.huggingface.co/v1',
    together:'https://api.together.xyz/v1', openrouter:'https://openrouter.ai/api/v1',
    synthetic:'https://api.synthetic.new/openai/v1', ollama:'http://127.0.0.1:11434/v1',
    vllm:'http://127.0.0.1:8000/v1', litellm:'http://localhost:4000/v1'
  };
  return urls[provKey] || 'https://api.openai.com/v1';
}
function callProvider(provKey, model, apiKey, messages) {
  const actualModel = model.includes('/') ? model.split('/').slice(1).join('/') : model;
  try {
    if (provKey === 'anthropic') {
      const r = safeExec(`curl -s -X POST https://api.anthropic.com/v1/messages -H 'x-api-key: ${apiKey.replace(/'/g,"'\\''")}' -H 'anthropic-version: 2023-06-01' -H 'content-type: application/json' -d '${JSON.stringify({model:actualModel,max_tokens:1024,messages}).replace(/'/g,"'\\''")}'`, 60000);
      if (!r) return { ok: false, error: 'Empty response' };
      const j = JSON.parse(r);
      if (j.error) return { ok: false, error: j.error.message || j.error.type || 'API error' };
      return { ok: true, reply: j.content?.[0]?.text || 'No response', tokens: (j.usage?.input_tokens||0) + (j.usage?.output_tokens||0) };
    } else if (provKey === 'gemini') {
      const gModel = actualModel.replace('google/', '');
      const r = safeExec(`curl -s -X POST "https://generativelanguage.googleapis.com/v1beta/models/${gModel}:generateContent?key=${apiKey.replace(/'/g,"'\\''")}" -H 'content-type: application/json' -d '${JSON.stringify({contents:messages.map(m=>({role:m.role==='assistant'?'model':'user',parts:[{text:m.content}]}))}).replace(/'/g,"'\\''")}'`, 60000);
      if (!r) return { ok: false, error: 'Empty response' };
      const j = JSON.parse(r);
      if (j.error) return { ok: false, error: j.error.message || 'API error' };
      return { ok: true, reply: j.candidates?.[0]?.content?.parts?.[0]?.text || 'No response', tokens: j.usageMetadata?.totalTokenCount || 0 };
    } else {
      const baseUrl = getProviderBaseUrl(provKey);
      const r = safeExec(`curl -s -X POST ${baseUrl}/chat/completions -H 'Authorization: Bearer ${apiKey.replace(/'/g,"'\\''")}' -H 'content-type: application/json' -d '${JSON.stringify({model:actualModel,messages,max_tokens:1024}).replace(/'/g,"'\\''")}'`, 60000);
      if (!r) return { ok: false, error: 'Empty response' };
      const j = JSON.parse(r);
      if (j.error) return { ok: false, error: j.error.message || j.error.type || 'API error' };
      return { ok: true, reply: j.choices?.[0]?.message?.content || 'No response', tokens: j.usage?.total_tokens || 0 };
    }
  } catch (e) { return { ok: false, error: e.message }; }
}
function checkRateLimit(fbCfg, provKey) {
  const now = Date.now();
  const state = fbCfg.rateState[provKey] || { count: 0, windowStart: 0, cooldownUntil: 0 };
  if (state.cooldownUntil && now < state.cooldownUntil) return { allowed: false, reason: 'cooldown', remaining: Math.ceil((state.cooldownUntil - now) / 1000) };
  const windowMs = 60000;
  if (now - state.windowStart > windowMs) { state.count = 0; state.windowStart = now; }
  if (state.count >= (fbCfg.settings.rateLimitPerMinute || 60)) return { allowed: false, reason: 'rate_limit' };
  fbCfg.rateState[provKey] = state;
  return { allowed: true };
}
function recordProviderCall(fbCfg, provKey) {
  if (!fbCfg.rateState[provKey]) fbCfg.rateState[provKey] = { count: 0, windowStart: Date.now(), cooldownUntil: 0 };
  fbCfg.rateState[provKey].count++;
}
function recordProviderCooldown(fbCfg, provKey) {
  if (!fbCfg.rateState[provKey]) fbCfg.rateState[provKey] = { count: 0, windowStart: Date.now(), cooldownUntil: 0 };
  fbCfg.rateState[provKey].cooldownUntil = Date.now() + (fbCfg.settings.cooldownSeconds || 300) * 1000;
}

// --- Provider configs ---
// Category: 'cloud' = Cloud API, 'gateway' = Gateway/Proxy, 'local' = Self-hosted
const PROVIDERS = {
  // ====== CLOUD PROVIDERS ======
  anthropic: {
    name: 'Anthropic', envKey: 'ANTHROPIC_API_KEY', configFile: `${CONFIG_DIR}/anthropic.json`,
    color: '#d97706', icon: '\u2728', category: 'cloud',
    models: [
      { id: 'anthropic/claude-opus-4-6', name: 'Claude Opus 4.6', desc: 'Flagship — smartest' },
      { id: 'anthropic/claude-opus-4-5', name: 'Claude Opus 4.5', desc: 'Powerful — deep thinking' },
      { id: 'anthropic/claude-sonnet-4-20250514', name: 'Claude Sonnet 4', desc: 'Balanced — fast' },
      { id: 'anthropic/claude-haiku-3-5-20241022', name: 'Claude Haiku 3.5', desc: 'Fastest — low cost' }
    ],
    testFn: (k) => { try { return safeExec(`curl -s -o /dev/null -w '%{http_code}' -X POST https://api.anthropic.com/v1/messages -H 'x-api-key: ${k.replace(/'/g,"'\\''")}' -H 'anthropic-version: 2023-06-01' -H 'content-type: application/json' -d '{"model":"claude-sonnet-4-20250514","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}'`, 15000) === '200'; } catch { return false; } }
  },
  openai: {
    name: 'OpenAI', envKey: 'OPENAI_API_KEY', configFile: `${CONFIG_DIR}/openai.json`,
    color: '#10a37f', icon: '\ud83e\udde0', category: 'cloud',
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
    name: 'Google Gemini', envKey: 'GOOGLE_API_KEY', configFile: `${CONFIG_DIR}/gemini.json`,
    color: '#4285f4', icon: '\ud83d\udc8e', category: 'cloud',
    models: [
      { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro', desc: 'Flagship — reasoning & coding' },
      { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash', desc: 'Balanced — fast thinking' },
      { id: 'google/gemini-2.0-flash', name: 'Gemini 2.0 Flash', desc: 'Speed — low latency' },
      { id: 'google/gemini-2.0-flash-lite', name: 'Gemini 2.0 Flash Lite', desc: 'Lightweight — cost efficient' }
    ],
    testFn: (k) => { try { return safeExec(`curl -s -o /dev/null -w '%{http_code}' "https://generativelanguage.googleapis.com/v1beta/models?key=${k.replace(/'/g,"'\\''")}"`  , 15000) === '200'; } catch { return false; } }
  },
  xai: {
    name: 'xAI (Grok)', envKey: 'XAI_API_KEY', configFile: `${CONFIG_DIR}/openai.json`,
    color: '#1d1d1f', icon: '\ud83d\ude80', category: 'cloud',
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
    name: 'MiniMax', envKey: 'MINIMAX_API_KEY', configFile: `${CONFIG_DIR}/openai.json`,
    color: '#6366f1', icon: '\u26a1', category: 'cloud',
    models: [
      { id: 'minimax/MiniMax-M2.5', name: 'MiniMax M2.5', desc: 'Latest — most capable' },
      { id: 'minimax/MiniMax-M2.1', name: 'MiniMax M2.1', desc: 'Balanced — reliable' },
      { id: 'minimax/MiniMax-M2.1-lightning', name: 'M2.1 Lightning', desc: 'Fast — low latency' },
      { id: 'minimax/MiniMax-M2', name: 'MiniMax M2', desc: 'Base — cost efficient' }
    ],
    testFn: (k) => { try { return safeExec(`curl -s -o /dev/null -w '%{http_code}' https://api.minimax.io/v1/models -H 'Authorization: Bearer ${k.replace(/'/g,"'\\''")}' `, 15000) === '200'; } catch { return false; } }
  },
  moonshot: {
    name: 'Moonshot AI', envKey: 'MOONSHOT_API_KEY', configFile: `${CONFIG_DIR}/openai.json`,
    color: '#7c3aed', icon: '\ud83c\udf19', category: 'cloud',
    models: [
      { id: 'moonshot/kimi-k2.5', name: 'Kimi K2.5', desc: 'Latest — most powerful' },
      { id: 'moonshot/kimi-k2-thinking', name: 'Kimi K2 Thinking', desc: 'Reasoning — deep thinking' },
      { id: 'moonshot/kimi-k2-thinking-turbo', name: 'K2 Thinking Turbo', desc: 'Fast reasoning' },
      { id: 'moonshot/kimi-k2-0905-preview', name: 'Kimi K2 Preview', desc: 'Balanced — stable' },
      { id: 'moonshot/kimi-k2-turbo-preview', name: 'K2 Turbo Preview', desc: 'Fast — low latency' }
    ],
    testFn: (k) => { try { return safeExec(`curl -s -o /dev/null -w '%{http_code}' https://api.moonshot.ai/v1/models -H 'Authorization: Bearer ${k.replace(/'/g,"'\\''")}' `, 15000) === '200'; } catch { return false; } }
  },
  'kimi-coding': {
    name: 'Kimi Coding', envKey: 'KIMI_API_KEY', configFile: `${CONFIG_DIR}/openai.json`,
    color: '#8b5cf6', icon: '\ud83d\udcbb', category: 'cloud',
    models: [
      { id: 'kimi-coding/k2p5', name: 'Kimi K2P5', desc: 'Code optimized' }
    ],
    testFn: (k) => { try { return safeExec(`curl -s -o /dev/null -w '%{http_code}' https://api.moonshot.ai/v1/models -H 'Authorization: Bearer ${k.replace(/'/g,"'\\''")}' `, 15000) === '200'; } catch { return false; } }
  },
  zai: {
    name: 'Z.AI (GLM)', envKey: 'ZAI_API_KEY', configFile: `${CONFIG_DIR}/openai.json`,
    color: '#0ea5e9', icon: '\ud83e\udd16', category: 'cloud',
    models: [
      { id: 'zai/glm-5', name: 'GLM-5', desc: 'Latest — most powerful' },
      { id: 'zai/glm-4.7', name: 'GLM-4.7', desc: 'Balanced — reliable' },
      { id: 'zai/glm-4.6', name: 'GLM-4.6', desc: 'Stable — cost efficient' }
    ],
    testFn: (k) => { try { return safeExec(`curl -s -o /dev/null -w '%{http_code}' https://api.z.ai/v1/models -H 'Authorization: Bearer ${k.replace(/'/g,"'\\''")}' `, 15000) === '200'; } catch { return false; } }
  },
  venice: {
    name: 'Venice AI', envKey: 'VENICE_API_KEY', configFile: `${CONFIG_DIR}/openai.json`,
    color: '#f43f5e', icon: '\ud83c\udfad', category: 'cloud',
    models: [
      { id: 'venice/deepseek-v3.2', name: 'DeepSeek V3.2', desc: 'Powerful — open source' },
      { id: 'venice/qwen3-235b-a22b-thinking-2507', name: 'Qwen3 235B Thinking', desc: 'Reasoning — large' },
      { id: 'venice/qwen3-coder-480b-a35b-instruct', name: 'Qwen3 Coder 480B', desc: 'Code — largest' },
      { id: 'venice/llama-3.3-70b', name: 'Llama 3.3 70B', desc: 'Meta — balanced' },
      { id: 'venice/venice-uncensored', name: 'Venice Uncensored', desc: 'Uncensored — private' }
    ],
    testFn: (k) => { try { return safeExec(`curl -s -o /dev/null -w '%{http_code}' https://api.venice.ai/api/v1/models -H 'Authorization: Bearer ${k.replace(/'/g,"'\\''")}' `, 15000) === '200'; } catch { return false; } }
  },
  xiaomi: {
    name: 'Xiaomi MiMo', envKey: 'XIAOMI_API_KEY', configFile: `${CONFIG_DIR}/openai.json`,
    color: '#ff6900', icon: '\ud83d\udcf1', category: 'cloud',
    models: [
      { id: 'xiaomi/mimo-v2-flash', name: 'MiMo V2 Flash', desc: '262K context — fast' }
    ],
    testFn: (k) => { try { return safeExec(`curl -s -o /dev/null -w '%{http_code}' https://api.xiaomimimo.com/anthropic/v1/models -H 'Authorization: Bearer ${k.replace(/'/g,"'\\''")}' `, 15000) === '200'; } catch { return false; } }
  },
  nvidia: {
    name: 'NVIDIA', envKey: 'NVIDIA_API_KEY', configFile: `${CONFIG_DIR}/openai.json`,
    color: '#76b900', icon: '\ud83d\udfe2', category: 'cloud',
    models: [
      { id: 'nvidia/nvidia/llama-3.1-nemotron-70b-instruct', name: 'Nemotron 70B', desc: 'Instruct — 131K context' },
      { id: 'nvidia/meta/llama-3.3-70b-instruct', name: 'Llama 3.3 70B', desc: 'Meta — balanced' }
    ],
    testFn: (k) => { try { return safeExec(`curl -s -o /dev/null -w '%{http_code}' https://integrate.api.nvidia.com/v1/models -H 'Authorization: Bearer ${k.replace(/'/g,"'\\''")}' `, 15000) === '200'; } catch { return false; } }
  },
  bedrock: {
    name: 'Amazon Bedrock', envKey: 'AWS_ACCESS_KEY_ID', configFile: `${CONFIG_DIR}/anthropic.json`,
    color: '#ff9900', icon: '\u2601\ufe0f', category: 'cloud',
    extraEnvKeys: ['AWS_SECRET_ACCESS_KEY', 'AWS_REGION'],
    models: [
      { id: 'amazon-bedrock/us.anthropic.claude-opus-4-6-v1:0', name: 'Claude Opus 4.6', desc: 'Anthropic via AWS' },
      { id: 'amazon-bedrock/us.anthropic.claude-sonnet-4-20250514-v1:0', name: 'Claude Sonnet 4', desc: 'Balanced via AWS' }
    ],
    testFn: () => { try { return !!safeExec('aws sts get-caller-identity 2>/dev/null', 10000); } catch { return false; } }
  },
  synthetic: {
    name: 'Synthetic', envKey: 'SYNTHETIC_API_KEY', configFile: `${CONFIG_DIR}/openai.json`,
    color: '#a855f7', icon: '\ud83e\uddec', category: 'cloud',
    models: [
      { id: 'synthetic/hf:MiniMaxAI/MiniMax-M2.1', name: 'MiniMax M2.1', desc: 'Via Synthetic' },
      { id: 'synthetic/hf:moonshotai/Kimi-K2-Thinking', name: 'Kimi K2 Thinking', desc: 'Reasoning via Synthetic' },
      { id: 'synthetic/hf:deepseek-ai/DeepSeek-V3.2', name: 'DeepSeek V3.2', desc: 'Open source via Synthetic' },
      { id: 'synthetic/hf:Qwen/Qwen3-Coder-480B-A35B-Instruct', name: 'Qwen3 Coder 480B', desc: 'Code via Synthetic' },
      { id: 'synthetic/hf:openai/gpt-oss-120b', name: 'GPT-OSS 120B', desc: 'Open source GPT' }
    ],
    testFn: (k) => { try { return safeExec(`curl -s -o /dev/null -w '%{http_code}' https://api.synthetic.new/anthropic/v1/models -H 'Authorization: Bearer ${k.replace(/'/g,"'\\''")}' `, 15000) === '200'; } catch { return false; } }
  },
  huggingface: {
    name: 'Hugging Face', envKey: 'HF_TOKEN', configFile: `${CONFIG_DIR}/openai.json`,
    color: '#ff9d00', icon: '\ud83e\udd17', category: 'cloud',
    models: [
      { id: 'huggingface/deepseek-ai/DeepSeek-R1', name: 'DeepSeek R1', desc: 'Reasoning — open source' },
      { id: 'huggingface/deepseek-ai/DeepSeek-V3.2', name: 'DeepSeek V3.2', desc: 'Powerful — open source' },
      { id: 'huggingface/meta-llama/Llama-3.3-70B-Instruct', name: 'Llama 3.3 70B', desc: 'Meta — balanced' },
      { id: 'huggingface/openai/gpt-oss-120b', name: 'GPT-OSS 120B', desc: 'Open source GPT' },
      { id: 'huggingface/Qwen/Qwen3-8B', name: 'Qwen3 8B', desc: 'Small — fast' }
    ],
    testFn: (k) => { try { return safeExec(`curl -s -o /dev/null -w '%{http_code}' https://router.huggingface.co/v1/models -H 'Authorization: Bearer ${k.replace(/'/g,"'\\''")}' `, 15000) === '200'; } catch { return false; } }
  },
  together: {
    name: 'Together AI', envKey: 'TOGETHER_API_KEY', configFile: `${CONFIG_DIR}/openai.json`,
    color: '#0066ff', icon: '\ud83e\udd1d', category: 'cloud',
    models: [
      { id: 'together/moonshotai/Kimi-K2.5', name: 'Kimi K2.5', desc: 'Latest Moonshot via Together' },
      { id: 'together/meta-llama/Llama-3.3-70B-Instruct-Turbo', name: 'Llama 3.3 70B Turbo', desc: 'Meta — fast' },
      { id: 'together/meta-llama/Llama-4-Maverick', name: 'Llama 4 Maverick', desc: 'Meta — latest' },
      { id: 'together/deepseek/DeepSeek-V3.1', name: 'DeepSeek V3.1', desc: 'Open source — powerful' },
      { id: 'together/deepseek/DeepSeek-R1', name: 'DeepSeek R1', desc: 'Reasoning — open source' }
    ],
    testFn: (k) => { try { return safeExec(`curl -s -o /dev/null -w '%{http_code}' https://api.together.xyz/v1/models -H 'Authorization: Bearer ${k.replace(/'/g,"'\\''")}' `, 15000) === '200'; } catch { return false; } }
  },
  opencode: {
    name: 'OpenCode Zen', envKey: 'OPENCODE_API_KEY', configFile: `${CONFIG_DIR}/openai.json`,
    color: '#14b8a6', icon: '\ud83e\uddd8', category: 'cloud',
    models: [
      { id: 'opencode/claude-opus-4-6', name: 'Claude Opus 4.6', desc: 'Anthropic via OpenCode' }
    ],
    testFn: (k) => { try { return !!k && k.length > 10; } catch { return false; } }
  },
  qianfan: {
    name: 'Qianfan (Baidu)', envKey: 'QIANFAN_API_KEY', configFile: `${CONFIG_DIR}/openai.json`,
    color: '#2563eb', icon: '\u2601\ufe0f', category: 'cloud',
    models: [
      { id: 'qianfan/ernie-4.5-turbo-128k', name: 'ERNIE 4.5 Turbo', desc: 'Baidu — flagship' }
    ],
    testFn: (k) => { try { return !!k && k.startsWith('bce-v3/'); } catch { return false; } }
  },

  // ====== GATEWAY / PROXY PROVIDERS ======
  openrouter: {
    name: 'OpenRouter', envKey: 'OPENROUTER_API_KEY', configFile: `${CONFIG_DIR}/openai.json`,
    color: '#6d28d9', icon: '\ud83d\udd00', category: 'gateway',
    models: [
      { id: 'openrouter/anthropic/claude-opus-4', name: 'Claude Opus 4', desc: 'Anthropic via OpenRouter' },
      { id: 'openrouter/openai/gpt-5.2', name: 'GPT-5.2', desc: 'OpenAI via OpenRouter' },
      { id: 'openrouter/google/gemini-2.5-pro', name: 'Gemini 2.5 Pro', desc: 'Google via OpenRouter' },
      { id: 'openrouter/deepseek/deepseek-r1', name: 'DeepSeek R1', desc: 'Reasoning via OpenRouter' }
    ],
    testFn: (k) => { try { return safeExec(`curl -s -o /dev/null -w '%{http_code}' https://openrouter.ai/api/v1/models -H 'Authorization: Bearer ${k.replace(/'/g,"'\\''")}' `, 15000) === '200'; } catch { return false; } }
  },
  'vercel-ai-gateway': {
    name: 'Vercel AI Gateway', envKey: 'AI_GATEWAY_API_KEY', configFile: `${CONFIG_DIR}/openai.json`,
    color: '#000000', icon: '\u25b2', category: 'gateway',
    models: [
      { id: 'vercel-ai-gateway/anthropic/claude-opus-4.6', name: 'Claude Opus 4.6', desc: 'Anthropic via Vercel' },
      { id: 'vercel-ai-gateway/openai/gpt-5.2', name: 'GPT-5.2', desc: 'OpenAI via Vercel' }
    ],
    testFn: (k) => { try { return !!k && k.length > 10; } catch { return false; } }
  },
  'cloudflare-ai-gateway': {
    name: 'Cloudflare AI Gateway', envKey: 'CLOUDFLARE_AI_GATEWAY_API_KEY', configFile: `${CONFIG_DIR}/openai.json`,
    color: '#f38020', icon: '\u2601\ufe0f', category: 'gateway',
    models: [
      { id: 'cloudflare-ai-gateway/claude-sonnet-4-5', name: 'Claude Sonnet 4.5', desc: 'Default model' }
    ],
    testFn: (k) => { try { return !!k && k.length > 10; } catch { return false; } }
  },
  litellm: {
    name: 'LiteLLM Proxy', envKey: 'LITELLM_API_KEY', configFile: `${CONFIG_DIR}/openai.json`,
    color: '#059669', icon: '\ud83d\udd17', category: 'gateway',
    models: [
      { id: 'litellm/claude-opus-4-6', name: 'Claude Opus 4.6', desc: 'Via LiteLLM Proxy' },
      { id: 'litellm/gpt-4o', name: 'GPT-4o', desc: 'OpenAI via LiteLLM' }
    ],
    testFn: (k) => { try { return safeExec(`curl -s -o /dev/null -w '%{http_code}' http://localhost:4000/v1/models -H 'Authorization: Bearer ${k.replace(/'/g,"'\\''")}' `, 10000) === '200'; } catch { return false; } }
  },

  // ====== SELF-HOSTED / LOCAL PROVIDERS ======
  ollama: {
    name: 'Ollama', envKey: 'OLLAMA_API_KEY', configFile: `${CONFIG_DIR}/openai.json`,
    color: '#333333', icon: '\ud83e\uddac', category: 'local',
    models: [
      { id: 'ollama/llama3.3', name: 'Llama 3.3', desc: 'Meta — local' },
      { id: 'ollama/gpt-oss:20b', name: 'GPT-OSS 20B', desc: 'OpenAI OSS — local' },
      { id: 'ollama/qwen3:8b', name: 'Qwen3 8B', desc: 'Alibaba — small' }
    ],
    testFn: (k) => { try { return safeExec(`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:11434/api/tags`, 10000) === '200'; } catch { return false; } }
  },
  vllm: {
    name: 'vLLM', envKey: 'VLLM_API_KEY', configFile: `${CONFIG_DIR}/openai.json`,
    color: '#475569', icon: '\u2699\ufe0f', category: 'local',
    models: [
      { id: 'vllm/your-model-id', name: 'Custom Model', desc: 'OpenAI-compatible local' }
    ],
    testFn: (k) => { try { return safeExec(`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8000/v1/models`, 10000) === '200'; } catch { return false; } }
  }
};

// --- Channel configs ---
const CHANNELS = {
  telegram: { name: 'Telegram', icon: '\ud83d\udce8', envKeys: ['TELEGRAM_BOT_TOKEN'], pairCmd: 'telegram', desc: 'Create bot at @BotFather', canPair: true },
  discord: { name: 'Discord', icon: '\ud83c\udfae', envKeys: ['DISCORD_BOT_TOKEN'], pairCmd: 'discord', desc: 'Create bot at discord.com/developers', canPair: true },
  slack: { name: 'Slack', icon: '\ud83d\udcbc', envKeys: ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'], pairCmd: null, desc: 'Create app at api.slack.com/apps', canPair: false },
  line: { name: 'LINE', icon: '\ud83d\udfe2', envKeys: ['LINE_CHANNEL_ACCESS_TOKEN', 'LINE_CHANNEL_SECRET'], pairCmd: null, desc: 'Plugin — create bot at developers.line.biz', canPair: false },
  matrix: { name: 'Matrix', icon: '\ud83c\udf10', envKeys: ['MATRIX_HOMESERVER', 'MATRIX_ACCESS_TOKEN'], pairCmd: null, desc: 'Plugin — configure homeserver + token', canPair: false },
  zalo: { name: 'Zalo', icon: '\ud83d\udcac', envKeys: ['ZALO_BOT_TOKEN'], pairCmd: 'zalo', desc: 'Create bot at bot.zaloplatforms.com', canPair: true }
};

// --- CSS ---
const CSS = `
:root{--bg:#f4f6fb;--sidebar-bg:#111318;--sidebar-w:250px;--card-bg:#fff;--accent:#4285f4;--accent2:#34a853;--text:#1a1a2e;--text2:#5f6368;--border:#e8eaed;--danger:#ea4335;--warn:#fbbc05;--radius:16px}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',Roboto,-apple-system,BlinkMacSystemFont,sans-serif;background:#f4f6fb;color:var(--text);min-height:100vh;display:flex}

/* Sidebar */
.sidebar{width:var(--sidebar-w);background:var(--sidebar-bg);min-height:100vh;position:fixed;top:0;left:0;display:flex;flex-direction:column;z-index:10}
.sidebar .brand{padding:20px 18px 16px;border-bottom:1px solid rgba(255,255,255,.06)}
.sidebar .brand h1{font-size:18px;color:#fff;font-weight:700;letter-spacing:-.2px;background:linear-gradient(135deg,#4285f4,#34a853);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.sidebar .brand p{font-size:10px;color:rgba(255,255,255,.3);margin-top:2px;letter-spacing:.3px;text-transform:uppercase;font-weight:600}
.sidebar nav{flex:1;padding:8px 8px;overflow-y:auto}
.sidebar nav::-webkit-scrollbar{width:4px} .sidebar nav::-webkit-scrollbar-track{background:transparent} .sidebar nav::-webkit-scrollbar-thumb{background:rgba(255,255,255,.1);border-radius:4px} .sidebar nav::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.2)}
.nav-group-label{font-size:10px;font-weight:700;color:rgba(255,255,255,.25);text-transform:uppercase;letter-spacing:1.2px;padding:16px 14px 6px;margin-top:4px}
.nav-group-label:first-child{margin-top:0;padding-top:8px}
.nav-item{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:8px;cursor:pointer;color:rgba(255,255,255,.5);font-size:13px;font-weight:500;transition:all .2s ease;margin-bottom:1px;user-select:none;position:relative}
.nav-item:hover{background:rgba(255,255,255,.07);color:rgba(255,255,255,.85)}
.nav-item.active{background:rgba(255,255,255,.08);color:#fff}
.nav-item.active::before{content:'';position:absolute;left:0;top:50%;transform:translateY(-50%);width:3px;height:20px;background:linear-gradient(180deg,#4285f4,#34a853);border-radius:0 3px 3px 0}
.nav-item .nav-icon{font-size:16px;width:22px;text-align:center;flex-shrink:0}
/* Sidebar Footer */
.sidebar-footer{border-top:1px solid rgba(255,255,255,.06);padding:0}
.sidebar-footer-top{padding:12px 14px 8px;display:flex;align-items:center}
.sidebar-user{display:flex;align-items:center;gap:10px;flex:1;min-width:0}
.sidebar-user-avatar{width:32px;height:32px;border-radius:8px;background:linear-gradient(135deg,#4285f4,#34a853);color:#fff;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;flex-shrink:0}
.sidebar-user-info{display:flex;flex-direction:column;min-width:0}
.sidebar-user-name{font-size:13px;font-weight:600;color:rgba(255,255,255,.85);line-height:1.2}
.sidebar-user-role{font-size:10px;color:rgba(255,255,255,.3);line-height:1.2;margin-top:2px}
.sidebar-footer-actions{display:flex;align-items:center;gap:6px;padding:4px 14px 14px}
.sidebar-action-btn{display:flex;align-items:center;justify-content:center;gap:6px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);border-radius:8px;color:rgba(255,255,255,.45);cursor:pointer;transition:all .2s ease;padding:8px 10px;font-size:12px;font-weight:500;font-family:inherit}
.sidebar-action-btn:hover{background:rgba(255,255,255,.1);color:rgba(255,255,255,.9);border-color:rgba(255,255,255,.15)}
.sidebar-action-btn svg{flex-shrink:0}
.sidebar-logout-btn{flex:1;justify-content:center}
.sidebar-logout-btn:hover{background:rgba(234,67,53,.15);color:#f87171;border-color:rgba(234,67,53,.3)}

/* Main */
.main{margin-left:var(--sidebar-w);flex:1;padding:32px 36px;min-height:100vh}
.page-title{font-size:26px;font-weight:800;margin-bottom:6px;color:var(--text);letter-spacing:-.3px}
.page-desc{font-size:14px;color:var(--text2);margin-bottom:28px;line-height:1.6}

/* Cards */
.card{background:linear-gradient(135deg,#ffffff 0%,#f9fafb 100%);border-radius:var(--radius);padding:32px;box-shadow:0 10px 40px rgba(0,0,0,.08);border:1px solid rgba(0,0,0,.06);margin-bottom:24px;position:relative;overflow:hidden}
.card::before{content:'';position:absolute;top:0;left:0;right:0;height:4px;background:linear-gradient(90deg,var(--accent),var(--accent2));opacity:.85}
.card-title{font-size:17px;font-weight:700;margin-bottom:18px;display:flex;align-items:center;gap:10px}
.card-title .ct-icon{font-size:20px}

/* Provider list */
.prov-list{display:flex;flex-direction:column;gap:8px;margin-bottom:20px;max-height:520px;overflow-y:auto;padding-right:4px}
.prov-list::-webkit-scrollbar{width:5px} .prov-list::-webkit-scrollbar-track{background:#f1f1f1;border-radius:4px} .prov-list::-webkit-scrollbar-thumb{background:#c1c1c1;border-radius:4px}
.prov-item{display:flex;align-items:center;gap:14px;padding:16px 18px;border:2px solid var(--border);border-radius:12px;cursor:pointer;transition:all .3s ease;background:#fff}
.prov-item:hover{border-color:var(--accent);transform:translateY(-2px);box-shadow:0 8px 25px rgba(66,133,244,.12)}
.prov-item.selected{border-color:var(--accent);background:linear-gradient(135deg,#e8f0fe,#e6f4ea);box-shadow:0 4px 20px rgba(66,133,244,.15)}
.prov-item.current{border-color:var(--accent2);background:linear-gradient(135deg,#e6f4ea,#dcfce7)}
.prov-icon{width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0}
.prov-info{flex:1;min-width:0}
.prov-name{font-size:15px;font-weight:700;color:var(--text)}
.prov-desc{font-size:12px;color:var(--text2);margin-top:2px}
.prov-badge{font-size:10px;font-weight:700;padding:3px 10px;border-radius:8px;flex-shrink:0}

/* Channel list */
.ch-list{display:flex;flex-direction:column;gap:8px;margin-bottom:20px}
.ch-item{display:flex;align-items:center;gap:12px;padding:14px 16px;border:2px solid var(--border);border-radius:12px;cursor:pointer;transition:all .3s ease;background:#fff}
.ch-item:hover{border-color:var(--accent);transform:translateY(-1px);box-shadow:0 4px 15px rgba(66,133,244,.08)}
.ch-item.selected{border-color:var(--accent);background:linear-gradient(135deg,#e8f0fe,#e6f4ea)}
.ch-item.active-ch{border-color:var(--accent2);background:linear-gradient(135deg,#e6f4ea,#dcfce7)}
.ch-icon{font-size:24px;width:36px;text-align:center;flex-shrink:0}
.ch-info{flex:1} .ch-name{font-size:14px;font-weight:700} .ch-desc{font-size:12px;color:var(--text2);margin-top:1px}

/* Fields */
.field{margin-bottom:18px}
.field label{display:block;font-size:13px;color:var(--text2);margin-bottom:8px;font-weight:600;text-transform:uppercase;letter-spacing:.5px}
.field input,.field select{width:100%;padding:12px 16px;background:#f8f9fa;border:2px solid var(--border);border-radius:10px;color:var(--text);font-size:15px;outline:none;transition:all .3s ease}
.field input:focus,.field select:focus{border-color:var(--accent);box-shadow:0 0 0 4px rgba(66,133,244,.1);background:#fff}

/* Buttons */
.btn{display:inline-flex;align-items:center;gap:8px;padding:12px 24px;border-radius:10px;font-size:14px;font-weight:700;cursor:pointer;transition:all .3s ease;border:none}
.btn-primary{background:linear-gradient(135deg,#4285f4,#34a853);color:#fff;box-shadow:0 4px 15px rgba(66,133,244,.3)}
.btn-primary:hover{transform:translateY(-2px);box-shadow:0 8px 25px rgba(66,133,244,.4)}
.btn-success{background:linear-gradient(135deg,#34a853,#1e8e3e);color:#fff;box-shadow:0 4px 15px rgba(52,168,83,.3)}
.btn-success:hover{transform:translateY(-2px);box-shadow:0 8px 25px rgba(52,168,83,.4)}
.btn-outline{background:#fff;border:2px solid var(--border);color:var(--text2)}
.btn-outline:hover{border-color:var(--accent);color:var(--accent);background:#f8f9fa;transform:translateY(-1px);box-shadow:0 4px 12px rgba(0,0,0,.06)}
.btn-danger{background:linear-gradient(135deg,#ea4335,#c5221f);color:#fff;box-shadow:0 4px 15px rgba(234,67,53,.3)}
.btn:disabled{opacity:.4;cursor:not-allowed;transform:none!important;box-shadow:none!important}
.btn-row{display:flex;gap:10px;margin-top:20px;flex-wrap:wrap}
.btn-sm{padding:6px 14px;font-size:12px;border-radius:8px}
.dev-item{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border:2px solid var(--border);border-radius:12px;margin-bottom:10px;transition:all .3s ease}
.dev-item:hover{border-color:var(--accent);background:rgba(66,133,244,.03);transform:translateY(-1px);box-shadow:0 4px 15px rgba(0,0,0,.06)}
.dev-info{flex:1;min-width:0}
.dev-name{font-weight:700;font-size:14px;color:var(--text1);margin-bottom:4px}
.dev-meta{font-size:12px;color:var(--text2)}

/* Status */
.status{padding:14px 18px;border-radius:10px;font-size:13px;margin-top:14px;display:none;font-weight:600;transition:all .3s ease}
.status.ok{display:block;background:#e6f4ea;border:1px solid #34a853;color:#1e8e3e}
.status.fail{display:block;background:#fce8e6;border:1px solid #ea4335;color:#c5221f}
.status.loading{display:block;background:#e8f0fe;border:1px solid #4285f4;color:#1967d2}
.status.warn{display:block;background:#fef7e0;border:1px solid #fbbc05;color:#b45309}

/* Info rows */
.info-grid{display:grid;gap:0}
.info-row{display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid #f0f1f3;transition:background .15s ease}
.info-row:hover{background:rgba(66,133,244,.03);padding:12px 8px;margin:0 -8px;border-radius:6px}
.info-row:last-child{border:none}
.info-k{font-size:13px;color:var(--text2);font-weight:600} .info-v{font-size:13px;font-weight:700;color:var(--text);text-align:right;max-width:65%;word-break:break-all}
.badge{display:inline-block;padding:4px 12px;border-radius:20px;font-size:11px;font-weight:800;letter-spacing:.3px}
.bg-green{background:#dcfce7;color:#166534} .bg-red{background:#fee2e2;color:#991b1b} .bg-blue{background:#dbeafe;color:#1e40af}

/* Log box */
.log-box{background:#0f172a;color:#94a3b8;border-radius:10px;padding:18px;font-family:'JetBrains Mono','Fira Code','Courier New',monospace;font-size:12px;max-height:400px;overflow-y:auto;white-space:pre-wrap;line-height:1.7}

/* Config pane */
.config-pane{margin-top:18px;padding:22px;background:#f8f9fa;border:2px solid var(--border);border-radius:12px}

/* Sections */
.section{display:none} .section.active{display:block}

/* Chat */
.chat-box{display:flex;flex-direction:column;height:440px;border:2px solid var(--border);border-radius:16px;overflow:hidden;background:#fafbfc}
.chat-msgs{flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:12px}
.chat-msg{max-width:85%;padding:12px 16px;border-radius:14px;font-size:14px;line-height:1.6;word-wrap:break-word;white-space:pre-wrap}
.chat-msg.user{align-self:flex-end;background:linear-gradient(135deg,#4285f4,#34a853);color:#fff;border-bottom-right-radius:4px}
.chat-msg.ai{align-self:flex-start;background:#fff;border:1px solid var(--border);color:var(--text);border-bottom-left-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,.04)}
.chat-msg.ai .meta{font-size:11px;color:var(--text2);margin-top:8px;border-top:1px solid #f0f1f3;padding-top:6px}
.chat-input{display:flex;gap:10px;padding:14px;border-top:2px solid var(--border);background:#fff}
.chat-input input{flex:1;padding:12px 16px;border:2px solid var(--border);border-radius:10px;font-size:14px;outline:none;transition:all .3s ease} .chat-input input:focus{border-color:var(--accent);box-shadow:0 0 0 4px rgba(66,133,244,.1)}
.chat-input button{padding:12px 24px;background:linear-gradient(135deg,#4285f4,#34a853);color:#fff;border:none;border-radius:10px;font-weight:700;cursor:pointer;font-size:14px;transition:all .3s ease;box-shadow:0 4px 15px rgba(66,133,244,.3)}
.chat-input button:hover{transform:translateY(-1px);box-shadow:0 6px 20px rgba(66,133,244,.4)}

/* Config Editor */
.json-editor{width:100%;min-height:300px;font-family:'JetBrains Mono','Fira Code','Courier New',monospace;font-size:12px;padding:18px;background:#0f172a;color:#e2e8f0;border:none;border-radius:10px;outline:none;resize:vertical;line-height:1.7;tab-size:2}

/* QR */
.qr-box{text-align:center;padding:24px;background:#fff;border-radius:12px;border:1px solid var(--border)}
.qr-box canvas{max-width:200px;max-height:200px}

/* History item */
.hist-item{display:flex;align-items:center;gap:12px;padding:12px 16px;border:2px solid var(--border);border-radius:10px;cursor:pointer;transition:all .3s ease}
.hist-item:hover{border-color:var(--accent);background:rgba(66,133,244,.04);transform:translateY(-1px);box-shadow:0 4px 12px rgba(0,0,0,.06)}

/* Doctor */
.doc-actions{display:flex;gap:12px;flex-wrap:wrap}
.doc-btn{display:flex;align-items:center;gap:10px;padding:16px 22px;border-radius:12px;cursor:pointer;border:2px solid var(--border);background:linear-gradient(135deg,#ffffff 0%,#f9fafb 100%);transition:all .3s ease;flex:1;min-width:160px}
.doc-btn:hover{border-color:var(--accent);box-shadow:0 8px 25px rgba(66,133,244,.12);transform:translateY(-2px)}
.doc-btn.running{opacity:.6;pointer-events:none}
.doc-btn .db-icon{font-size:26px;width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.doc-btn .db-info{flex:1} .doc-btn .db-title{font-size:14px;font-weight:700;color:var(--text)} .doc-btn .db-desc{font-size:12px;color:var(--text2);margin-top:3px}
.doc-summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:12px;margin-bottom:18px}
.doc-stat{text-align:center;padding:16px 10px;background:linear-gradient(135deg,#f8f9fa,#f0f4ff);border-radius:12px;border:1px solid var(--border)}
.doc-stat .ds-num{font-size:30px;font-weight:800;line-height:1} .doc-stat .ds-label{font-size:12px;color:var(--text2);margin-top:6px;font-weight:600}
.doc-checks{display:flex;flex-direction:column;gap:6px;max-height:400px;overflow-y:auto}
.doc-check{display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:10px;font-size:13px;border:1px solid var(--border);background:#fff}
.doc-check.pass{border-left:4px solid #22c55e} .doc-check.warn{border-left:4px solid #f59e0b} .doc-check.fail{border-left:4px solid #ef4444}
.doc-check .dc-icon{font-size:18px;flex-shrink:0;width:22px;text-align:center} .doc-check .dc-text{flex:1;color:var(--text);font-weight:600} .doc-check .dc-detail{color:var(--text2);font-size:12px;max-width:50%;text-align:right}
.doc-hist{display:flex;flex-direction:column;gap:8px}
.doc-hist-item{display:flex;align-items:center;gap:12px;padding:10px 14px;border:1px solid var(--border);border-radius:10px;font-size:13px;transition:all .3s ease}
.doc-hist-item:hover{border-color:var(--accent);box-shadow:0 2px 8px rgba(0,0,0,.04)}
.doc-hist-item .dh-date{font-weight:700;color:var(--text);min-width:140px} .doc-hist-item .dh-mode{font-size:11px;font-weight:700;padding:3px 10px;border-radius:8px;background:#dbeafe;color:#1e40af}
.doc-hist-item .dh-result{flex:1;text-align:right;font-weight:600}

/* Fallback */
.fb-chain{display:flex;flex-direction:column;gap:10px}
.fb-item{display:flex;align-items:center;gap:14px;padding:14px 18px;border-radius:12px;border:2px solid var(--border);background:linear-gradient(135deg,#ffffff 0%,#f9fafb 100%);transition:all .3s ease}
.fb-item:hover{border-color:var(--accent);transform:translateY(-1px);box-shadow:0 4px 15px rgba(66,133,244,.08)}
.fb-item .fb-icon{font-size:24px;width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.fb-item .fb-info{flex:1} .fb-item .fb-name{font-size:14px;font-weight:700;color:var(--text)} .fb-item .fb-model{font-size:12px;color:var(--text2);margin-top:3px}
.fb-badge{display:inline-block;padding:3px 10px;border-radius:8px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px}
.fb-badge.primary{background:linear-gradient(135deg,#dbeafe,#e8f0fe);color:#1d4ed8} .fb-badge.fallback{background:linear-gradient(135deg,#fef3c7,#fef7e0);color:#92400e}
.fb-status-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0;box-shadow:0 0 6px rgba(0,0,0,.1)}
.fb-status-dot.active{background:#22c55e;box-shadow:0 0 8px rgba(34,197,94,.3)} .fb-status-dot.configured{background:#f59e0b;box-shadow:0 0 8px rgba(245,158,11,.3)} .fb-status-dot.nokey{background:#ef4444;box-shadow:0 0 8px rgba(239,68,68,.3)}
.fb-remove{background:#fff;border:2px solid #fecaca;color:#ef4444;padding:6px 14px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;transition:all .3s ease}
.fb-remove:hover{background:#fef2f2;border-color:#ef4444;transform:translateY(-1px)}
.fb-empty{text-align:center;padding:24px;color:var(--text2);font-size:14px}

/* Dark Mode */
body.dark{--bg:#0f172a;--sidebar-bg:#0a0e1a;--card-bg:#1e293b;--text:#e2e8f0;--text2:#94a3b8;--border:#334155}
body.dark{background:#0f172a}
body.dark .nav-group-label{color:rgba(255,255,255,.2)}
body.dark .sidebar-action-btn{background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.06)}
body.dark .sidebar-action-btn:hover{background:rgba(255,255,255,.1);color:rgba(255,255,255,.9)}
body.dark .sidebar-logout-btn:hover{background:rgba(234,67,53,.12);color:#f87171;border-color:rgba(234,67,53,.25)}
body.dark .card{background:linear-gradient(135deg,var(--card-bg) 0%,#1a2438 100%);border-color:var(--border)}
body.dark .prov-item,body.dark .ch-item{background:var(--card-bg);border-color:var(--border)}
body.dark .prov-item.current{background:#1a3a2a;border-color:var(--accent2)}
body.dark .prov-item.selected,body.dark .ch-item.selected{background:#1a2a4a;border-color:var(--accent)}
body.dark .config-pane{background:#1a2438;border-color:var(--border)}
body.dark .field input,body.dark .field select,body.dark .field textarea{background:#0f172a;border-color:var(--border);color:var(--text)}
body.dark .btn-outline{background:var(--card-bg);border-color:var(--border);color:var(--text2)}
body.dark .chat-box{background:#1a2438;border-color:var(--border)} body.dark .chat-input{background:var(--card-bg);border-color:var(--border)}
body.dark .chat-msg.ai{background:var(--card-bg);border-color:var(--border)}
body.dark .chat-input input{background:#0f172a;border-color:var(--border);color:var(--text)}
body.dark .info-row{border-color:var(--border)}
body.dark .dev-item{border-color:var(--border)} body.dark .dev-item:hover{border-color:var(--accent);background:rgba(66,133,244,.06)}
body.dark .hist-item{border-color:var(--border)} body.dark .hist-item:hover{background:rgba(66,133,244,.08)}
body.dark .log-box{background:#0a0e1a}
body.dark .qr-box{background:var(--card-bg);border-color:var(--border)}
body.dark .doc-btn{background:linear-gradient(135deg,var(--card-bg) 0%,#1a2438 100%);border-color:var(--border)} body.dark .doc-stat{background:#1a2438;border-color:var(--border)}
body.dark .doc-check{background:var(--card-bg);border-color:var(--border)} body.dark .doc-hist-item{border-color:var(--border)}
body.dark .doc-hist-item .dh-mode{background:#1a2a4a;color:#60a5fa}
body.dark .fb-item{background:linear-gradient(135deg,var(--card-bg) 0%,#1a2438 100%);border-color:var(--border)}
body.dark .fb-badge.primary{background:#1e3a5f;color:#60a5fa} body.dark .fb-badge.fallback{background:#3a2a0a;color:#fbbf24}
body.dark .fb-remove{background:var(--card-bg);border-color:#4a1a1a;color:#f87171} body.dark .fb-remove:hover{background:#2e0a0a}
body.dark .status.ok{background:#0a2e1a;border-color:#1a4a2a;color:#4ade80}
body.dark .status.fail{background:#2e0a0a;border-color:#4a1a1a;color:#f87171}
body.dark .status.loading{background:#0a1a2e;border-color:#1a2a4a;color:#60a5fa}
body.dark .status.warn{background:#2e1a0a;border-color:#4a2a1a;color:#fbbf24}
body.dark .info-row:hover{background:rgba(66,133,244,.05)}

/* Animations */
@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
.section.active{animation:fadeIn .25s ease}

/* Button Loading Spinner */
.btn-loading{position:relative;color:transparent!important;pointer-events:none}
.btn-loading::after{content:'';position:absolute;width:16px;height:16px;top:50%;left:50%;margin:-8px 0 0 -8px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .6s linear infinite}

/* Scrollbar */
.log-box::-webkit-scrollbar,.chat-msgs::-webkit-scrollbar{width:5px}
.log-box::-webkit-scrollbar-track,.chat-msgs::-webkit-scrollbar-track{background:transparent}
.log-box::-webkit-scrollbar-thumb,.chat-msgs::-webkit-scrollbar-thumb{background:rgba(0,0,0,.15);border-radius:4px}
body.dark .log-box::-webkit-scrollbar-thumb,body.dark .chat-msgs::-webkit-scrollbar-thumb{background:rgba(255,255,255,.1)}

/* Empty State */
.empty-state{text-align:center;padding:32px 20px;color:var(--text2)}
.empty-state .empty-icon{font-size:36px;margin-bottom:12px;opacity:.5}
.empty-state .empty-text{font-size:14px;line-height:1.6}

/* Responsive */
.hamburger{display:none;position:fixed;top:12px;left:12px;z-index:20;background:var(--sidebar-bg);color:#fff;border:none;border-radius:10px;padding:10px 14px;font-size:18px;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.2);backdrop-filter:blur(8px)}
.hamburger:active{transform:scale(.92)}
@media(max-width:768px){
  .sidebar{transform:translateX(-100%);transition:transform .25s} .sidebar.open{transform:translateX(0)}
  .main{margin-left:0;padding:20px 16px;padding-top:56px}
  .hamburger{display:block}
  .prov-list,.ch-list{gap:6px}
}`;

// --- Login HTML ---
function loginPage() {
  return `<!DOCTYPE html><html lang="vi"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenClaw Panel</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',Roboto,-apple-system,BlinkMacSystemFont,sans-serif;background:linear-gradient(135deg,#f0f4ff 0%,#e8f5e9 50%,#f3e5f5 100%);color:#1a1a2e;min-height:100vh;display:flex;align-items:center;justify-content:center}
.wrap{width:100%;max-width:440px;padding:20px}
.logo{text-align:center;margin-bottom:36px} .logo h1{font-size:32px;font-weight:800;background:linear-gradient(135deg,#4285f4,#34a853);-webkit-background-clip:text;-webkit-text-fill-color:transparent} .logo p{color:#5f6368;font-size:14px;margin-top:8px}
.card{background:linear-gradient(135deg,#ffffff 0%,#f9fafb 100%);border:1px solid rgba(0,0,0,.06);border-radius:16px;padding:36px;box-shadow:0 10px 40px rgba(0,0,0,.08);position:relative;overflow:hidden}
.card::before{content:'';position:absolute;top:0;left:0;right:0;height:4px;background:linear-gradient(90deg,#4285f4,#34a853,#fbbc05,#ea4335)}
.field{margin-bottom:20px} .field label{display:block;font-size:13px;color:#5f6368;margin-bottom:8px;font-weight:600;text-transform:uppercase;letter-spacing:.5px}
.field input{width:100%;padding:12px 16px;background:#f8f9fa;border:2px solid #e8eaed;border-radius:10px;color:#1a1a2e;font-size:15px;outline:none;transition:all .3s ease} .field input:focus{border-color:#4285f4;background:#fff;box-shadow:0 0 0 4px rgba(66,133,244,.1)}
.btn{width:100%;padding:14px;background:linear-gradient(135deg,#4285f4,#34a853);color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;transition:all .3s ease;box-shadow:0 4px 15px rgba(66,133,244,.3)} .btn:hover{transform:translateY(-2px);box-shadow:0 8px 25px rgba(66,133,244,.4)} .btn:disabled{opacity:.5;cursor:not-allowed;transform:none;box-shadow:none}
.err{padding:10px 14px;border-radius:8px;font-size:13px;margin-top:14px;display:none;font-weight:500;background:#fce8e6;border:1px solid #f5c6cb;color:#ea4335} .err.show{display:block}
@media(prefers-color-scheme:dark){
  body{background:linear-gradient(135deg,#0f172a 0%,#1a2438 50%,#1e1a2e 100%);color:#e2e8f0}
  .card{background:linear-gradient(135deg,#1e293b,#1a2438);border-color:#334155}
  .field input{background:#0f172a;border-color:#334155;color:#e2e8f0}
  .field input:focus{background:#0f172a;border-color:#4285f4;box-shadow:0 0 0 4px rgba(66,133,244,.2)}
  .field label{color:#94a3b8} .logo p{color:#94a3b8}
  .err{background:#2e0a0a;border-color:#4a1a1a;color:#f87171}
}
</style></head><body>
<div class="wrap">
  <div class="logo"><h1>OpenClaw</h1><p>Management Panel</p></div>
  <div class="card">
    <form id="f">
      <div class="field"><label>Username</label><input type="text" id="u" value="root" autocomplete="username"></div>
      <div class="field"><label>Password</label><input type="password" id="p" placeholder="Enter root password" autocomplete="current-password" autofocus></div>
      <button type="submit" class="btn" id="b">Login</button>
      <div class="err" id="e"></div>
    </form>
  </div>
</div>
<script>
document.getElementById('f').addEventListener('submit',async e=>{
  e.preventDefault();const b=document.getElementById('b'),err=document.getElementById('e');
  b.disabled=true;b.textContent='Authenticating...';err.className='err';
  try{const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:document.getElementById('u').value,password:document.getElementById('p').value})});
  const d=await r.json();if(d.ok)window.location.href='/panel';else{err.className='err show';err.textContent=d.error}}
  catch(x){err.className='err show';err.textContent='Connection error'}
  b.disabled=false;b.textContent='Login'});
</script></body></html>`;
}

// --- Panel HTML ---
function panelPage() {
  const provJSON = JSON.stringify(Object.entries(PROVIDERS).map(([k,v])=>({id:k,name:v.name,color:v.color,icon:v.icon,models:v.models,category:v.category||'cloud',extraEnvKeys:v.extraEnvKeys||[]})));
  const chJSON = JSON.stringify(Object.entries(CHANNELS).map(([k,v])=>({id:k,name:v.name,icon:v.icon,desc:v.desc,envKeys:v.envKeys,canPair:v.canPair})));

  return `<!DOCTYPE html><html lang="vi"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenClaw Panel</title>
<style>${CSS}</style></head><body>

<button class="hamburger" onclick="document.querySelector('.sidebar').classList.toggle('open')">&#9776;</button>

<div class="sidebar">
  <div class="brand"><h1>OpenClaw</h1><p>Management Panel</p></div>
  <nav>
    <div class="nav-group-label">AI</div>
    <div class="nav-item active" onclick="showTab('provider',this)"><span class="nav-icon">\u2728</span>AI Provider</div>
    <div class="nav-item" onclick="showTab('fallback',this)"><span class="nav-icon">\ud83d\udd04</span>Fallback</div>
    <div class="nav-item" onclick="showTab('agents',this)"><span class="nav-icon">\ud83e\udd16</span>Agents</div>
    <div class="nav-item" onclick="showTab('channels',this)"><span class="nav-icon">\ud83d\udce8</span>Channels</div>
    <div class="nav-item" onclick="showTab('chat',this)"><span class="nav-icon">\ud83d\udcac</span>Playground</div>
    <div class="nav-group-label">Infrastructure</div>
    <div class="nav-item" onclick="showTab('gateway',this)"><span class="nav-icon">\ud83d\udd11</span>Gateway</div>
    <div class="nav-item" onclick="showTab('domain',this)"><span class="nav-icon">\ud83c\udf10</span>Domain & SSL</div>
    <div class="nav-item" onclick="showTab('plugins',this)"><span class="nav-icon">\ud83e\udde9</span>Plugins</div>
    <div class="nav-item" onclick="showTab('skills',this)"><span class="nav-icon">\u26a1</span>Skills</div>
    <div class="nav-item" onclick="showTab('config',this)"><span class="nav-icon">\ud83d\udd27</span>Config</div>
    <div class="nav-item" onclick="showTab('qr',this)"><span class="nav-icon">\ud83d\udcf1</span>QR Code</div>
    <div class="nav-group-label">Monitoring</div>
    <div class="nav-item" onclick="showTab('analytics',this)"><span class="nav-icon">\ud83d\udcca</span>Analytics</div>
    <div class="nav-item" onclick="showTab('history',this)"><span class="nav-icon">\ud83d\udcdd</span>History</div>
    <div class="nav-item" onclick="showTab('status',this)"><span class="nav-icon">\ud83d\udfe2</span>Status</div>
    <div class="nav-item" onclick="showTab('doctor',this)"><span class="nav-icon">\ud83e\ude7a</span>Doctor</div>
    <div class="nav-group-label">Admin</div>
    <div class="nav-item" onclick="showTab('users',this)"><span class="nav-icon">\ud83d\udc65</span>Users</div>
    <div class="nav-item" onclick="showTab('backup',this)"><span class="nav-icon">\ud83d\udce6</span>Backup</div>
    <div class="nav-item" onclick="showTab('update',this)"><span class="nav-icon">\u2b06\ufe0f</span>Update</div>
  </nav>
  <div class="sidebar-footer">
    <div class="sidebar-footer-top">
      <div class="sidebar-user">
        <div class="sidebar-user-avatar">R</div>
        <div class="sidebar-user-info">
          <span class="sidebar-user-name">root</span>
          <span class="sidebar-user-role">Administrator</span>
        </div>
      </div>
    </div>
    <div class="sidebar-footer-actions">
      <button class="sidebar-action-btn" id="themeToggleBtn" onclick="toggleDark()" title="Toggle theme">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 1v1m0 12v1m7-7h-1M2 8H1m12.07-4.07-.71.71M3.64 12.36l-.71.71m10.14 0-.71-.71M3.64 3.64l-.71-.71M11 8a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
      </button>
      <button class="sidebar-action-btn sidebar-logout-btn" onclick="doLogout()" title="Log out">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 14H3a1 1 0 01-1-1V3a1 1 0 011-1h3m4 9l3-3-3-3m3 3H6"/></svg>
        <span>Log out</span>
      </button>
    </div>
  </div>
</div>

<div class="main">

  <!-- TAB: Provider -->
  <div class="section active" id="sec-provider">
    <div class="page-title">AI Provider</div>
    <div class="page-desc">Select AI provider, model and enter API key.</div>
    <div class="card"><div class="card-title"><span class="ct-icon">\ud83d\udccc</span> Current</div><div id="currentProvider" class="info-grid"></div></div>
    <div class="card"><div class="card-title"><span class="ct-icon">\ud83d\udd04</span> Change Provider</div>
      <div class="prov-list" id="providerList"></div>
      <div id="providerConfig" style="display:none" class="config-pane">
        <div class="field"><label>Model</label><select id="provModel"></select></div>
        <div class="field"><label>API Key</label><input type="password" id="provKey" placeholder="Enter API key"></div>
        <div id="provExtraFields"></div>
        <div class="btn-row">
          <button class="btn btn-outline" onclick="testProviderKey()">Test Key</button>
          <button class="btn btn-outline" onclick="saveProviderKey()" style="border-color:var(--accent2);color:var(--accent2)">Save Key</button>
          <button class="btn btn-primary" onclick="applyProvider()">Apply & Switch Model</button>
        </div>
        <div class="status" id="provStatus"></div>
      </div>
    </div>
  </div>

  <!-- TAB: Fallback -->
  <div class="section" id="sec-fallback">
    <div class="page-title">Multi-Provider Fallback</div>
    <div class="page-desc">Configure fallback provider — auto switch when primary is down.</div>
    <div class="card">
      <div class="card-title"><span class="ct-icon">\u26d3\ufe0f</span> Fallback Chain</div>
      <div id="fbChain" class="fb-chain"><div class="muted">Loading...</div></div>
    </div>
    <div class="card">
      <div class="card-title"><span class="ct-icon">\u2795</span> Add Fallback Provider</div>
      <div class="field"><label>Provider</label><select id="fbProvider" onchange="onFbProviderChange()"><option value="">-- Select provider --</option></select></div>
      <div class="field"><label>Model</label><select id="fbModel"></select></div>
      <div class="field"><label>API Key</label><input type="password" id="fbApiKey" placeholder="Enter API key for this provider"></div>
      <div class="btn-row"><button class="btn btn-primary" onclick="addFallbackProvider()">Add to Chain</button></div>
      <div class="status" id="fbAddStatus"></div>
    </div>
    <div class="card">
      <div class="card-title"><span class="ct-icon">\u2699\ufe0f</span> Settings</div>
      <div class="field"><label>Rate limit (requests/min)</label><input type="number" id="fbRateLimit" value="60" min="1" max="1000"></div>
      <div class="field"><label>Cooldown on fail (seconds)</label><input type="number" id="fbCooldown" value="300" min="10" max="3600"></div>
      <div class="btn-row"><button class="btn btn-primary" onclick="saveFallbackSettings()">Save Settings</button></div>
      <div class="status" id="fbSettingsStatus"></div>
    </div>
  </div>

  <!-- TAB: Agents -->
  <div class="section" id="sec-agents">
    <div class="page-title">Multi-Agent Management</div>
    <div class="page-desc">Manage agents — each agent has its own workspace, model and routing.</div>
    <div class="card">
      <div class="card-title"><span class="ct-icon">\ud83e\udd16</span> Agent List</div>
      <div id="agentList" class="fb-chain"><div class="muted">Loading...</div></div>
    </div>
    <div class="card" id="agentIdentityCard" style="display:none">
      <div class="card-title"><span class="ct-icon">\u270f\ufe0f</span> Identity — <span id="agentIdentityName"></span></div>
      <div class="field"><label>Display Name</label><input type="text" id="agentIdName" placeholder="e.g. Support Bot"></div>
      <div class="field"><label>Emoji</label><input type="text" id="agentIdEmoji" placeholder="e.g. \ud83e\udd16"></div>
      <div class="field"><label>Theme</label><input type="text" id="agentIdTheme" placeholder="e.g. professional, casual"></div>
      <div class="btn-row"><button class="btn btn-outline" onclick="cancelEditIdentity()">Cancel</button> <button class="btn btn-primary" onclick="saveAgentIdentity()">Save Identity</button></div>
      <div class="status" id="agentIdentityStatus"></div>
    </div>
    <div class="card">
      <div class="card-title"><span class="ct-icon">\u2795</span> Add New Agent</div>
      <div class="field"><label>Agent Name (ID)</label><input type="text" id="newAgentName" placeholder="e.g. support, sales, dev"></div>
      <div class="field"><label>Model</label><select id="newAgentModel"><option value="">-- Select model --</option></select></div>
      <div class="field"><label>Channel Binding (optional)</label><select id="newAgentBind"><option value="">-- No binding --</option></select></div>
      <div class="btn-row"><button class="btn btn-primary" onclick="addAgent()">Add Agent</button></div>
      <div class="status" id="addAgentStatus"></div>
    </div>
  </div>

  <!-- TAB: Channels -->
  <div class="section" id="sec-channels">
    <div class="page-title">Messaging Channels</div>
    <div class="page-desc">Configure and pair chat channels with AI.</div>
    <div class="card"><div class="card-title"><span class="ct-icon">\u2705</span> Active</div><div id="currentChannels" class="info-grid"></div></div>
    <div class="card"><div class="card-title"><span class="ct-icon">\u2795</span> Add Channel</div>
      <div class="ch-list" id="channelList"></div>
      <div id="channelConfig" style="display:none" class="config-pane">
        <div id="channelFields"></div>
        <div class="btn-row">
          <button class="btn btn-primary" onclick="saveChannel()">Save & Restart</button>
          <button class="btn btn-outline" id="pairChannelBtn" style="display:none" onclick="showPairForm()">Pair</button>
        </div>
        <div class="status" id="channelStatus"></div>
        <div id="pairForm" style="display:none;margin-top:14px">
          <div class="field"><label>Pairing Code</label><input type="text" id="pairCode" placeholder="Enter code from bot"></div>
          <div class="btn-row"><button class="btn btn-success" onclick="pairChannel()">Pair</button></div>
          <div class="status" id="pairStatus"></div>
        </div>
      </div>
    </div>
  </div>

  <!-- TAB: Gateway -->
  <div class="section" id="sec-gateway">
    <div class="page-title">Gateway</div>
    <div class="page-desc">Auth token, device pairing and dashboard management.</div>
    <div class="card"><div class="card-title"><span class="ct-icon">\ud83d\udd11</span> Information</div><div id="gatewayInfo" class="info-grid"></div></div>
    <div class="card"><div class="card-title"><span class="ct-icon">\ud83d\udd17</span> Pair Dashboard</div>
      <p style="font-size:13px;color:var(--text2);margin-bottom:12px;line-height:1.6">Open the dashboard link below in a <strong>new tab</strong>, wait for it to load, then come back here and click <strong>Pair</strong> to approve.</p>
      <div id="pairDashboardUrl" style="padding:10px 14px;background:#f0f4ff;border:1.5px solid var(--accent);border-radius:8px;font-family:monospace;font-size:12px;cursor:pointer;color:var(--accent);margin-bottom:12px;word-break:break-all" onclick="window.open(this.textContent,'_blank')"></div>
      <div class="btn-row">
        <button class="btn btn-success" id="pairDeviceBtn" onclick="pairDevice()">Pair Device</button>
        <button class="btn btn-outline" onclick="loadDevices()">Refresh</button>
      </div>
      <div class="status" id="pairDeviceStatus"></div>
    </div>
    <div class="card"><div class="card-title"><span class="ct-icon">\ud83d\udcf1</span> Paired Devices</div><div id="deviceList"><div style="color:var(--text2);font-size:12px;padding:8px">Loading...</div></div></div>
    <div class="card"><div class="card-title"><span class="ct-icon">\ud83d\udd04</span> Change Token</div>
      <div class="field"><label>Custom token (optional)</label><input type="text" id="customToken" placeholder="Leave empty to generate random"></div>
      <div class="btn-row">
        <button class="btn btn-primary" onclick="generateToken()">Generate Random Token</button>
        <button class="btn btn-outline" onclick="applyCustomToken()">Apply Custom Token</button>
      </div>
      <div class="status" id="gatewayStatus"></div>
    </div>
  </div>

  <!-- TAB: Domain -->
  <div class="section" id="sec-domain">
    <div class="page-title">Domain & SSL</div>
    <div class="page-desc">Configure domain with Let's Encrypt certificate.</div>
    <div class="card"><div class="card-title"><span class="ct-icon">\ud83c\udf10</span> Current</div><div id="domainInfo" class="info-grid"></div></div>
    <div class="card"><div class="card-title"><span class="ct-icon">\ud83d\udd12</span> Configure</div>
      <div class="field"><label>Domain</label><input type="text" id="domainInput" placeholder="bot.example.com"></div>
      <div class="field"><label>Let's Encrypt Email (optional)</label><input type="email" id="domainEmail" placeholder="admin@example.com"></div>
      <div class="btn-row">
        <button class="btn btn-primary" onclick="saveDomain()">Configure SSL</button>
        <button class="btn btn-outline" onclick="resetDomainToIP()">Use IP (self-signed)</button>
      </div>
      <div class="status" id="domainStatus"></div>
    </div>
  </div>

  <!-- TAB: Doctor -->
  <div class="section" id="sec-doctor">
    <div class="page-title">System Diagnostics</div>
    <div class="page-desc">Run OpenClaw Doctor to check, repair and optimize the system.</div>
    <div class="card">
      <div class="card-title"><span class="ct-icon">\ud83d\ude80</span> Actions</div>
      <div class="doc-actions">
        <div class="doc-btn" id="docBtnScan" onclick="runDoctor('scan')">
          <div class="db-icon" style="background:#dbeafe;color:#2563eb">\ud83d\udd0d</div>
          <div class="db-info"><div class="db-title">Scan</div><div class="db-desc">Check 19 items, no repair</div></div>
        </div>
        <div class="doc-btn" id="docBtnRepair" onclick="runDoctor('repair')">
          <div class="db-icon" style="background:#dcfce7;color:#16a34a">\ud83d\udd27</div>
          <div class="db-info"><div class="db-title">Auto Repair</div><div class="db-desc">Check + auto repair errors</div></div>
        </div>
        <div class="doc-btn" id="docBtnDeep" onclick="runDoctor('deep')">
          <div class="db-icon" style="background:#fef3c7;color:#d97706">\u26a1</div>
          <div class="db-info"><div class="db-title">Deep Scan</div><div class="db-desc">Deep scan services + gateway</div></div>
        </div>
      </div>
      <div class="status" id="doctorStatus"></div>
    </div>
    <div class="card" id="doctorResultCard" style="display:none">
      <div class="card-title"><span class="ct-icon">\ud83d\udcca</span> Result</div>
      <div class="doc-summary" id="doctorSummary"></div>
      <div class="doc-checks" id="doctorChecks"></div>
    </div>
    <div class="card" id="doctorOutputCard" style="display:none">
      <div class="card-title"><span class="ct-icon">\ud83d\udcbb</span> Output</div>
      <div class="log-box" id="doctorLog" style="max-height:420px"></div>
    </div>
    <div class="card">
      <div class="card-title"><span class="ct-icon">\ud83d\udcc5</span> History</div>
      <div class="doc-hist" id="doctorHistory"><div style="color:var(--text2);font-size:12px;padding:8px">No history yet.</div></div>
    </div>
  </div>

  <!-- TAB: Update -->
  <div class="section" id="sec-update">
    <div class="page-title">Update</div>
    <div class="page-desc">Update OpenClaw Gateway and Management Panel.</div>
    <div class="card"><div class="card-title"><span class="ct-icon">\ud83d\udce6</span> OpenClaw Gateway</div><div id="updateInfo" class="info-grid"></div>
      <div class="btn-row" style="margin-top:16px">
        <button class="btn btn-outline" onclick="checkUpdate()">Check for Updates</button>
        <div class="field" id="updateVersionField" style="display:none;margin:0;min-width:180px"><select id="updateVersionSelect"></select></div>
        <button class="btn btn-primary" id="doUpdateBtn" style="display:none" onclick="doUpdate()">Update Gateway</button>
      </div>
      <div class="status" id="updateStatus"></div>
      <div id="updateLog" style="display:none;margin-top:14px"><div class="log-box" id="updateLogBox"></div></div>
    </div>
    <div class="card"><div class="card-title"><span class="ct-icon">\ud83d\udda5\ufe0f</span> Management Panel</div><div id="panelUpdateInfo" class="info-grid"></div>
      <div class="btn-row" style="margin-top:16px">
        <button class="btn btn-outline" onclick="checkPanelUpdate()">Check Panel Update</button>
        <button class="btn btn-primary" id="doPanelUpdateBtn" style="display:none" onclick="doPanelUpdate()">Update Panel</button>
      </div>
      <div class="status" id="panelUpdateStatus"></div>
    </div>
  </div>

  <!-- TAB: Status -->
  <div class="section" id="sec-status">
    <div class="page-title">System Status</div>
    <div class="page-desc">Monitor services, resources and logs.</div>
    <div class="card"><div class="card-title"><span class="ct-icon">\ud83d\udcca</span> Services & System</div><div id="statusInfo" class="info-grid"></div>
      <div class="btn-row" style="margin-top:16px">
        <button class="btn btn-outline" onclick="loadStatus()">Refresh</button>
        <button class="btn btn-primary" onclick="restartSvc('openclaw')">Restart OpenClaw</button>
        <button class="btn btn-outline" onclick="restartSvc('caddy')">Restart Caddy</button>
      </div>
      <div class="status" id="statusMsg"></div>
    </div>
    <div class="card"><div class="card-title"><span class="ct-icon">\ud83d\udcdd</span> OpenClaw Logs</div><div class="log-box" id="logsBox">Loading...</div></div>
  </div>

  <!-- TAB: Chat Playground -->
  <div class="section" id="sec-chat">
    <div class="page-title">\ud83d\udcac Chat Playground</div>
    <div class="page-desc">Test live chat with the current AI provider.</div>
    <div class="card">
      <div class="card-title"><span class="ct-icon">\u2728</span> <span id="chatProviderLabel">AI Chat</span></div>
      <div class="chat-box">
        <div class="chat-msgs" id="chatMsgs"><div class="chat-msg ai">Hello! I'm an AI assistant. Send a message to test.</div></div>
        <div class="chat-input">
          <input type="text" id="chatInput" placeholder="Enter message..." onkeydown="if(event.key==='Enter')sendChat()">
          <button onclick="sendChat()">Send</button>
        </div>
      </div>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn btn-outline" onclick="clearChat()">Clear Chat</button>
        <span id="chatMeta" style="font-size:11px;color:var(--text2);align-self:center;margin-left:8px"></span>
      </div>
    </div>
  </div>

  <!-- TAB: Usage Analytics -->
  <div class="section" id="sec-analytics">
    <div class="page-title">\ud83d\udcca Usage Analytics</div>
    <div class="page-desc">AI usage statistics — from messaging channels and Chat Playground.</div>
    <div class="card"><div class="card-title"><span class="ct-icon">\ud83d\udcc8</span> Overview</div><div id="analyticsOverview" class="info-grid"></div></div>
    <div class="card"><div class="card-title"><span class="ct-icon">\ud83d\udcf1</span> By Channel</div><div id="analyticsChannels" class="info-grid"></div></div>
    <div class="card"><div class="card-title"><span class="ct-icon">\ud83d\udcc5</span> Messages (7 days)</div>
      <div id="analyticsChart" style="display:flex;align-items:flex-end;gap:6px;height:120px;padding:16px 0"></div>
      <div id="analyticsList" style="margin-top:16px"></div>
    </div>
    <div class="btn-row"><button class="btn btn-outline" onclick="loadAnalytics()">Refresh</button></div>
  </div>

  <!-- TAB: Conversation History -->
  <div class="section" id="sec-history">
    <div class="page-title">\ud83d\udcdd Conversation History</div>
    <div class="page-desc">View recent conversation history.</div>
    <div class="card"><div class="card-title"><span class="ct-icon">\ud83d\udcc2</span> Conversations</div>
      <div id="historyList" style="display:flex;flex-direction:column;gap:8px"></div>
      <div class="btn-row" style="margin-top:16px">
        <button class="btn btn-outline" onclick="loadHistory()">Refresh</button>
      </div>
    </div>
    <div class="card" id="historyDetail" style="display:none">
      <div class="card-title"><span class="ct-icon">\ud83d\udcac</span> <span id="historyDetailTitle">Details</span></div>
      <div id="historyMsgs" style="display:flex;flex-direction:column;gap:8px"></div>
    </div>
  </div>



  <!-- TAB: User Management -->
  <div class="section" id="sec-users">
    <div class="page-title">\ud83d\udc65 User Management</div>
    <div class="page-desc">Manage panel access account.</div>
    <div class="card"><div class="card-title"><span class="ct-icon">\ud83d\udd10</span> Change Root Password</div>
      <div class="field"><label>Current Password</label><input type="password" id="oldPass" placeholder="Enter current password"></div>
      <div class="field"><label>New Password</label><input type="password" id="newPass" placeholder="Enter new password"></div>
      <div class="field"><label>Confirm</label><input type="password" id="confirmPass" placeholder="Re-enter new password"></div>
      <div class="btn-row"><button class="btn btn-primary" onclick="changePassword()">Change Password</button></div>
      <div class="status" id="passStatus"></div>
    </div>
    <div class="card"><div class="card-title"><span class="ct-icon">\ud83d\udee1\ufe0f</span> Security</div>
      <div id="securityInfo" class="info-grid"></div>
      <div class="btn-row" style="margin-top:12px"><button class="btn btn-outline" onclick="loadUsers()">Refresh</button></div>
    </div>
  </div>

  <!-- TAB: Backup & Restore -->
  <div class="section" id="sec-backup">
    <div class="page-title">\ud83d\udce6 Backup & Restore</div>
    <div class="page-desc">Backup and restore system configuration.</div>
    <div class="card"><div class="card-title"><span class="ct-icon">\ud83d\udcbe</span> Backup</div>
      <p style="font-size:13px;color:var(--text2);margin-bottom:16px;line-height:1.6">Create a backup of configuration (openclaw.json, openclaw.env, Caddyfile). API keys are hidden for security.</p>
      <div class="btn-row">
        <button class="btn btn-primary" onclick="downloadBackup()">\ud83d\udce5 Download Backup</button>
        <button class="btn btn-outline" onclick="doBackup()">\ud83d\udccb View JSON</button>
      </div>
      <div class="status" id="backupStatus"></div>
      <div id="backupData" style="display:none;margin-top:14px">
        <div class="field"><label>Backup Data (copy and save)</label>
          <textarea id="backupContent" class="json-editor" style="min-height:160px" readonly></textarea>
        </div>
      </div>
    </div>
    <div class="card"><div class="card-title"><span class="ct-icon">\ud83d\udd04</span> Restore</div>
      <p style="font-size:13px;color:var(--text2);margin-bottom:16px;line-height:1.6">Upload a backup file or paste JSON to restore configuration.</p>
      <div class="btn-row" style="margin-bottom:16px">
        <button class="btn btn-primary" onclick="document.getElementById('restoreFile').click()">\ud83d\udce4 Upload Backup File</button>
        <input type="file" id="restoreFile" accept=".json" style="display:none" onchange="handleRestoreFile(event)">
      </div>
      <div class="field"><label>Or paste backup JSON</label><textarea id="restoreContent" class="json-editor" style="min-height:120px" placeholder="Paste backup JSON here..."></textarea></div>
      <div class="btn-row"><button class="btn btn-danger" onclick="doRestore()">\u26a0\ufe0f Restore</button></div>
      <div class="status" id="restoreStatus"></div>
    </div>
  </div>

  <!-- TAB: Plugins -->
  <div class="section" id="sec-plugins">
    <div class="page-title">\ud83e\udde9 Plugins</div>
    <div class="page-desc">Manage extensions: enable, disable, install or remove plugins.</div>
    <div class="card">
      <div class="card-title"><span class="ct-icon">\ud83d\udce6</span> Installed Plugins</div>
      <div class="btn-row" style="margin-bottom:12px">
        <button class="btn btn-outline" onclick="loadPlugins()">Refresh</button>
        <button class="btn btn-outline" onclick="updateAllPlugins()">Update All</button>
      </div>
      <div id="pluginsList"></div>
      <div class="status" id="pluginsStatus"></div>
    </div>
    <div class="card">
      <div class="card-title"><span class="ct-icon">\u2795</span> Install Plugin</div>
      <p style="font-size:13px;color:var(--text2);margin-bottom:14px;line-height:1.6">Install from npm registry or local archive (.tgz, .zip).</p>
      <div class="field"><label>Package name or path</label><input type="text" id="pluginInstallInput" placeholder="e.g. @openclaw/plugin-name or ./plugin.tgz"></div>
      <div class="btn-row">
        <button class="btn btn-primary" onclick="installPlugin()">Install</button>
      </div>
      <div class="status" id="pluginInstallStatus"></div>
      <div id="pluginInstallLog" style="display:none;margin-top:12px"><div class="log-box" id="pluginInstallLogBox" style="max-height:200px;overflow-y:auto"></div></div>
    </div>
  </div>

  <!-- TAB: Skills -->
  <div class="section" id="sec-skills">
    <div class="page-title">\u26a1 Skills</div>
    <div class="page-desc">Manage AI skills: view eligibility, enable or disable bundled skills.</div>
    <div class="card">
      <div class="card-title"><span class="ct-icon">\ud83d\udcca</span> Overview</div>
      <div id="skillsSummary" class="info-grid"></div>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn btn-outline" onclick="loadSkills()">Refresh</button>
        <select id="skillsFilter" onchange="filterSkills()" style="padding:6px 12px;border:1px solid var(--border);border-radius:8px;background:var(--card-bg);color:var(--text);font-size:13px">
          <option value="all">All Skills</option>
          <option value="eligible">Eligible</option>
          <option value="disabled">Disabled</option>
          <option value="missing">Missing Requirements</option>
        </select>
      </div>
    </div>
    <div class="card">
      <div class="card-title"><span class="ct-icon">\u26a1</span> Skills List</div>
      <div id="skillsList"></div>
      <div class="status" id="skillsStatus"></div>
    </div>
    <div class="card">
      <div class="card-title"><span class="ct-icon">\ud83c\udf10</span> ClawHub — Skill Registry</div>
      <p style="font-size:13px;color:var(--text2);margin-bottom:14px;line-height:1.6">Search and install skills from the ClawHub public registry.</p>
      <div style="display:flex;gap:8px;margin-bottom:12px">
        <input type="text" id="clawhubSearchInput" placeholder="Search skills... e.g. docker, weather, git" style="flex:1;padding:8px 14px;border:1px solid var(--border);border-radius:8px;background:var(--card-bg);color:var(--text);font-size:13px" onkeydown="if(event.key==='Enter')searchClawHub()">
        <button class="btn btn-primary" style="padding:8px 20px" onclick="searchClawHub()">Search</button>
      </div>
      <div id="clawhubResults"></div>
      <div class="status" id="clawhubStatus"></div>
    </div>
    <div class="card">
      <div class="card-title"><span class="ct-icon">\ud83d\udce6</span> Installed from ClawHub</div>
      <div class="btn-row" style="margin-bottom:12px">
        <button class="btn btn-outline" onclick="loadClawHubInstalled()">Refresh</button>
        <button class="btn btn-outline" onclick="updateAllClawHub()">Update All</button>
      </div>
      <div id="clawhubInstalled"></div>
      <div class="status" id="clawhubInstalledStatus"></div>
    </div>
  </div>

  <!-- TAB: Config Editor -->
  <div class="section" id="sec-config">
    <div class="page-title">\ud83d\udd27 Config Editor</div>
    <div class="page-desc">Edit system configuration files directly.</div>
    <div class="card"><div class="card-title"><span class="ct-icon">\ud83d\udcc4</span> openclaw.json</div>
      <textarea id="configJson" class="json-editor" style="min-height:320px"></textarea>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn btn-primary" onclick="saveConfigFile('json')">Save & Restart</button>
        <button class="btn btn-outline" onclick="loadConfigEditor()">Reload</button>
      </div>
      <div class="status" id="configJsonStatus"></div>
    </div>
    <div class="card"><div class="card-title"><span class="ct-icon">\ud83d\udcc4</span> openclaw.env</div>
      <textarea id="configEnv" class="json-editor" style="min-height:200px"></textarea>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn btn-primary" onclick="saveConfigFile('env')">Save & Restart</button>
        <button class="btn btn-outline" onclick="loadConfigEditor()">Reload</button>
      </div>
      <div class="status" id="configEnvStatus"></div>
    </div>
  </div>

  <!-- TAB: QR Code -->
  <div class="section" id="sec-qr">
    <div class="page-title">\ud83d\udcf1 QR Code Pairing</div>
    <div class="page-desc">Ma QR de truy cap dashboard tu dien thoai.</div>
    <div class="card">
      <div class="card-title"><span class="ct-icon">\ud83d\udcf1</span> Dashboard QR</div>
      <div class="qr-box" id="qrBox">
        <div id="qrCanvas" style="margin:16px auto;display:inline-block;padding:12px;background:#fff;border-radius:8px"></div>
        <p style="font-size:12px;color:var(--text2);margin-top:12px" id="qrUrl"></p>
      </div>
      <div class="btn-row" style="justify-content:center;margin-top:12px">
        <button class="btn btn-outline" onclick="loadQR()">Regenerate QR</button>
      </div>
    </div>
  </div>
</div>

<script>
let selectedProvider=null,selectedChannel=null,availVersions=[];
const PANEL_VER='${PANEL_VERSION}';
const providers=${provJSON};
const channels=${chJSON};

function showTab(name,el){
  document.querySelectorAll('.section').forEach(s=>s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  const sec=document.getElementById('sec-'+name);if(sec)sec.classList.add('active');
  if(el)el.classList.add('active');
  document.querySelector('.sidebar').classList.remove('open');
  const loaders={provider:loadProvider,fallback:loadFallback,agents:loadAgents,channels:loadChannels,gateway:loadGateway,domain:loadDomain,update:loadUpdate,
    chat:loadChat,analytics:loadAnalytics,history:loadHistory,users:loadUsers,backup:()=>{},config:loadConfigEditor,qr:loadQR,
    plugins:loadPlugins,skills:loadSkills,doctor:loadDoctor,status:()=>{loadStatus();loadLogs()}};
  if(loaders[name]){if(el)el.style.opacity='.6';Promise.resolve(loaders[name]()).finally(()=>{if(el)el.style.opacity='1'})}
}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
async function api(path,method,body){
  const o={method:method||'GET',headers:{'Content-Type':'application/json'}};
  if(body)o.body=JSON.stringify(body);
  try{const r=await fetch(path,o);if(r.status===401){location.href='/';return{ok:false,error:'Session expired'}}return await r.json()}catch(e){return{ok:false,error:'Connection error: '+e.message}}
}
async function doLogout(){await api('/api/logout','POST');location.href='/'}
function toggleTokenVis(){const el=document.getElementById('tokenDisplay');if(!el||!window._gwToken)return;window._gwTokenVis=!window._gwTokenVis;if(window._gwTokenVis)el.textContent=window._gwToken;else{const t=window._gwToken;el.textContent=t.substring(0,8)+'\\u2022'.repeat(8)+t.substring(t.length-8)}}

// === Provider ===
async function loadProvider(){
  const d=await api('/api/current-config');
  const el=document.getElementById('currentProvider');
  el.innerHTML=d.provider
    ?'<div class="info-row"><span class="info-k">Provider</span><span class="info-v">'+esc(d.providerName)+'</span></div><div class="info-row"><span class="info-k">Model</span><span class="info-v">'+esc(d.model)+'</span></div>'
    :'<div class="info-row"><span class="info-v" style="color:var(--warn)">Not configured</span></div>';
  const list=document.getElementById('providerList');list.innerHTML='';
  const cats={cloud:{label:'\\u2601\\ufe0f Cloud Providers',items:[]},gateway:{label:'\\ud83d\\udd00 Gateway / Proxy',items:[]},local:{label:'\\ud83d\\udda5\\ufe0f Self-hosted',items:[]}};
  providers.forEach(p=>{(cats[p.category||'cloud']||cats.cloud).items.push(p)});
  Object.values(cats).forEach(cat=>{
    if(!cat.items.length)return;
    const hdr=document.createElement('div');hdr.style.cssText='font-size:12px;font-weight:800;color:var(--text2);padding:8px 4px 4px;margin-top:8px;text-transform:uppercase;letter-spacing:.5px';hdr.textContent=cat.label;list.appendChild(hdr);
    cat.items.forEach(p=>{
      const isCurrent=d.provider===p.id;
      const div=document.createElement('div');div.className='prov-item'+(isCurrent?' current':'');
      div.innerHTML='<div class="prov-icon" style="background:'+p.color+'15;color:'+p.color+'">'+p.icon+'</div><div class="prov-info"><div class="prov-name">'+p.name+'</div><div class="prov-desc">'+p.models.length+' model'+(p.models.length>1?'s':'')+'</div></div>'+(isCurrent?'<span class="prov-badge bg-green">ACTIVE</span>':'');
      div.onclick=()=>{selectedProvider=p.id;document.querySelectorAll('.prov-item').forEach(i=>i.classList.remove('selected'));div.classList.add('selected');
        const sel=document.getElementById('provModel');sel.innerHTML=p.models.map(m=>'<option value="'+m.id+'">'+m.name+' \\u2014 '+m.desc+'</option>').join('');
        let extraHtml='';if(p.extraEnvKeys&&p.extraEnvKeys.length>0)p.extraEnvKeys.forEach(ek=>{extraHtml+='<div class="field"><label>'+ek+'</label><input type="text" id="extraEnv-'+ek+'" placeholder="Enter '+ek+'"></div>'});
        document.getElementById('provExtraFields').innerHTML=extraHtml;
        document.getElementById('providerConfig').style.display='block';document.getElementById('provStatus').className='status';};
      list.appendChild(div);
    });
  });
}
async function testProviderKey(){
  const st=document.getElementById('provStatus'),k=document.getElementById('provKey').value.trim();
  if(!k){st.className='status fail';st.textContent='Enter API key';return}
  st.className='status loading';st.textContent='Checking...';
  const d=await api('/api/test-key','POST',{provider:selectedProvider,apiKey:k});
  st.className=d.ok?'status ok':'status fail';st.textContent=d.ok?'API key is valid!':d.error||'Invalid key';
}
async function saveProviderKey(){
  const st=document.getElementById('provStatus'),k=document.getElementById('provKey').value.trim();
  if(!selectedProvider){st.className='status fail';st.textContent='Select a provider';return}
  if(!k){st.className='status fail';st.textContent='Enter API key';return}
  st.className='status loading';st.textContent='Saving key...';
  const prov=providers.find(p=>p.id===selectedProvider);const extraEnv={};
  if(prov&&prov.extraEnvKeys)prov.extraEnvKeys.forEach(ek=>{const el=document.getElementById('extraEnv-'+ek);if(el)extraEnv[ek]=el.value.trim()});
  const d=await api('/api/provider-save-key','POST',{provider:selectedProvider,apiKey:k,extraEnv});
  st.className=d.ok?'status ok':'status fail';st.textContent=d.ok?'API key saved for '+esc(prov?prov.name:selectedProvider)+'! Current model unchanged.':d.error||'Error';
  if(d.ok)setTimeout(loadProvider,1500);
}
async function applyProvider(){
  const st=document.getElementById('provStatus'),k=document.getElementById('provKey').value.trim(),m=document.getElementById('provModel').value;
  if(!selectedProvider){st.className='status fail';st.textContent='Select a provider';return}
  if(!k){st.className='status fail';st.textContent='Enter API key';return}
  st.className='status loading';st.textContent='Applying...';
  const prov=providers.find(p=>p.id===selectedProvider);const extraEnv={};
  if(prov&&prov.extraEnvKeys)prov.extraEnvKeys.forEach(ek=>{const el=document.getElementById('extraEnv-'+ek);if(el)extraEnv[ek]=el.value.trim()});
  const d=await api('/api/provider','POST',{provider:selectedProvider,model:m,apiKey:k,extraEnv});
  st.className=d.ok?'status ok':'status fail';st.textContent=d.ok?'Success! OpenClaw restarted.':d.error||'Error';
  if(d.ok)setTimeout(loadProvider,1500);
}

// === Channels ===
async function loadChannels(){
  const d=await api('/api/current-config');
  const el=document.getElementById('currentChannels');
  let h='';if(d.channels&&d.channels.length>0)d.channels.forEach(c=>{h+='<div class="info-row"><span class="info-k">'+esc(c.name)+'</span><span class="info-v" style="display:flex;align-items:center;gap:8px"><span class="badge bg-green">Active</span><button onclick="disableChannel(\\x27'+esc(c.id)+'\\x27)" style="background:none;border:1px solid #fecaca;color:#ef4444;padding:3px 10px;border-radius:6px;font-size:11px;cursor:pointer;font-weight:600;transition:all .2s" onmouseover="this.style.background=\\x27#fef2f2\\x27" onmouseout="this.style.background=\\x27none\\x27">Disable</button></span></div>'});
  else h='<div class="info-row"><span class="info-v" style="color:var(--text2)">No channels</span></div>';
  el.innerHTML=h;
  const list=document.getElementById('channelList');list.innerHTML='';
  channels.forEach(c=>{
    const isActive=d.channels&&d.channels.some(x=>x.id===c.id);
    const div=document.createElement('div');div.className='ch-item'+(isActive?' active-ch':'');
    div.innerHTML='<div class="ch-icon">'+c.icon+'</div><div class="ch-info"><div class="ch-name">'+c.name+'</div><div class="ch-desc">'+c.desc+'</div></div>'+(isActive?'<span class="badge bg-green">ON</span>':'');
    div.onclick=()=>{
      selectedChannel=c;document.querySelectorAll('.ch-item').forEach(i=>i.classList.remove('selected'));div.classList.add('selected');
      const fields=document.getElementById('channelFields'),pb=document.getElementById('pairChannelBtn');
      document.getElementById('pairForm').style.display='none';document.getElementById('channelStatus').className='status';
      fields.innerHTML=c.envKeys.map(k=>'<div class="field"><label>'+esc(k)+'</label><input type="text" id="chfield-'+k+'" placeholder="Enter '+esc(k)+'"></div>').join('');pb.style.display=c.canPair?'inline-flex':'none';
      // Pre-fill current values
      if(isActive)(async()=>{const cfg=await api('/api/channel-values','POST',{channel:c.id});if(cfg.ok&&cfg.values)Object.entries(cfg.values).forEach(([k,v])=>{const el=document.getElementById('chfield-'+k);if(el&&v)el.value=v})})();
      document.getElementById('channelConfig').style.display='block';
    };
    list.appendChild(div);
  });
}
async function saveChannel(){
  if(!selectedChannel)return;const st=document.getElementById('channelStatus'),data={channel:selectedChannel.id,tokens:{}};
  selectedChannel.envKeys.forEach(k=>{const el=document.getElementById('chfield-'+k);if(el)data.tokens[k]=el.value.trim()});
  st.className='status loading';st.textContent='Saving...';
  const d=await api('/api/channels','POST',data);st.className=d.ok?'status ok':'status fail';st.textContent=d.ok?'Saved! Restart successful.':d.error||'Error';
  if(d.ok)setTimeout(loadChannels,1500);
}
async function disableChannel(chId){
  if(!confirm('Disable channel '+chId+'? Token will be deleted and service restarted.'))return;
  const d=await api('/api/channel-disable','POST',{channel:chId});
  if(d.ok){setTimeout(loadChannels,1500)}else{alert(d.error||'Error disabling channel')}
}
function showPairForm(){document.getElementById('pairForm').style.display='block'}
async function pairChannel(){
  if(!selectedChannel||!selectedChannel.canPair)return;const st=document.getElementById('pairStatus'),code=document.getElementById('pairCode').value.trim();
  if(!code){st.className='status fail';st.textContent='Enter pairing code';return}
  st.className='status loading';st.textContent='Pairing...';
  const d=await api('/api/channel-pair','POST',{channel:selectedChannel.id,code});
  st.className=d.ok?'status ok':'status fail';st.textContent=d.ok?'Pairing successful!':d.error||'Error';
}

// === Agents ===
let editingAgentId=null;
async function loadAgents(){
  const d=await api('/api/agents');
  const el=document.getElementById('agentList');
  if(!d.ok){el.innerHTML='<div class="fb-empty">Error: '+esc(d.error||'Unable to load')+'</div>';return}
  const agents=d.agents||[];
  if(!agents.length){el.innerHTML='<div class="fb-empty">No agents yet.</div>';return}
  let h='';
  agents.forEach(a=>{
    const isDefault=a.isDefault;
    const emoji=a.identity&&a.identity.emoji?a.identity.emoji:'\ud83e\udd16';
    const displayName=a.identity&&a.identity.name?a.identity.name:a.id;
    const model=a.model||'N/A';
    const bindText=a.bindings>0?a.bindings+' binding(s)':'No bindings';
    const routeText=a.routes&&a.routes.length?a.routes.join(', '):'No routes';
    h+='<div class="fb-item">';
    h+='<div class="fb-icon" style="font-size:28px">'+emoji+'</div>';
    h+='<div class="fb-info"><div class="fb-name">'+esc(displayName)+' <span style="color:var(--text2);font-weight:400;font-size:12px">('+esc(a.id)+')</span></div>';
    h+='<div class="fb-model">'+esc(model)+' &middot; '+esc(bindText)+'</div>';
    h+='<div style="font-size:11px;color:var(--text2);margin-top:3px">'+esc(routeText)+'</div></div>';
    h+='<span class="fb-badge '+(isDefault?'primary':'fallback')+'">'+(isDefault?'DEFAULT':'AGENT')+'</span>';
    h+='<button class="btn btn-sm btn-outline" style="margin-left:8px" onclick="editAgentIdentity(\\x27'+esc(a.id)+'\\x27)">Identity</button>';
    if(!isDefault)h+='<button class="fb-remove" style="margin-left:6px" onclick="deleteAgent(\\x27'+esc(a.id)+'\\x27)">Delete</button>';
    h+='</div>';
  });
  el.innerHTML=h;
  // Populate model dropdown (only active providers with API key)
  const modelSel=document.getElementById('newAgentModel');
  modelSel.innerHTML='<option value="">-- Select model --</option>';
  const ap=d.activeProviders||[];
  if(ap.length){ap.forEach(p=>{p.models.forEach(m=>{modelSel.innerHTML+='<option value="'+m.id+'">'+esc(p.name)+' — '+esc(m.name)+'</option>'})})}
  else{modelSel.innerHTML='<option value="">No AI Provider configured</option>'}
  // Populate channel binding dropdown
  const bindSel=document.getElementById('newAgentBind');
  bindSel.innerHTML='<option value="">-- No binding --</option>';
  channels.forEach(c=>{bindSel.innerHTML+='<option value="'+c.id+'">'+c.icon+' '+esc(c.name)+'</option>'});
  // Hide identity editor
  document.getElementById('agentIdentityCard').style.display='none';
  editingAgentId=null;
}
async function addAgent(){
  const name=document.getElementById('newAgentName').value.trim();
  const model=document.getElementById('newAgentModel').value;
  const bind=document.getElementById('newAgentBind').value;
  const st=document.getElementById('addAgentStatus');
  if(!name){st.className='status fail';st.textContent='Enter agent name';return}
  if(!/^[a-zA-Z0-9_-]+$/.test(name)){st.className='status fail';st.textContent='Name must contain only letters, numbers, -, _';return}
  if(name.length>32){st.className='status fail';st.textContent='Name too long (max 32 chars)';return}
  st.className='status loading';st.textContent='Adding agent...';
  const d=await api('/api/agents/add','POST',{name,model,bind});
  st.className=d.ok?'status ok':'status fail';
  st.textContent=d.ok?'Added agent '+name+'!':d.error||'Error';
  if(d.ok){document.getElementById('newAgentName').value='';setTimeout(loadAgents,1500)}
}
function editAgentIdentity(agentId){
  editingAgentId=agentId;
  document.getElementById('agentIdentityCard').style.display='block';
  document.getElementById('agentIdentityName').textContent=agentId;
  document.getElementById('agentIdName').value='';
  document.getElementById('agentIdEmoji').value='';
  document.getElementById('agentIdTheme').value='';
  document.getElementById('agentIdentityStatus').className='status';
}
function cancelEditIdentity(){
  editingAgentId=null;
  document.getElementById('agentIdentityCard').style.display='none';
}
async function saveAgentIdentity(){
  if(!editingAgentId)return;
  const name=document.getElementById('agentIdName').value.trim();
  const emoji=document.getElementById('agentIdEmoji').value.trim();
  const theme=document.getElementById('agentIdTheme').value.trim();
  const st=document.getElementById('agentIdentityStatus');
  if(!name&&!emoji&&!theme){st.className='status fail';st.textContent='Enter at least 1 field';return}
  st.className='status loading';st.textContent='Saving identity...';
  const d=await api('/api/agents/identity','POST',{agent:editingAgentId,name,emoji,theme});
  st.className=d.ok?'status ok':'status fail';
  st.textContent=d.ok?'Identity updated!':d.error||'Error';
  if(d.ok)setTimeout(()=>{cancelEditIdentity();loadAgents()},1500);
}
async function deleteAgent(agentId){
  if(!confirm('Delete agent "'+agentId+'"? Workspace and state will be deleted. This cannot be undone.'))return;
  const d=await api('/api/agents/delete','DELETE',{agent:agentId});
  if(d.ok){loadAgents()}else{alert(d.error||'Error deleting agent')}
}

// === Gateway ===
async function loadGateway(){
  const d=await api('/api/current-config'),el=document.getElementById('gatewayInfo'),host=d.domain||d.serverIP||'localhost';
  const dashUrl='https://'+esc(host)+'?token='+esc(d.token);
  const maskedToken=d.token?(d.token.substring(0,8)+'\\u2022'.repeat(8)+d.token.substring(d.token.length-8)):'';
  el.innerHTML='<div class="info-row"><span class="info-k">Token</span><span class="info-v" style="font-family:monospace;font-size:10px"><span id="tokenDisplay">'+esc(maskedToken)+'</span> <button onclick="toggleTokenVis()" style="background:none;border:none;cursor:pointer;font-size:12px;color:var(--accent)" title="Show/Hide">\\ud83d\\udc41</button></span></div><div class="info-row"><span class="info-k">Dashboard</span><span class="info-v"><a href="'+dashUrl+'" target="_blank" style="color:var(--accent);text-decoration:none">https://'+esc(host)+'</a></span></div>';
  window._gwToken=d.token;window._gwTokenVis=false;
  document.getElementById('pairDashboardUrl').textContent=dashUrl;
  loadDevices();
}
async function loadDevices(){
  try{
    const d=await api('/api/devices');
    const el=document.getElementById('deviceList');
    if(!d.ok){el.innerHTML='<div style="color:var(--text2);font-size:12px;padding:8px">'+(d.error||'Error')+'</div>';return}
    if(!d.devices||d.devices.length===0){el.innerHTML='<div style="color:var(--text2);font-size:12px;padding:8px">No devices paired yet.</div>';return}
    let h='';d.devices.forEach(dev=>{
      const badge=dev.status==='paired'?'bg-green':dev.status==='pending'?'bg-blue':'bg-red';
      const label=dev.status==='paired'?'Paired':dev.status==='revoked'?'Revoked':'Pending';
      const modeIcon=dev.mode==='cli'?'\\uD83D\\uDDA5\\uFE0F':'\\uD83C\\uDF10';
      const info=esc(dev.platform)+(dev.ip?' &middot; '+esc(dev.ip):'')+(dev.mode?' &middot; '+modeIcon+' '+esc(dev.mode):'');
      h+='<div class="dev-item">';
      h+='<div class="dev-info"><div class="dev-name">'+esc(dev.name||dev.uuid||'Unknown')+' <span class="badge '+badge+'" style="font-size:10px;padding:2px 8px;vertical-align:middle">'+label+'</span></div>';
      h+='<div class="dev-meta">'+info+'</div></div>';
      if(dev.status==='paired'){h+='<button class="btn btn-sm btn-danger" data-did="'+esc(dev.uuid)+'" data-role="'+esc(dev.role||'operator')+'" onclick="revokeDevice(this.dataset.did,this.dataset.role,this)">Revoke</button>'}
      h+='</div>';
    });
    el.innerHTML=h;
  }catch{document.getElementById('deviceList').innerHTML='<div style="color:var(--text2);font-size:12px;padding:8px">Error loading list.</div>'}
}
async function revokeDevice(deviceId,role,btn){
  if(!confirm('Are you sure you want to revoke this device?')) return;
  const orig=btn.textContent;btn.disabled=true;btn.textContent='Revoking...';
  try{
    const d=await api('/api/device-revoke','DELETE',{deviceId,role});
    if(d.ok){btn.textContent='Revoked!';setTimeout(()=>loadDevices(),500)}
    else{alert(d.error||'Revoke error');btn.disabled=false;btn.textContent=orig}
  }catch(e){alert('Error: '+e.message);btn.disabled=false;btn.textContent=orig}
}
async function pairDevice(){
  const st=document.getElementById('pairDeviceStatus'),btn=document.getElementById('pairDeviceBtn');
  btn.disabled=true;btn.textContent='Finding request...';st.className='status loading';st.textContent='Checking pending requests...';
  try{
    const d=await api('/api/pair','POST',{});
    if(d.ok){st.className='status ok';st.textContent='Pairing successful!';loadDevices()}
    else{st.className='status fail';st.textContent=d.error||'Unable to pair'}
    btn.disabled=false;btn.textContent='Pair Device';
  }catch(e){st.className='status fail';st.textContent='Error: '+e.message;btn.disabled=false;btn.textContent='Pair Device'}
}
async function generateToken(){
  if(!confirm('Generate new token? This will disconnect all current devices.'))return;
  const st=document.getElementById('gatewayStatus');st.className='status loading';st.textContent='Generating...';
  const d=await api('/api/gateway-token','POST',{action:'generate'});st.className=d.ok?'status ok':'status fail';st.textContent=d.ok?'New token created! All devices need to re-pair.':d.error||'Error';if(d.ok)loadGateway();
}
async function applyCustomToken(){
  const st=document.getElementById('gatewayStatus'),t=document.getElementById('customToken').value.trim();
  if(!t){st.className='status fail';st.textContent='Enter token';return}
  if(t.length<16){st.className='status fail';st.textContent='Token too short (min 16 chars)';return}
  st.className='status loading';st.textContent='Updating...';
  const d=await api('/api/gateway-token','POST',{action:'custom',token:t});st.className=d.ok?'status ok':'status fail';st.textContent=d.ok?'Updated!':d.error||'Error';if(d.ok)loadGateway();
}

// === Domain ===
async function loadDomain(){
  const d=await api('/api/current-config'),el=document.getElementById('domainInfo');
  el.innerHTML='<div class="info-row"><span class="info-k">Domain/IP</span><span class="info-v">'+esc(d.domain||d.serverIP)+'</span></div><div class="info-row"><span class="info-k">SSL</span><span class="info-v">'+(d.domain?"Let\\'s Encrypt":'Self-signed')+'</span></div>';
}
async function saveDomain(){
  const st=document.getElementById('domainStatus'),dm=document.getElementById('domainInput').value.trim(),em=document.getElementById('domainEmail').value.trim();
  if(!dm){st.className='status fail';st.textContent='Enter domain';return}
  st.className='status loading';st.textContent='Configuring Caddy + SSL...';
  const d=await api('/api/domain','POST',{domain:dm,email:em});st.className=d.ok?'status ok':'status fail';st.textContent=d.ok?'SSL configured for '+dm+'!':d.error||'Error';if(d.ok)setTimeout(loadDomain,1500);
}
async function resetDomainToIP(){
  if(!confirm('Switch to IP? This will remove SSL configuration.'))return;
  const st=document.getElementById('domainStatus');st.className='status loading';st.textContent='Switching to IP...';
  const d=await api('/api/domain','POST',{resetToIP:true});st.className=d.ok?'status ok':'status fail';st.textContent=d.ok?'Switched to IP!':d.error||'Error';if(d.ok)setTimeout(loadDomain,1500);
}

// === Update ===
async function loadUpdate(){
  const d=await api('/api/current-config'),el=document.getElementById('updateInfo');
  el.innerHTML='<div class="info-row"><span class="info-k">Version</span><span class="info-v">'+esc(d.version||'N/A')+'</span></div>';
  document.getElementById('doUpdateBtn').style.display='none';document.getElementById('updateLog').style.display='none';
  loadPanelUpdate();
}
async function checkUpdate(){
  const st=document.getElementById('updateStatus');st.className='status loading';st.textContent='Checking...';
  document.getElementById('updateVersionField').style.display='none';document.getElementById('doUpdateBtn').style.display='none';
  const d=await api('/api/update-check');
  if(d.ok){availVersions=d.versions||[];
    if(availVersions.length>0){
      const sel=document.getElementById('updateVersionSelect');sel.innerHTML='';
      availVersions.forEach(v=>{const o=document.createElement('option');o.value=v;o.textContent=v;sel.appendChild(o)});
      document.getElementById('updateVersionField').style.display='';document.getElementById('doUpdateBtn').style.display='inline-flex';
      st.className='status ok';st.textContent=availVersions.length+' newer version(s) available.';
    }else{st.className='status ok';st.textContent='Already up to date!'}
  }else{st.className='status fail';st.textContent=d.error||'Error'}
}
async function doUpdate(){
  const sel=document.getElementById('updateVersionSelect');
  const v=sel&&sel.value?sel.value:(availVersions.length>0?availVersions[0]:'latest');
  if(!confirm('Update to '+v+'? OpenClaw will be temporarily down during this process.'))return;
  const st=document.getElementById('updateStatus');
  st.className='status loading';st.textContent='Updating to '+v+'...';
  document.getElementById('doUpdateBtn').style.display='none';document.getElementById('updateVersionField').style.display='none';
  document.getElementById('updateLog').style.display='block';document.getElementById('updateLogBox').textContent='Starting...\\n';
  const d=await api('/api/update','POST',{version:v});
  st.className=d.ok?'status ok':'status fail';st.textContent=d.ok?'Updated to '+v+' successfully!':d.error||'Error';
  document.getElementById('updateLogBox').textContent+=d.log||'';if(d.ok)loadUpdate();
}

// === Panel Update ===
function loadPanelUpdate(){
  const el=document.getElementById('panelUpdateInfo');
  el.innerHTML='<div class="info-row"><span class="info-k">Panel version</span><span class="info-v">'+esc(PANEL_VER)+'</span></div>';
  document.getElementById('doPanelUpdateBtn').style.display='none';
}
async function checkPanelUpdate(){
  const st=document.getElementById('panelUpdateStatus');st.className='status loading';st.textContent='Checking...';
  const d=await api('/api/panel-update-check');
  if(d.ok){
    document.getElementById('panelUpdateInfo').innerHTML=
      '<div class="info-row"><span class="info-k">Current</span><span class="info-v">'+esc(d.current||'-')+'</span></div>'+
      '<div class="info-row"><span class="info-k">Latest</span><span class="info-v">'+esc(d.latest||'-')+'</span></div>';
    if(d.updateAvailable){st.className='status ok';st.textContent='New version available: '+d.latest;document.getElementById('doPanelUpdateBtn').style.display='inline-flex'}
    else{st.className='status ok';st.textContent='Panel is up to date!'}
  }else{st.className='status fail';st.textContent=d.error||'Error'}
}
async function doPanelUpdate(){
  if(!confirm('Update Panel? Page will auto-reload after update.'))return;
  const st=document.getElementById('panelUpdateStatus');
  st.className='status loading';st.textContent='Updating Panel...';
  document.getElementById('doPanelUpdateBtn').style.display='none';
  try{
    const d=await api('/api/panel-update','POST');
    if(d.ok){st.className='status ok';st.textContent='Success! Reloading...';setTimeout(()=>{window.location.reload()},3000)}
    else{st.className='status fail';st.textContent=d.error||'Update error';document.getElementById('doPanelUpdateBtn').style.display='inline-flex'}
  }catch(e){
    st.className='status ok';st.textContent='Panel restarting... Reloading in 5 seconds.';
    setTimeout(()=>{window.location.reload()},5000);
  }
}

// === Plugins ===
async function loadPlugins(){
  const el=document.getElementById('pluginsList');const st=document.getElementById('pluginsStatus');
  el.innerHTML='<div style="color:var(--text2);font-size:13px">Loading plugins...</div>';st.className='';st.textContent='';
  const d=await api('/api/plugins');
  if(!d.ok){el.innerHTML='';st.className='status fail';st.textContent=d.error||'Error loading plugins';return}
  const plugins=d.plugins||[];
  if(!plugins.length){el.innerHTML='<div style="color:var(--text2);font-size:13px">No plugins found.</div>';return}
  let h='<div style="display:flex;flex-direction:column;gap:8px">';
  plugins.forEach(p=>{
    const isOn=p.status==='loaded'||p.enabled;
    const badge=isOn?'<span class="badge bg-green">Loaded</span>':'<span class="badge" style="background:#fee2e2;color:#dc2626">Disabled</span>';
    const origin=p.origin==='bundled'?'<span style="font-size:11px;color:var(--text2);background:var(--border);padding:1px 6px;border-radius:4px">bundled</span>'
      :p.origin==='npm'?'<span style="font-size:11px;color:#7c3aed;background:#ede9fe;padding:1px 6px;border-radius:4px">npm</span>'
      :'<span style="font-size:11px;color:var(--text2);background:var(--border);padding:1px 6px;border-radius:4px">'+esc(p.origin||'unknown')+'</span>';
    const ver=p.version?'<span style="font-size:11px;color:var(--text2)">v'+esc(p.version)+'</span>':'';
    const desc=p.description?'<div style="font-size:12px;color:var(--text2);margin-top:2px">'+esc(p.description)+'</div>':'';
    const details=[];
    if(p.channelIds&&p.channelIds.length)details.push('Channels: '+p.channelIds.join(', '));
    if(p.providerIds&&p.providerIds.length)details.push('Providers: '+p.providerIds.join(', '));
    if(p.toolNames&&p.toolNames.length)details.push('Tools: '+p.toolNames.join(', '));
    const detailLine=details.length?'<div style="font-size:11px;color:var(--accent);margin-top:2px">'+esc(details.join(' | '))+'</div>':'';
    const toggleBtn=isOn
      ?'<button class="btn btn-outline" style="font-size:12px;padding:4px 12px;border-color:#fecaca;color:#ef4444" onclick="togglePlugin(\\''+esc(p.id)+'\\',false)">Disable</button>'
      :'<button class="btn btn-outline" style="font-size:12px;padding:4px 12px;border-color:#bbf7d0;color:#16a34a" onclick="togglePlugin(\\''+esc(p.id)+'\\',true)">Enable</button>';
    const updateBtn=p.origin==='npm'?'<button class="btn btn-outline" style="font-size:12px;padding:4px 12px" onclick="updatePlugin(\\''+esc(p.id)+'\\')">Update</button>':'';
    const uninstallBtn=p.origin!=='bundled'?'<button class="btn btn-outline" style="font-size:12px;padding:4px 12px;border-color:#fecaca;color:#ef4444" onclick="uninstallPlugin(\\''+esc(p.id)+'\\')">Uninstall</button>':'';
    h+='<div style="display:flex;align-items:flex-start;justify-content:space-between;padding:10px 14px;background:var(--bg);border-radius:10px;border:1px solid var(--border)">'
      +'<div style="flex:1;min-width:0"><div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><strong style="font-size:13px">'+esc(p.name||p.id)+'</strong> '+badge+' '+origin+' '+ver+'</div>'+desc+detailLine+'</div>'
      +'<div style="display:flex;gap:6px;align-items:center;flex-shrink:0;margin-left:12px">'+toggleBtn+updateBtn+uninstallBtn+'</div>'
      +'</div>';
  });
  h+='</div>';
  el.innerHTML=h;
  st.className='status ok';st.textContent=plugins.length+' plugin(s) found. '+plugins.filter(p=>p.status==='loaded'||p.enabled).length+' loaded.';
}
async function togglePlugin(id,enable){
  const st=document.getElementById('pluginsStatus');st.className='status loading';st.textContent=(enable?'Enabling':'Disabling')+' '+id+'...';
  const d=await api('/api/plugins/toggle','POST',{id,enable});
  st.className=d.ok?'status ok':'status fail';st.textContent=d.ok?(enable?'Enabled':'Disabled')+' '+id+'. Restart required.':d.error||'Error';
  if(d.ok)setTimeout(loadPlugins,1500);
}
async function installPlugin(){
  const input=document.getElementById('pluginInstallInput');const spec=input.value.trim();
  if(!spec){document.getElementById('pluginInstallStatus').className='status fail';document.getElementById('pluginInstallStatus').textContent='Enter a package name.';return}
  const st=document.getElementById('pluginInstallStatus');st.className='status loading';st.textContent='Installing '+spec+'...';
  document.getElementById('pluginInstallLog').style.display='block';document.getElementById('pluginInstallLogBox').textContent='Installing...\\n';
  const d=await api('/api/plugins/install','POST',{spec});
  st.className=d.ok?'status ok':'status fail';st.textContent=d.ok?'Installed '+spec+' successfully!':d.error||'Error';
  document.getElementById('pluginInstallLogBox').textContent=d.log||'';
  if(d.ok){input.value='';setTimeout(loadPlugins,1500)}
}
async function uninstallPlugin(id){
  if(!confirm('Uninstall plugin "'+id+'"? This will remove plugin files.'))return;
  const st=document.getElementById('pluginsStatus');st.className='status loading';st.textContent='Uninstalling '+id+'...';
  const d=await api('/api/plugins/uninstall','POST',{id});
  st.className=d.ok?'status ok':'status fail';st.textContent=d.ok?'Uninstalled '+id+'.':d.error||'Error';
  if(d.ok)setTimeout(loadPlugins,1500);
}
async function updatePlugin(id){
  const st=document.getElementById('pluginsStatus');st.className='status loading';st.textContent='Updating '+id+'...';
  const d=await api('/api/plugins/update','POST',{id});
  st.className=d.ok?'status ok':'status fail';st.textContent=d.ok?'Updated '+id+'.':d.error||'Error';
  if(d.ok)setTimeout(loadPlugins,1500);
}
async function updateAllPlugins(){
  if(!confirm('Update all npm-installed plugins?'))return;
  const st=document.getElementById('pluginsStatus');st.className='status loading';st.textContent='Updating all plugins...';
  const d=await api('/api/plugins/update','POST',{id:'--all'});
  st.className=d.ok?'status ok':'status fail';st.textContent=d.ok?'All plugins updated.':d.error||'Error';
  if(d.ok)setTimeout(loadPlugins,1500);
}

// === Skills ===
let allSkills=[];
async function loadSkills(){
  const el=document.getElementById('skillsList');const st=document.getElementById('skillsStatus');const sum=document.getElementById('skillsSummary');
  el.innerHTML='<div style="color:var(--text2);font-size:13px">Loading skills...</div>';st.className='';st.textContent='';
  const d=await api('/api/skills');
  if(!d.ok){el.innerHTML='';st.className='status fail';st.textContent=d.error||'Error loading skills';return}
  allSkills=d.skills||[];
  const total=allSkills.length,eligible=allSkills.filter(s=>s.eligible).length,disabled=allSkills.filter(s=>s.disabled).length,missing=allSkills.filter(s=>!s.eligible&&!s.disabled).length;
  sum.innerHTML='<div class="info-row"><span class="info-k">Total</span><span class="info-v">'+total+'</span></div>'
    +'<div class="info-row"><span class="info-k">Eligible</span><span class="info-v" style="color:#16a34a;font-weight:600">'+eligible+'</span></div>'
    +'<div class="info-row"><span class="info-k">Disabled</span><span class="info-v" style="color:#dc2626">'+disabled+'</span></div>'
    +'<div class="info-row"><span class="info-k">Missing requirements</span><span class="info-v" style="color:#d97706">'+missing+'</span></div>';
  filterSkills();
  loadClawHubInstalled();
}
function filterSkills(){
  const f=document.getElementById('skillsFilter').value;
  let list=allSkills;
  if(f==='eligible')list=allSkills.filter(s=>s.eligible&&!s.disabled);
  else if(f==='disabled')list=allSkills.filter(s=>s.disabled);
  else if(f==='missing')list=allSkills.filter(s=>!s.eligible&&!s.disabled);
  renderSkills(list);
}
function renderSkills(skills){
  const el=document.getElementById('skillsList');const st=document.getElementById('skillsStatus');
  if(!skills.length){el.innerHTML='<div style="color:var(--text2);font-size:13px">No skills match this filter.</div>';st.className='';st.textContent='';return}
  let h='<div style="display:flex;flex-direction:column;gap:8px">';
  skills.forEach(s=>{
    const badge=s.disabled?'<span class="badge" style="background:#fee2e2;color:#dc2626">Disabled</span>'
      :s.eligible?'<span class="badge bg-green">Eligible</span>'
      :'<span class="badge" style="background:#fef3c7;color:#b45309">Missing Reqs</span>';
    const emoji=s.emoji?'<span style="font-size:16px;margin-right:4px">'+s.emoji+'</span>':'';
    const desc=s.description?'<div style="font-size:12px;color:var(--text2);margin-top:2px;max-width:600px">'+esc(s.description)+'</div>':'';
    const src='<span style="font-size:11px;color:var(--text2);background:var(--border);padding:1px 6px;border-radius:4px">'+esc(s.source||'bundled')+'</span>';
    let missingHtml='';
    if(s.missing){
      const parts=[];
      if(s.missing.bins&&s.missing.bins.length)parts.push('Bins: '+s.missing.bins.join(', '));
      if(s.missing.env&&s.missing.env.length)parts.push('Env: '+s.missing.env.join(', '));
      if(s.missing.os&&s.missing.os.length)parts.push('OS: '+s.missing.os.join(', '));
      if(parts.length)missingHtml='<div style="font-size:11px;color:#d97706;margin-top:2px">\u26a0 '+esc(parts.join(' | '))+'</div>';
    }
    const link=s.homepage?'<a href="'+esc(s.homepage)+'" target="_blank" rel="noopener" style="font-size:11px;color:var(--accent);text-decoration:none">\ud83d\udd17 Docs</a>':'';
    let toggleBtn='';
    if(s.eligible&&!s.disabled){toggleBtn='<button class="btn btn-outline" style="font-size:12px;padding:4px 12px;border-color:#fecaca;color:#ef4444" onclick="toggleSkill(\\''+esc(s.name)+'\\',true)">Disable</button>'}
    else if(s.disabled){toggleBtn='<button class="btn btn-outline" style="font-size:12px;padding:4px 12px;border-color:#bbf7d0;color:#16a34a" onclick="toggleSkill(\\''+esc(s.name)+'\\',false)">Enable</button>'}
    h+='<div style="display:flex;align-items:flex-start;justify-content:space-between;padding:10px 14px;background:var(--bg);border-radius:10px;border:1px solid var(--border)">'
      +'<div style="flex:1;min-width:0"><div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">'+emoji+'<strong style="font-size:13px">'+esc(s.name)+'</strong> '+badge+' '+src+' '+link+'</div>'+desc+missingHtml+'</div>'
      +'<div style="display:flex;gap:6px;align-items:center;flex-shrink:0;margin-left:12px">'+toggleBtn+'</div>'
      +'</div>';
  });
  h+='</div>';
  el.innerHTML=h;
  st.className='status ok';st.textContent=skills.length+' skill(s) shown.';
}
async function toggleSkill(name,disable){
  const st=document.getElementById('skillsStatus');st.className='status loading';st.textContent=(disable?'Disabling':'Enabling')+' '+name+'...';
  const d=await api('/api/skills/toggle','POST',{name,disable});
  st.className=d.ok?'status ok':'status fail';st.textContent=d.ok?(disable?'Disabled':'Enabled')+' '+name+'. Restarting...':d.error||'Error';
  if(d.ok)setTimeout(loadSkills,2000);
}

// === ClawHub ===
async function searchClawHub(){
  const q=document.getElementById('clawhubSearchInput').value.trim();
  if(!q){document.getElementById('clawhubStatus').className='status fail';document.getElementById('clawhubStatus').textContent='Enter a search query.';return}
  const st=document.getElementById('clawhubStatus');const el=document.getElementById('clawhubResults');
  st.className='status loading';st.textContent='Searching "'+q+'"...';el.innerHTML='';
  const d=await api('/api/clawhub/search','POST',{query:q});
  if(!d.ok){st.className='status fail';st.textContent=d.error||'Search error';return}
  const results=d.results||[];
  if(!results.length){st.className='status ok';st.textContent='No results found.';return}
  let h='<div style="display:flex;flex-direction:column;gap:6px;margin-top:8px">';
  results.forEach(r=>{
    h+='<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:var(--bg);border-radius:8px;border:1px solid var(--border)">'
      +'<div style="flex:1;min-width:0"><strong style="font-size:13px">'+esc(r.slug)+'</strong> <span style="font-size:11px;color:var(--text2)">'+esc(r.version)+'</span>'
      +(r.name?' <span style="font-size:12px;color:var(--text2)">'+esc(r.name)+'</span>':'')
      +'</div>'
      +'<button class="btn btn-primary" style="font-size:12px;padding:4px 14px;flex-shrink:0" onclick="installClawHubSkill(\\''+esc(r.slug)+'\\')">Install</button>'
      +'</div>';
  });
  h+='</div>';
  el.innerHTML=h;
  st.className='status ok';st.textContent=results.length+' result(s).';
}
async function installClawHubSkill(slug){
  if(!confirm('Install skill "'+slug+'" from ClawHub?'))return;
  const st=document.getElementById('clawhubStatus');st.className='status loading';st.textContent='Installing '+slug+'...';
  const d=await api('/api/clawhub/install','POST',{slug});
  st.className=d.ok?'status ok':'status fail';st.textContent=d.ok?'Installed '+slug+'!':d.error||'Error';
  if(d.ok){loadClawHubInstalled();setTimeout(loadSkills,2000)}
}
async function loadClawHubInstalled(){
  const el=document.getElementById('clawhubInstalled');const st=document.getElementById('clawhubInstalledStatus');
  el.innerHTML='<div style="color:var(--text2);font-size:13px">Loading...</div>';st.className='';st.textContent='';
  const d=await api('/api/clawhub/list');
  if(!d.ok){el.innerHTML='';st.className='status fail';st.textContent=d.error||'Error';return}
  const items=d.items||[];
  if(!items.length){el.innerHTML='<div style="color:var(--text2);font-size:13px">No skills installed from ClawHub yet.</div>';st.className='';st.textContent='';return}
  let h='<div style="display:flex;flex-direction:column;gap:6px">';
  items.forEach(i=>{
    h+='<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:var(--bg);border-radius:8px;border:1px solid var(--border)">'
      +'<div style="flex:1;min-width:0"><strong style="font-size:13px">'+esc(i.slug)+'</strong> <span style="font-size:11px;color:var(--text2)">'+esc(i.version||'')+'</span></div>'
      +'<div style="display:flex;gap:6px;flex-shrink:0">'
      +'<button class="btn btn-outline" style="font-size:12px;padding:4px 12px" onclick="updateClawHubSkill(\\''+esc(i.slug)+'\\')">Update</button>'
      +'<button class="btn btn-outline" style="font-size:12px;padding:4px 12px;border-color:#fecaca;color:#ef4444" onclick="uninstallClawHubSkill(\\''+esc(i.slug)+'\\')">Uninstall</button>'
      +'</div></div>';
  });
  h+='</div>';
  el.innerHTML=h;
  st.className='status ok';st.textContent=items.length+' skill(s) installed from ClawHub.';
}
async function uninstallClawHubSkill(slug){
  if(!confirm('Uninstall skill "'+slug+'"?'))return;
  const st=document.getElementById('clawhubInstalledStatus');st.className='status loading';st.textContent='Uninstalling '+slug+'...';
  const d=await api('/api/clawhub/uninstall','POST',{slug});
  st.className=d.ok?'status ok':'status fail';st.textContent=d.ok?'Uninstalled '+slug+'.':d.error||'Error';
  if(d.ok){loadClawHubInstalled();setTimeout(loadSkills,2000)}
}
async function updateClawHubSkill(slug){
  const st=document.getElementById('clawhubInstalledStatus');st.className='status loading';st.textContent='Updating '+slug+'...';
  const d=await api('/api/clawhub/update','POST',{slug});
  st.className=d.ok?'status ok':'status fail';st.textContent=d.ok?'Updated '+slug+'.':d.error||'Error';
  if(d.ok)loadClawHubInstalled();
}
async function updateAllClawHub(){
  if(!confirm('Update all ClawHub skills?'))return;
  const st=document.getElementById('clawhubInstalledStatus');st.className='status loading';st.textContent='Updating all...';
  const d=await api('/api/clawhub/update','POST',{slug:'--all'});
  st.className=d.ok?'status ok':'status fail';st.textContent=d.ok?'All ClawHub skills updated.':d.error||'Error';
  if(d.ok)loadClawHubInstalled();
}

// === Status ===
async function loadStatus(){
  const d=await api('/api/status'),el=document.getElementById('statusInfo');
  if(!d.ok){el.innerHTML='<div class="info-row"><span class="info-v" style="color:var(--danger)">Error</span></div>';return}
  let h='';(d.services||[]).forEach(s=>{h+='<div class="info-row"><span class="info-k">'+esc(s.name)+'</span><span class="info-v"><span class="badge '+(s.active?'bg-green':'bg-red')+'">'+(s.active?'Running':'Stopped')+'</span></span></div>'});
  h+='<div class="info-row" style="border-top:2px solid #f0f1f3;margin-top:4px;padding-top:12px"><span class="info-k">Uptime</span><span class="info-v">'+esc(d.uptime||'-')+'</span></div>';
  h+='<div class="info-row"><span class="info-k">RAM</span><span class="info-v">'+esc(d.memory||'-')+'</span></div>';
  h+='<div class="info-row"><span class="info-k">Disk</span><span class="info-v">'+esc(d.disk||'-')+'</span></div>';
  h+='<div class="info-row"><span class="info-k">CPU</span><span class="info-v">'+esc(d.cpu||'-')+'</span></div>';
  h+='<div class="info-row"><span class="info-k">Gateway</span><span class="info-v">'+esc(d.version||'-')+'</span></div>';
  h+='<div class="info-row"><span class="info-k">Panel</span><span class="info-v">'+esc(d.panelVersion||'-')+'</span></div>';
  const st_tok=d.token||'-';const st_masked=st_tok.length>16?st_tok.substring(0,6)+'...'+st_tok.substring(st_tok.length-6):st_tok;
  h+='<div class="info-row"><span class="info-k">Token</span><span class="info-v" style="font-family:monospace;font-size:9px">'+esc(st_masked)+'</span></div>';
  el.innerHTML=h;
}
async function loadLogs(){const d=await api('/api/logs');document.getElementById('logsBox').textContent=d.ok?d.logs:'Error'}
async function restartSvc(n){
  const st=document.getElementById('statusMsg');st.className='status loading';st.textContent='Restarting '+n+'...';
  const d=await api('/api/restart','POST',{service:n});st.className=d.ok?'status ok':'status fail';st.textContent=d.ok?n+' OK!':d.error||'Error';
  setTimeout(()=>{loadStatus();loadLogs()},2000);
}

// === Fallback ===
const PROV_LIST_FB = ${JSON.stringify(Object.keys(PROVIDERS).map(k=>({key:k,name:PROVIDERS[k].name,icon:PROVIDERS[k].icon,models:PROVIDERS[k].models})))};
async function loadFallback(){
  const d=await api('/api/fallback');if(!d.ok)return;
  const chain=d.chain||[];const settings=d.settings||{};
  // Render chain
  const el=document.getElementById('fbChain');
  if(!chain.length&&!d.primaryProvider){el.innerHTML='<div class="fb-empty">Primary provider not configured. Go to AI Provider tab first.</div>';return;}
  let h='';
  // Primary always first
  if(d.primaryProvider){
    const pp=PROV_LIST_FB.find(p=>p.key===d.primaryProvider);
    h+='<div class="fb-item"><div class="fb-icon">'+(pp?pp.icon:'\\u2728')+'</div><div class="fb-info"><div class="fb-name">'+(pp?pp.name:d.primaryProvider)+'</div><div class="fb-model">'+(d.primaryModel||'')+'</div></div><span class="fb-badge primary">PRIMARY</span><div class="fb-status-dot active" title="Active"></div></div>';
  }
  chain.forEach((c,i)=>{
    if(c.provider===d.primaryProvider)return;
    const pp=PROV_LIST_FB.find(p=>p.key===c.provider);
    const hasKey=c.hasKey;
    h+='<div class="fb-item"><div class="fb-icon">'+(pp?pp.icon:'\\u2728')+'</div><div class="fb-info"><div class="fb-name">'+(pp?pp.name:c.provider)+'</div><div class="fb-model">'+(c.model||'')+'</div></div><span class="fb-badge fallback">FALLBACK #'+(i+1)+'</span><div class="fb-status-dot '+(hasKey?'configured':'nokey')+'" title="'+(hasKey?'Key OK':'No API key')+'"></div><button class="fb-remove" onclick="removeFallbackProvider(\\''+c.provider+'\\')">Remove</button></div>';
  });
  if(!chain.length||chain.every(c=>c.provider===d.primaryProvider))h+='<div class="fb-empty" style="margin-top:8px">No fallback provider. Add a backup provider below.</div>';
  el.innerHTML=h;
  // Populate add dropdown (exclude already in chain + primary)
  const usedKeys=chain.map(c=>c.provider);if(d.primaryProvider)usedKeys.push(d.primaryProvider);
  const sel=document.getElementById('fbProvider');sel.innerHTML='<option value="">-- Select provider --</option>';
  PROV_LIST_FB.forEach(p=>{if(!usedKeys.includes(p.key))sel.innerHTML+='<option value="'+p.key+'">'+p.icon+' '+p.name+'</option>';});
  document.getElementById('fbModel').innerHTML='';
  // Settings
  document.getElementById('fbRateLimit').value=settings.rateLimitPerMinute||60;
  document.getElementById('fbCooldown').value=settings.cooldownSeconds||300;
}
function onFbProviderChange(){
  const k=document.getElementById('fbProvider').value;
  const sel=document.getElementById('fbModel');sel.innerHTML='';
  if(!k)return;
  const pp=PROV_LIST_FB.find(p=>p.key===k);
  if(pp&&pp.models)pp.models.forEach(m=>{sel.innerHTML+='<option value="'+m.id+'">'+m.name+'</option>';});
}
async function addFallbackProvider(){
  const prov=document.getElementById('fbProvider').value;
  const model=document.getElementById('fbModel').value;
  const apiKey=document.getElementById('fbApiKey').value;
  const st=document.getElementById('fbAddStatus');
  if(!prov){st.className='status fail';st.textContent='Select provider first';return;}
  if(!apiKey){st.className='status fail';st.textContent='Enter API key';return;}
  st.className='status loading';st.textContent='Adding...';
  const d=await api('/api/fallback/add','POST',{provider:prov,model:model,apiKey:apiKey});
  st.className=d.ok?'status ok':'status fail';st.textContent=d.ok?'Added '+prov+' to fallback chain!':(d.error||'Error');
  if(d.ok){document.getElementById('fbApiKey').value='';loadFallback();}
}
async function removeFallbackProvider(prov){
  if(!confirm('Remove '+prov+' from fallback chain?'))return;
  const d=await api('/api/fallback/remove','DELETE',{provider:prov});
  if(d.ok)loadFallback();
}
async function saveFallbackSettings(){
  const st=document.getElementById('fbSettingsStatus');
  st.className='status loading';st.textContent='Saving...';
  const d=await api('/api/fallback','POST',{settings:{rateLimitPerMinute:parseInt(document.getElementById('fbRateLimit').value)||60,cooldownSeconds:parseInt(document.getElementById('fbCooldown').value)||300}});
  st.className=d.ok?'status ok':'status fail';st.textContent=d.ok?'Settings saved!':(d.error||'Error');
}

// === Chat Playground ===
let chatHistory=[];
async function loadChat(){
  const d=await api('/api/current-config');
  document.getElementById('chatProviderLabel').textContent=d.providerName?(d.providerName+' — '+d.model):'AI Chat';
}
let chatSending=false;
async function sendChat(){
  if(chatSending)return;
  const inp=document.getElementById('chatInput'),msg=inp.value.trim();if(!msg)return;
  chatSending=true;inp.value='';inp.disabled=true;
  const sendBtn=document.querySelector('.chat-input button');if(sendBtn){sendBtn.disabled=true;sendBtn.textContent='Sending...'}
  const box=document.getElementById('chatMsgs');
  const userDiv=document.createElement('div');userDiv.className='chat-msg user';userDiv.textContent=msg;box.appendChild(userDiv);
  chatHistory.push({role:'user',content:msg});
  const aiDiv=document.createElement('div');aiDiv.className='chat-msg ai';aiDiv.textContent='Thinking...';box.appendChild(aiDiv);
  box.scrollTop=box.scrollHeight;
  const t0=Date.now();
  try{const d=await api('/api/chat','POST',{message:msg,history:chatHistory.slice(-20)});
    if(d.ok){aiDiv.innerHTML=esc(d.reply).replace(/\\n/g,'<br>')+'<div class="meta">'+(d.tokens?d.tokens+' tokens | ':'')+((Date.now()-t0)/1000).toFixed(1)+'s'+(d.model?' | '+esc(d.model):'')+'</div>';
      chatHistory.push({role:'assistant',content:d.reply});
      document.getElementById('chatMeta').textContent='Messages: '+chatHistory.length;
    }else{aiDiv.textContent='Error: '+(d.error||'Unable to connect');}
  }catch(e){aiDiv.textContent='Error: '+e.message;}
  chatSending=false;inp.disabled=false;inp.focus();
  if(sendBtn){sendBtn.disabled=false;sendBtn.textContent='Send'}
  box.scrollTop=box.scrollHeight;
}
function clearChat(){chatHistory=[];document.getElementById('chatMsgs').innerHTML='<div class="chat-msg ai">Chat cleared. Send a new message.</div>';document.getElementById('chatMeta').textContent=''}

// === Usage Analytics ===
async function loadAnalytics(){
  const d=await api('/api/analytics');
  const ov=document.getElementById('analyticsOverview');
  const ch=document.getElementById('analyticsChannels');
  if(!d.ok){ov.innerHTML='<div class="info-row"><span class="info-v" style="color:var(--text2)">Error loading data</span></div>';ch.innerHTML='';return}
  ov.innerHTML='<div class="info-row"><span class="info-k">Conversations</span><span class="info-v">'+esc(String(d.totalConversations||0))+'</span></div>'+
    '<div class="info-row"><span class="info-k">Messages (user)</span><span class="info-v">'+esc(String(d.totalMessages||0))+'</span></div>'+
    '<div class="info-row"><span class="info-k">Tokens (Playground)</span><span class="info-v">'+esc(String((d.totalTokens||0).toLocaleString()))+'</span></div>'+
    '<div class="info-row"><span class="info-k">Today</span><span class="info-v">'+esc(String(d.todayMessages||0))+' messages</span></div>'+
    '<div class="info-row"><span class="info-k">Provider</span><span class="info-v">'+esc(d.provider||'-')+'</span></div>';
  // Channel breakdown
  if(d.channels&&Object.keys(d.channels).length>0){
    let chH='';Object.entries(d.channels).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>{
      if(v>0)chH+='<div class="info-row"><span class="info-k">'+esc(k)+'</span><span class="info-v">'+v+' conversations</span></div>';
    });
    ch.innerHTML=chH||'<div class="info-row"><span class="info-v" style="color:var(--text2)">None</span></div>';
  }else ch.innerHTML='<div class="info-row"><span class="info-v" style="color:var(--text2)">None</span></div>';
  // 7-day chart
  const chart=document.getElementById('analyticsChart'),list=document.getElementById('analyticsList');
  chart.innerHTML='';list.innerHTML='';
  if(d.daily&&d.daily.length>0){
    const maxR=Math.max(...d.daily.map(x=>x.messages||0),1);
    d.daily.forEach(day=>{const msgs=day.messages||0;const pct=Math.max(4,(msgs/maxR)*100);
      const bar=document.createElement('div');bar.style.cssText='flex:1;display:flex;flex-direction:column;align-items:center;gap:4px';
      bar.innerHTML='<span style="font-size:10px;color:var(--text2)">'+msgs+'</span><div style="width:100%;height:'+pct+'px;background:linear-gradient(180deg,var(--accent),var(--accent2));border-radius:4px;min-width:20px" title="'+esc(day.date)+': '+msgs+' messages"></div><span style="font-size:9px;color:var(--text2)">'+esc(day.date.slice(5))+'</span>';
      chart.appendChild(bar);
    });
  }else{chart.innerHTML='<div style="color:var(--text2);font-size:13px;padding:20px;text-align:center;width:100%">No data in the last 7 days</div>'}
}

// === Conversation History ===
async function loadHistory(){
  const d=await api('/api/conversations');
  const el=document.getElementById('historyList');
  document.getElementById('historyDetail').style.display='none';
  if(!d.ok||!d.conversations||d.conversations.length===0){el.innerHTML='<div style="font-size:12px;color:var(--text2)">No conversations yet.</div>';return}
  el.innerHTML='';
  d.conversations.forEach((c,i)=>{
    const div=document.createElement('div');div.style.cssText='display:flex;align-items:center;gap:12px;padding:10px 14px;border:1px solid var(--border);border-radius:8px;cursor:pointer;transition:all .15s';
    div.innerHTML='<span style="font-size:18px">\\ud83d\\udcac</span><div style="flex:1"><div style="font-size:13px;font-weight:600">'+esc(c.title||'Conversation #'+(i+1))+'</div><div style="font-size:11px;color:var(--text2)">'+esc(c.date||'')+' \\u2014 '+(c.messageCount||0)+' messages'+(c.channel?' \\u2014 '+esc(c.channel):'')+'</div></div>';
    div.onmouseover=()=>{div.style.borderColor='var(--accent)'};div.onmouseout=()=>{div.style.borderColor='var(--border)'};
    div.onclick=()=>showConversation(c.id,c.title||'Conversation #'+(i+1));
    el.appendChild(div);
  });
}
async function showConversation(id,title){
  document.getElementById('historyDetail').style.display='block';
  document.getElementById('historyDetailTitle').textContent=title;
  const d=await api('/api/conversations/'+id);
  const el=document.getElementById('historyMsgs');
  if(!d.ok){el.innerHTML='<div style="color:var(--text2)">Error</div>';return}
  el.innerHTML='';
  (d.messages||[]).forEach(m=>{
    const div=document.createElement('div');div.className='chat-msg '+(m.role==='user'?'user':'ai');div.style.maxWidth='95%';
    div.textContent=m.content||'';el.appendChild(div);
  });
}

// === User Management ===
async function loadUsers(){
  const d=await api('/api/security');
  const el=document.getElementById('securityInfo');
  if(!d.ok){el.innerHTML='<div class="info-row"><span class="info-v" style="color:var(--text2)">Error</span></div>';return}
  el.innerHTML='<div class="info-row"><span class="info-k">UFW Firewall</span><span class="info-v"><span class="badge '+(d.ufw?'bg-green':'bg-red')+'">'+(d.ufw?'Active':'Inactive')+'</span></span></div>'+
    '<div class="info-row"><span class="info-k">SSH</span><span class="info-v">'+esc(String(d.sshPort||22))+'</span></div>'+
    '<div class="info-row"><span class="info-k">Current Login IP</span><span class="info-v">'+esc(d.clientIP||'-')+'</span></div>';
}
async function changePassword(){
  const st=document.getElementById('passStatus'),o=document.getElementById('oldPass').value,n=document.getElementById('newPass').value,c=document.getElementById('confirmPass').value;
  if(!o||!n){st.className='status fail';st.textContent='Fill in all fields';return}
  if(n!==c){st.className='status fail';st.textContent='New passwords don\\x27t match';return}
  if(n.length<6){st.className='status fail';st.textContent='New password too short (min 6)';return}
  st.className='status loading';st.textContent='Changing...';
  const d=await api('/api/change-password','POST',{oldPassword:o,newPassword:n});
  st.className=d.ok?'status ok':'status fail';st.textContent=d.ok?'Password changed!':d.error||'Error';
  if(d.ok){document.getElementById('oldPass').value='';document.getElementById('newPass').value='';document.getElementById('confirmPass').value=''}
}

// === Backup & Restore ===
async function downloadBackup(){
  const st=document.getElementById('backupStatus');st.className='status loading';st.textContent='Creating backup...';
  const d=await api('/api/backup');
  if(!d.ok){st.className='status fail';st.textContent=d.error||'Error';return}
  st.className='status ok';st.textContent='Backup successful! File is downloading...';
  const blob=new Blob([JSON.stringify(d.data,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob);const a=document.createElement('a');
  const date=new Date().toISOString().slice(0,10).replace(/-/g,'');
  a.href=url;a.download='openclaw-backup-'+date+'.json';document.body.appendChild(a);a.click();
  document.body.removeChild(a);URL.revokeObjectURL(url);
}
async function doBackup(){
  const st=document.getElementById('backupStatus');st.className='status loading';st.textContent='Creating backup...';
  const d=await api('/api/backup');
  if(d.ok){st.className='status ok';st.textContent='Backup successful! Copy the content below.';
    document.getElementById('backupData').style.display='block';
    document.getElementById('backupContent').value=JSON.stringify(d.data,null,2);
  }else{st.className='status fail';st.textContent=d.error||'Error'}
}
function handleRestoreFile(e){
  const file=e.target.files[0];if(!file)return;
  const st=document.getElementById('restoreStatus');
  if(!file.name.endsWith('.json')){st.className='status fail';st.textContent='Only .json files accepted';e.target.value='';return}
  const reader=new FileReader();
  reader.onload=function(ev){
    try{JSON.parse(ev.target.result);document.getElementById('restoreContent').value=ev.target.result;
      st.className='status ok';st.textContent='Read file '+file.name+' — click "Restore" to apply.';
    }catch{st.className='status fail';st.textContent='Invalid JSON file'}
  };
  reader.onerror=function(){st.className='status fail';st.textContent='Unable to read file'};
  reader.readAsText(file);e.target.value='';
}
async function doRestore(){
  const st=document.getElementById('restoreStatus'),raw=document.getElementById('restoreContent').value.trim();
  if(!raw){st.className='status fail';st.textContent='Upload file or paste backup JSON first';return}
  let data;try{data=JSON.parse(raw)}catch{st.className='status fail';st.textContent='Invalid JSON';return}
  if(!confirm('Are you sure? Current configuration will be overwritten.'))return;
  st.className='status loading';st.textContent='Restoring...';
  const d=await api('/api/restore','POST',{data});
  st.className=d.ok?'status ok':'status fail';st.textContent=d.ok?'Restore successful! OpenClaw restarted.':d.error||'Error';
}

// === Config Editor ===
async function loadConfigEditor(){
  const d=await api('/api/config-read');
  if(d.ok){document.getElementById('configJson').value=d.json||'{}';document.getElementById('configEnv').value=d.env||''}
}
async function saveConfigFile(type){
  const stId=type==='json'?'configJsonStatus':'configEnvStatus';const st=document.getElementById(stId);
  st.className='status loading';st.textContent='Saving...';
  const content=type==='json'?document.getElementById('configJson').value:document.getElementById('configEnv').value;
  if(type==='json'){try{JSON.parse(content)}catch(e){st.className='status fail';st.textContent='JSON error: '+e.message;return}}
  const d=await api('/api/config-write','POST',{type,content});
  st.className=d.ok?'status ok':'status fail';st.textContent=d.ok?'Saved! Restart OK.':d.error||'Error';
}

// === QR Code (local SVG generation — no external API) ===
function makeQR(text){
  // Minimal QR Code generator — alphanumeric mode, version auto
  // Uses a simple encoding: converts text to a data URL then renders as squares
  const size=180;
  // Create QR using canvas-free approach: encode as a grid pattern
  const mods=qrEncode(text);
  if(!mods||!mods.length)return '<div style="color:var(--danger);font-size:13px">QR Error</div>';
  const n=mods.length,cellSize=Math.floor(size/n),pad=Math.floor((size-cellSize*n)/2);
  let svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+size+'" height="'+size+'" viewBox="0 0 '+size+' '+size+'">';
  svg+='<rect width="'+size+'" height="'+size+'" fill="#fff"/>';
  for(let y=0;y<n;y++)for(let x=0;x<n;x++)if(mods[y][x])svg+='<rect x="'+(pad+x*cellSize)+'" y="'+(pad+y*cellSize)+'" width="'+cellSize+'" height="'+cellSize+'" fill="#000"/>';
  svg+='</svg>';return svg;
}
// Minimal QR encoder (version 1-6, byte mode, error correction L)
function qrEncode(text){
  const data=[];for(let i=0;i<text.length;i++)data.push(text.charCodeAt(i));
  // Version selection
  const caps=[0,17,32,53,78,106,134];
  let ver=1;for(;ver<=6;ver++)if(data.length<=caps[ver])break;
  if(ver>6)ver=6;
  const size=ver*4+17;
  const grid=Array.from({length:size},()=>Array(size).fill(null));
  const mask=Array.from({length:size},()=>Array(size).fill(false));
  // Finder patterns
  function finderPattern(r,c){for(let y=-1;y<=7;y++)for(let x=-1;x<=7;x++){const ry=r+y,cx=c+x;if(ry>=0&&ry<size&&cx>=0&&cx<size){if(y===-1||y===7||x===-1||x===7)grid[ry][cx]=0;else if(y>=0&&y<=6&&x>=0&&x<=6){if(y===0||y===6||x===0||x===6)grid[ry][cx]=1;else if(y>=2&&y<=4&&x>=2&&x<=4)grid[ry][cx]=1;else grid[ry][cx]=0;}mask[ry][cx]=true;}}}
  finderPattern(0,0);finderPattern(0,size-7);finderPattern(size-7,0);
  // Timing patterns
  for(let i=8;i<size-8;i++){if(grid[6][i]===null){grid[6][i]=i%2===0?1:0;mask[6][i]=true}if(grid[i][6]===null){grid[i][6]=i%2===0?1:0;mask[i][6]=true}}
  // Alignment (ver>=2)
  if(ver>=2){const pos=[6,ver*4+10];for(const ay of pos)for(const ax of pos){if(mask[ay]&&mask[ay][ax])continue;for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){const ry=ay+dy,cx=ax+dx;if(ry>=0&&ry<size&&cx>=0&&cx<size&&!mask[ry][cx]){grid[ry][cx]=(Math.abs(dy)===2||Math.abs(dx)===2||(!dy&&!dx))?1:0;mask[ry][cx]=true;}}}}
  // Format info area
  for(let i=0;i<9;i++){if(i<size&&!mask[8]){if(!mask[8][i]){grid[8][i]=0;mask[8][i]=true;}if(i<8&&!mask[i]){if(!mask[i][8]){grid[i][8]=0;mask[i][8]=true;}}}
  if(i<8){const ri=size-1-i;if(ri>=0&&ri<size&&!mask[ri][8]){grid[ri][8]=0;mask[ri][8]=true;}if(8<size&&i<size-8&&!mask[8][size-1-i]){grid[8][size-1-i]=0;mask[8][size-1-i]=true;}}}
  grid[size-8][8]=1;mask[size-8][8]=true;
  // Encode data
  const totalBits=caps[ver]*8;const bits=[];
  bits.push(0,1,0,0);// byte mode
  const lenBits=ver<=9?8:16;const len=data.length;for(let i=lenBits-1;i>=0;i--)bits.push((len>>i)&1);
  for(const b of data)for(let i=7;i>=0;i--)bits.push((b>>i)&1);
  // Terminator + padding
  const termLen=Math.min(4,totalBits-bits.length);for(let i=0;i<termLen;i++)bits.push(0);
  while(bits.length%8!==0)bits.push(0);
  const pads=[0xEC,0x11];let pi=0;while(bits.length<totalBits){const p=pads[pi%2];for(let i=7;i>=0;i--)bits.push((p>>i)&1);pi++;}
  // Place data
  let bitIdx=0;let upward=true;for(let col=size-1;col>=1;col-=2){if(col===6)col=5;
    const rows=upward?Array.from({length:size},(_,i)=>size-1-i):Array.from({length:size},(_,i)=>i);
    for(const row of rows){for(let c=0;c<2;c++){const x=col-c;if(!mask[row][x]){grid[row][x]=bitIdx<bits.length?bits[bitIdx]:0;bitIdx++;}}}upward=!upward;}
  // Mask pattern 0: (row+col)%2==0
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){if(!mask[y][x]){grid[y][x]^=((y+x)%2===0)?1:0;}}
  // Format info (mask 0, EC level L = 01)
  const fmtBits=[1,1,1,0,0,1,0,0,1,0,1,0,1,0,1];
  for(let i=0;i<6;i++)grid[8][i]=fmtBits[i];grid[8][7]=fmtBits[6];grid[8][8]=fmtBits[7];grid[7][8]=fmtBits[8];
  for(let i=0;i<6;i++)grid[5-i][8]=fmtBits[9+i];
  for(let i=0;i<8;i++)grid[8][size-8+i]=fmtBits[i];
  for(let i=0;i<7;i++)grid[size-1-i][8]=fmtBits[8+i];
  return grid;
}
async function loadQR(){
  const d=await api('/api/current-config');
  const host=d.domain||d.serverIP||'localhost',token=d.token||'';
  const url='https://'+host+'?token='+token;
  document.getElementById('qrUrl').textContent=url;
  const canvas=document.getElementById('qrCanvas');
  canvas.innerHTML=makeQR(url);
}

// === Doctor ===
let doctorRunning=false;
function parseDoctorOutput(output){
  const lines=(output||'').split('\\n');
  const checks=[];
  for(const line of lines){
    const l=line.trim();if(!l)continue;
    let status='',name='',detail='';
    if(l.includes('\\u2705')||l.match(/\\[PASS\\]/i)||l.match(/\\[OK\\]/i)||l.match(/\\u2714/)){status='pass';name=l.replace(/[\\u2705\\u2714]/g,'').replace(/\\[(PASS|OK)\\]/gi,'').trim()}
    else if(l.includes('\\u26a0')||l.match(/\\[WARN\\]/i)||l.includes('\\u26a0\\ufe0f')){status='warn';name=l.replace(/[\\u26a0\\ufe0f]/g,'').replace(/\\[WARN\\]/gi,'').trim()}
    else if(l.includes('\\u274c')||l.match(/\\[FAIL\\]/i)||l.match(/\\[ERROR\\]/i)){status='fail';name=l.replace(/[\\u274c]/g,'').replace(/\\[(FAIL|ERROR)\\]/gi,'').trim()}
    if(status){
      const parts=name.split(/\\s*[—\\-:]\\s*/,2);
      if(parts.length>1){name=parts[0].trim();detail=parts[1].trim()}
      checks.push({status,name,detail});
    }
  }
  const pass=checks.filter(c=>c.status==='pass').length;
  const warn=checks.filter(c=>c.status==='warn').length;
  const fail=checks.filter(c=>c.status==='fail').length;
  return {total:checks.length,pass,warn,fail,checks};
}
async function loadDoctor(){
  try{
    const d=await api('/api/doctor-history');
    const el=document.getElementById('doctorHistory');
    if(!d.ok||!d.history||d.history.length===0){el.innerHTML='<div style="color:var(--text2);font-size:12px;padding:8px">No history. Click Scan to start.</div>';return}
    let h='';d.history.forEach(item=>{
      const modeLabel={scan:'Scan',repair:'Repair',deep:'Deep'}[item.mode]||item.mode;
      const s=item.summary||{};
      const resultColor=s.fail>0?'var(--danger)':s.warn>0?'var(--warn)':'var(--accent2)';
      const resultText=s.total>0?(s.pass+' pass, '+s.warn+' warn, '+s.fail+' fail'):(item.duration||'-');
      h+='<div class="doc-hist-item"><span class="dh-date">'+esc(item.date||'-')+'</span><span class="dh-mode">'+esc(modeLabel)+'</span><span class="dh-result" style="color:'+resultColor+'">'+esc(resultText)+'</span></div>';
    });
    el.innerHTML=h;
    // Show last run result
    if(d.history.length>0&&d.history[0].summary&&d.history[0].summary.total>0){
      renderDoctorResult(d.history[0].summary,d.history[0].output||'');
    }
  }catch{}
}
function renderDoctorResult(summary,output){
  const sc=document.getElementById('doctorResultCard');sc.style.display='block';
  const sm=document.getElementById('doctorSummary');
  sm.innerHTML='<div class="doc-stat"><div class="ds-num" style="color:var(--accent)">'+(summary.total||0)+'</div><div class="ds-label">Total</div></div>'
    +'<div class="doc-stat"><div class="ds-num" style="color:#22c55e">'+(summary.pass||0)+'</div><div class="ds-label">Pass</div></div>'
    +'<div class="doc-stat"><div class="ds-num" style="color:#f59e0b">'+(summary.warn||0)+'</div><div class="ds-label">Warning</div></div>'
    +'<div class="doc-stat"><div class="ds-num" style="color:#ef4444">'+(summary.fail||0)+'</div><div class="ds-label">Fail</div></div>';
  const ch=document.getElementById('doctorChecks');
  if(summary.checks&&summary.checks.length>0){
    ch.innerHTML=summary.checks.map(c=>'<div class="doc-check '+c.status+'"><span class="dc-icon">'+(c.status==='pass'?'\\u2705':c.status==='warn'?'\\u26a0\\ufe0f':'\\u274c')+'</span><span class="dc-text">'+esc(c.name)+'</span><span class="dc-detail">'+esc(c.detail)+'</span></div>').join('');
  }else ch.innerHTML='';
  if(output){
    document.getElementById('doctorOutputCard').style.display='block';
    document.getElementById('doctorLog').textContent=output;
  }
}
async function runDoctor(mode){
  if(doctorRunning)return;doctorRunning=true;
  const st=document.getElementById('doctorStatus');
  const btns=document.querySelectorAll('.doc-btn');btns.forEach(b=>b.classList.add('running'));
  const modeLabel={scan:'Scanning...',repair:'Repairing...',deep:'Deep scanning...'}[mode]||'Running...';
  st.className='status loading';st.textContent=modeLabel+' (may take 1-2 minutes)';
  document.getElementById('doctorResultCard').style.display='none';
  document.getElementById('doctorOutputCard').style.display='none';
  try{
    const d=await api('/api/doctor','POST',{mode});
    btns.forEach(b=>b.classList.remove('running'));doctorRunning=false;
    if(!d.ok){st.className='status fail';st.textContent=d.error||'Error running doctor';return}
    const s=d.summary||{};
    if(s.fail>0){st.className='status fail';st.textContent='Found '+s.fail+' error(s)! ('+s.total+' checks, '+d.duration+')'}
    else if(s.warn>0){st.className='status warn';st.textContent=s.warn+' warning(s). ('+s.total+' checks, '+d.duration+')'}
    else{st.className='status ok';st.textContent='System is healthy! ('+s.total+' checks, '+d.duration+')'}
    renderDoctorResult(s,d.output||'');
    loadDoctor();
  }catch(e){
    btns.forEach(b=>b.classList.remove('running'));doctorRunning=false;
    st.className='status fail';st.textContent='Error: '+e.message;
  }
}

// === Dark Mode ===
function updateThemeIcon(){
  const btn=document.getElementById('themeToggleBtn');if(!btn)return;
  const isDark=document.body.classList.contains('dark');
  btn.innerHTML=isDark
    ?'<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 1v1m0 12v1m7-7h-1M2 8H1m12.07-4.07-.71.71M3.64 12.36l-.71.71m10.14 0-.71-.71M3.64 3.64l-.71-.71M11 8a3 3 0 11-6 0 3 3 0 016 0z"/></svg>'
    :'<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 9.27A7 7 0 016.73 2a7 7 0 107.27 7.27z"/></svg>';
}
function toggleDark(){
  document.body.classList.toggle('dark');
  try{localStorage.setItem('oc-dark',document.body.classList.contains('dark')?'1':'0')}catch{}
  updateThemeIcon();
}
(function(){try{if(localStorage.getItem('oc-dark')==='1')document.body.classList.add('dark')}catch{} updateThemeIcon()})();

// Mobile: close sidebar on outside click
document.addEventListener('click',function(e){if(window.innerWidth<=768){const sb=document.querySelector('.sidebar');const hb=document.querySelector('.hamburger');if(sb&&sb.classList.contains('open')&&!sb.contains(e.target)&&e.target!==hb)sb.classList.remove('open')}});
// Auto-refresh status tab every 30s
let statusInterval=null;
const origShowTab=showTab;
showTab=function(name,el){origShowTab(name,el);if(statusInterval){clearInterval(statusInterval);statusInterval=null}if(name==='status')statusInterval=setInterval(()=>{loadStatus();loadLogs()},30000)};

showTab('provider',document.querySelector('.nav-item'));
</script></body></html>`;
}

// --- HTTP Server ---
const server = http.createServer(async (req, res) => {
  const ip = getClientIP(req);
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/login')) {
    if (isValidSession(req)) { res.writeHead(302, { Location: '/panel' }); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(loginPage());
  }
  if (req.method === 'GET' && url.pathname === '/panel') {
    if (!isValidSession(req)) { res.writeHead(302, { Location: '/' }); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(panelPage());
  }

  // Login
  if (req.method === 'POST' && url.pathname === '/api/login') {
    if (isBlocked(ip)) return json(res, 429, { ok: false, error: 'Too many attempts. Wait 15 minutes.' });
    try {
      const body = await parseBody(req);
      if (!body.username || !body.password) return json(res, 400, { ok: false, error: 'Missing credentials' });
      if (verifyPassword(body.username, body.password)) {
        const token = createSession();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `panel_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}` });
        return res.end(JSON.stringify({ ok: true }));
      } else {
        recordFailedLogin(ip);
        const rem = MAX_LOGIN_ATTEMPTS - (loginAttempts[ip]?.count || 0);
        return json(res, 401, { ok: false, error: `Wrong password. ${Math.max(0, rem)} attempt(s) remaining.` });
      }
    } catch { return json(res, 400, { ok: false, error: 'Bad request' }); }
  }

  // Logout
  if (req.method === 'POST' && url.pathname === '/api/logout') {
    const m = (req.headers.cookie || '').match(/panel_session=([a-f0-9]{64})/);
    if (m && sessions[m[1]]) delete sessions[m[1]];
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'panel_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    return res.end(JSON.stringify({ ok: true }));
  }

  // Auth check
  if (url.pathname.startsWith('/api/') && url.pathname !== '/api/login') {
    if (!isValidSession(req)) return json(res, 401, { ok: false, error: 'Not logged in' });
  }

  // Current Config
  if (req.method === 'GET' && url.pathname === '/api/current-config') {
    try {
      const config = getConfig();
      const model = config?.agents?.defaults?.model?.primary || '';
      const providerInfo = Object.entries(PROVIDERS).find(([k]) => {
        if (model.startsWith(k + '/')) return true;
        if (k === 'gemini' && model.startsWith('google/')) return true;
        if (k === 'bedrock' && model.startsWith('amazon-bedrock/')) return true;
        return false;
      });
      const provider = providerInfo ? providerInfo[0] : '';
      const providerName = providerInfo ? providerInfo[1].name : '';
      const activeChannels = [];
      for (const [id, ch] of Object.entries(CHANNELS)) {
        if (ch.envKeys.length === 0) continue;
        if (ch.envKeys.every(k => { const v = getEnvValue(k); return v && !v.startsWith('#'); }))
          activeChannels.push({ id, name: ch.name });
      }
      let domain = '';
      try { const c = fs.readFileSync(CADDYFILE, 'utf8'); const m = c.match(/^([a-z0-9][a-z0-9.-]+\.[a-z]{2,})\s*\{/m); if (m) domain = m[1]; } catch {}
      return json(res, 200, { ok: true, provider, providerName, model, channels: activeChannels, domain, token: getEnvValue('OPENCLAW_GATEWAY_TOKEN'), version: getEnvValue('OPENCLAW_VERSION'), panelVersion: PANEL_VERSION, serverIP: getServerIP() });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // Test Key
  if (req.method === 'POST' && url.pathname === '/api/test-key') {
    try {
      const body = await parseBody(req); const p = PROVIDERS[body.provider];
      if (!p) return json(res, 400, { ok: false, error: 'Invalid provider' });
      const ok = p.testFn(body.apiKey);
      return json(res, 200, { ok, error: ok ? null : 'Invalid API key' });
    } catch { return json(res, 500, { ok: false, error: 'Error' }); }
  }

  // Save Provider Key Only (no model change, no restart)
  if (req.method === 'POST' && url.pathname === '/api/provider-save-key') {
    try {
      const body = await parseBody(req); const prov = PROVIDERS[body.provider];
      if (!prov) return json(res, 400, { ok: false, error: 'Invalid provider' });
      if (!body.apiKey) return json(res, 400, { ok: false, error: 'Missing API key' });
      setEnvValue(prov.envKey, body.apiKey);
      if (body.extraEnv && prov.extraEnvKeys) { for (const [ek, ev] of Object.entries(body.extraEnv)) { if (prov.extraEnvKeys.includes(ek) && ev) setEnvValue(ek, ev); } }
      return json(res, 200, { ok: true });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // Apply Provider (save key + change model + restart)
  if (req.method === 'POST' && url.pathname === '/api/provider') {
    try {
      const body = await parseBody(req); const prov = PROVIDERS[body.provider];
      if (!prov) return json(res, 400, { ok: false, error: 'Invalid provider' });
      const token = getEnvValue('OPENCLAW_GATEWAY_TOKEN');
      setEnvValue(prov.envKey, body.apiKey);
      if (body.extraEnv && prov.extraEnvKeys) { for (const [ek, ev] of Object.entries(body.extraEnv)) { if (prov.extraEnvKeys.includes(ek) && ev) setEnvValue(ek, ev); } }
      let config; try { config = JSON.parse(fs.readFileSync(prov.configFile, 'utf8')); } catch { config = getConfig(); }
      config.gateway = config.gateway || {}; config.gateway.auth = config.gateway.auth || {}; config.gateway.auth.token = token;
      config.agents = config.agents || { defaults: { model: {} } }; config.agents.defaults = config.agents.defaults || { model: {} }; config.agents.defaults.model = config.agents.defaults.model || {};
      if (body.model) config.agents.defaults.model.primary = body.model;
      config.browser = config.browser || { headless: true, executablePath: '/usr/bin/google-chrome', defaultProfile: 'openclaw', noSandbox: true };
      config.gateway.mode = config.gateway.mode || 'local'; config.gateway.bind = config.gateway.bind || 'loopback'; config.gateway.trustedProxies = config.gateway.trustedProxies || ['127.0.0.1', '::1'];
      saveConfig(config); restartService('openclaw'); await new Promise(r => setTimeout(r, 2000));
      return json(res, 200, { ok: isServiceActive('openclaw'), error: isServiceActive('openclaw') ? null : 'Unable to start' });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // Fallback — GET config
  if (req.method === 'GET' && url.pathname === '/api/fallback') {
    try {
      const fbCfg = getFallbackConfig();
      const config = getConfig();
      const model = config?.agents?.defaults?.model?.primary || '';
      const provInfo = Object.entries(PROVIDERS).find(([k]) => model.startsWith(k + '/') || (k === 'gemini' && model.startsWith('google/')) || (k === 'bedrock' && model.startsWith('amazon-bedrock/')));
      const primaryProvider = provInfo ? provInfo[0] : '';
      const chain = (fbCfg.chain || []).map(c => {
        const prov = PROVIDERS[c.provider];
        return { ...c, hasKey: prov ? !!getEnvValue(prov.envKey) : false };
      });
      return json(res, 200, { ok: true, chain, settings: fbCfg.settings || {}, primaryProvider, primaryModel: model });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // Fallback — POST save config/settings
  if (req.method === 'POST' && url.pathname === '/api/fallback') {
    try {
      const body = await parseBody(req);
      const fbCfg = getFallbackConfig();
      if (body.chain) fbCfg.chain = body.chain;
      if (body.settings) fbCfg.settings = { ...fbCfg.settings, ...body.settings };
      saveFallbackConfig(fbCfg);
      return json(res, 200, { ok: true });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // Fallback — Add provider to chain
  if (req.method === 'POST' && url.pathname === '/api/fallback/add') {
    try {
      const body = await parseBody(req);
      const prov = PROVIDERS[body.provider];
      if (!prov) return json(res, 400, { ok: false, error: 'Invalid provider' });
      const fbCfg = getFallbackConfig();
      if (fbCfg.chain.some(c => c.provider === body.provider)) return json(res, 400, { ok: false, error: 'Provider already in chain' });
      fbCfg.chain.push({ provider: body.provider, model: body.model || prov.models[0]?.id || '', priority: fbCfg.chain.length + 1 });
      if (body.apiKey) setEnvValue(prov.envKey, body.apiKey);
      saveFallbackConfig(fbCfg);
      return json(res, 200, { ok: true, chain: fbCfg.chain });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // Fallback — Remove provider from chain
  if (req.method === 'DELETE' && url.pathname === '/api/fallback/remove') {
    try {
      const body = await parseBody(req);
      const fbCfg = getFallbackConfig();
      const config = getConfig();
      const primaryModel = config?.agents?.defaults?.model?.primary || '';
      const isPrimary = primaryModel.startsWith(body.provider + '/') || (body.provider === 'gemini' && primaryModel.startsWith('google/')) || (body.provider === 'bedrock' && primaryModel.startsWith('amazon-bedrock/'));
      if (isPrimary) return json(res, 400, { ok: false, error: 'Cannot remove primary provider' });
      fbCfg.chain = fbCfg.chain.filter(c => c.provider !== body.provider);
      fbCfg.chain.forEach((c, i) => c.priority = i + 1);
      saveFallbackConfig(fbCfg);
      return json(res, 200, { ok: true, chain: fbCfg.chain });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // === Agents ===
  if (req.method === 'GET' && url.pathname === '/api/agents') {
    try {
      let output = '';
      try { output = execSync(`/opt/openclaw-cli.sh agents list --json 2>/dev/null`, { timeout: 15000, stdio: 'pipe' }).toString(); }
      catch (e) { output = (e.stdout || '').toString(); }
      let agents;
      try { agents = JSON.parse(output); } catch { return json(res, 200, { ok: false, error: 'Unable to read agent list' }); }
      const config = getConfig();
      const defaultModel = config?.agents?.defaults?.model?.primary || '';
      agents = (Array.isArray(agents) ? agents : []).map(a => ({ ...a, model: a.model || defaultModel, identity: a.identity || {} }));
      // Collect active providers (have API key set)
      const activeProviders = [];
      for (const [k, p] of Object.entries(PROVIDERS)) {
        const key = getEnvValue(p.envKey);
        if (key && !key.startsWith('#')) activeProviders.push({ id: k, name: p.name, icon: p.icon, models: p.models });
      }
      return json(res, 200, { ok: true, agents, activeProviders });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  if (req.method === 'POST' && url.pathname === '/api/agents/add') {
    try {
      const body = await parseBody(req);
      const name = (body.name || '').replace(/[^a-zA-Z0-9_-]/g, '');
      if (!name) return json(res, 400, { ok: false, error: 'Missing agent name' });
      if (name.length > 32) return json(res, 400, { ok: false, error: 'Name too long (max 32 chars)' });
      let cmd = `agents add "${name}" --non-interactive --json`;
      if (body.model) { const m = body.model.replace(/[^a-zA-Z0-9/_.-]/g, ''); cmd += ` --model "${m}"`; }
      if (body.bind) { const b = body.bind.replace(/[^a-zA-Z0-9_:-]/g, ''); cmd += ` --bind "${b}"`; }
      try { execSync(`/opt/openclaw-cli.sh ${cmd}`, { timeout: 30000, stdio: 'pipe' }); }
      catch (e) { const err = ((e.stderr || '') + (e.stdout || '')).toString().trim(); return json(res, 200, { ok: false, error: err.substring(0, 300) || e.message }); }
      restartService('openclaw'); await new Promise(r => setTimeout(r, 2000));
      return json(res, 200, { ok: true });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  if (req.method === 'POST' && url.pathname === '/api/agents/identity') {
    try {
      const body = await parseBody(req);
      const agent = (body.agent || '').replace(/[^a-zA-Z0-9_-]/g, '');
      if (!agent) return json(res, 400, { ok: false, error: 'Missing agent ID' });
      let cmd = `agents set-identity --agent "${agent}" --json`;
      if (body.name) { const n = body.name.replace(/"/g, '\\"'); cmd += ` --name "${n}"`; }
      if (body.emoji) { const e = body.emoji.replace(/"/g, '\\"'); cmd += ` --emoji "${e}"`; }
      if (body.theme) { const t = body.theme.replace(/[^a-zA-Z0-9_-]/g, ''); cmd += ` --theme "${t}"`; }
      try { execSync(`/opt/openclaw-cli.sh ${cmd}`, { timeout: 15000, stdio: 'pipe' }); }
      catch (e) { const err = ((e.stderr || '') + (e.stdout || '')).toString().trim(); return json(res, 200, { ok: false, error: err.substring(0, 300) || e.message }); }
      return json(res, 200, { ok: true });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  if (req.method === 'DELETE' && url.pathname === '/api/agents/delete') {
    try {
      const body = await parseBody(req);
      const agent = (body.agent || '').replace(/[^a-zA-Z0-9_-]/g, '');
      if (!agent) return json(res, 400, { ok: false, error: 'Missing agent ID' });
      if (agent === 'main') return json(res, 400, { ok: false, error: 'Cannot delete default agent (main)' });
      try { execSync(`/opt/openclaw-cli.sh agents delete "${agent}" --force --json`, { timeout: 15000, stdio: 'pipe' }); }
      catch (e) { const err = ((e.stderr || '') + (e.stdout || '')).toString().trim(); return json(res, 200, { ok: false, error: err.substring(0, 300) || e.message }); }
      restartService('openclaw'); await new Promise(r => setTimeout(r, 2000));
      return json(res, 200, { ok: true });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // Channels
  if (req.method === 'POST' && url.pathname === '/api/channels') {
    try {
      const body = await parseBody(req); const ch = CHANNELS[body.channel];
      if (!ch) return json(res, 400, { ok: false, error: 'Invalid channel' });
      for (const [key, val] of Object.entries(body.tokens || {})) { if (ch.envKeys.includes(key) && val) setEnvValue(key, val); }
      restartService('openclaw'); await new Promise(r => setTimeout(r, 2000));
      return json(res, 200, { ok: true });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // Channel Disable (disable channel — remove token env vars)
  if (req.method === 'POST' && url.pathname === '/api/channel-disable') {
    try {
      const body = await parseBody(req); const ch = CHANNELS[body.channel];
      if (!ch) return json(res, 400, { ok: false, error: 'Invalid channel' });
      // Remove all env keys for channel (set as comment)
      ch.envKeys.forEach(k => { setEnvValue(k, '#disabled'); });
      restartService('openclaw'); await new Promise(r => setTimeout(r, 2000));
      return json(res, 200, { ok: true });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // Channel Values (pre-fill for active channels)
  if (req.method === 'POST' && url.pathname === '/api/channel-values') {
    try {
      const body = await parseBody(req); const ch = CHANNELS[body.channel];
      if (!ch) return json(res, 400, { ok: false, error: 'Invalid channel' });
      const values = {};
      ch.envKeys.forEach(k => { const v = getEnvValue(k); if (v && !v.startsWith('#')) values[k] = v.substring(0, 4) + '***' + v.substring(v.length - 4); });
      return json(res, 200, { ok: true, values });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // Channel Pair
  if (req.method === 'POST' && url.pathname === '/api/channel-pair') {
    try {
      const body = await parseBody(req); const ch = CHANNELS[body.channel];
      if (!ch || !ch.canPair) return json(res, 400, { ok: false, error: 'Web pairing not supported' });
      const code = (body.code || '').replace(/[^a-zA-Z0-9_-]/g, '');
      if (!code) return json(res, 400, { ok: false, error: 'Missing code' });
      try { execSync(`/opt/openclaw-cli.sh pairing approve ${ch.pairCmd} ${code}`, { timeout: 15000, stdio: 'pipe' }); return json(res, 200, { ok: true }); }
      catch (e) { return json(res, 200, { ok: false, error: (e.stderr || e.stdout || '').toString().substring(0, 200) || e.message }); }
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // Device Pair — find and approve pending pairing request
  if (req.method === 'POST' && url.pathname === '/api/pair') {
    try {
      const gatewayToken = getEnvValue('OPENCLAW_GATEWAY_TOKEN');
      if (!gatewayToken) return json(res, 400, { ok: false, error: 'No gateway token' });
      let output = '';
      try { output = execSync(`/opt/openclaw-cli.sh devices list --token=${gatewayToken} --json 2>/dev/null`, { timeout: 15000, stdio: 'pipe' }).toString(); } catch (e) { output = (e.stdout || '').toString(); }
      let data; try { data = JSON.parse(output); } catch { return json(res, 200, { ok: false, error: 'Unable to read device list' }); }
      const pending = data.pending || [];
      if (!pending.length) return json(res, 200, { ok: false, error: 'No pairing request found. Open dashboard first then try again.' });
      if (pending.length > 1) return json(res, 200, { ok: false, error: 'Found ' + pending.length + ' request(s). Try again later.' });
      const requestId = pending[0].requestId || '';
      if (!requestId) return json(res, 200, { ok: false, error: 'Unable to get request ID' });
      execSync(`/opt/openclaw-cli.sh devices approve "${requestId}" --token=${gatewayToken}`, { timeout: 15000, stdio: 'pipe' });
      return json(res, 200, { ok: true });
    } catch (e) { return json(res, 500, { ok: false, error: 'Pairing error: ' + e.message }); }
  }

  // Device List
  if (req.method === 'GET' && url.pathname === '/api/devices') {
    try {
      const gatewayToken = getEnvValue('OPENCLAW_GATEWAY_TOKEN');
      if (!gatewayToken) return json(res, 200, { ok: true, devices: [] });
      let output = '';
      try { output = execSync(`/opt/openclaw-cli.sh devices list --token=${gatewayToken} --json 2>/dev/null`, { timeout: 15000, stdio: 'pipe' }).toString(); } catch (e) { output = (e.stdout || '').toString(); }
      let data; try { data = JSON.parse(output); } catch { return json(res, 200, { ok: true, devices: [] }); }
      const devices = [];
      (data.paired || []).forEach(d => { const tokens = d.tokens || []; const allRevoked = tokens.length > 0 && tokens.every(t => t.revokedAtMs); const st = allRevoked ? 'revoked' : 'paired'; devices.push({ uuid: d.deviceId || d.id || '', name: (d.platform || d.clientId || d.deviceId || '').substring(0, 20), status: st, ip: d.remoteIp || '', platform: d.platform || '', client: d.clientId || '', mode: d.clientMode || '', role: d.role || 'operator' }); });
      (data.pending || []).forEach(d => devices.push({ uuid: d.deviceId || d.id || '', name: (d.platform || d.clientId || d.deviceId || '').substring(0, 20) + ' (pending)', status: 'pending', ip: d.remoteIp || '', platform: d.platform || '', client: d.clientId || '', mode: d.clientMode || '', role: d.role || 'operator' }));
      return json(res, 200, { ok: true, devices });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // Revoke Device
  if (req.method === 'DELETE' && url.pathname === '/api/device-revoke') {
    try {
      const body = await parseBody(req);
      const deviceId = (body.deviceId || '').replace(/[^a-f0-9]/g, '');
      const role = (body.role || 'operator').replace(/[^a-z]/g, '');
      if (!deviceId) return json(res, 400, { ok: false, error: 'Missing device ID' });
      const gatewayToken = getEnvValue('OPENCLAW_GATEWAY_TOKEN');
      if (!gatewayToken) return json(res, 400, { ok: false, error: 'No gateway token' });
      execSync(`/opt/openclaw-cli.sh devices revoke --device ${deviceId} --role ${role} --token=${gatewayToken}`, { timeout: 15000, stdio: 'pipe' });
      return json(res, 200, { ok: true });
    } catch (e) { return json(res, 500, { ok: false, error: 'Revoke error: ' + (e.stderr ? e.stderr.toString().trim() : e.message) }); }
  }

  // Gateway Token
  if (req.method === 'POST' && url.pathname === '/api/gateway-token') {
    try {
      const body = await parseBody(req);
      let t = (body.action === 'custom' && body.token) ? body.token.replace(/[^a-zA-Z0-9_-]/g, '') : crypto.randomBytes(32).toString('hex');
      setEnvValue('OPENCLAW_GATEWAY_TOKEN', t);
      const config = getConfig(); if (config.gateway?.auth) { config.gateway.auth.token = t; saveConfig(config); }
      restartService('openclaw'); await new Promise(r => setTimeout(r, 2000));
      return json(res, 200, { ok: true, token: t });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // Domain
  if (req.method === 'POST' && url.pathname === '/api/domain') {
    try {
      const body = await parseBody(req); const serverIP = getServerIP();
      if (body.resetToIP) {
        writeCaddyfile(null);
        restartService('caddy'); await new Promise(r => setTimeout(r, 2000)); return json(res, 200, { ok: true });
      }
      const domain = (body.domain || '').trim().toLowerCase(), email = (body.email || '').trim();
      if (!domain) return json(res, 400, { ok: false, error: 'Missing domain' });
      if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) return json(res, 400, { ok: false, error: 'Invalid domain' });
      let ips = [];
      try { const o = safeExec(`dig +short A ${domain}`, 10000); if (o) ips = o.split('\n').filter(i => /^\d+\.\d+\.\d+\.\d+$/.test(i.trim())); } catch {}
      if (!ips.length) try { const o = safeExec(`host ${domain}`, 10000); const m = o.match(/has address (\d+\.\d+\.\d+\.\d+)/g); if (m) ips = m.map(s => s.replace('has address ', '')); } catch {}
      if (!ips.length) try { const o = safeExec(`python3 -c "import socket; print(socket.gethostbyname('${domain}'))"`, 10000); if (/^\d+\.\d+\.\d+\.\d+$/.test(o)) ips = [o]; } catch {}
      if (!ips.length) return json(res, 400, { ok: false, error: `DNS resolution failed. Point A record to ${serverIP}.` });
      if (!ips.includes(serverIP)) return json(res, 400, { ok: false, error: `DNS points to ${ips.join(', ')} — not ${serverIP}.` });
      writeCaddyfile(domain, email);
      execSync('systemctl enable caddy 2>/dev/null || true', { timeout: 10000 }); restartService('caddy'); await new Promise(r => setTimeout(r, 3000));
      if (isServiceActive('caddy')) return json(res, 200, { ok: true, domain });
      writeCaddyfile(null); restartService('caddy');
      return json(res, 500, { ok: false, error: 'Caddy error. Rolled back.' });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // Update Check
  if (req.method === 'GET' && url.pathname === '/api/update-check') {
    try {
      const cur = getEnvValue('OPENCLAW_VERSION') || '';
      safeExec(`cd ${OPENCLAW_DIR} && git fetch --tags 2>/dev/null`, 30000);
      const raw = safeExec(`cd ${OPENCLAW_DIR} && git tag --sort=-version:refname 2>/dev/null`, 10000);
      // Only stable releases: vYYYY.M.D (no -beta, -rc, -2 suffixes)
      const tags = raw.split('\n').map(t => t.trim()).filter(t => /^v\d+\.\d+\.\d+$/.test(t));
      // Parse version for comparison: v2026.2.18 => [2026, 2, 18]
      const parseVer = v => (v.replace(/^v/, '').split('.').map(Number));
      const cmpVer = (a, b) => { const pa = parseVer(a), pb = parseVer(b); for (let i = 0; i < 3; i++) { if ((pa[i]||0) !== (pb[i]||0)) return (pb[i]||0) - (pa[i]||0); } return 0; };
      tags.sort(cmpVer);
      const newer = cur && /^v\d+\.\d+\.\d+$/.test(cur) ? tags.filter(t => cmpVer(t, cur) < 0) : tags.filter(t => t !== cur);
      return json(res, 200, { ok: true, current: cur, versions: newer.slice(0, 20) });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // Update
  if (req.method === 'POST' && url.pathname === '/api/update') {
    try {
      const body = await parseBody(req); const ver = (body.version || 'latest').trim(); let log = '';
      log += 'Stop OpenClaw...\n'; safeExec('systemctl stop openclaw', 30000);
      log += 'Fetch...\n'; safeExec(`cd ${OPENCLAW_DIR} && git stash 2>/dev/null`, 15000); safeExec(`cd ${OPENCLAW_DIR} && git fetch --tags --all`, 30000);
      if (ver === 'latest') { safeExec(`cd ${OPENCLAW_DIR} && git checkout main && git pull origin main`, 30000); log += 'Checkout main.\n'; }
      else { safeExec(`cd ${OPENCLAW_DIR} && git checkout ${ver.replace(/[^a-zA-Z0-9._-]/g, '')}`, 15000); log += `Checkout ${ver}.\n`; }
      log += 'Fix permissions...\n'; safeExec(`chown -R openclaw:openclaw ${OPENCLAW_DIR}`, 30000);
      log += 'Build...\n';
      const bo = safeExec(`cd ${OPENCLAW_DIR} && su - openclaw -c "cd ${OPENCLAW_DIR} && pnpm install --frozen-lockfile 2>&1 && pnpm build 2>&1 && pnpm ui:install 2>&1 && pnpm ui:build 2>&1"`, 300000);
      log += bo ? bo.substring(Math.max(0, bo.length - 500)) + '\n' : 'Done.\n';
      if (ver !== 'latest') setEnvValue('OPENCLAW_VERSION', ver);
      log += 'Start...\n'; restartService('openclaw'); await new Promise(r => setTimeout(r, 3000));
      const ok = isServiceActive('openclaw'); log += ok ? 'OK!\n' : 'FAIL\n';
      return json(res, 200, { ok, log, error: ok ? null : 'Unable to start' });
    } catch (e) { return json(res, 500, { ok: false, error: e.message, log: e.message }); }
  }

  // Plugins List
  if (req.method === 'GET' && url.pathname === '/api/plugins') {
    try {
      const out = safeExec(`su - openclaw -c "cd ${OPENCLAW_DIR} && node dist/index.js plugins list --json" 2>/dev/null`, 30000);
      if (!out) return json(res, 500, { ok: false, error: 'Failed to list plugins' });
      const data = JSON.parse(out);
      return json(res, 200, { ok: true, plugins: data.plugins || [] });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // Plugin Toggle (enable/disable)
  if (req.method === 'POST' && url.pathname === '/api/plugins/toggle') {
    try {
      const body = await parseBody(req);
      const id = (body.id || '').replace(/[^a-zA-Z0-9_-]/g, '');
      if (!id) return json(res, 400, { ok: false, error: 'Missing plugin id' });
      const action = body.enable ? 'enable' : 'disable';
      const out = safeExec(`su - openclaw -c "cd ${OPENCLAW_DIR} && node dist/index.js plugins ${action} ${id}" 2>&1`, 30000);
      restartService('openclaw'); await new Promise(r => setTimeout(r, 2000));
      return json(res, 200, { ok: true, log: out });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // Plugin Install
  if (req.method === 'POST' && url.pathname === '/api/plugins/install') {
    try {
      const body = await parseBody(req);
      const spec = (body.spec || '').replace(/[;&|`$()]/g, '');
      if (!spec) return json(res, 400, { ok: false, error: 'Missing package spec' });
      const out = safeExec(`su - openclaw -c "cd ${OPENCLAW_DIR} && node dist/index.js plugins install '${spec}'" 2>&1`, 120000);
      const ok = !out.includes('Error') && !out.includes('error:');
      if (ok) { restartService('openclaw'); await new Promise(r => setTimeout(r, 2000)); }
      return json(res, 200, { ok, log: out, error: ok ? null : out });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // Plugin Uninstall
  if (req.method === 'POST' && url.pathname === '/api/plugins/uninstall') {
    try {
      const body = await parseBody(req);
      const id = (body.id || '').replace(/[^a-zA-Z0-9_-]/g, '');
      if (!id) return json(res, 400, { ok: false, error: 'Missing plugin id' });
      const out = safeExec(`su - openclaw -c "cd ${OPENCLAW_DIR} && node dist/index.js plugins uninstall ${id} --yes" 2>&1`, 60000);
      restartService('openclaw'); await new Promise(r => setTimeout(r, 2000));
      return json(res, 200, { ok: true, log: out });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // Plugin Update
  if (req.method === 'POST' && url.pathname === '/api/plugins/update') {
    try {
      const body = await parseBody(req);
      const id = (body.id || '').replace(/[^a-zA-Z0-9_-]/g, '');
      if (!id) return json(res, 400, { ok: false, error: 'Missing plugin id' });
      const cmd = id === '--all' ? 'plugins update --all --yes' : `plugins update ${id} --yes`;
      const out = safeExec(`su - openclaw -c "cd ${OPENCLAW_DIR} && node dist/index.js ${cmd}" 2>&1`, 120000);
      restartService('openclaw'); await new Promise(r => setTimeout(r, 2000));
      return json(res, 200, { ok: true, log: out });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // Skills List
  if (req.method === 'GET' && url.pathname === '/api/skills') {
    try {
      const out = safeExec(`su - openclaw -c "cd ${OPENCLAW_DIR} && node dist/index.js skills list --json" 2>/dev/null`, 30000);
      if (!out) return json(res, 500, { ok: false, error: 'Failed to list skills' });
      const data = JSON.parse(out);
      return json(res, 200, { ok: true, skills: data.skills || [] });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // Skills Toggle (enable/disable)
  if (req.method === 'POST' && url.pathname === '/api/skills/toggle') {
    try {
      const body = await parseBody(req);
      const name = (body.name || '').replace(/[^a-zA-Z0-9_-]/g, '');
      if (!name) return json(res, 400, { ok: false, error: 'Missing skill name' });
      const action = body.disable ? 'disable' : 'enable';
      const out = safeExec(`su - openclaw -c "cd ${OPENCLAW_DIR} && node dist/index.js skills ${action} ${name}" 2>&1`, 30000);
      restartService('openclaw'); await new Promise(r => setTimeout(r, 2000));
      return json(res, 200, { ok: true, log: out });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // ClawHub Search
  if (req.method === 'POST' && url.pathname === '/api/clawhub/search') {
    try {
      const body = await parseBody(req);
      const query = (body.query || '').replace(/[;&|`$()'"]/g, '').substring(0, 100);
      if (!query) return json(res, 400, { ok: false, error: 'Missing query' });
      const out = safeExec(`su - openclaw -c "cd ${OPENCLAW_DIR} && npx clawhub search '${query}'" 2>/dev/null`, 30000);
      if (!out) return json(res, 200, { ok: true, results: [] });
      const results = out.split('\n').filter(l => l.trim()).map(l => {
        const m = l.match(/^(\S+)\s+(v[\d.]+)\s+(.+?)\s+\(([\d.]+)\)$/);
        return m ? { slug: m[1], version: m[2], name: m[3].trim(), score: parseFloat(m[4]) } : null;
      }).filter(Boolean);
      return json(res, 200, { ok: true, results });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // ClawHub Install
  if (req.method === 'POST' && url.pathname === '/api/clawhub/install') {
    try {
      const body = await parseBody(req);
      const slug = (body.slug || '').replace(/[^a-zA-Z0-9_-]/g, '');
      if (!slug) return json(res, 400, { ok: false, error: 'Missing slug' });
      const out = safeExec(`su - openclaw -c "cd ${OPENCLAW_DIR} && npx clawhub install ${slug} --force" 2>&1`, 60000);
      const ok = !out.includes('Error:') && !out.includes('error:') && !out.includes('ENOENT');
      if (ok) { restartService('openclaw'); await new Promise(r => setTimeout(r, 2000)); }
      return json(res, 200, { ok, log: out, error: ok ? null : out });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // ClawHub Uninstall
  if (req.method === 'POST' && url.pathname === '/api/clawhub/uninstall') {
    try {
      const body = await parseBody(req);
      const slug = (body.slug || '').replace(/[^a-zA-Z0-9_-]/g, '');
      if (!slug) return json(res, 400, { ok: false, error: 'Missing slug' });
      const out = safeExec(`su - openclaw -c "cd ${OPENCLAW_DIR} && npx clawhub uninstall ${slug} --yes" 2>&1`, 30000);
      restartService('openclaw'); await new Promise(r => setTimeout(r, 2000));
      return json(res, 200, { ok: true, log: out });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // ClawHub Update
  if (req.method === 'POST' && url.pathname === '/api/clawhub/update') {
    try {
      const body = await parseBody(req);
      const slug = (body.slug || '').replace(/[^a-zA-Z0-9_-]/g, '');
      if (!slug) return json(res, 400, { ok: false, error: 'Missing slug' });
      const cmd = slug === '--all' ? 'update --all' : `update ${slug}`;
      const out = safeExec(`su - openclaw -c "cd ${OPENCLAW_DIR} && npx clawhub ${cmd}" 2>&1`, 60000);
      restartService('openclaw'); await new Promise(r => setTimeout(r, 2000));
      return json(res, 200, { ok: true, log: out });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // ClawHub List Installed
  if (req.method === 'GET' && url.pathname === '/api/clawhub/list') {
    try {
      const out = safeExec(`su - openclaw -c "cd ${OPENCLAW_DIR} && npx clawhub list" 2>/dev/null`, 30000);
      if (!out || out.includes('No installed skills')) return json(res, 200, { ok: true, items: [] });
      const items = out.split('\n').filter(l => l.trim() && !l.includes('Installed skills')).map(l => {
        const m = l.match(/^(\S+)\s+(v[\d.]+)?/);
        return m ? { slug: m[1], version: (m[2] || '').trim() } : null;
      }).filter(Boolean);
      return json(res, 200, { ok: true, items });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // Panel Update Check
  if (req.method === 'GET' && url.pathname === '/api/panel-update-check') {
    try {
      const localVersion = PANEL_VERSION;
      const remoteHead = safeExec(`curl -sL --max-time 10 -H "Accept: application/vnd.github.raw" -r 0-1500 "${PANEL_CHECK_URL}"`, 15000);
      const m = remoteHead.match(/PANEL_VERSION\s*=\s*['"]([^'"]+)['"]/);
      const remoteVersion = m ? m[1] : null;
      if (!remoteVersion) return json(res, 200, { ok: true, current: localVersion, latest: null, updateAvailable: false, error: 'Unable to read version from server' });
      return json(res, 200, { ok: true, current: localVersion, latest: remoteVersion, updateAvailable: remoteVersion !== localVersion });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // Panel Update
  if (req.method === 'POST' && url.pathname === '/api/panel-update') {
    try {
      const tmpFile = PANEL_FILE + '.new';
      let log = '';
      log += 'Downloading latest panel.js...\n';
      const dlResult = safeExec(`curl -fsSL --max-time 30 -o "${tmpFile}" "${PANEL_UPDATE_URL}" && echo "OK"`, 45000);
      if (!dlResult.includes('OK')) { try { fs.unlinkSync(tmpFile); } catch {} return json(res, 500, { ok: false, error: 'Failed to download panel.js', log }); }
      log += 'Validating...\n';
      const stat = fs.statSync(tmpFile);
      if (stat.size < 1000) { fs.unlinkSync(tmpFile); return json(res, 500, { ok: false, error: 'Downloaded file too small (' + stat.size + ' bytes)', log }); }
      const head = fs.readFileSync(tmpFile, 'utf8').substring(0, 300);
      if (!head.includes('#!/usr/bin/env node') || !head.includes('OpenClaw')) { fs.unlinkSync(tmpFile); return json(res, 500, { ok: false, error: 'Invalid file', log }); }
      log += 'Backing up current panel...\n';
      try { fs.copyFileSync(PANEL_FILE, PANEL_FILE + '.bak'); } catch {}
      log += 'Replacing panel.js...\n';
      fs.renameSync(tmpFile, PANEL_FILE);
      log += 'Restarting panel service...\n';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, log, message: 'Update successful! Panel restarting...' }));
      setTimeout(() => {
        try { execSync('systemctl restart openclaw-panel', { timeout: 15000 }); }
        catch { try { fs.copyFileSync(PANEL_FILE + '.bak', PANEL_FILE); execSync('systemctl restart openclaw-panel', { timeout: 15000 }); } catch {} }
      }, 500);
      return;
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // Status
  if (req.method === 'GET' && url.pathname === '/api/status') {
    try {
      const services = [
        { name: 'OpenClaw Gateway', active: isServiceActive('openclaw') },
        { name: 'Caddy', active: isServiceActive('caddy') },
        { name: 'Panel', active: isServiceActive('openclaw-panel') }
      ];
      return json(res, 200, { ok: true, services,
        uptime: safeExec('uptime -p') || '-',
        memory: safeExec("free -h | awk '/^Mem:/{print $3\"/\"$2}'") || '-',
        disk: safeExec("df -h / | awk 'NR==2{print $3\"/\"$2\" (\"$5\" used)\"}'") || '-',
        cpu: safeExec("top -bn1 | grep 'Cpu(s)' | awk '{print $2\"%\"}'") || safeExec("nproc") + ' cores',
        version: getEnvValue('OPENCLAW_VERSION') || '-',
        panelVersion: PANEL_VERSION,
        token: getEnvValue('OPENCLAW_GATEWAY_TOKEN') || '-'
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // Logs
  if (req.method === 'GET' && url.pathname === '/api/logs') {
    try { return json(res, 200, { ok: true, logs: safeExec('journalctl -u openclaw -n 50 --no-pager 2>/dev/null', 10000) || 'No logs.' }); }
    catch (e) { return json(res, 200, { ok: true, logs: 'Error: ' + e.message }); }
  }

  // Restart
  if (req.method === 'POST' && url.pathname === '/api/restart') {
    try {
      const body = await parseBody(req); const svc = (body.service || '').replace(/[^a-z-]/g, '');
      if (!['openclaw', 'caddy'].includes(svc)) return json(res, 400, { ok: false, error: 'Invalid' });
      const ok = restartService(svc); await new Promise(r => setTimeout(r, 2000));
      return json(res, 200, { ok, error: ok ? null : 'Fail' });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // === Chat Playground (with fallback) ===
  if (req.method === 'POST' && url.pathname === '/api/chat') {
    try {
      const body = await parseBody(req);
      const config = getConfig();
      const model = config?.agents?.defaults?.model?.primary || '';
      if (!model) return json(res, 400, { ok: false, error: 'Provider not configured' });

      // Detect primary provider
      const provEntry = Object.entries(PROVIDERS).find(([k]) => model.startsWith(k + '/') || (k === 'gemini' && model.startsWith('google/')) || (k === 'bedrock' && model.startsWith('amazon-bedrock/')));
      if (!provEntry) return json(res, 400, { ok: false, error: 'Unknown provider' });

      // Build messages
      const messages = (body.history || []).slice(-20).map(m => ({ role: m.role, content: m.content }));
      if (!messages.length || messages[messages.length - 1].content !== body.message)
        messages.push({ role: 'user', content: body.message });

      // Build provider chain: primary first, then fallbacks
      const fbCfg = getFallbackConfig();
      const tryList = [{ provKey: provEntry[0], model }];
      (fbCfg.chain || []).forEach(c => {
        if (c.provider !== provEntry[0] && PROVIDERS[c.provider]) tryList.push({ provKey: c.provider, model: c.model });
      });

      let reply = '', tokens = 0, usedProvider = '', usedModel = '', lastError = '';
      for (const attempt of tryList) {
        const prov = PROVIDERS[attempt.provKey];
        const apiKey = getEnvValue(prov.envKey);
        if (!apiKey) { lastError = attempt.provKey + ': no API key'; continue; }
        // Rate limit check
        const rl = checkRateLimit(fbCfg, attempt.provKey);
        if (!rl.allowed) { lastError = attempt.provKey + ': ' + rl.reason + (rl.remaining ? ' (' + rl.remaining + 's)' : ''); continue; }
        // Call provider
        const result = callProvider(attempt.provKey, attempt.model, apiKey, messages);
        recordProviderCall(fbCfg, attempt.provKey);
        if (result.ok && result.reply && result.reply !== 'No response') {
          reply = result.reply; tokens = result.tokens || 0;
          usedProvider = attempt.provKey; usedModel = attempt.model;
          break;
        } else {
          lastError = attempt.provKey + ': ' + (result.error || 'failed');
          recordProviderCooldown(fbCfg, attempt.provKey);
        }
      }
      // Save rate state
      try { saveFallbackConfig(fbCfg); } catch {}

      if (!reply) return json(res, 502, { ok: false, error: 'All providers failed. ' + lastError });

      // Track usage
      try {
        const statsFile = '/opt/openclaw-panel-stats.json';
        let stats = {}; try { stats = JSON.parse(fs.readFileSync(statsFile, 'utf8')); } catch {}
        const today = new Date().toISOString().slice(0, 10);
        stats.requests = (stats.requests || 0) + 1; stats.tokens = (stats.tokens || 0) + tokens;
        stats.daily = stats.daily || {}; stats.daily[today] = stats.daily[today] || { requests: 0, tokens: 0 };
        stats.daily[today].requests++; stats.daily[today].tokens += tokens;
        fs.writeFileSync(statsFile, JSON.stringify(stats), 'utf8');
      } catch {}

      return json(res, 200, { ok: true, reply, tokens, model: usedModel, usedProvider });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // === Analytics ===
  if (req.method === 'GET' && url.pathname === '/api/analytics') {
    try {
      // 1. Chat Playground stats (existing)
      const statsFile = '/opt/openclaw-panel-stats.json';
      let pgStats = {}; try { pgStats = JSON.parse(fs.readFileSync(statsFile, 'utf8')); } catch {}

      // 2. Read real sessions from OpenClaw agent
      const sessionsFile = '/home/openclaw/.openclaw/agents/main/sessions/sessions.json';
      let sessionsData = {}; try { sessionsData = JSON.parse(fs.readFileSync(sessionsFile, 'utf8')); } catch {}

      let totalMsgs = 0, totalConv = 0, channelCounts = {}, dailyMsgs = {};
      const today = new Date().toISOString().slice(0, 10);

      Object.values(sessionsData).forEach(sess => {
        if (!sess || typeof sess !== 'object') return;
        totalConv++;
        const channel = sess.deliveryContext?.channel || sess.origin?.surface || 'unknown';
        channelCounts[channel] = (channelCounts[channel] || 0) + 1;

        // Read session JSONL for message counts + dates
        const sf = sess.sessionFile;
        if (sf && fs.existsSync(sf)) {
          try {
            const lines = fs.readFileSync(sf, 'utf8').split('\n').filter(Boolean);
            for (const line of lines) {
              try {
                const d = JSON.parse(line);
                if (d.type === 'message' && d.message?.role === 'user') {
                  totalMsgs++;
                  const dateStr = (d.timestamp || '').substring(0, 10);
                  if (dateStr.match(/^\d{4}-\d{2}-\d{2}$/)) dailyMsgs[dateStr] = (dailyMsgs[dateStr] || 0) + 1;
                }
              } catch {}
            }
          } catch {}
        }
      });

      // Add playground stats to channel counts
      if (pgStats.requests > 0) channelCounts['playground'] = (channelCounts['playground'] || 0) + (pgStats.requests || 0);

      // 3. Build 7-day chart (merge sessions + playground)
      const daily = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        const ds = d.toISOString().slice(0, 10);
        daily.push({
          date: ds,
          messages: (dailyMsgs[ds] || 0) + (pgStats.daily?.[ds]?.requests || 0),
          tokens: pgStats.daily?.[ds]?.tokens || 0
        });
      }

      // 4. Provider info
      const config = getConfig(); const model = config?.agents?.defaults?.model?.primary || '';
      const provInfo = Object.entries(PROVIDERS).find(([k]) => model.startsWith(k + '/') || (k === 'gemini' && model.startsWith('google/')) || (k === 'bedrock' && model.startsWith('amazon-bedrock/')));

      return json(res, 200, {
        ok: true,
        totalConversations: totalConv,
        totalMessages: totalMsgs + (pgStats.requests || 0),
        totalTokens: pgStats.tokens || 0,
        todayMessages: (dailyMsgs[today] || 0) + (pgStats.daily?.[today]?.requests || 0),
        provider: provInfo ? provInfo[1].name : '-',
        channels: channelCounts,
        daily
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // === Conversations (reads from real OpenClaw session files) ===
  const SESSIONS_DIR = '/home/openclaw/.openclaw/agents/main/sessions';
  const SESSIONS_INDEX = SESSIONS_DIR + '/sessions.json';

  // Helper: extract text from message content (string or array of {type,text})
  function extractMsgText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.filter(c => c && c.type === 'text').map(c => c.text || '').join(' ');
    return '';
  }
  // Helper: clean user message prefix like "[Thu 2026-02-19 08:44 GMT+7]" or "[Telegram ...]"
  function cleanUserMsg(text) {
    return text.replace(/^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s[^\]]*\]\s*/i, '').replace(/^\[Telegram\s[^\]]*\]\s*/i, '').replace(/^\[Zalo\s[^\]]*\]\s*/i, '').replace(/\n\[message_id:[^\]]*\]\s*$/i, '').trim();
  }

  if (req.method === 'GET' && url.pathname === '/api/conversations') {
    try {
      let sessionsData = {}; try { sessionsData = JSON.parse(fs.readFileSync(SESSIONS_INDEX, 'utf8')); } catch {}
      const conversations = [];

      Object.entries(sessionsData).forEach(([key, sess]) => {
        if (!sess || !sess.sessionFile) return;
        try {
          const channel = sess.deliveryContext?.channel || sess.origin?.surface || 'unknown';
          const label = sess.origin?.label || '';
          const sf = sess.sessionFile;
          if (!fs.existsSync(sf)) return;

          const lines = fs.readFileSync(sf, 'utf8').split('\n').filter(Boolean);
          let msgCount = 0, firstUserMsg = '', firstTs = '', lastTs = '';
          for (const line of lines) {
            try {
              const d = JSON.parse(line);
              if (d.type === 'message') {
                const role = d.message?.role;
                if (role === 'user' || role === 'assistant') {
                  msgCount++;
                  if (!firstTs) firstTs = d.timestamp || '';
                  lastTs = d.timestamp || lastTs;
                  if (role === 'user' && !firstUserMsg) {
                    firstUserMsg = cleanUserMsg(extractMsgText(d.message?.content));
                  }
                }
              }
            } catch {}
          }
          if (msgCount === 0) return;

          const dateStr = (lastTs || firstTs || '').replace('T', ' ').substring(0, 19);
          conversations.push({
            id: sess.sessionId || key,
            title: firstUserMsg.substring(0, 60) || label || 'Conversation',
            date: dateStr,
            messageCount: msgCount,
            channel,
            label
          });
        } catch {}
      });

      // Sort by date descending
      conversations.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      return json(res, 200, { ok: true, conversations });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/conversations/')) {
    try {
      const id = url.pathname.replace('/api/conversations/', '').replace(/[^a-zA-Z0-9_.-]/g, '');
      // Find session file by sessionId
      let sessionsData = {}; try { sessionsData = JSON.parse(fs.readFileSync(SESSIONS_INDEX, 'utf8')); } catch {}
      let sessionFile = '';
      for (const sess of Object.values(sessionsData)) {
        if (sess?.sessionId === id && sess.sessionFile) { sessionFile = sess.sessionFile; break; }
      }
      // Fallback: try direct path
      if (!sessionFile) { const tryPath = `${SESSIONS_DIR}/${id}.jsonl`; if (fs.existsSync(tryPath)) sessionFile = tryPath; }
      if (!sessionFile || !fs.existsSync(sessionFile)) return json(res, 404, { ok: false, error: 'Not found' });

      const lines = fs.readFileSync(sessionFile, 'utf8').split('\n').filter(Boolean);
      const messages = [];
      for (const line of lines) {
        try {
          const d = JSON.parse(line);
          if (d.type === 'message') {
            const role = d.message?.role;
            if (role === 'user') {
              messages.push({ role: 'user', content: cleanUserMsg(extractMsgText(d.message?.content)) });
            } else if (role === 'assistant') {
              const text = extractMsgText(d.message?.content);
              if (text) messages.push({ role: 'assistant', content: text });
            }
          }
        } catch {}
      }
      return json(res, 200, { ok: true, messages });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // === Security / User Management ===
  if (req.method === 'GET' && url.pathname === '/api/security') {
    try {
      return json(res, 200, {
        ok: true,
        ufw: !!safeExec("ufw status | grep -q 'Status: active' && echo 1"),
        sshPort: safeExec("grep -E '^Port ' /etc/ssh/sshd_config | awk '{print $2}'") || '22',
        clientIP: ip
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/change-password') {
    try {
      const body = await parseBody(req);
      if (!body.oldPassword || !body.newPassword) return json(res, 400, { ok: false, error: 'Missing credentials' });
      if (body.newPassword.length < 6) return json(res, 400, { ok: false, error: 'New password too short' });
      if (!verifyPassword('root', body.oldPassword)) return json(res, 401, { ok: false, error: 'Current password incorrect' });
      try {
        execSync(`echo 'root:${body.newPassword.replace(/'/g,"'\\''")}' | chpasswd`, { timeout: 10000 });
        return json(res, 200, { ok: true });
      } catch (e) { return json(res, 500, { ok: false, error: 'Error changing password: ' + e.message }); }
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // === Backup ===
  if (req.method === 'GET' && url.pathname === '/api/backup') {
    try {
      const data = { _type: 'openclaw-backup', _date: new Date().toISOString(), _version: getEnvValue('OPENCLAW_VERSION') || '' };
      try { data.config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { data.config = {}; }
      // Remove sensitive data
      if (data.config?.gateway?.auth?.token) data.config.gateway.auth.token = '***REDACTED***';
      try { const env = fs.readFileSync(ENV_FILE, 'utf8'); data.env = env.replace(/^(.*(?:KEY|TOKEN|SECRET|PASSWORD).*)=(.+)$/gm, '$1=***REDACTED***'); } catch { data.env = ''; }
      try { data.caddyfile = fs.readFileSync(CADDYFILE, 'utf8'); } catch { data.caddyfile = ''; }
      try { data.fallback = JSON.parse(fs.readFileSync(FALLBACK_FILE, 'utf8')); if (data.fallback?.chain) data.fallback.chain.forEach(c => { if (c.apiKey) c.apiKey = '***REDACTED***'; }); } catch { data.fallback = null; }
      return json(res, 200, { ok: true, data });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // === Restore ===
  if (req.method === 'POST' && url.pathname === '/api/restore') {
    try {
      const body = await parseBody(req);
      const d = body.data;
      if (!d || d._type !== 'openclaw-backup') return json(res, 400, { ok: false, error: 'Invalid backup data' });
      // Restore config (keep existing token)
      if (d.config && typeof d.config === 'object') {
        const existing = getConfig();
        const token = existing?.gateway?.auth?.token || getEnvValue('OPENCLAW_GATEWAY_TOKEN');
        if (d.config.gateway?.auth?.token === '***REDACTED***' && token) d.config.gateway.auth.token = token;
        saveConfig(d.config);
      }
      // Restore env (keep sensitive values)
      if (d.env && typeof d.env === 'string') {
        const lines = d.env.split('\n');
        for (const line of lines) {
          const m = line.match(/^([A-Z_]+)=(.+)$/);
          if (m && !m[2].includes('REDACTED')) setEnvValue(m[1], m[2]);
        }
      }
      // Restore fallback config (keep existing API keys for redacted entries)
      if (d.fallback && typeof d.fallback === 'object') {
        try { const existing = getFallbackConfig(); if (d.fallback.chain) d.fallback.chain.forEach(c => { if (c.apiKey === '***REDACTED***') { const ex = existing.chain?.find(e => e.provider === c.provider); if (ex?.apiKey) c.apiKey = ex.apiKey; else delete c.apiKey; } }); saveFallbackConfig(d.fallback); } catch {}
      }
      // Restore Caddyfile
      if (d.caddyfile) { fs.writeFileSync(CADDYFILE, d.caddyfile, 'utf8'); restartService('caddy'); }
      restartService('openclaw'); await new Promise(r => setTimeout(r, 2000));
      return json(res, 200, { ok: isServiceActive('openclaw') });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // === Config Editor ===
  if (req.method === 'GET' && url.pathname === '/api/config-read') {
    try {
      let j = '{}', e = '';
      try { j = fs.readFileSync(CONFIG_FILE, 'utf8'); } catch {}
      try { e = fs.readFileSync(ENV_FILE, 'utf8'); } catch {}
      return json(res, 200, { ok: true, json: j, env: e });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/config-write') {
    try {
      const body = await parseBody(req);
      if (body.type === 'json') {
        try { JSON.parse(body.content); } catch (e) { return json(res, 400, { ok: false, error: 'JSON error: ' + e.message }); }
        const dir = '/home/openclaw/.openclaw'; fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(CONFIG_FILE, body.content, 'utf8');
        execSync(`chown openclaw:openclaw ${CONFIG_FILE}`); execSync(`chmod 0600 ${CONFIG_FILE}`);
      } else if (body.type === 'env') {
        fs.writeFileSync(ENV_FILE, body.content, 'utf8');
      } else { return json(res, 400, { ok: false, error: 'Invalid type' }); }
      restartService('openclaw'); await new Promise(r => setTimeout(r, 2000));
      return json(res, 200, { ok: isServiceActive('openclaw') });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // === Doctor ===
  const DOCTOR_HISTORY_FILE = '/opt/openclaw-doctor-history.json';

  if (req.method === 'POST' && url.pathname === '/api/doctor') {
    try {
      const body = await parseBody(req);
      const mode = (body.mode || 'scan').replace(/[^a-z]/g, '');
      const cmds = {
        scan: 'doctor --non-interactive',
        repair: 'doctor --repair --yes',
        deep: 'doctor --deep --yes'
      };
      const cmd = cmds[mode] || cmds.scan;
      const startTime = Date.now();

      // Run openclaw doctor via CLI
      let output = '';
      try {
        output = execSync(
          `su -l openclaw -c 'cd ${OPENCLAW_DIR} && node dist/index.js ${cmd}' 2>&1`,
          { timeout: 120000, stdio: 'pipe', maxBuffer: 1024 * 1024 }
        ).toString();
      } catch (e) {
        // Doctor may exit with non-zero on failures — capture output anyway
        output = (e.stdout || '').toString() + '\n' + (e.stderr || '').toString();
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(1) + 's';

      // Parse output into summary
      const lines = output.split('\n');
      const checks = [];
      for (const line of lines) {
        const l = line.trim(); if (!l) continue;
        let status = '', name = '', detail = '';
        if (/[\u2705\u2714]/.test(l) || /\[(PASS|OK)\]/i.test(l)) { status = 'pass'; name = l.replace(/[\u2705\u2714]/g, '').replace(/\[(PASS|OK)\]/gi, '').trim(); }
        else if (/[\u26a0]/.test(l) || /\[WARN\]/i.test(l)) { status = 'warn'; name = l.replace(/[\u26a0\ufe0f]/g, '').replace(/\[WARN\]/gi, '').trim(); }
        else if (/[\u274c]/.test(l) || /\[(FAIL|ERROR)\]/i.test(l)) { status = 'fail'; name = l.replace(/[\u274c]/g, '').replace(/\[(FAIL|ERROR)\]/gi, '').trim(); }
        if (status) {
          const parts = name.split(/\s*[—\-:]\s*/, 2);
          if (parts.length > 1) { name = parts[0].trim(); detail = parts[1].trim(); }
          else { name = parts[0].trim(); detail = ''; }
          checks.push({ status, name, detail });
        }
      }
      const pass = checks.filter(c => c.status === 'pass').length;
      const warn = checks.filter(c => c.status === 'warn').length;
      const fail = checks.filter(c => c.status === 'fail').length;
      const summary = { total: checks.length, pass, warn, fail, checks };

      // Save to history (keep last 20)
      try {
        let history = [];
        try { history = JSON.parse(fs.readFileSync(DOCTOR_HISTORY_FILE, 'utf8')); } catch {}
        if (!Array.isArray(history)) history = [];
        history.unshift({ date: new Date().toISOString().replace('T', ' ').slice(0, 19), mode, summary: { total: checks.length, pass, warn, fail }, duration, output: output.substring(0, 10000) });
        if (history.length > 20) history = history.slice(0, 20);
        fs.writeFileSync(DOCTOR_HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
      } catch {}

      return json(res, 200, { ok: true, output, summary, duration });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  if (req.method === 'GET' && url.pathname === '/api/doctor-history') {
    try {
      let history = [];
      try { history = JSON.parse(fs.readFileSync(DOCTOR_HISTORY_FILE, 'utf8')); } catch {}
      if (!Array.isArray(history)) history = [];
      return json(res, 200, { ok: true, history });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  json(res, 404, { error: 'Not found' });
});

// Retry listen with backoff if port is still occupied (e.g., Setup UI hasn't fully exited)
let retryCount = 0;
const MAX_RETRIES = 20;

function startListen() {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Management Panel] OK — http://0.0.0.0:${PORT}`);
    retryCount = 0;
  });
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && retryCount < MAX_RETRIES) {
    retryCount++;
    // Exponential backoff: 2s, 2s, 3s, 3s, 4s, 5s, ... max 10s
    const delay = Math.min(2000 + Math.floor(retryCount / 2) * 1000, 10000);
    console.log(`[Management Panel] Port ${PORT} in use. Retry ${retryCount}/${MAX_RETRIES} in ${delay/1000}s...`);
    setTimeout(startListen, delay);
  } else {
    console.error(`[Management Panel] Unrecoverable error: ${err.message}`);
    console.error(`[Management Panel] Check: ss -tlnp | grep :${PORT}`);
    process.exit(1);
  }
});

startListen();
