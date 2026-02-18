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
    <div class="nav-item" onclick="showTab('channels',this)"><span class="nav-icon">\ud83d\udcac</span>Channels</div>
    <div class="nav-item" onclick="showTab('gateway',this)"><span class="nav-icon">\ud83d\udd11</span>Gateway</div>
    <div class="nav-item" onclick="showTab('domain',this)"><span class="nav-icon">\ud83c\udf10</span>Domain & SSL</div>
    <div class="nav-item" onclick="showTab('update',this)"><span class="nav-icon">\ud83d\udce6</span>Update</div>
    <div class="nav-item" onclick="showTab('status',this)"><span class="nav-icon">\ud83d\udcca</span>Status</div>
  </nav>
  <div class="sidebar-footer">OpenClaw Panel v1.0</div>
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
    <div class="page-title">Gateway Token</div>
    <div class="page-desc">Token xac thuc de truy cap dashboard va API.</div>
    <div class="card"><div class="card-title"><span class="ct-icon">\ud83d\udd11</span> Thong tin</div><div id="gatewayInfo" class="info-grid"></div></div>
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
</div>

<script>
let selectedProvider=null,selectedChannel=null,availVersions=[];
const providers=${provJSON};
const channels=${chJSON};

function showTab(name,el){
  document.querySelectorAll('.section').forEach(s=>s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  document.getElementById('sec-'+name).classList.add('active');
  if(el)el.classList.add('active');
  document.querySelector('.sidebar').classList.remove('open');
  if(name==='provider')loadProvider();
  if(name==='channels')loadChannels();
  if(name==='gateway')loadGateway();
  if(name==='domain')loadDomain();
  if(name==='update')loadUpdate();
  if(name==='status'){loadStatus();loadLogs();}
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
  el.innerHTML='<div class="info-row"><span class="info-k">Token</span><span class="info-v" style="font-family:monospace;font-size:10px">'+d.token+'</span></div><div class="info-row"><span class="info-k">Dashboard</span><span class="info-v"><a href="https://'+host+'?token='+d.token+'" target="_blank" style="color:var(--accent);text-decoration:none">https://'+host+'</a></span></div>';
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
        { name: 'Panel', active: isServiceActive('openclaw-panel') },
        { name: 'Fail2ban', active: isServiceActive('fail2ban') }
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

  json(res, 404, { error: 'Not found' });
});

server.listen(PORT, '0.0.0.0', () => { console.log(`[Management Panel] http://0.0.0.0:${PORT}`); });
