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
const SESSION_TTL = 60 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;
const BLOCK_DURATION = 15 * 60 * 1000;

const ENV_FILE = '/opt/openclaw.env';
const CONFIG_FILE = '/home/openclaw/.openclaw/openclaw.json';
const CONFIG_DIR = '/etc/config';
const CADDYFILE = '/etc/caddy/Caddyfile';
const OPENCLAW_DIR = '/opt/openclaw';

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
function verifyPassword(username, password) {
  try {
    const out = execSync(`echo '${password.replace(/'/g, "'\\''")}' | su -c 'echo __AUTH_OK__' ${username} 2>/dev/null`, { timeout: 5000, stdio: 'pipe' }).toString();
    return out.includes('__AUTH_OK__');
  } catch { return false; }
}
function createSession() { const t = crypto.randomBytes(32).toString('hex'); sessions[t] = { created: Date.now() }; return t; }
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
const CSS = `
:root{--bg:#f4f6fb;--sidebar-bg:#1a1a2e;--sidebar-w:240px;--card-bg:#fff;--accent:#4285f4;--accent2:#34a853;--text:#1a1a2e;--text2:#5f6368;--border:#e4e7ec;--danger:#ea4335;--warn:#fbbc05;--radius:12px}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',Roboto,-apple-system,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:flex}

/* Sidebar */
.sidebar{width:var(--sidebar-w);background:var(--sidebar-bg);min-height:100vh;position:fixed;top:0;left:0;display:flex;flex-direction:column;z-index:10}
.sidebar .brand{padding:24px 20px 20px;border-bottom:1px solid rgba(255,255,255,.08)}
.sidebar .brand h1{font-size:20px;color:#fff;font-weight:800;letter-spacing:-.3px}
.sidebar .brand p{font-size:11px;color:rgba(255,255,255,.45);margin-top:4px}
.sidebar nav{flex:1;padding:12px 10px}
.nav-item{display:flex;align-items:center;gap:12px;padding:11px 14px;border-radius:10px;cursor:pointer;color:rgba(255,255,255,.55);font-size:13px;font-weight:600;transition:all .15s;margin-bottom:2px;user-select:none}
.nav-item:hover{background:rgba(255,255,255,.06);color:rgba(255,255,255,.85)}
.nav-item.active{background:linear-gradient(135deg,rgba(66,133,244,.25),rgba(52,168,83,.18));color:#fff}
.nav-item .nav-icon{font-size:18px;width:24px;text-align:center;flex-shrink:0}
.sidebar-footer{padding:16px 20px;border-top:1px solid rgba(255,255,255,.08);font-size:11px;color:rgba(255,255,255,.3)}

/* Main */
.main{margin-left:var(--sidebar-w);flex:1;padding:28px 32px;min-height:100vh}
.page-title{font-size:22px;font-weight:800;margin-bottom:4px;color:var(--text)}
.page-desc{font-size:13px;color:var(--text2);margin-bottom:24px}

/* Cards */
.card{background:var(--card-bg);border-radius:var(--radius);padding:24px;box-shadow:0 1px 3px rgba(0,0,0,.04);border:1px solid var(--border);margin-bottom:20px}
.card-title{font-size:15px;font-weight:700;margin-bottom:16px;display:flex;align-items:center;gap:8px}
.card-title .ct-icon{font-size:18px}

/* Provider list */
.prov-list{display:flex;flex-direction:column;gap:6px;margin-bottom:20px;max-height:520px;overflow-y:auto;padding-right:4px}
.prov-list::-webkit-scrollbar{width:5px} .prov-list::-webkit-scrollbar-track{background:#f1f1f1;border-radius:4px} .prov-list::-webkit-scrollbar-thumb{background:#c1c1c1;border-radius:4px}
.prov-item{display:flex;align-items:center;gap:14px;padding:14px 16px;border:2px solid var(--border);border-radius:10px;cursor:pointer;transition:all .15s;background:#fff}
.prov-item:hover{border-color:var(--accent);box-shadow:0 2px 12px rgba(66,133,244,.08)}
.prov-item.selected{border-color:var(--accent);background:linear-gradient(135deg,#eef3ff,#edf7ee);box-shadow:0 2px 12px rgba(66,133,244,.12)}
.prov-item.current{border-color:var(--accent2);background:#edf7ee}
.prov-icon{width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0}
.prov-info{flex:1;min-width:0}
.prov-name{font-size:14px;font-weight:700;color:var(--text)}
.prov-desc{font-size:11px;color:var(--text2);margin-top:1px}
.prov-badge{font-size:10px;font-weight:700;padding:2px 8px;border-radius:6px;flex-shrink:0}

/* Channel list */
.ch-list{display:flex;flex-direction:column;gap:8px;margin-bottom:20px}
.ch-item{display:flex;align-items:center;gap:12px;padding:12px 14px;border:2px solid var(--border);border-radius:10px;cursor:pointer;transition:all .15s;background:#fff}
.ch-item:hover{border-color:var(--accent)} .ch-item.selected{border-color:var(--accent);background:#eef3ff}
.ch-item.active-ch{border-color:var(--accent2);background:#edf7ee}
.ch-icon{font-size:22px;width:32px;text-align:center;flex-shrink:0}
.ch-info{flex:1} .ch-name{font-size:13px;font-weight:700} .ch-desc{font-size:11px;color:var(--text2)}

/* Fields */
.field{margin-bottom:14px}
.field label{display:block;font-size:11px;color:var(--text2);margin-bottom:5px;font-weight:700;text-transform:uppercase;letter-spacing:.5px}
.field input,.field select{width:100%;padding:10px 12px;background:#f8f9fb;border:1.5px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;outline:none;transition:all .15s}
.field input:focus,.field select:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(66,133,244,.08);background:#fff}

/* Buttons */
.btn{display:inline-flex;align-items:center;gap:6px;padding:9px 18px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;transition:all .15s;border:none}
.btn-primary{background:var(--accent);color:#fff;box-shadow:0 2px 8px rgba(66,133,244,.2)} .btn-primary:hover{box-shadow:0 4px 16px rgba(66,133,244,.3);transform:translateY(-1px)}
.btn-success{background:var(--accent2);color:#fff;box-shadow:0 2px 8px rgba(52,168,83,.2)}
.btn-outline{background:#fff;border:1.5px solid var(--border);color:var(--text2)} .btn-outline:hover{border-color:var(--accent);color:var(--accent)}
.btn-danger{background:var(--danger);color:#fff}
.btn:disabled{opacity:.4;cursor:not-allowed;transform:none!important;box-shadow:none!important}
.btn-row{display:flex;gap:8px;margin-top:16px;flex-wrap:wrap}

/* Status */
.status{padding:10px 14px;border-radius:8px;font-size:12px;margin-top:12px;display:none;font-weight:600}
.status.ok{display:block;background:#e6f4ea;border:1px solid #a8dab5;color:#1e7e34}
.status.fail{display:block;background:#fce8e6;border:1px solid #f5b7b1;color:#c0392b}
.status.loading{display:block;background:#e8f0fe;border:1px solid #a4c2f4;color:#1967d2}
.status.warn{display:block;background:#fef7e0;border:1px solid #f9e6a0;color:#b45309}

/* Info rows */
.info-grid{display:grid;gap:0}
.info-row{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #f0f1f3}
.info-row:last-child{border:none}
.info-k{font-size:12px;color:var(--text2);font-weight:600} .info-v{font-size:12px;font-weight:700;color:var(--text);text-align:right;max-width:65%;word-break:break-all}
.badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:10px;font-weight:800;letter-spacing:.3px}
.bg-green{background:#dcfce7;color:#166534} .bg-red{background:#fee2e2;color:#991b1b} .bg-blue{background:#dbeafe;color:#1e40af}

/* Log box */
.log-box{background:#0f172a;color:#94a3b8;border-radius:8px;padding:14px;font-family:'JetBrains Mono','Fira Code','Courier New',monospace;font-size:11px;max-height:360px;overflow-y:auto;white-space:pre-wrap;line-height:1.6}

/* Config pane */
.config-pane{margin-top:16px;padding:18px;background:#f8f9fb;border:1.5px solid var(--border);border-radius:10px}

/* Sections */
.section{display:none} .section.active{display:block}

/* Chat */
.chat-box{display:flex;flex-direction:column;height:420px;border:1.5px solid var(--border);border-radius:10px;overflow:hidden;background:#fafbfc}
.chat-msgs{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px}
.chat-msg{max-width:85%;padding:10px 14px;border-radius:12px;font-size:13px;line-height:1.5;word-wrap:break-word;white-space:pre-wrap}
.chat-msg.user{align-self:flex-end;background:var(--accent);color:#fff;border-bottom-right-radius:4px}
.chat-msg.ai{align-self:flex-start;background:#fff;border:1px solid var(--border);color:var(--text);border-bottom-left-radius:4px}
.chat-msg.ai .meta{font-size:10px;color:var(--text2);margin-top:6px;border-top:1px solid #f0f1f3;padding-top:4px}
.chat-input{display:flex;gap:8px;padding:12px;border-top:1.5px solid var(--border);background:#fff}
.chat-input input{flex:1;padding:10px 12px;border:1.5px solid var(--border);border-radius:8px;font-size:13px;outline:none} .chat-input input:focus{border-color:var(--accent)}
.chat-input button{padding:10px 20px;background:var(--accent);color:#fff;border:none;border-radius:8px;font-weight:700;cursor:pointer;font-size:13px}

/* Config Editor */
.json-editor{width:100%;min-height:300px;font-family:'JetBrains Mono','Fira Code','Courier New',monospace;font-size:12px;padding:14px;background:#0f172a;color:#e2e8f0;border:none;border-radius:8px;outline:none;resize:vertical;line-height:1.6;tab-size:2}

/* QR */
.qr-box{text-align:center;padding:20px;background:#fff;border-radius:10px;border:1px solid var(--border)}
.qr-box canvas{max-width:200px;max-height:200px}

/* History item */
.hist-item{display:flex;align-items:center;gap:12px;padding:10px 14px;border:1px solid var(--border);border-radius:8px;cursor:pointer;transition:all .15s}
.hist-item:hover{border-color:var(--accent);background:rgba(66,133,244,.04)}

/* Doctor */
.doc-actions{display:flex;gap:10px;flex-wrap:wrap}
.doc-btn{display:flex;align-items:center;gap:8px;padding:14px 20px;border-radius:10px;cursor:pointer;border:2px solid var(--border);background:var(--card-bg);transition:all .15s;flex:1;min-width:160px}
.doc-btn:hover{border-color:var(--accent);box-shadow:0 2px 12px rgba(66,133,244,.1);transform:translateY(-1px)}
.doc-btn.running{opacity:.6;pointer-events:none}
.doc-btn .db-icon{font-size:24px;width:36px;height:36px;border-radius:8px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.doc-btn .db-info{flex:1} .doc-btn .db-title{font-size:13px;font-weight:700;color:var(--text)} .doc-btn .db-desc{font-size:11px;color:var(--text2);margin-top:2px}
.doc-summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:10px;margin-bottom:16px}
.doc-stat{text-align:center;padding:14px 8px;background:var(--bg);border-radius:10px;border:1px solid var(--border)}
.doc-stat .ds-num{font-size:28px;font-weight:800;line-height:1} .doc-stat .ds-label{font-size:11px;color:var(--text2);margin-top:4px;font-weight:600}
.doc-checks{display:flex;flex-direction:column;gap:4px;max-height:400px;overflow-y:auto}
.doc-check{display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:8px;font-size:12px;border:1px solid var(--border);background:var(--card-bg)}
.doc-check.pass{border-left:3px solid #22c55e} .doc-check.warn{border-left:3px solid #f59e0b} .doc-check.fail{border-left:3px solid #ef4444}
.doc-check .dc-icon{font-size:16px;flex-shrink:0;width:20px;text-align:center} .doc-check .dc-text{flex:1;color:var(--text);font-weight:600} .doc-check .dc-detail{color:var(--text2);font-size:11px;max-width:50%;text-align:right}
.doc-hist{display:flex;flex-direction:column;gap:6px}
.doc-hist-item{display:flex;align-items:center;gap:10px;padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:12px}
.doc-hist-item .dh-date{font-weight:700;color:var(--text);min-width:140px} .doc-hist-item .dh-mode{font-size:10px;font-weight:700;padding:2px 8px;border-radius:6px;background:#dbeafe;color:#1e40af}
.doc-hist-item .dh-result{flex:1;text-align:right;font-weight:600}

/* Dark Mode */
body.dark{--bg:#0f172a;--sidebar-bg:#0a0e1a;--card-bg:#1e293b;--text:#e2e8f0;--text2:#94a3b8;--border:#334155}
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
body.dark .hist-item{border-color:var(--border)} body.dark .hist-item:hover{background:rgba(66,133,244,.08)}
body.dark .log-box{background:#0a0e1a}
body.dark .qr-box{background:var(--card-bg);border-color:var(--border)}
body.dark .doc-btn{background:var(--card-bg);border-color:var(--border)} body.dark .doc-stat{background:#1a2438;border-color:var(--border)}
body.dark .doc-check{background:var(--card-bg);border-color:var(--border)} body.dark .doc-hist-item{border-color:var(--border)}
body.dark .doc-hist-item .dh-mode{background:#1a2a4a;color:#60a5fa}
body.dark .status.ok{background:#0a2e1a;border-color:#1a4a2a;color:#4ade80}
body.dark .status.fail{background:#2e0a0a;border-color:#4a1a1a;color:#f87171}
body.dark .status.loading{background:#0a1a2e;border-color:#1a2a4a;color:#60a5fa}
body.dark .status.warn{background:#2e1a0a;border-color:#4a2a1a;color:#fbbf24}

/* Responsive */
.hamburger{display:none;position:fixed;top:12px;left:12px;z-index:20;background:var(--sidebar-bg);color:#fff;border:none;border-radius:8px;padding:8px 12px;font-size:18px;cursor:pointer}
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
body{font-family:'Segoe UI',Roboto,-apple-system,sans-serif;background:#1a1a2e;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center}
.wrap{width:100%;max-width:400px;padding:24px}
.logo{text-align:center;margin-bottom:32px} .logo h1{font-size:28px;font-weight:800;background:linear-gradient(135deg,#4285f4,#34a853);-webkit-background-clip:text;-webkit-text-fill-color:transparent} .logo p{color:rgba(255,255,255,.4);font-size:12px;margin-top:6px}
.card{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:32px;backdrop-filter:blur(20px)}
.field{margin-bottom:18px} .field label{display:block;font-size:11px;color:rgba(255,255,255,.5);margin-bottom:6px;font-weight:700;text-transform:uppercase;letter-spacing:.5px}
.field input{width:100%;padding:12px 14px;background:rgba(255,255,255,.06);border:1.5px solid rgba(255,255,255,.1);border-radius:10px;color:#fff;font-size:14px;outline:none;transition:all .2s} .field input:focus{border-color:#4285f4;box-shadow:0 0 0 3px rgba(66,133,244,.15)}
.btn{width:100%;padding:13px;background:linear-gradient(135deg,#4285f4,#34a853);color:#fff;border:none;border-radius:10px;font-size:14px;font-weight:700;cursor:pointer;transition:all .2s} .btn:hover{transform:translateY(-1px);box-shadow:0 6px 24px rgba(66,133,244,.3)} .btn:disabled{opacity:.4;transform:none}
.err{padding:10px 14px;border-radius:8px;font-size:12px;margin-top:14px;display:none;font-weight:600;background:rgba(234,67,53,.15);border:1px solid rgba(234,67,53,.3);color:#ff6b6b} .err.show{display:block}
</style></head><body>
<div class="wrap">
  <div class="logo"><h1>OpenClaw</h1><p>Management Panel</p></div>
  <div class="card">
    <form id="f">
      <div class="field"><label>Username</label><input type="text" id="u" value="root" autocomplete="username"></div>
      <div class="field"><label>Password</label><input type="password" id="p" placeholder="Nhap mat khau root" autocomplete="current-password" autofocus></div>
      <button type="submit" class="btn" id="b">Dang nhap</button>
      <div class="err" id="e"></div>
    </form>
  </div>
</div>
<script>
document.getElementById('f').addEventListener('submit',async e=>{
  e.preventDefault();const b=document.getElementById('b'),err=document.getElementById('e');
  b.disabled=true;b.textContent='Dang xac thuc...';err.className='err';
  try{const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:document.getElementById('u').value,password:document.getElementById('p').value})});
  const d=await r.json();if(d.ok)window.location.href='/panel';else{err.className='err show';err.textContent=d.error}}
  catch(x){err.className='err show';err.textContent='Loi ket noi'}
  b.disabled=false;b.textContent='Dang nhap'});
</script></body></html>`;
}

// --- Panel HTML ---
function panelPage() {
  const provJSON = JSON.stringify(Object.entries(PROVIDERS).map(([k,v])=>({id:k,name:v.name,color:v.color,icon:v.icon,models:v.models,category:v.category||'cloud',extraEnvKeys:v.extraEnvKeys||[]})));
  const chJSON = JSON.stringify(Object.entries(CHANNELS).map(([k,v])=>({id:k,name:v.name,icon:v.icon,desc:v.desc,envKeys:v.envKeys,canPair:v.canPair,cliOnly:v.cliOnly||false})));

  return `<!DOCTYPE html><html lang="vi"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenClaw Panel</title>
<style>${CSS}</style></head><body>

<button class="hamburger" onclick="document.querySelector('.sidebar').classList.toggle('open')">&#9776;</button>

<div class="sidebar">
  <div class="brand"><h1>OpenClaw</h1><p>Management Panel</p></div>
  <nav>
    <div class="nav-item active" onclick="showTab('provider',this)"><span class="nav-icon">\u2728</span>AI Provider</div>
    <div class="nav-item" onclick="showTab('channels',this)"><span class="nav-icon">\ud83d\udce8</span>Channels</div>
    <div class="nav-item" onclick="showTab('chat',this)"><span class="nav-icon">\ud83d\udcac</span>Playground</div>
    <div class="nav-item" onclick="showTab('gateway',this)"><span class="nav-icon">\ud83d\udd11</span>Gateway</div>
    <div class="nav-item" onclick="showTab('domain',this)"><span class="nav-icon">\ud83c\udf10</span>Domain & SSL</div>
    <div class="nav-item" onclick="showTab('analytics',this)"><span class="nav-icon">\ud83d\udcca</span>Analytics</div>
    <div class="nav-item" onclick="showTab('history',this)"><span class="nav-icon">\ud83d\udcdd</span>History</div>
    <div class="nav-item" onclick="showTab('users',this)"><span class="nav-icon">\ud83d\udc65</span>Users</div>
    <div class="nav-item" onclick="showTab('backup',this)"><span class="nav-icon">\ud83d\udce6</span>Backup</div>
    <div class="nav-item" onclick="showTab('config',this)"><span class="nav-icon">\ud83d\udd27</span>Config</div>
    <div class="nav-item" onclick="showTab('qr',this)"><span class="nav-icon">\ud83d\udcf1</span>QR Code</div>
    <div class="nav-item" onclick="showTab('doctor',this)"><span class="nav-icon">\ud83e\ude7a</span>Doctor</div>
    <div class="nav-item" onclick="showTab('update',this)"><span class="nav-icon">\u2b06\ufe0f</span>Update</div>
    <div class="nav-item" onclick="showTab('status',this)"><span class="nav-icon">\ud83d\udfe2</span>Status</div>
  </nav>
  <div class="sidebar-footer" style="display:flex;align-items:center;justify-content:space-between">
    <span>OpenClaw Panel v2.0</span>
    <button onclick="toggleDark()" style="background:none;border:none;color:rgba(255,255,255,.4);cursor:pointer;font-size:16px" title="Dark Mode">\ud83c\udf19</button>
  </div>
</div>

<div class="main">

  <!-- TAB: Provider -->
  <div class="section active" id="sec-provider">
    <div class="page-title">AI Provider</div>
    <div class="page-desc">Chon nha cung cap AI, model va nhap API key.</div>
    <div class="card"><div class="card-title"><span class="ct-icon">\ud83d\udccc</span> Hien tai</div><div id="currentProvider" class="info-grid"></div></div>
    <div class="card"><div class="card-title"><span class="ct-icon">\ud83d\udd04</span> Thay doi Provider</div>
      <div class="prov-list" id="providerList"></div>
      <div id="providerConfig" style="display:none" class="config-pane">
        <div class="field"><label>Model</label><select id="provModel"></select></div>
        <div class="field"><label>API Key</label><input type="password" id="provKey" placeholder="Nhap API key"></div>
        <div id="provExtraFields"></div>
        <div class="btn-row">
          <button class="btn btn-outline" onclick="testProviderKey()">Kiem tra key</button>
          <button class="btn btn-primary" onclick="applyProvider()">Ap dung</button>
        </div>
        <div class="status" id="provStatus"></div>
      </div>
    </div>
  </div>

  <!-- TAB: Channels -->
  <div class="section" id="sec-channels">
    <div class="page-title">Kenh nhan tin</div>
    <div class="page-desc">Cau hinh va ghep noi cac kenh chat voi AI.</div>
    <div class="card"><div class="card-title"><span class="ct-icon">\u2705</span> Dang hoat dong</div><div id="currentChannels" class="info-grid"></div></div>
    <div class="card"><div class="card-title"><span class="ct-icon">\u2795</span> Them kenh</div>
      <div class="ch-list" id="channelList"></div>
      <div id="channelConfig" style="display:none" class="config-pane">
        <div id="channelFields"></div>
        <div class="btn-row">
          <button class="btn btn-primary" onclick="saveChannel()">Luu & Restart</button>
          <button class="btn btn-outline" id="pairChannelBtn" style="display:none" onclick="showPairForm()">Ghep noi</button>
        </div>
        <div class="status" id="channelStatus"></div>
        <div id="pairForm" style="display:none;margin-top:14px">
          <div class="field"><label>Ma ghep noi (Pairing Code)</label><input type="text" id="pairCode" placeholder="Nhap ma tu bot"></div>
          <div class="btn-row"><button class="btn btn-success" onclick="pairChannel()">Ghep noi</button></div>
          <div class="status" id="pairStatus"></div>
        </div>
      </div>
    </div>
  </div>

  <!-- TAB: Gateway -->
  <div class="section" id="sec-gateway">
    <div class="page-title">Gateway</div>
    <div class="page-desc">Token xac thuc, ghep noi thiet bi va quan ly dashboard.</div>
    <div class="card"><div class="card-title"><span class="ct-icon">\ud83d\udd11</span> Thong tin</div><div id="gatewayInfo" class="info-grid"></div></div>
    <div class="card"><div class="card-title"><span class="ct-icon">\ud83d\udd17</span> Ghep noi Dashboard</div>
      <p style="font-size:13px;color:var(--text2);margin-bottom:12px;line-height:1.6">Mo dashboard link ben duoi trong <strong>tab moi</strong>, doi trang tai xong, roi quay lai day bam <strong>Ghep noi</strong> de approve.</p>
      <div id="pairDashboardUrl" style="padding:10px 14px;background:#f0f4ff;border:1.5px solid var(--accent);border-radius:8px;font-family:monospace;font-size:12px;cursor:pointer;color:var(--accent);margin-bottom:12px;word-break:break-all" onclick="window.open(this.textContent,'_blank')"></div>
      <div class="btn-row">
        <button class="btn btn-success" id="pairDeviceBtn" onclick="pairDevice()">Ghep noi thiet bi</button>
        <button class="btn btn-outline" onclick="loadDevices()">Lam moi</button>
      </div>
      <div class="status" id="pairDeviceStatus"></div>
    </div>
    <div class="card"><div class="card-title"><span class="ct-icon">\ud83d\udcf1</span> Thiet bi da ghep noi</div><div id="deviceList" class="info-grid"><div style="color:var(--text2);font-size:12px;padding:8px">Dang tai...</div></div></div>
    <div class="card"><div class="card-title"><span class="ct-icon">\ud83d\udd04</span> Thay doi token</div>
      <div class="field"><label>Token tu nhap (tuy chon)</label><input type="text" id="customToken" placeholder="De trong de tao ngau nhien"></div>
      <div class="btn-row">
        <button class="btn btn-primary" onclick="generateToken()">Tao token ngau nhien</button>
        <button class="btn btn-outline" onclick="applyCustomToken()">Ap dung token tu nhap</button>
      </div>
      <div class="status" id="gatewayStatus"></div>
    </div>
  </div>

  <!-- TAB: Domain -->
  <div class="section" id="sec-domain">
    <div class="page-title">Domain & SSL</div>
    <div class="page-desc">Cau hinh ten mien voi chung chi Let's Encrypt.</div>
    <div class="card"><div class="card-title"><span class="ct-icon">\ud83c\udf10</span> Hien tai</div><div id="domainInfo" class="info-grid"></div></div>
    <div class="card"><div class="card-title"><span class="ct-icon">\ud83d\udd12</span> Cau hinh</div>
      <div class="field"><label>Ten mien</label><input type="text" id="domainInput" placeholder="bot.example.com"></div>
      <div class="field"><label>Email Let's Encrypt (tuy chon)</label><input type="email" id="domainEmail" placeholder="admin@example.com"></div>
      <div class="btn-row">
        <button class="btn btn-primary" onclick="saveDomain()">Cau hinh SSL</button>
        <button class="btn btn-outline" onclick="resetDomainToIP()">Dung IP (tu ky)</button>
      </div>
      <div class="status" id="domainStatus"></div>
    </div>
  </div>

  <!-- TAB: Doctor -->
  <div class="section" id="sec-doctor">
    <div class="page-title">Chan doan he thong</div>
    <div class="page-desc">Chay OpenClaw Doctor de kiem tra, sua chua va toi uu hoa he thong.</div>
    <div class="card">
      <div class="card-title"><span class="ct-icon">\ud83d\ude80</span> Hanh dong</div>
      <div class="doc-actions">
        <div class="doc-btn" id="docBtnScan" onclick="runDoctor('scan')">
          <div class="db-icon" style="background:#dbeafe;color:#2563eb">\ud83d\udd0d</div>
          <div class="db-info"><div class="db-title">Scan</div><div class="db-desc">Kiem tra 19 muc, khong sua</div></div>
        </div>
        <div class="doc-btn" id="docBtnRepair" onclick="runDoctor('repair')">
          <div class="db-icon" style="background:#dcfce7;color:#16a34a">\ud83d\udd27</div>
          <div class="db-info"><div class="db-title">Auto Repair</div><div class="db-desc">Kiem tra + tu dong sua loi</div></div>
        </div>
        <div class="doc-btn" id="docBtnDeep" onclick="runDoctor('deep')">
          <div class="db-icon" style="background:#fef3c7;color:#d97706">\u26a1</div>
          <div class="db-info"><div class="db-title">Deep Scan</div><div class="db-desc">Scan sau services + gateway</div></div>
        </div>
      </div>
      <div class="status" id="doctorStatus"></div>
    </div>
    <div class="card" id="doctorResultCard" style="display:none">
      <div class="card-title"><span class="ct-icon">\ud83d\udcca</span> Ket qua</div>
      <div class="doc-summary" id="doctorSummary"></div>
      <div class="doc-checks" id="doctorChecks"></div>
    </div>
    <div class="card" id="doctorOutputCard" style="display:none">
      <div class="card-title"><span class="ct-icon">\ud83d\udcbb</span> Output</div>
      <div class="log-box" id="doctorLog" style="max-height:420px"></div>
    </div>
    <div class="card">
      <div class="card-title"><span class="ct-icon">\ud83d\udcc5</span> Lich su</div>
      <div class="doc-hist" id="doctorHistory"><div style="color:var(--text2);font-size:12px;padding:8px">Chua co lich su.</div></div>
    </div>
  </div>

  <!-- TAB: Update -->
  <div class="section" id="sec-update">
    <div class="page-title">Cap nhat</div>
    <div class="page-desc">Cap nhat phien ban OpenClaw tu GitHub.</div>
    <div class="card"><div class="card-title"><span class="ct-icon">\ud83d\udce6</span> Phien ban</div><div id="updateInfo" class="info-grid"></div>
      <div class="btn-row" style="margin-top:16px">
        <button class="btn btn-outline" onclick="checkUpdate()">Kiem tra ban moi</button>
        <button class="btn btn-primary" id="doUpdateBtn" style="display:none" onclick="doUpdate()">Cap nhat</button>
      </div>
      <div class="status" id="updateStatus"></div>
      <div id="updateLog" style="display:none;margin-top:14px"><div class="log-box" id="updateLogBox"></div></div>
    </div>
  </div>

  <!-- TAB: Status -->
  <div class="section" id="sec-status">
    <div class="page-title">Trang thai he thong</div>
    <div class="page-desc">Giam sat services, tai nguyen va log.</div>
    <div class="card"><div class="card-title"><span class="ct-icon">\ud83d\udcca</span> Services & System</div><div id="statusInfo" class="info-grid"></div>
      <div class="btn-row" style="margin-top:16px">
        <button class="btn btn-outline" onclick="loadStatus()">Lam moi</button>
        <button class="btn btn-primary" onclick="restartSvc('openclaw')">Restart OpenClaw</button>
        <button class="btn btn-outline" onclick="restartSvc('caddy')">Restart Caddy</button>
      </div>
      <div class="status" id="statusMsg"></div>
    </div>
    <div class="card"><div class="card-title"><span class="ct-icon">\ud83d\udcdd</span> Log OpenClaw</div><div class="log-box" id="logsBox">Dang tai...</div></div>
  </div>

  <!-- TAB: Chat Playground -->
  <div class="section" id="sec-chat">
    <div class="page-title">\ud83d\udcac Chat Playground</div>
    <div class="page-desc">Test chat truc tiep voi AI provider hien tai.</div>
    <div class="card">
      <div class="card-title"><span class="ct-icon">\u2728</span> <span id="chatProviderLabel">AI Chat</span></div>
      <div class="chat-box">
        <div class="chat-msgs" id="chatMsgs"><div class="chat-msg ai">Xin chao! Toi la AI assistant. Hay gui tin nhan de test.</div></div>
        <div class="chat-input">
          <input type="text" id="chatInput" placeholder="Nhap tin nhan..." onkeydown="if(event.key==='Enter')sendChat()">
          <button onclick="sendChat()">Gui</button>
        </div>
      </div>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn btn-outline" onclick="clearChat()">Xoa chat</button>
        <span id="chatMeta" style="font-size:11px;color:var(--text2);align-self:center;margin-left:8px"></span>
      </div>
    </div>
  </div>

  <!-- TAB: Usage Analytics -->
  <div class="section" id="sec-analytics">
    <div class="page-title">\ud83d\udcca Usage Analytics</div>
    <div class="page-desc">Thong ke su dung API va token.</div>
    <div class="card"><div class="card-title"><span class="ct-icon">\ud83d\udcc8</span> Tong quan</div><div id="analyticsOverview" class="info-grid"></div></div>
    <div class="card"><div class="card-title"><span class="ct-icon">\ud83d\udcc5</span> Lich su request (7 ngay)</div>
      <div id="analyticsChart" style="display:flex;align-items:flex-end;gap:6px;height:120px;padding:16px 0"></div>
      <div id="analyticsList" style="margin-top:16px"></div>
    </div>
    <div class="btn-row"><button class="btn btn-outline" onclick="loadAnalytics()">Lam moi</button></div>
  </div>

  <!-- TAB: Conversation History -->
  <div class="section" id="sec-history">
    <div class="page-title">\ud83d\udcdd Conversation History</div>
    <div class="page-desc">Xem lich su hoi thoai gan day.</div>
    <div class="card"><div class="card-title"><span class="ct-icon">\ud83d\udcc2</span> Cac cuoc hoi thoai</div>
      <div id="historyList" style="display:flex;flex-direction:column;gap:8px"></div>
      <div class="btn-row" style="margin-top:16px">
        <button class="btn btn-outline" onclick="loadHistory()">Lam moi</button>
      </div>
    </div>
    <div class="card" id="historyDetail" style="display:none">
      <div class="card-title"><span class="ct-icon">\ud83d\udcac</span> <span id="historyDetailTitle">Chi tiet</span></div>
      <div id="historyMsgs" style="display:flex;flex-direction:column;gap:8px"></div>
    </div>
  </div>



  <!-- TAB: User Management -->
  <div class="section" id="sec-users">
    <div class="page-title">\ud83d\udc65 User Management</div>
    <div class="page-desc">Quan ly tai khoan truy cap panel.</div>
    <div class="card"><div class="card-title"><span class="ct-icon">\ud83d\udd10</span> Doi mat khau Root</div>
      <div class="field"><label>Mat khau cu</label><input type="password" id="oldPass" placeholder="Nhap mat khau hien tai"></div>
      <div class="field"><label>Mat khau moi</label><input type="password" id="newPass" placeholder="Nhap mat khau moi"></div>
      <div class="field"><label>Xac nhan</label><input type="password" id="confirmPass" placeholder="Nhap lai mat khau moi"></div>
      <div class="btn-row"><button class="btn btn-primary" onclick="changePassword()">Doi mat khau</button></div>
      <div class="status" id="passStatus"></div>
    </div>
    <div class="card"><div class="card-title"><span class="ct-icon">\ud83d\udee1\ufe0f</span> Bao mat</div>
      <div id="securityInfo" class="info-grid"></div>
      <div class="btn-row" style="margin-top:12px"><button class="btn btn-outline" onclick="loadUsers()">Lam moi</button></div>
    </div>
  </div>

  <!-- TAB: Backup & Restore -->
  <div class="section" id="sec-backup">
    <div class="page-title">\ud83d\udce6 Backup & Restore</div>
    <div class="page-desc">Sao luu va phuc hoi cau hinh he thong.</div>
    <div class="card"><div class="card-title"><span class="ct-icon">\ud83d\udcbe</span> Backup</div>
      <p style="font-size:12px;color:var(--text2);margin-bottom:14px">Tao ban sao cau hinh (openclaw.json, openclaw.env, Caddyfile). Khong bao gom API key.</p>
      <div class="btn-row"><button class="btn btn-primary" onclick="doBackup()">Tao Backup</button></div>
      <div class="status" id="backupStatus"></div>
      <div id="backupData" style="display:none;margin-top:14px">
        <div class="field"><label>Backup Data (copy va luu lai)</label>
          <textarea id="backupContent" class="json-editor" style="min-height:160px" readonly></textarea>
        </div>
      </div>
    </div>
    <div class="card"><div class="card-title"><span class="ct-icon">\ud83d\udd04</span> Restore</div>
      <p style="font-size:12px;color:var(--text2);margin-bottom:14px">Dan noi dung backup vao day de phuc hoi cau hinh.</p>
      <div class="field"><label>Backup Data</label><textarea id="restoreContent" class="json-editor" style="min-height:120px" placeholder="Dan backup JSON vao day..."></textarea></div>
      <div class="btn-row"><button class="btn btn-danger" onclick="doRestore()">Phuc hoi</button></div>
      <div class="status" id="restoreStatus"></div>
    </div>
  </div>

  <!-- TAB: Config Editor -->
  <div class="section" id="sec-config">
    <div class="page-title">\ud83d\udd27 Config Editor</div>
    <div class="page-desc">Chinh sua truc tiep file cau hinh he thong.</div>
    <div class="card"><div class="card-title"><span class="ct-icon">\ud83d\udcc4</span> openclaw.json</div>
      <textarea id="configJson" class="json-editor" style="min-height:320px"></textarea>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn btn-primary" onclick="saveConfigFile('json')">Luu & Restart</button>
        <button class="btn btn-outline" onclick="loadConfigEditor()">Reload</button>
      </div>
      <div class="status" id="configJsonStatus"></div>
    </div>
    <div class="card"><div class="card-title"><span class="ct-icon">\ud83d\udcc4</span> openclaw.env</div>
      <textarea id="configEnv" class="json-editor" style="min-height:200px"></textarea>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn btn-primary" onclick="saveConfigFile('env')">Luu & Restart</button>
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
        <button class="btn btn-outline" onclick="loadQR()">Tao lai QR</button>
      </div>
    </div>
  </div>
</div>

<script>
let selectedProvider=null,selectedChannel=null,availVersions=[];
const providers=${provJSON};
const channels=${chJSON};

function showTab(name,el){
  document.querySelectorAll('.section').forEach(s=>s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  const sec=document.getElementById('sec-'+name);if(sec)sec.classList.add('active');
  if(el)el.classList.add('active');
  document.querySelector('.sidebar').classList.remove('open');
  const loaders={provider:loadProvider,channels:loadChannels,gateway:loadGateway,domain:loadDomain,update:loadUpdate,
    chat:loadChat,analytics:loadAnalytics,history:loadHistory,users:loadUsers,backup:()=>{},config:loadConfigEditor,qr:loadQR,
    doctor:loadDoctor,status:()=>{loadStatus();loadLogs()}};
  if(loaders[name])loaders[name]();
}
async function api(path,method,body){
  const o={method:method||'GET',headers:{'Content-Type':'application/json'}};
  if(body)o.body=JSON.stringify(body);
  return (await fetch(path,o)).json();
}

// === Provider ===
async function loadProvider(){
  const d=await api('/api/current-config');
  const el=document.getElementById('currentProvider');
  el.innerHTML=d.provider
    ?'<div class="info-row"><span class="info-k">Provider</span><span class="info-v">'+d.providerName+'</span></div><div class="info-row"><span class="info-k">Model</span><span class="info-v">'+d.model+'</span></div>'
    :'<div class="info-row"><span class="info-v" style="color:var(--warn)">Chua cau hinh</span></div>';
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
        let extraHtml='';if(p.extraEnvKeys&&p.extraEnvKeys.length>0)p.extraEnvKeys.forEach(ek=>{extraHtml+='<div class="field"><label>'+ek+'</label><input type="text" id="extraEnv-'+ek+'" placeholder="Nhap '+ek+'"></div>'});
        document.getElementById('provExtraFields').innerHTML=extraHtml;
        document.getElementById('providerConfig').style.display='block';document.getElementById('provStatus').className='status';};
      list.appendChild(div);
    });
  });
}
async function testProviderKey(){
  const st=document.getElementById('provStatus'),k=document.getElementById('provKey').value.trim();
  if(!k){st.className='status fail';st.textContent='Nhap API key';return}
  st.className='status loading';st.textContent='Dang kiem tra...';
  const d=await api('/api/test-key','POST',{provider:selectedProvider,apiKey:k});
  st.className=d.ok?'status ok':'status fail';st.textContent=d.ok?'API key hop le!':d.error||'Key khong hop le';
}
async function applyProvider(){
  const st=document.getElementById('provStatus'),k=document.getElementById('provKey').value.trim(),m=document.getElementById('provModel').value;
  if(!selectedProvider){st.className='status fail';st.textContent='Chon provider';return}
  if(!k){st.className='status fail';st.textContent='Nhap API key';return}
  st.className='status loading';st.textContent='Dang ap dung...';
  const prov=providers.find(p=>p.id===selectedProvider);const extraEnv={};
  if(prov&&prov.extraEnvKeys)prov.extraEnvKeys.forEach(ek=>{const el=document.getElementById('extraEnv-'+ek);if(el)extraEnv[ek]=el.value.trim()});
  const d=await api('/api/provider','POST',{provider:selectedProvider,model:m,apiKey:k,extraEnv});
  st.className=d.ok?'status ok':'status fail';st.textContent=d.ok?'Thanh cong! OpenClaw da restart.':d.error||'Loi';
  if(d.ok)setTimeout(loadProvider,1500);
}

// === Channels ===
async function loadChannels(){
  const d=await api('/api/current-config');
  const el=document.getElementById('currentChannels');
  let h='';if(d.channels&&d.channels.length>0)d.channels.forEach(c=>{h+='<div class="info-row"><span class="info-k">'+c.name+'</span><span class="info-v"><span class="badge bg-green">Active</span></span></div>'});
  else h='<div class="info-row"><span class="info-v" style="color:var(--text2)">Chua co kenh nao</span></div>';
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
      if(c.cliOnly){fields.innerHTML='<div class="status warn" style="display:block">'+c.name+' chi ho tro qua CLI. '+c.desc+'</div>';pb.style.display='none'}
      else{fields.innerHTML=c.envKeys.map(k=>'<div class="field"><label>'+k+'</label><input type="text" id="chfield-'+k+'" placeholder="Nhap '+k+'"></div>').join('');pb.style.display=c.canPair?'inline-flex':'none'}
      document.getElementById('channelConfig').style.display='block';
    };
    list.appendChild(div);
  });
}
async function saveChannel(){
  if(!selectedChannel)return;const st=document.getElementById('channelStatus'),data={channel:selectedChannel.id,tokens:{}};
  selectedChannel.envKeys.forEach(k=>{const el=document.getElementById('chfield-'+k);if(el)data.tokens[k]=el.value.trim()});
  st.className='status loading';st.textContent='Dang luu...';
  const d=await api('/api/channels','POST',data);st.className=d.ok?'status ok':'status fail';st.textContent=d.ok?'Da luu! Restart thanh cong.':d.error||'Loi';
  if(d.ok)setTimeout(loadChannels,1500);
}
function showPairForm(){document.getElementById('pairForm').style.display='block'}
async function pairChannel(){
  if(!selectedChannel||!selectedChannel.canPair)return;const st=document.getElementById('pairStatus'),code=document.getElementById('pairCode').value.trim();
  if(!code){st.className='status fail';st.textContent='Nhap ma ghep noi';return}
  st.className='status loading';st.textContent='Dang ghep noi...';
  const d=await api('/api/channel-pair','POST',{channel:selectedChannel.id,code});
  st.className=d.ok?'status ok':'status fail';st.textContent=d.ok?'Ghep noi thanh cong!':d.error||'Loi';
}

// === Gateway ===
async function loadGateway(){
  const d=await api('/api/current-config'),el=document.getElementById('gatewayInfo'),host=d.domain||d.serverIP||'localhost';
  const dashUrl='https://'+host+'?token='+d.token;
  el.innerHTML='<div class="info-row"><span class="info-k">Token</span><span class="info-v" style="font-family:monospace;font-size:10px">'+d.token+'</span></div><div class="info-row"><span class="info-k">Dashboard</span><span class="info-v"><a href="'+dashUrl+'" target="_blank" style="color:var(--accent);text-decoration:none">https://'+host+'</a></span></div>';
  document.getElementById('pairDashboardUrl').textContent=dashUrl;
  loadDevices();
}
async function loadDevices(){
  try{
    const d=await api('/api/devices');
    const el=document.getElementById('deviceList');
    if(!d.ok){el.innerHTML='<div style="color:var(--text2);font-size:12px;padding:8px">'+(d.error||'Loi')+'</div>';return}
    if(!d.devices||d.devices.length===0){el.innerHTML='<div style="color:var(--text2);font-size:12px;padding:8px">Chua co thiet bi nao duoc ghep noi.</div>';return}
    let h='';d.devices.forEach(dev=>{
      const badge=dev.status==='paired'?'bg-green':dev.status==='pending'?'bg-blue':'bg-red';
      const label=dev.status==='paired'?'Paired':dev.status==='pending'?'Pending':dev.status;
      h+='<div class="info-row"><span class="info-k" style="max-width:50%;word-break:break-all">'+(dev.name||dev.uuid||'Unknown')+'</span><span class="info-v"><span class="badge '+badge+'">'+label+'</span></span></div>';
    });
    el.innerHTML=h;
  }catch{document.getElementById('deviceList').innerHTML='<div style="color:var(--text2);font-size:12px;padding:8px">Loi tai danh sach.</div>'}
}
async function pairDevice(){
  const st=document.getElementById('pairDeviceStatus'),btn=document.getElementById('pairDeviceBtn');
  btn.disabled=true;btn.textContent='Dang tim yeu cau...';st.className='status loading';st.textContent='Dang kiem tra pending requests...';
  try{
    const d=await api('/api/pair','POST',{});
    if(d.ok){st.className='status ok';st.textContent='Ghep noi thanh cong!';loadDevices()}
    else{st.className='status fail';st.textContent=d.error||'Khong the ghep noi'}
    btn.disabled=false;btn.textContent='Ghep noi thiet bi';
  }catch(e){st.className='status fail';st.textContent='Loi: '+e.message;btn.disabled=false;btn.textContent='Ghep noi thiet bi'}
}
async function generateToken(){
  const st=document.getElementById('gatewayStatus');st.className='status loading';st.textContent='Dang tao...';
  const d=await api('/api/gateway-token','POST',{action:'generate'});st.className=d.ok?'status ok':'status fail';st.textContent=d.ok?'Token moi: '+d.token:d.error||'Loi';if(d.ok)loadGateway();
}
async function applyCustomToken(){
  const st=document.getElementById('gatewayStatus'),t=document.getElementById('customToken').value.trim();
  if(!t){st.className='status fail';st.textContent='Nhap token';return}
  if(t.length<16){st.className='status fail';st.textContent='Token qua ngan (min 16 ky tu)';return}
  st.className='status loading';st.textContent='Dang cap nhat...';
  const d=await api('/api/gateway-token','POST',{action:'custom',token:t});st.className=d.ok?'status ok':'status fail';st.textContent=d.ok?'Da cap nhat!':d.error||'Loi';if(d.ok)loadGateway();
}

// === Domain ===
async function loadDomain(){
  const d=await api('/api/current-config'),el=document.getElementById('domainInfo');
  el.innerHTML='<div class="info-row"><span class="info-k">Domain/IP</span><span class="info-v">'+(d.domain||d.serverIP)+'</span></div><div class="info-row"><span class="info-k">SSL</span><span class="info-v">'+(d.domain?"Let\\'s Encrypt":'Self-signed')+'</span></div>';
}
async function saveDomain(){
  const st=document.getElementById('domainStatus'),dm=document.getElementById('domainInput').value.trim(),em=document.getElementById('domainEmail').value.trim();
  if(!dm){st.className='status fail';st.textContent='Nhap ten mien';return}
  st.className='status loading';st.textContent='Dang cau hinh Caddy + SSL...';
  const d=await api('/api/domain','POST',{domain:dm,email:em});st.className=d.ok?'status ok':'status fail';st.textContent=d.ok?'SSL da cau hinh cho '+dm+'!':d.error||'Loi';if(d.ok)setTimeout(loadDomain,1500);
}
async function resetDomainToIP(){
  const st=document.getElementById('domainStatus');st.className='status loading';st.textContent='Chuyen ve IP...';
  const d=await api('/api/domain','POST',{resetToIP:true});st.className=d.ok?'status ok':'status fail';st.textContent=d.ok?'Da chuyen ve IP!':d.error||'Loi';if(d.ok)setTimeout(loadDomain,1500);
}

// === Update ===
async function loadUpdate(){
  const d=await api('/api/current-config'),el=document.getElementById('updateInfo');
  el.innerHTML='<div class="info-row"><span class="info-k">Phien ban</span><span class="info-v">'+(d.version||'N/A')+'</span></div>';
  document.getElementById('doUpdateBtn').style.display='none';document.getElementById('updateLog').style.display='none';
}
async function checkUpdate(){
  const st=document.getElementById('updateStatus');st.className='status loading';st.textContent='Dang kiem tra...';
  const d=await api('/api/update-check');
  if(d.ok){availVersions=d.versions||[];
    if(availVersions.length>0){st.className='status ok';st.textContent=availVersions.length+' phien ban moi. Latest: '+availVersions[0];document.getElementById('doUpdateBtn').style.display='inline-flex'}
    else{st.className='status ok';st.textContent='Da la ban moi nhat!'}
  }else{st.className='status fail';st.textContent=d.error||'Loi'}
}
async function doUpdate(){
  const st=document.getElementById('updateStatus'),v=availVersions.length>0?availVersions[0]:'latest';
  st.className='status loading';st.textContent='Dang cap nhat '+v+'...';
  document.getElementById('updateLog').style.display='block';document.getElementById('updateLogBox').textContent='Bat dau...\\n';
  const d=await api('/api/update','POST',{version:v});
  st.className=d.ok?'status ok':'status fail';st.textContent=d.ok?'Cap nhat thanh cong!':d.error||'Loi';
  document.getElementById('updateLogBox').textContent+=d.log||'';if(d.ok)loadUpdate();
}

// === Status ===
async function loadStatus(){
  const d=await api('/api/status'),el=document.getElementById('statusInfo');
  if(!d.ok){el.innerHTML='<div class="info-row"><span class="info-v" style="color:var(--danger)">Loi</span></div>';return}
  let h='';(d.services||[]).forEach(s=>{h+='<div class="info-row"><span class="info-k">'+s.name+'</span><span class="info-v"><span class="badge '+(s.active?'bg-green':'bg-red')+'">'+(s.active?'Running':'Stopped')+'</span></span></div>'});
  h+='<div class="info-row" style="border-top:2px solid #f0f1f3;margin-top:4px;padding-top:12px"><span class="info-k">Uptime</span><span class="info-v">'+(d.uptime||'-')+'</span></div>';
  h+='<div class="info-row"><span class="info-k">RAM</span><span class="info-v">'+(d.memory||'-')+'</span></div>';
  h+='<div class="info-row"><span class="info-k">Disk</span><span class="info-v">'+(d.disk||'-')+'</span></div>';
  h+='<div class="info-row"><span class="info-k">CPU</span><span class="info-v">'+(d.cpu||'-')+'</span></div>';
  h+='<div class="info-row"><span class="info-k">Version</span><span class="info-v">'+(d.version||'-')+'</span></div>';
  h+='<div class="info-row"><span class="info-k">Token</span><span class="info-v" style="font-family:monospace;font-size:9px">'+(d.token||'-')+'</span></div>';
  el.innerHTML=h;
}
async function loadLogs(){const d=await api('/api/logs');document.getElementById('logsBox').textContent=d.ok?d.logs:'Loi'}
async function restartSvc(n){
  const st=document.getElementById('statusMsg');st.className='status loading';st.textContent='Restart '+n+'...';
  const d=await api('/api/restart','POST',{service:n});st.className=d.ok?'status ok':'status fail';st.textContent=d.ok?n+' OK!':d.error||'Loi';
  setTimeout(()=>{loadStatus();loadLogs()},2000);
}

// === Chat Playground ===
let chatHistory=[];
async function loadChat(){
  const d=await api('/api/current-config');
  document.getElementById('chatProviderLabel').textContent=d.providerName?(d.providerName+' — '+d.model):'AI Chat';
}
async function sendChat(){
  const inp=document.getElementById('chatInput'),msg=inp.value.trim();if(!msg)return;
  inp.value='';const box=document.getElementById('chatMsgs');
  const userDiv=document.createElement('div');userDiv.className='chat-msg user';userDiv.textContent=msg;box.appendChild(userDiv);
  chatHistory.push({role:'user',content:msg});
  const aiDiv=document.createElement('div');aiDiv.className='chat-msg ai';aiDiv.textContent='Dang suy nghi...';box.appendChild(aiDiv);
  box.scrollTop=box.scrollHeight;
  const t0=Date.now();
  try{const d=await api('/api/chat','POST',{message:msg,history:chatHistory.slice(-20)});
    if(d.ok){aiDiv.innerHTML=d.reply.replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\\n/g,'<br>')+'<div class="meta">'+(d.tokens?d.tokens+' tokens | ':'')+((Date.now()-t0)/1000).toFixed(1)+'s'+(d.model?' | '+d.model:'')+'</div>';
      chatHistory.push({role:'assistant',content:d.reply});
      document.getElementById('chatMeta').textContent='Messages: '+chatHistory.length;
    }else{aiDiv.textContent='Loi: '+(d.error||'Khong the ket noi');}
  }catch(e){aiDiv.textContent='Loi: '+e.message;}
  box.scrollTop=box.scrollHeight;
}
function clearChat(){chatHistory=[];document.getElementById('chatMsgs').innerHTML='<div class="chat-msg ai">Chat da xoa. Hay gui tin nhan moi.</div>';document.getElementById('chatMeta').textContent=''}

// === Usage Analytics ===
async function loadAnalytics(){
  const d=await api('/api/analytics');
  const ov=document.getElementById('analyticsOverview');
  if(!d.ok){ov.innerHTML='<div class="info-row"><span class="info-v" style="color:var(--text2)">Chua co du lieu</span></div>';return}
  ov.innerHTML='<div class="info-row"><span class="info-k">Tong request</span><span class="info-v">'+d.totalRequests+'</span></div>'+
    '<div class="info-row"><span class="info-k">Tong token</span><span class="info-v">'+(d.totalTokens||0).toLocaleString()+'</span></div>'+
    '<div class="info-row"><span class="info-k">Hom nay</span><span class="info-v">'+d.todayRequests+' req</span></div>'+
    '<div class="info-row"><span class="info-k">Provider</span><span class="info-v">'+(d.provider||'-')+'</span></div>';
  const chart=document.getElementById('analyticsChart'),list=document.getElementById('analyticsList');
  chart.innerHTML='';list.innerHTML='';
  if(d.daily&&d.daily.length>0){
    const maxR=Math.max(...d.daily.map(x=>x.requests),1);
    d.daily.forEach(day=>{const pct=Math.max(4,(day.requests/maxR)*100);
      const bar=document.createElement('div');bar.style.cssText='flex:1;display:flex;flex-direction:column;align-items:center;gap:4px';
      bar.innerHTML='<span style="font-size:10px;color:var(--text2)">'+day.requests+'</span><div style="width:100%;height:'+pct+'px;background:var(--accent);border-radius:4px;min-width:20px"></div><span style="font-size:9px;color:var(--text2)">'+day.date.slice(5)+'</span>';
      chart.appendChild(bar);
    });
  }
}

// === Conversation History ===
async function loadHistory(){
  const d=await api('/api/conversations');
  const el=document.getElementById('historyList');
  document.getElementById('historyDetail').style.display='none';
  if(!d.ok||!d.conversations||d.conversations.length===0){el.innerHTML='<div style="font-size:12px;color:var(--text2)">Chua co hoi thoai nao.</div>';return}
  el.innerHTML='';
  d.conversations.forEach((c,i)=>{
    const div=document.createElement('div');div.style.cssText='display:flex;align-items:center;gap:12px;padding:10px 14px;border:1px solid var(--border);border-radius:8px;cursor:pointer;transition:all .15s';
    div.innerHTML='<span style="font-size:18px">\\ud83d\\udcac</span><div style="flex:1"><div style="font-size:13px;font-weight:600">'+(c.title||'Hoi thoai #'+(i+1))+'</div><div style="font-size:11px;color:var(--text2)">'+(c.date||'')+' \\u2014 '+(c.messageCount||0)+' tin nhan'+(c.channel?' \\u2014 '+c.channel:'')+'</div></div>';
    div.onmouseover=()=>{div.style.borderColor='var(--accent)'};div.onmouseout=()=>{div.style.borderColor='var(--border)'};
    div.onclick=()=>showConversation(c.id,c.title||'Hoi thoai #'+(i+1));
    el.appendChild(div);
  });
}
async function showConversation(id,title){
  document.getElementById('historyDetail').style.display='block';
  document.getElementById('historyDetailTitle').textContent=title;
  const d=await api('/api/conversations/'+id);
  const el=document.getElementById('historyMsgs');
  if(!d.ok){el.innerHTML='<div style="color:var(--text2)">Loi</div>';return}
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
  if(!d.ok){el.innerHTML='<div class="info-row"><span class="info-v" style="color:var(--text2)">Loi</span></div>';return}
  el.innerHTML='<div class="info-row"><span class="info-k">UFW Firewall</span><span class="info-v"><span class="badge '+(d.ufw?'bg-green':'bg-red')+'">'+(d.ufw?'Active':'Inactive')+'</span></span></div>'+
    '<div class="info-row"><span class="info-k">SSH</span><span class="info-v">'+(d.sshPort||22)+'</span></div>'+
    '<div class="info-row"><span class="info-k">Login IP hien tai</span><span class="info-v">'+(d.clientIP||'-')+'</span></div>';
}
async function changePassword(){
  const st=document.getElementById('passStatus'),o=document.getElementById('oldPass').value,n=document.getElementById('newPass').value,c=document.getElementById('confirmPass').value;
  if(!o||!n){st.className='status fail';st.textContent='Nhap day du';return}
  if(n!==c){st.className='status fail';st.textContent='Mat khau moi khong khop';return}
  if(n.length<6){st.className='status fail';st.textContent='Mat khau moi qua ngan (min 6)';return}
  st.className='status loading';st.textContent='Dang doi...';
  const d=await api('/api/change-password','POST',{oldPassword:o,newPassword:n});
  st.className=d.ok?'status ok':'status fail';st.textContent=d.ok?'Da doi mat khau!':d.error||'Loi';
  if(d.ok){document.getElementById('oldPass').value='';document.getElementById('newPass').value='';document.getElementById('confirmPass').value=''}
}

// === Backup & Restore ===
async function doBackup(){
  const st=document.getElementById('backupStatus');st.className='status loading';st.textContent='Dang tao backup...';
  const d=await api('/api/backup');
  if(d.ok){st.className='status ok';st.textContent='Backup thanh cong! Copy noi dung ben duoi.';
    document.getElementById('backupData').style.display='block';
    document.getElementById('backupContent').value=JSON.stringify(d.data,null,2);
  }else{st.className='status fail';st.textContent=d.error||'Loi'}
}
async function doRestore(){
  const st=document.getElementById('restoreStatus'),raw=document.getElementById('restoreContent').value.trim();
  if(!raw){st.className='status fail';st.textContent='Dan noi dung backup';return}
  let data;try{data=JSON.parse(raw)}catch{st.className='status fail';st.textContent='JSON khong hop le';return}
  if(!confirm('Ban chac chan muon phuc hoi? Cau hinh hien tai se bi ghi de.'))return;
  st.className='status loading';st.textContent='Dang phuc hoi...';
  const d=await api('/api/restore','POST',{data});
  st.className=d.ok?'status ok':'status fail';st.textContent=d.ok?'Phuc hoi thanh cong! OpenClaw da restart.':d.error||'Loi';
}

// === Config Editor ===
async function loadConfigEditor(){
  const d=await api('/api/config-read');
  if(d.ok){document.getElementById('configJson').value=d.json||'{}';document.getElementById('configEnv').value=d.env||''}
}
async function saveConfigFile(type){
  const stId=type==='json'?'configJsonStatus':'configEnvStatus';const st=document.getElementById(stId);
  st.className='status loading';st.textContent='Dang luu...';
  const content=type==='json'?document.getElementById('configJson').value:document.getElementById('configEnv').value;
  if(type==='json'){try{JSON.parse(content)}catch(e){st.className='status fail';st.textContent='JSON loi: '+e.message;return}}
  const d=await api('/api/config-write','POST',{type,content});
  st.className=d.ok?'status ok':'status fail';st.textContent=d.ok?'Da luu! Restart OK.':d.error||'Loi';
}

// === QR Code ===
async function loadQR(){
  const d=await api('/api/current-config');
  const host=d.domain||d.serverIP||'localhost',token=d.token||'';
  const url='https://'+host+'?token='+token;
  document.getElementById('qrUrl').textContent=url;
  // Simple QR code using API
  const canvas=document.getElementById('qrCanvas');
  canvas.innerHTML='<img src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&data='+encodeURIComponent(url)+'" alt="QR" style="border-radius:8px;width:180px;height:180px">';
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
    if(!d.ok||!d.history||d.history.length===0){el.innerHTML='<div style="color:var(--text2);font-size:12px;padding:8px">Chua co lich su. Bam Scan de bat dau.</div>';return}
    let h='';d.history.forEach(item=>{
      const modeLabel={scan:'Scan',repair:'Repair',deep:'Deep'}[item.mode]||item.mode;
      const s=item.summary||{};
      const resultColor=s.fail>0?'var(--danger)':s.warn>0?'var(--warn)':'var(--accent2)';
      const resultText=s.total>0?(s.pass+' pass, '+s.warn+' warn, '+s.fail+' fail'):(item.duration||'-');
      h+='<div class="doc-hist-item"><span class="dh-date">'+(item.date||'-')+'</span><span class="dh-mode">'+modeLabel+'</span><span class="dh-result" style="color:'+resultColor+'">'+resultText+'</span></div>';
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
    ch.innerHTML=summary.checks.map(c=>'<div class="doc-check '+c.status+'"><span class="dc-icon">'+(c.status==='pass'?'\\u2705':c.status==='warn'?'\\u26a0\\ufe0f':'\\u274c')+'</span><span class="dc-text">'+c.name+'</span><span class="dc-detail">'+c.detail+'</span></div>').join('');
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
  st.className='status loading';st.textContent=modeLabel+' (co the mat 1-2 phut)';
  document.getElementById('doctorResultCard').style.display='none';
  document.getElementById('doctorOutputCard').style.display='none';
  try{
    const d=await api('/api/doctor','POST',{mode});
    btns.forEach(b=>b.classList.remove('running'));doctorRunning=false;
    if(!d.ok){st.className='status fail';st.textContent=d.error||'Loi khi chay doctor';return}
    const s=d.summary||{};
    if(s.fail>0){st.className='status fail';st.textContent='Phat hien '+s.fail+' loi! ('+s.total+' checks, '+d.duration+')'}
    else if(s.warn>0){st.className='status warn';st.textContent=s.warn+' canh bao. ('+s.total+' checks, '+d.duration+')'}
    else{st.className='status ok';st.textContent='He thong binh thuong! ('+s.total+' checks, '+d.duration+')'}
    renderDoctorResult(s,d.output||'');
    loadDoctor();
  }catch(e){
    btns.forEach(b=>b.classList.remove('running'));doctorRunning=false;
    st.className='status fail';st.textContent='Loi: '+e.message;
  }
}

// === Dark Mode ===
function toggleDark(){
  document.body.classList.toggle('dark');
  try{localStorage.setItem('oc-dark',document.body.classList.contains('dark')?'1':'0')}catch{}
}
(function(){try{if(localStorage.getItem('oc-dark')==='1')document.body.classList.add('dark')}catch{}})();

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
    if (isBlocked(ip)) return json(res, 429, { ok: false, error: 'Qua nhieu lan thu. Doi 15 phut.' });
    try {
      const body = await parseBody(req);
      if (!body.username || !body.password) return json(res, 400, { ok: false, error: 'Thieu thong tin' });
      if (verifyPassword(body.username, body.password)) {
        const token = createSession();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `panel_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}` });
        return res.end(JSON.stringify({ ok: true }));
      } else {
        recordFailedLogin(ip);
        const rem = MAX_LOGIN_ATTEMPTS - (loginAttempts[ip]?.count || 0);
        return json(res, 401, { ok: false, error: `Sai mat khau. Con ${Math.max(0, rem)} lan.` });
      }
    } catch { return json(res, 400, { ok: false, error: 'Request loi' }); }
  }

  // Auth check
  if (url.pathname.startsWith('/api/') && url.pathname !== '/api/login') {
    if (!isValidSession(req)) return json(res, 401, { ok: false, error: 'Chua dang nhap' });
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
      return json(res, 200, { ok: true, provider, providerName, model, channels: activeChannels, domain, token: getEnvValue('OPENCLAW_GATEWAY_TOKEN'), version: getEnvValue('OPENCLAW_VERSION'), serverIP: getServerIP() });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // Test Key
  if (req.method === 'POST' && url.pathname === '/api/test-key') {
    try {
      const body = await parseBody(req); const p = PROVIDERS[body.provider];
      if (!p) return json(res, 400, { ok: false, error: 'Provider khong hop le' });
      const ok = p.testFn(body.apiKey);
      return json(res, 200, { ok, error: ok ? null : 'API key khong hop le' });
    } catch { return json(res, 500, { ok: false, error: 'Loi' }); }
  }

  // Apply Provider
  if (req.method === 'POST' && url.pathname === '/api/provider') {
    try {
      const body = await parseBody(req); const prov = PROVIDERS[body.provider];
      if (!prov) return json(res, 400, { ok: false, error: 'Provider khong hop le' });
      const token = getEnvValue('OPENCLAW_GATEWAY_TOKEN');
      for (const [, p] of Object.entries(PROVIDERS)) { if (p.envKey !== prov.envKey) removeEnvValue(p.envKey); if (p.extraEnvKeys) p.extraEnvKeys.forEach(ek => { if (!(prov.extraEnvKeys || []).includes(ek)) removeEnvValue(ek); }); }
      setEnvValue(prov.envKey, body.apiKey);
      if (body.extraEnv && prov.extraEnvKeys) { for (const [ek, ev] of Object.entries(body.extraEnv)) { if (prov.extraEnvKeys.includes(ek) && ev) setEnvValue(ek, ev); } }
      let config; try { config = JSON.parse(fs.readFileSync(prov.configFile, 'utf8')); } catch { config = getConfig(); }
      config.gateway = config.gateway || {}; config.gateway.auth = config.gateway.auth || {}; config.gateway.auth.token = token;
      config.agents = config.agents || { defaults: { model: {} } }; config.agents.defaults = config.agents.defaults || { model: {} }; config.agents.defaults.model = config.agents.defaults.model || {};
      if (body.model) config.agents.defaults.model.primary = body.model;
      config.browser = config.browser || { headless: true, executablePath: '/usr/bin/google-chrome', defaultProfile: 'openclaw', noSandbox: true };
      config.gateway.mode = config.gateway.mode || 'local'; config.gateway.bind = config.gateway.bind || 'loopback'; config.gateway.trustedProxies = config.gateway.trustedProxies || ['127.0.0.1', '::1'];
      saveConfig(config); restartService('openclaw'); await new Promise(r => setTimeout(r, 2000));
      return json(res, 200, { ok: isServiceActive('openclaw'), error: isServiceActive('openclaw') ? null : 'Khong khoi dong duoc' });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // Channels
  if (req.method === 'POST' && url.pathname === '/api/channels') {
    try {
      const body = await parseBody(req); const ch = CHANNELS[body.channel];
      if (!ch) return json(res, 400, { ok: false, error: 'Channel khong hop le' });
      for (const [key, val] of Object.entries(body.tokens || {})) { if (ch.envKeys.includes(key) && val) setEnvValue(key, val); }
      restartService('openclaw'); await new Promise(r => setTimeout(r, 2000));
      return json(res, 200, { ok: true });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // Channel Pair
  if (req.method === 'POST' && url.pathname === '/api/channel-pair') {
    try {
      const body = await parseBody(req); const ch = CHANNELS[body.channel];
      if (!ch || !ch.canPair) return json(res, 400, { ok: false, error: 'Khong ho tro pairing qua web' });
      const code = (body.code || '').replace(/[^a-zA-Z0-9_-]/g, '');
      if (!code) return json(res, 400, { ok: false, error: 'Thieu ma' });
      try { execSync(`/opt/openclaw-cli.sh pairing approve ${ch.pairCmd} ${code}`, { timeout: 15000, stdio: 'pipe' }); return json(res, 200, { ok: true }); }
      catch (e) { return json(res, 200, { ok: false, error: (e.stderr || e.stdout || '').toString().substring(0, 200) || e.message }); }
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // Device Pair — tim va approve pending pairing request
  if (req.method === 'POST' && url.pathname === '/api/pair') {
    try {
      const gatewayToken = getEnvValue('OPENCLAW_GATEWAY_TOKEN');
      if (!gatewayToken) return json(res, 400, { ok: false, error: 'Chua co gateway token' });
      let output = '';
      try {
        output = execSync(`/opt/openclaw-cli.sh devices list --token=${gatewayToken} 2>/dev/null`, { timeout: 15000, stdio: 'pipe' }).toString();
      } catch (e) { output = (e.stdout || '').toString(); }
      const pendingSection = output.match(/Pending[\s\S]*?(?=Paired|$)/i);
      if (!pendingSection) return json(res, 200, { ok: false, error: 'Khong tim thay yeu cau ghep noi. Mo dashboard truoc roi thu lai.' });
      const uuids = pendingSection[0].match(/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/g);
      if (!uuids || uuids.length === 0) return json(res, 200, { ok: false, error: 'Khong tim thay yeu cau ghep noi. Mo dashboard truoc roi thu lai.' });
      if (uuids.length > 1) return json(res, 200, { ok: false, error: `Tim thay ${uuids.length} yeu cau. Thu lai sau.` });
      execSync(`/opt/openclaw-cli.sh devices approve "${uuids[0]}" --token=${gatewayToken}`, { timeout: 15000, stdio: 'pipe' });
      return json(res, 200, { ok: true });
    } catch (e) { return json(res, 500, { ok: false, error: 'Loi ghep noi: ' + e.message }); }
  }

  // Device List
  if (req.method === 'GET' && url.pathname === '/api/devices') {
    try {
      const gatewayToken = getEnvValue('OPENCLAW_GATEWAY_TOKEN');
      if (!gatewayToken) return json(res, 200, { ok: true, devices: [] });
      let output = '';
      try {
        output = execSync(`/opt/openclaw-cli.sh devices list --token=${gatewayToken} 2>/dev/null`, { timeout: 15000, stdio: 'pipe' }).toString();
      } catch (e) { output = (e.stdout || '').toString(); }
      const devices = [];
      // Parse paired devices
      const pairedSection = output.match(/Paired[\s\S]*?(?=Pending|$)/i);
      if (pairedSection) {
        const uuids = pairedSection[0].match(/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/g);
        if (uuids) uuids.forEach(u => devices.push({ uuid: u, name: u.substring(0, 8) + '...', status: 'paired' }));
      }
      // Parse pending devices
      const pendingSection = output.match(/Pending[\s\S]*?(?=Paired|$)/i);
      if (pendingSection) {
        const uuids = pendingSection[0].match(/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/g);
        if (uuids) uuids.forEach(u => devices.push({ uuid: u, name: u.substring(0, 8) + '... (cho duyet)', status: 'pending' }));
      }
      return json(res, 200, { ok: true, devices });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
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
        fs.writeFileSync(CADDYFILE, `${serverIP} {\n    tls internal\n    reverse_proxy localhost:18789\n}\n`, 'utf8');
        restartService('caddy'); await new Promise(r => setTimeout(r, 2000)); return json(res, 200, { ok: true });
      }
      const domain = (body.domain || '').trim().toLowerCase(), email = (body.email || '').trim();
      if (!domain) return json(res, 400, { ok: false, error: 'Thieu ten mien' });
      if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) return json(res, 400, { ok: false, error: 'Ten mien khong hop le' });
      let ips = [];
      try { const o = safeExec(`dig +short A ${domain}`, 10000); if (o) ips = o.split('\n').filter(i => /^\d+\.\d+\.\d+\.\d+$/.test(i.trim())); } catch {}
      if (!ips.length) try { const o = safeExec(`host ${domain}`, 10000); const m = o.match(/has address (\d+\.\d+\.\d+\.\d+)/g); if (m) ips = m.map(s => s.replace('has address ', '')); } catch {}
      if (!ips.length) try { const o = safeExec(`python3 -c "import socket; print(socket.gethostbyname('${domain}'))"`, 10000); if (/^\d+\.\d+\.\d+\.\d+$/.test(o)) ips = [o]; } catch {}
      if (!ips.length) return json(res, 400, { ok: false, error: `Khong phan giai DNS. Tro A record ve ${serverIP}.` });
      if (!ips.includes(serverIP)) return json(res, 400, { ok: false, error: `DNS tro ve ${ips.join(', ')} — khong phai ${serverIP}.` });
      const el = email ? `email ${email}\n` : '';
      fs.writeFileSync(CADDYFILE, `${el}${domain} {\n    tls {\n        issuer acme {\n            dir https://acme-v02.api.letsencrypt.org/directory\n            profile shortlived\n        }\n    }\n    reverse_proxy localhost:18789\n}\n`, 'utf8');
      execSync('systemctl enable caddy 2>/dev/null || true', { timeout: 10000 }); restartService('caddy'); await new Promise(r => setTimeout(r, 3000));
      if (isServiceActive('caddy')) return json(res, 200, { ok: true, domain });
      fs.writeFileSync(CADDYFILE, `${serverIP} {\n    tls internal\n    reverse_proxy localhost:18789\n}\n`, 'utf8'); restartService('caddy');
      return json(res, 500, { ok: false, error: 'Caddy loi. Da rollback.' });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // Update Check
  if (req.method === 'GET' && url.pathname === '/api/update-check') {
    try {
      const cur = getEnvValue('OPENCLAW_VERSION') || '';
      safeExec(`cd ${OPENCLAW_DIR} && git fetch --tags 2>/dev/null`, 30000);
      const raw = safeExec(`cd ${OPENCLAW_DIR} && git tag --sort=-version:refname 2>/dev/null`, 10000);
      const tags = raw.split('\n').filter(t => t.trim() && t.startsWith('v')).slice(0, 20);
      return json(res, 200, { ok: true, current: cur, versions: tags.filter(t => t !== cur), allVersions: tags });
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
      log += 'Build...\n';
      const bo = safeExec(`cd ${OPENCLAW_DIR} && su - openclaw -c "cd ${OPENCLAW_DIR} && pnpm install --frozen-lockfile 2>&1 && pnpm build 2>&1 && pnpm ui:install 2>&1 && pnpm ui:build 2>&1"`, 300000);
      log += bo ? bo.substring(Math.max(0, bo.length - 500)) + '\n' : 'Done.\n';
      if (ver !== 'latest') setEnvValue('OPENCLAW_VERSION', ver);
      log += 'Start...\n'; restartService('openclaw'); await new Promise(r => setTimeout(r, 3000));
      const ok = isServiceActive('openclaw'); log += ok ? 'OK!\n' : 'FAIL\n';
      return json(res, 200, { ok, log, error: ok ? null : 'Khong khoi dong duoc' });
    } catch (e) { return json(res, 500, { ok: false, error: e.message, log: e.message }); }
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

  // === Chat Playground ===
  if (req.method === 'POST' && url.pathname === '/api/chat') {
    try {
      const body = await parseBody(req);
      const config = getConfig();
      const model = config?.agents?.defaults?.model?.primary || '';
      if (!model) return json(res, 400, { ok: false, error: 'Chua cau hinh provider' });

      // Detect provider from model string
      const provKey = Object.entries(PROVIDERS).find(([k]) => {
        if (model.startsWith(k + '/')) return true;
        if (k === 'gemini' && model.startsWith('google/')) return true;
        if (k === 'bedrock' && model.startsWith('amazon-bedrock/')) return true;
        return false;
      });
      if (!provKey) return json(res, 400, { ok: false, error: 'Provider khong xac dinh' });
      const prov = provKey[1];
      const apiKey = getEnvValue(prov.envKey);
      if (!apiKey) return json(res, 400, { ok: false, error: 'API key chua cau hinh' });

      // Build messages
      const messages = (body.history || []).slice(-20).map(m => ({ role: m.role, content: m.content }));
      if (!messages.length || messages[messages.length - 1].content !== body.message)
        messages.push({ role: 'user', content: body.message });

      // Route to correct API
      let reply = '', tokens = 0;
      const actualModel = model.includes('/') ? model.split('/').slice(1).join('/') : model;

      if (provKey[0] === 'anthropic') {
        const r = safeExec(`curl -s -X POST https://api.anthropic.com/v1/messages -H 'x-api-key: ${apiKey.replace(/'/g,"'\\''")}' -H 'anthropic-version: 2023-06-01' -H 'content-type: application/json' -d '${JSON.stringify({model:actualModel,max_tokens:1024,messages}).replace(/'/g,"'\\''")}'`, 60000);
        try { const j = JSON.parse(r); reply = j.content?.[0]?.text || 'No response'; tokens = (j.usage?.input_tokens||0) + (j.usage?.output_tokens||0); } catch { reply = r || 'Loi parse response'; }
      } else if (provKey[0] === 'gemini') {
        const gModel = actualModel.replace('google/', '');
        const r = safeExec(`curl -s -X POST "https://generativelanguage.googleapis.com/v1beta/models/${gModel}:generateContent?key=${apiKey.replace(/'/g,"'\\''")}" -H 'content-type: application/json' -d '${JSON.stringify({contents:messages.map(m=>({role:m.role==='assistant'?'model':'user',parts:[{text:m.content}]}))}).replace(/'/g,"'\\''")}'`, 60000);
        try { const j = JSON.parse(r); reply = j.candidates?.[0]?.content?.parts?.[0]?.text || 'No response'; tokens = j.usageMetadata?.totalTokenCount || 0; } catch { reply = r || 'Loi'; }
      } else {
        // OpenAI-compatible (most providers)
        let baseUrl = 'https://api.openai.com/v1';
        if (provKey[0] === 'xai') baseUrl = 'https://api.x.ai/v1';
        else if (provKey[0] === 'minimax') baseUrl = 'https://api.minimax.io/v1';
        else if (provKey[0] === 'moonshot' || provKey[0] === 'kimi-coding') baseUrl = 'https://api.moonshot.ai/v1';
        else if (provKey[0] === 'zai') baseUrl = 'https://api.z.ai/v1';
        else if (provKey[0] === 'venice') baseUrl = 'https://api.venice.ai/api/v1';
        else if (provKey[0] === 'nvidia') baseUrl = 'https://integrate.api.nvidia.com/v1';
        else if (provKey[0] === 'huggingface') baseUrl = 'https://router.huggingface.co/v1';
        else if (provKey[0] === 'together') baseUrl = 'https://api.together.xyz/v1';
        else if (provKey[0] === 'openrouter') baseUrl = 'https://openrouter.ai/api/v1';
        else if (provKey[0] === 'synthetic') baseUrl = 'https://api.synthetic.new/openai/v1';
        else if (provKey[0] === 'ollama') baseUrl = 'http://127.0.0.1:11434/v1';
        else if (provKey[0] === 'vllm') baseUrl = 'http://127.0.0.1:8000/v1';
        else if (provKey[0] === 'litellm') baseUrl = 'http://localhost:4000/v1';

        const r = safeExec(`curl -s -X POST ${baseUrl}/chat/completions -H 'Authorization: Bearer ${apiKey.replace(/'/g,"'\\''")}' -H 'content-type: application/json' -d '${JSON.stringify({model:actualModel,messages,max_tokens:1024}).replace(/'/g,"'\\''")}'`, 60000);
        try { const j = JSON.parse(r); reply = j.choices?.[0]?.message?.content || 'No response'; tokens = j.usage?.total_tokens || 0; } catch { reply = r || 'Loi'; }
      }

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

      return json(res, 200, { ok: true, reply, tokens, model });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // === Analytics ===
  if (req.method === 'GET' && url.pathname === '/api/analytics') {
    try {
      const statsFile = '/opt/openclaw-panel-stats.json';
      let stats = {}; try { stats = JSON.parse(fs.readFileSync(statsFile, 'utf8')); } catch {}
      const config = getConfig(); const model = config?.agents?.defaults?.model?.primary || '';
      const provInfo = Object.entries(PROVIDERS).find(([k]) => model.startsWith(k + '/') || (k === 'gemini' && model.startsWith('google/')) || (k === 'bedrock' && model.startsWith('amazon-bedrock/')));
      const today = new Date().toISOString().slice(0, 10);
      const daily = [];
      for (let i = 6; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); const ds = d.toISOString().slice(0, 10); daily.push({ date: ds, requests: stats.daily?.[ds]?.requests || 0, tokens: stats.daily?.[ds]?.tokens || 0 }); }
      return json(res, 200, { ok: true, totalRequests: stats.requests || 0, totalTokens: stats.tokens || 0, todayRequests: stats.daily?.[today]?.requests || 0, provider: provInfo ? provInfo[1].name : '-', daily });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // === Conversations ===
  if (req.method === 'GET' && url.pathname === '/api/conversations') {
    try {
      const convDir = '/home/openclaw/.openclaw/conversations';
      let conversations = [];
      try {
        if (fs.existsSync(convDir)) {
          const files = fs.readdirSync(convDir).filter(f => f.endsWith('.json')).sort().reverse().slice(0, 50);
          files.forEach((f, i) => {
            try {
              const data = JSON.parse(fs.readFileSync(`${convDir}/${f}`, 'utf8'));
              const msgs = data.messages || data.conversation || [];
              const firstMsg = msgs.find(m => m.role === 'user');
              conversations.push({
                id: f.replace('.json', ''), title: (firstMsg?.content || '').substring(0, 60) || 'Hoi thoai',
                date: data.createdAt || data.timestamp || f.replace('.json', '').slice(0, 10),
                messageCount: msgs.length, channel: data.channel || data.platform || ''
              });
            } catch {}
          });
        }
      } catch {}
      return json(res, 200, { ok: true, conversations });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/conversations/')) {
    try {
      const id = url.pathname.replace('/api/conversations/', '').replace(/[^a-zA-Z0-9_.-]/g, '');
      const convDir = '/home/openclaw/.openclaw/conversations';
      const fpath = `${convDir}/${id}.json`;
      if (!fs.existsSync(fpath)) return json(res, 404, { ok: false, error: 'Not found' });
      const data = JSON.parse(fs.readFileSync(fpath, 'utf8'));
      return json(res, 200, { ok: true, messages: data.messages || data.conversation || [] });
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
      if (!body.oldPassword || !body.newPassword) return json(res, 400, { ok: false, error: 'Thieu thong tin' });
      if (body.newPassword.length < 6) return json(res, 400, { ok: false, error: 'Mat khau moi qua ngan' });
      if (!verifyPassword('root', body.oldPassword)) return json(res, 401, { ok: false, error: 'Mat khau cu sai' });
      try {
        execSync(`echo 'root:${body.newPassword.replace(/'/g,"'\\''")}' | chpasswd`, { timeout: 10000 });
        return json(res, 200, { ok: true });
      } catch (e) { return json(res, 500, { ok: false, error: 'Loi doi mat khau: ' + e.message }); }
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
      return json(res, 200, { ok: true, data });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // === Restore ===
  if (req.method === 'POST' && url.pathname === '/api/restore') {
    try {
      const body = await parseBody(req);
      const d = body.data;
      if (!d || d._type !== 'openclaw-backup') return json(res, 400, { ok: false, error: 'Backup data khong hop le' });
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
        try { JSON.parse(body.content); } catch (e) { return json(res, 400, { ok: false, error: 'JSON loi: ' + e.message }); }
        const dir = '/home/openclaw/.openclaw'; fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(CONFIG_FILE, body.content, 'utf8');
        execSync(`chown openclaw:openclaw ${CONFIG_FILE}`); execSync(`chmod 0600 ${CONFIG_FILE}`);
      } else if (body.type === 'env') {
        fs.writeFileSync(ENV_FILE, body.content, 'utf8');
      } else { return json(res, 400, { ok: false, error: 'Type khong hop le' }); }
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
          `su -l openclaw -c 'cd ${OPENCLAW_DIR} && node ./cli.js ${cmd}' 2>&1`,
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

// Retry listen voi backoff neu port van bi chiem (vd: Setup UI chua exit hoan toan)
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
    console.log(`[Management Panel] Port ${PORT} dang bi chiem. Retry ${retryCount}/${MAX_RETRIES} sau ${delay/1000}s...`);
    setTimeout(startListen, delay);
  } else {
    console.error(`[Management Panel] Loi khong phuc hoi: ${err.message}`);
    console.error(`[Management Panel] Kiem tra: ss -tlnp | grep :${PORT}`);
    process.exit(1);
  }
});

startListen();
