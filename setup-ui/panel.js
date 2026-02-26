#!/usr/bin/env node
// =============================================================================
// OpenClaw Management Panel — Web-based admin panel
// PAM authentication (root password), long-running service
// Port: 9999 | Runs as root | Systemd: openclaw-panel.service
// =============================================================================

const http = require('http');
const { execSync, exec, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = 9999;
const SESSION_TTL = 60 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;
const BLOCK_DURATION = 15 * 60 * 1000;

const ENV_FILE = '/opt/openclaw.env';
const CONFIG_FILE = '/home/openclaw/.openclaw/openclaw.json';
const CONFIG_DIR = '/etc/config';
const CADDYFILE = '/etc/caddy/Caddyfile';
const OPENCLAW_DIR = '/opt/openclaw';
function suOC(cmd) { return `su - openclaw -c "set -a; source ${ENV_FILE} 2>/dev/null; set +a; ${cmd}"`; }
// Read install metadata from SKILL.md files (cached)
const SKILLS_DIR = '/opt/openclaw/skills';
const LINUX_INSTALL_KINDS = { apt: 1, node: 1, npm: 1, go: 1, uv: 1, brew: 1 };
// Fallback apt installs for common bins missing from SKILL.md
const APT_FALLBACKS = { ffmpeg: 'ffmpeg', tmux: 'tmux', rg: 'ripgrep', jq: 'jq', curl: 'curl', wget: 'wget', git: 'git', python3: 'python3', pip3: 'python3-pip' };
let _skillInstallsCache = null;
function getSkillInstalls() {
  if (_skillInstallsCache) return _skillInstallsCache;
  _skillInstallsCache = {};
  try {
    const dirs = fs.readdirSync(SKILLS_DIR);
    for (const d of dirs) {
      try {
        const md = fs.readFileSync(SKILLS_DIR + '/' + d + '/SKILL.md', 'utf8');
        const idx = md.indexOf('"install"');
        if (idx < 0) continue;
        const start = md.indexOf('[', idx);
        if (start < 0 || start - idx > 30) continue;
        let depth = 0;
        for (let i = start; i < md.length && i < start + 3000; i++) {
          if (md[i] === '[') depth++;
          else if (md[i] === ']') { depth--; if (depth === 0) {
            const raw = md.substring(start, i + 1).replace(/,(\s*[}\]])/g, '$1');
            try { _skillInstallsCache[d] = JSON.parse(raw); } catch {}
            break;
          }}
        }
      } catch {}
    }
  } catch {}
  return _skillInstallsCache;
}
function buildInstallCmd(inst) {
  const pkg = (inst.package || '').replace(/[^a-zA-Z0-9@._\/-]/g, '');
  const mod = (inst.module || '').replace(/[^a-zA-Z0-9@._\/-]/g, '');
  const formula = (inst.formula || pkg).replace(/[^a-zA-Z0-9@._\/-]/g, '');
  if (inst.kind === 'apt') return 'apt-get install -y ' + pkg + ' 2>&1';
  if (inst.kind === 'node' || inst.kind === 'npm') return 'npm install -g ' + pkg + ' 2>&1 && ln -sf "$(npm prefix -g)/bin"/* /usr/local/bin/ 2>/dev/null';
  if (inst.kind === 'go') return 'GOPATH=/home/openclaw/go PATH=$PATH:/home/openclaw/go/bin:/usr/local/go/bin go install ' + mod + ' 2>&1 && ln -sf /home/openclaw/go/bin/* /usr/local/bin/ 2>/dev/null';
  if (inst.kind === 'uv') return 'uv tool install ' + pkg + ' 2>&1 && ln -sf /root/.local/bin/* /usr/local/bin/ 2>/dev/null';
  if (inst.kind === 'brew') return "su - openclaw -c 'eval \"$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)\" && brew install " + formula + "' 2>&1 && ln -sf /home/linuxbrew/.linuxbrew/bin/* /usr/local/bin/ 2>/dev/null";
  return null;
}
// Pre-check prerequisites before running install. Returns {ok:true} or {ok:false, error:'...'}
function checkInstallPrereqs(inst) {
  const formula = inst.formula || inst.package || inst.module || '';
  if (inst.kind === 'brew') {
    if (!safeExec('which brew 2>/dev/null', 5000) && !fs.existsSync('/home/linuxbrew/.linuxbrew/bin/brew'))
      return { ok: false, needsBrew: true, error: 'brew not installed \u2014 Homebrew is not installed. Install it from https://brew.sh or install "' + formula + '" manually.' };
  }
  if (inst.kind === 'go') {
    if (!safeExec('which go 2>/dev/null', 5000))
      return { ok: false, needsTool: 'go', error: 'go not installed \u2014 Go is required to build "' + formula + '". Click below to install it via apt.' };
  }
  if (inst.kind === 'uv') {
    if (!safeExec('which uv 2>/dev/null', 5000)) {
      safeExec('curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR="/usr/local/bin" sh 2>&1', 60000);
      if (!safeExec('which uv 2>/dev/null', 5000))
        return { ok: false, error: 'uv not installed \u2014 uv could not be auto-installed. Install it from https://docs.astral.sh/uv/getting-started/installation/' };
    }
  }
  if (inst.kind === 'node' || inst.kind === 'npm') {
    if (!safeExec('which npm 2>/dev/null', 5000))
      return { ok: false, error: 'npm not installed \u2014 Node.js/npm is not installed. Install Node.js from https://nodejs.org/' };
  }
  return { ok: true };
}
const PANEL_VERSION = '2026.02.26.6';
const PANEL_UPDATE_URL = 'https://raw.githubusercontent.com/LeAnhlinux/OpenClaw/main/setup-ui/panel.js';
const PANEL_CHECK_URL = 'https://api.github.com/repos/LeAnhlinux/OpenClaw/contents/setup-ui/panel.js';
const PANEL_FILE = '/opt/openclaw-panel/panel.js';

const sessions = {};
const loginAttempts = {};

// --- Helpers ---
function getClientIP(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) { const first = fwd.split(',')[0].trim(); if (first && first !== '127.0.0.1' && first !== '::1') return first; }
  const real = req.headers['x-real-ip'];
  if (real && real !== '127.0.0.1' && real !== '::1') return real;
  return req.socket.remoteAddress.replace('::ffff:', '');
}
function isBlocked(ip) {
  const r = loginAttempts[ip]; if (!r) return false;
  if (r.blockedUntil && Date.now() < r.blockedUntil) return true;
  if (r.blockedUntil && Date.now() >= r.blockedUntil) { delete loginAttempts[ip]; return false; }
  return false;
}
function recordFailedLogin(ip) {
  if (!loginAttempts[ip]) loginAttempts[ip] = { count: 0, blockedUntil: null };
  loginAttempts[ip].count++;
  if (loginAttempts[ip].count >= MAX_LOGIN_ATTEMPTS) {
    const multiplier = Math.min(Math.pow(2, loginAttempts[ip].count - MAX_LOGIN_ATTEMPTS), 8);
    loginAttempts[ip].blockedUntil = Date.now() + BLOCK_DURATION * multiplier;
  }
}
function escapeHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function isSafeShellArg(s) { return /^[a-zA-Z0-9@._\/-]+$/.test(s); }
function isSafeSlug(s) { return /^[a-zA-Z0-9_-]+$/.test(s); }
// Shell-safe quoting: wraps value in single quotes (shell does NOT interpret anything inside single quotes)
function shellEsc(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
function verifyPassword(username, password) {
  try {
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(username)) return false;
    // Read /etc/shadow directly (panel runs as root)
    // Old method `su -c ... username` was broken: root can su to itself without password
    const shadow = fs.readFileSync('/etc/shadow', 'utf8');
    const line = shadow.split('\n').find(l => l.startsWith(username + ':'));
    if (!line) return false;
    const storedHash = line.split(':')[1];
    if (!storedHash || storedHash === '!' || storedHash === '*' || storedHash === '!!' || storedHash === '') return false;
    // Extract algorithm id and salt from $id$salt$hash
    const m = storedHash.match(/^\$([^$]+)\$([^$]+)\$/);
    if (!m) return false;
    const algoId = m[1], salt = m[2];
    const algoFlag = algoId === '6' ? '-6' : '-5'; // $6$=SHA-512, $5$=SHA-256
    // Verify via openssl passwd (password passed via stdin, never in args)
    const r = spawnSync('openssl', ['passwd', algoFlag, '-salt', salt, '-stdin'], {
      input: password, timeout: 5000, stdio: ['pipe', 'pipe', 'pipe']
    });
    const computed = (r.stdout || '').toString().trim();
    return computed.length > 0 && computed === storedHash;
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
  // Strip newlines/control chars to prevent env injection
  const safeVal = String(value).replace(/[\r\n\x00-\x1f]/g, '');
  let c = ''; try { c = fs.readFileSync(ENV_FILE, 'utf8'); } catch {}
  if (new RegExp(`^${key}=`, 'm').test(c)) c = c.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${safeVal}`);
  else c = c.trim() + `\n${key}=${safeVal}\n`;
  fs.writeFileSync(ENV_FILE, c.trim() + '\n', { mode: 0o600 });
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

// --- Task registry for async operations with SSE streaming ---
const tasks = {};
let taskCounter = 0;

function createTask(type) {
  const id = 't' + (++taskCounter) + '_' + Date.now().toString(36);
  tasks[id] = { id, type, status: 'running', logs: [], startedAt: Date.now(), listeners: new Set(), result: null };
  setTimeout(() => { delete tasks[id]; }, 600000); // Auto-cleanup 10 min
  return tasks[id];
}

function taskLog(task, msg) {
  const line = { ts: Date.now(), text: msg };
  task.logs.push(line);
  for (const r of task.listeners) {
    try { r.write(`data: ${JSON.stringify({ type: 'log', text: msg })}\n\n`); } catch {}
  }
}

function taskDone(task, ok, error) {
  task.status = ok ? 'done' : 'failed';
  task.result = { ok, error: error || null };
  for (const r of task.listeners) {
    try { r.write(`data: ${JSON.stringify({ type: 'done', ok, error: error || null })}\n\n`); r.end(); } catch {}
  }
  task.listeners.clear();
}

function asyncExec(task, cmd, timeout) {
  const { spawn } = require('child_process');
  return new Promise((resolve) => {
    let out = '', done = false;
    const child = spawn('bash', ['-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => {
      const s = d.toString(); out += s;
      s.split('\n').filter(l => l.trim()).forEach(l => taskLog(task, l));
    });
    child.stderr.on('data', (d) => {
      const s = d.toString(); out += s;
      s.split('\n').filter(l => l.trim()).forEach(l => taskLog(task, l));
    });
    child.on('close', (code) => { if (!done) { done = true; resolve({ code, out: out.trim() }); } });
    child.on('error', () => { if (!done) { done = true; resolve({ code: 1, out: '' }); } });
    if (timeout) {
      setTimeout(() => {
        if (!done) { done = true; try { child.kill('SIGKILL'); } catch {} resolve({ code: 1, out: out.trim() }); }
      }, timeout + 5000);
    }
  });
}

// --- Browser helpers ---
function clearBrowserSessions() {
  // Clear all conversation sessions so AI starts fresh with correct tool list
  const sessDir = '/home/openclaw/.openclaw/agents/main/sessions';
  try {
    if (fs.existsSync(sessDir)) {
      const files = fs.readdirSync(sessDir);
      for (const f of files) fs.unlinkSync(path.join(sessDir, f));
    }
  } catch {}
}
// Patch status constants
const PATCH_OK = 'patched';
const PATCH_ALREADY = 'already_patched';
const PATCH_NO_FILE = 'no_file';
const PATCH_MISMATCH = 'pattern_mismatch'; // Source code changed — patch cannot apply
const PATCH_ERROR = 'error';

function patchCamofoxPlugin() {
  // Patch CamoFox plugin.ts to save screenshots as temp files + add MEDIA: tokens
  // This allows OpenClaw to forward screenshots to Telegram/WhatsApp via TRUSTED_TOOL_RESULT_MEDIA
  //
  // Returns: PATCH_OK | PATCH_ALREADY | PATCH_NO_FILE | PATCH_MISMATCH | PATCH_ERROR
  const pluginPath = '/home/openclaw/.openclaw/extensions/camofox-browser/plugin.ts';
  try {
    if (!fs.existsSync(pluginPath)) return PATCH_NO_FILE;
    let content = fs.readFileSync(pluginPath, 'utf8');
    if (content.includes('MEDIA:')) return PATCH_ALREADY; // Already patched

    // Validate: check key signatures exist before attempting patch
    // These are stable markers that should exist in any version of plugin.ts
    const hasScreenshotHandler = content.includes('camofox_screenshot') && content.includes('arrayBuffer');
    const hasSnapshotHandler = content.includes('camofox_snapshot') && content.includes('screenshot?.data');
    if (!hasScreenshotHandler && !hasSnapshotHandler) {
      return PATCH_MISMATCH; // Plugin structure completely changed
    }

    let patched = false;
    const mismatches = [];

    // Add fs import if not present
    if (!content.includes('writeFileSync')) {
      const lines = content.split('\n');
      let lastImportIdx = -1;
      for (let i = 0; i < Math.min(lines.length, 30); i++) {
        if (lines[i].startsWith('import ')) lastImportIdx = i;
      }
      if (lastImportIdx >= 0) {
        lines.splice(lastImportIdx + 1, 0, 'import { writeFileSync, existsSync, mkdirSync } from "fs";');
        content = lines.join('\n');
      } else {
        mismatches.push('fs_import: no import statements found');
      }
    }

    // Patch camofox_screenshot: save to temp file + add MEDIA: token
    const oldScreenshot = `const base64 = Buffer.from(arrayBuffer).toString("base64");
      return {
        content: [
          {
            type: "image",
            data: base64,
            mimeType: "image/png",
          },
        ],
      };`;
    const newScreenshot = `const arrayBuf = arrayBuffer;
      const buffer = Buffer.from(arrayBuf);
      const base64 = buffer.toString("base64");
      // Save to temp file for OpenClaw media delivery
      const tmpDir = "/home/openclaw/.openclaw/media/camofox";
      if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
      const tmpFile = \`\${tmpDir}/screenshot-\${Date.now()}.png\`;
      writeFileSync(tmpFile, buffer);
      return {
        content: [
          { type: "text", text: \`Screenshot captured.\\nMEDIA:\${tmpFile}\` },
          {
            type: "image",
            data: base64,
            mimeType: "image/png",
          },
        ],
      };`;
    if (content.includes(oldScreenshot)) {
      content = content.replace(oldScreenshot, newScreenshot);
      patched = true;
    } else if (hasScreenshotHandler) {
      mismatches.push('screenshot: handler exists but code pattern changed');
    }

    // Patch camofox_snapshot: save screenshot to temp file + add MEDIA: token
    const oldSnapshot = `if (screenshot?.data) {
        content.push({ type: "image", data: screenshot.data, mimeType: screenshot.mimeType || "image/png" });
      }`;
    const newSnapshot = `if (screenshot?.data) {
        // Save screenshot to temp file for OpenClaw media delivery
        const tmpDir2 = "/home/openclaw/.openclaw/media/camofox";
        if (!existsSync(tmpDir2)) mkdirSync(tmpDir2, { recursive: true });
        const tmpFile2 = \`\${tmpDir2}/snapshot-\${Date.now()}.png\`;
        writeFileSync(tmpFile2, Buffer.from(screenshot.data, "base64"));
        content.unshift({ type: "text", text: \`MEDIA:\${tmpFile2}\` });
        content.push({ type: "image", data: screenshot.data, mimeType: screenshot.mimeType || "image/png" });
      }`;
    if (content.includes(oldSnapshot)) {
      content = content.replace(oldSnapshot, newSnapshot);
      patched = true;
    } else if (hasSnapshotHandler) {
      mismatches.push('snapshot: handler exists but code pattern changed');
    }

    if (patched) {
      fs.writeFileSync(pluginPath, content);
      safeExec(`chown openclaw:openclaw "${pluginPath}"`, 5000);
    }
    // Return mismatch if some patterns didn't match (even if others did)
    if (mismatches.length > 0) {
      return patched ? `partial:${mismatches.join('; ')}` : PATCH_MISMATCH + ':' + mismatches.join('; ');
    }
    return patched ? PATCH_OK : PATCH_MISMATCH;
  } catch (e) { return PATCH_ERROR + ':' + e.message; }
}

function patchTrustedMedia() {
  // Add camofox tools to TRUSTED_TOOL_RESULT_MEDIA in dist files
  // This allows OpenClaw to forward local file paths from camofox tools to messaging platforms
  //
  // Returns: { status: PATCH_OK|PATCH_ALREADY|PATCH_MISMATCH|PATCH_ERROR, patched: number, details: string }
  const CAMOFOX_TOOLS = [
    'camofox_screenshot', 'camofox_snapshot', 'camofox_create_tab', 'camofox_click',
    'camofox_type', 'camofox_navigate', 'camofox_scroll', 'camofox_close_tab',
    'camofox_list_tabs', 'camofox_import_cookies'
  ];
  const distDir = OPENCLAW_DIR + '/dist';
  const targets = [];
  try {
    for (const f of fs.readdirSync(distDir).filter(f => f.startsWith('reply-') && f.endsWith('.js'))) {
      targets.push(distDir + '/' + f);
    }
    const sdkDir = distDir + '/plugin-sdk';
    if (fs.existsSync(sdkDir)) {
      for (const f of fs.readdirSync(sdkDir).filter(f => f.startsWith('reply-') && f.endsWith('.js'))) {
        targets.push(sdkDir + '/' + f);
      }
    }
  } catch (e) { return { status: PATCH_ERROR, patched: 0, details: 'Cannot read dist dir: ' + e.message }; }

  if (targets.length === 0) return { status: PATCH_ERROR, patched: 0, details: 'No reply-*.js files found in dist' };

  let patched = 0;
  let alreadyPatched = 0;
  const issues = [];

  for (const fp of targets) {
    const fname = fp.split('/').pop();
    try {
      if (!fs.existsSync(fp)) continue;
      let content = fs.readFileSync(fp, 'utf8');
      const marker = 'const TRUSTED_TOOL_RESULT_MEDIA = new Set([';
      if (!content.includes(marker)) {
        // This file doesn't have the TRUSTED set — check if it's expected
        // Only report if file looks like it SHOULD have it (contains tool result handling)
        if (content.includes('TRUSTED_TOOL_RESULT_MEDIA')) {
          issues.push(`${fname}: has TRUSTED_TOOL_RESULT_MEDIA reference but Set declaration pattern changed`);
        }
        continue;
      }
      if (content.includes('camofox_screenshot')) { alreadyPatched++; continue; } // Already patched
      const idx = content.indexOf(marker);
      const endIdx = content.indexOf(']);', idx);
      if (endIdx === -1) { issues.push(`${fname}: found Set marker but no closing ']);'`); continue; }
      const section = content.substring(idx, endIdx + 3);
      // Try multiple anchor patterns for insertion (robust against minor refactors)
      let anchorFound = false;
      for (const anchor of ['\t"write"', '"write"', "'write'"]) {
        if (section.includes(anchor)) {
          const insertEntries = CAMOFOX_TOOLS.map(t => `\t"${t}"`).join(',\n');
          const newSection = section.replace(anchor, anchor + ',\n' + insertEntries);
          content = content.substring(0, idx) + newSection + content.substring(endIdx + 3);
          fs.writeFileSync(fp, content);
          patched++;
          anchorFound = true;
          break;
        }
      }
      if (!anchorFound) {
        issues.push(`${fname}: TRUSTED Set found but "write" anchor entry missing — code structure may have changed`);
      }
    } catch (e) { issues.push(`${fname}: ${e.message}`); }
  }

  if (alreadyPatched > 0 && patched === 0 && issues.length === 0) {
    return { status: PATCH_ALREADY, patched: 0, details: `${alreadyPatched} file(s) already patched` };
  }
  if (patched > 0 && issues.length === 0) {
    return { status: PATCH_OK, patched, details: `${patched} file(s) patched` };
  }
  if (patched > 0 && issues.length > 0) {
    return { status: 'partial', patched, details: issues.join('; ') };
  }
  if (issues.length > 0) {
    return { status: PATCH_MISMATCH, patched: 0, details: issues.join('; ') };
  }
  return { status: PATCH_OK, patched: 0, details: 'No files needed patching' };
}

function formatPatchResult(name, result) {
  // Format patch result into human-readable log line with warnings
  if (typeof result === 'string') {
    // patchCamofoxPlugin returns string
    if (result === PATCH_OK) return `✓ ${name}: OK\n`;
    if (result === PATCH_ALREADY) return `✓ ${name}: already applied\n`;
    if (result === PATCH_NO_FILE) return `⚠ ${name}: plugin file not found\n`;
    if (result.startsWith('partial:')) return `⚠ ${name}: partially applied — ${result.slice(8)}\n`;
    if (result.startsWith(PATCH_MISMATCH)) return `⚠ ${name}: PATTERN MISMATCH — plugin code may have been updated! ${result.includes(':') ? result.split(':').slice(1).join(':') : ''}\n`;
    if (result.startsWith(PATCH_ERROR)) return `⚠ ${name}: ERROR — ${result.split(':').slice(1).join(':')}\n`;
    return `⚠ ${name}: ${result}\n`;
  }
  if (typeof result === 'object' && result !== null) {
    // patchTrustedMedia returns object
    if (result.status === PATCH_OK || result.status === PATCH_ALREADY) return `✓ ${name}: ${result.details}\n`;
    if (result.status === 'partial') return `⚠ ${name}: partially applied (${result.patched} OK) — ${result.details}\n`;
    if (result.status === PATCH_MISMATCH) return `⚠ ${name}: PATTERN MISMATCH — dist code may have changed! ${result.details}\n`;
    return `⚠ ${name}: ${result.status} — ${result.details}\n`;
  }
  return `⚠ ${name}: unexpected result\n`;
}

function updateBrowserToolsMd(browserType) {
  // Update TOOLS.md so AI knows which browser tools to use
  const toolsPath = '/home/openclaw/.openclaw/workspace/TOOLS.md';
  try {
    let content;
    if (browserType === 'camofox') {
      content = `# TOOLS.md - Local Notes

## 🦊 Browser — CamoFox (QUAN TRỌNG)

Server này dùng **CamoFox** (trình duyệt anti-detection dựa trên Firefox), KHÔNG dùng Chrome.

### Quy tắc bắt buộc:
- **CHỈ dùng các tool \`camofox_*\`** để duyệt web: \`camofox_create_tab\`, \`camofox_navigate\`, \`camofox_click\`, \`camofox_type\`, \`camofox_snapshot\`, \`camofox_screenshot\`, \`camofox_scroll\`, \`camofox_close_tab\`
- **KHÔNG BAO GIỜ dùng tool \`browser\`** — tool đó đã bị tắt, gọi sẽ lỗi

### Workflow chuẩn:
1. \`camofox_create_tab\` → mở tab mới với URL
2. \`camofox_snapshot\` → xem nội dung trang + screenshot (có element refs: e1, e2...)
3. \`camofox_click\` / \`camofox_type\` → tương tác bằng ref (e1, e2...)
4. \`camofox_navigate\` → điều hướng (hỗ trợ macro: @google_search, @youtube_search...)
5. \`camofox_close_tab\` → đóng tab khi xong

### Gửi ảnh screenshot cho người dùng:
- Screenshot từ \`camofox_screenshot\` và \`camofox_snapshot\` sẽ được tự động gửi kèm khi bạn trả lời
- KHÔNG cần lưu file ảnh riêng vào workspace — hệ thống đã xử lý tự động
- KHÔNG dùng base64 hay file path — ảnh được chuyển qua HTTP URL nội bộ

### Lưu ý:
- CamoFox bypass bot detection trên Google, Amazon, LinkedIn...
- Snapshot trả về accessibility tree + screenshot — ưu tiên dùng snapshot thay vì screenshot riêng
- Dùng \`ref\` (e1, e2...) từ snapshot để click/type, chính xác hơn CSS selector

---

Add whatever helps you do your job. This is your cheat sheet.
`;
    } else if (browserType === 'chrome') {
      content = `# TOOLS.md - Local Notes

## 🌐 Browser — Google Chrome

Server này dùng **Google Chrome** headless cho browser tools.

### Quy tắc bắt buộc:
- Dùng tool \`browser\` để duyệt web
- **KHÔNG dùng các tool \`camofox_*\`** — CamoFox đã bị tắt

### Lưu ý:
- Chrome chạy headless, không có giao diện
- Hỗ trợ CDP protocol

---

Add whatever helps you do your job. This is your cheat sheet.
`;
    } else {
      content = `# TOOLS.md - Local Notes

## Browser

Không có browser nào được cài đặt. Không thể duyệt web.

---

Add whatever helps you do your job. This is your cheat sheet.
`;
    }
    fs.writeFileSync(toolsPath, content);
    safeExec('chown openclaw:openclaw "' + toolsPath + '"', 5000);
  } catch {}
}

// --- Caddy + Firewall helpers ---
function writeCaddyfile(domain, email) {
  const BIND = '127.0.0.1', GW_PORT = 18789, PANEL_PORT = 9999;
  let cfg = '';
  if (domain) {
    const el = email ? `email ${email}\n` : '';
    const tlsBlock = `    tls {\n        issuer acme {\n            dir https://acme-v02.api.letsencrypt.org/directory\n            profile shortlived\n        }\n    }`;
    cfg = `${el}${domain} {\n${tlsBlock}\n    reverse_proxy ${BIND}:${GW_PORT}\n}\n\n${domain}:9443 {\n${tlsBlock}\n    reverse_proxy ${BIND}:${PANEL_PORT} {\n        header_up X-Real-IP {remote_host}\n    }\n}\n`;
    // Firewall: open 9443, close 9999 (panel only via Caddy HTTPS)
    try { execSync('ufw allow 9443/tcp comment "OpenClaw Panel HTTPS" 2>/dev/null', { stdio: 'ignore' }); } catch {}
    try { execSync('ufw deny 9999/tcp 2>/dev/null', { stdio: 'ignore' }); } catch {}
    // Bind gateway to loopback (Caddy handles external traffic)
    setEnvValue('OPENCLAW_GATEWAY_BIND', BIND);
  } else {
    const serverIP = getServerIP();
    cfg = `${serverIP} {\n    tls internal\n    reverse_proxy ${BIND}:${GW_PORT}\n}\n`;
    // Firewall: open 9999, close 9443
    try { execSync('ufw allow 9999/tcp comment "OpenClaw Panel HTTP" 2>/dev/null', { stdio: 'ignore' }); } catch {}
    try { execSync('ufw delete deny 9999/tcp 2>/dev/null', { stdio: 'ignore' }); } catch {}
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
    xai:'https://api.x.ai/v1', minimax:'https://api.minimax.io/anthropic',
    moonshot:'https://api.moonshot.ai/v1', 'kimi-coding':'https://api.moonshot.ai/v1',
    zai:'https://api.z.ai/api/paas/v4', venice:'https://api.venice.ai/api/v1',
    nvidia:'https://integrate.api.nvidia.com/v1', huggingface:'https://router.huggingface.co/v1',
    openrouter:'https://openrouter.ai/api/v1',
    synthetic:'https://api.synthetic.new/anthropic', xiaomi:'https://api.xiaomimimo.com/anthropic',
    ollama:'http://127.0.0.1:11434/v1', vllm:'http://127.0.0.1:8000/v1', litellm:'http://localhost:4000/v1'
  };
  return urls[provKey] || 'https://api.openai.com/v1';
}
function callProvider(provKey, model, apiKey, messages) {
  const actualModel = model.includes('/') ? model.split('/').slice(1).join('/') : model;
  try {
    if (provKey === 'anthropic' || provKey === 'xiaomi' || provKey === 'synthetic' || provKey === 'minimax' || provKey === 'cloudflare-ai-gateway') {
      let anthropicUrl;
      if (provKey === 'cloudflare-ai-gateway') { const acct = (getEnvValue('CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID') || '').trim().replace(/[^a-zA-Z0-9_-]/g, ''); const gw = (getEnvValue('CLOUDFLARE_AI_GATEWAY_GATEWAY_ID') || '').trim().replace(/[^a-zA-Z0-9_-]/g, ''); anthropicUrl = acct && gw ? `https://gateway.ai.cloudflare.com/v1/${acct}/${gw}/anthropic/v1/messages` : ''; }
      else if (provKey === 'xiaomi') anthropicUrl = 'https://api.xiaomimimo.com/anthropic/v1/messages';
      else if (provKey === 'synthetic') anthropicUrl = 'https://api.synthetic.new/anthropic/v1/messages';
      else if (provKey === 'minimax') anthropicUrl = 'https://api.minimax.io/anthropic/v1/messages';
      else anthropicUrl = 'https://api.anthropic.com/v1/messages';
      if (!anthropicUrl) return { ok: false, error: 'Missing Cloudflare Account ID or Gateway ID' };
      const r = safeExec(`curl -s -X POST '${anthropicUrl}' -H 'x-api-key: '${shellEsc(apiKey)} -H 'anthropic-version: 2023-06-01' -H 'content-type: application/json' -d '${JSON.stringify({model:actualModel,max_tokens:1024,messages}).replace(/'/g,"'\\''")}'`, 60000);
      if (!r) return { ok: false, error: 'Empty response' };
      const j = JSON.parse(r);
      if (j.error) return { ok: false, error: j.error.message || j.error.type || 'API error' };
      return { ok: true, reply: j.content?.[0]?.text || 'No response', tokens: (j.usage?.input_tokens||0) + (j.usage?.output_tokens||0) };
    } else if (provKey === 'gemini') {
      const gModel = actualModel.replace('google/', '');
      const safeModel = gModel.replace(/[^a-zA-Z0-9._-]/g, '');
      const r = safeExec(`curl -s -X POST 'https://generativelanguage.googleapis.com/v1beta/models/${safeModel}:generateContent?key='${shellEsc(apiKey)} -H 'content-type: application/json' -d '${JSON.stringify({contents:messages.map(m=>({role:m.role==='assistant'?'model':'user',parts:[{text:m.content}]}))}).replace(/'/g,"'\\''")}'`, 60000);
      if (!r) return { ok: false, error: 'Empty response' };
      const j = JSON.parse(r);
      if (j.error) return { ok: false, error: j.error.message || 'API error' };
      return { ok: true, reply: j.candidates?.[0]?.content?.parts?.[0]?.text || 'No response', tokens: j.usageMetadata?.totalTokenCount || 0 };
    } else {
      const baseUrl = getProviderBaseUrl(provKey);
      const r = safeExec(`curl -s -X POST '${baseUrl}/chat/completions' -H 'Authorization: Bearer '${shellEsc(apiKey)} -H 'content-type: application/json' -d '${JSON.stringify({model:actualModel,messages,max_tokens:1024}).replace(/'/g,"'\\''")}'`, 60000);
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

// --- SVG Icons (Lucide-inspired, currentColor for theme adaptation) ---
const _i = (d, fill) => `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="${fill||'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICONS = {
  // Navigation
  sparkles: _i('<path d="M12 3l1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5z"/><path d="M18 2l.5 2 2 .5-2 .5L18 7l-.5-2-2-.5 2-.5z"/>'),
  refresh: _i('<path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>'),
  robot: _i('<rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><circle cx="8" cy="16" r="1"/><circle cx="16" cy="16" r="1"/>'),
  mail: _i('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>'),
  messageCircle: _i('<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>'),
  key: _i('<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>'),
  globe: _i('<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>'),
  fox: _i('<path d="M18 2l-3 8h6l-1 4-3 6h-2l-3-5-3 5H7l-3-6-1-4h6L6 2"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/>'),
  puzzle: _i('<path d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704L4.23 8.77c.24-.24.581-.353.917-.303.515.077.877.528 1.073 1.01a2.5 2.5 0 1 0 3.259-3.259c-.482-.196-.933-.558-1.01-1.073-.05-.336.062-.676.303-.917l1.525-1.525A2.402 2.402 0 0 1 12 1.998c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.878.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.968 1.02z"/>'),
  zap: _i('<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>'),
  wrench: _i('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>'),
  smartphone: _i('<rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><path d="M12 18h.01"/>'),
  barChart: _i('<path d="M12 20V10"/><path d="M18 20V4"/><path d="M6 20v-4"/>'),
  fileText: _i('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>'),
  circleDot: _i('<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3" fill="currentColor"/>'),
  stethoscope: _i('<path d="M4.8 2.62L3 5.04V11a2 2 0 0 0 4 0V5.04L5.2 2.62"/><path d="M2 5h5"/><path d="M7 12v1a4 4 0 0 1-4 4"/><path d="M3 17v.01"/><circle cx="18" cy="16" r="3"/><path d="M18 13V7"/><circle cx="18" cy="5" r="1"/>'),
  users: _i('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
  package: _i('<path d="M16.5 9.4l-9-5.19"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>'),
  arrowUp: _i('<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>'),
  // Provider icons
  anthropic: _i('<path d="M17.17 3.5H14.4l-6.48 17h2.77l1.63-4.42h6.54L20.5 20.5h2.77L17.17 3.5zm-3.82 10.29L15.8 7.05l2.46 6.74h-4.92z" fill="currentColor" stroke="none"/>', 'currentColor'),
  openai: _i('<path d="M20.63 8.22a5.22 5.22 0 0 0-.75-5.17A5.3 5.3 0 0 0 14.2.78a5.26 5.26 0 0 0-4.01 1.88A5.24 5.24 0 0 0 6.66 1.5a5.29 5.29 0 0 0-5.04 3.65 5.26 5.26 0 0 0-.72 5.17A5.22 5.22 0 0 0 1.65 15.5a5.29 5.29 0 0 0 5.68 2.28A5.26 5.26 0 0 0 11.34 19.65a5.29 5.29 0 0 0 5.04-3.65 5.24 5.24 0 0 0 3.53 1.16 5.29 5.29 0 0 0 5.04-3.65 5.22 5.22 0 0 0-4.32-5.29z" fill="none"/><path d="M12 8v8m-4-6l4-2 4 2m-8 4l4 2 4-2"/>'),
  gemini: _i('<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10c1.85 0 3.58-.5 5.07-1.38" stroke="none" fill="currentColor" opacity=".15"/><path d="M12 2a10 10 0 0 1 0 20 10 10 0 0 1 0-20" fill="none"/><path d="M12 2c3 3.6 3 14.4 0 20M12 2c-3 3.6-3 14.4 0 20"/>'),
  xai: _i('<path d="M4 4l16 16M20 4l-9.5 9.5M10.5 19l-3-3" stroke-width="2.5"/>'),
  minimax: _i('<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>'),
  moonshot: _i('<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/>'),
  kimi: _i('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M9 10l2 2 4-4"/><path d="M6 16h12"/>'),
  zai: _i('<path d="M4 5h16"/><path d="M18 5L6 19"/><path d="M4 19h16"/>'),
  venice: _i('<path d="M12 3l-2 6h4l-2 6"/><circle cx="12" cy="19" r="2"/><path d="M5 8c0-3 3-5 7-5s7 2 7 5"/>'),
  xiaomi: _i('<rect x="2" y="6" width="20" height="14" rx="3"/><path d="M7 10v6"/><path d="M7 10h4v6"/><path d="M17 10v6"/><path d="M17 10h-4v6"/>'),
  nvidia: _i('<path d="M3 12c0-5 4-9 9-9s9 4 9 9-4 9-9 9-9-4-9-9z"/><path d="M9 8v8l6-4z" fill="currentColor"/>'),
  bedrock: _i('<path d="M19.43 12.98c.04-.32.07-.64.07-.98 0-.34-.03-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46a.5.5 0 0 0-.61-.22l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65A.49.49 0 0 0 14 2h-4a.49.49 0 0 0-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1a.49.49 0 0 0-.61.22l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.04.32-.07.65-.07.98s.03.66.07.98l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1c.23.09.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.65z"/><circle cx="12" cy="12" r="3"/>'),
  synthetic: _i('<path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2z"/>'),
  huggingface: _i('<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><circle cx="9" cy="10" r="1" fill="currentColor"/><circle cx="15" cy="10" r="1" fill="currentColor"/>'),
  opencode: _i('<path d="M12 2a5 5 0 0 1 5 5c0 2-1 3.5-3 4.5V14a2 2 0 0 1-4 0v-2.5C8 10.5 7 9 7 7a5 5 0 0 1 5-5z"/><path d="M8 18a4 4 0 0 0 8 0"/>'),
  qianfan: _i('<path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>'),
  openrouter: _i('<circle cx="12" cy="12" r="3"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4"/><path d="m4.93 4.93 2.83 2.83m8.48 8.48 2.83 2.83M4.93 19.07l2.83-2.83m8.48-8.48 2.83-2.83"/>'),
  vercel: _i('<path d="M12 2l10 18H2z" fill="currentColor" stroke="none"/>', 'currentColor'),
  cloudflare: _i('<path d="M19 11c.9 0 1.7.4 2.2 1H22a4 4 0 0 0-4-4c-.6 0-1.2.1-1.7.4A6 6 0 0 0 5 11c0 .2 0 .3.02.5A3.5 3.5 0 0 0 5.5 18h13a2.5 2.5 0 0 0 .5-4.95z"/>'),
  litellm: _i('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
  ollama: _i('<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/><circle cx="10" cy="7" r="1" fill="currentColor"/><circle cx="14" cy="7" r="1" fill="currentColor"/>'),
  vllm: _i('<path d="M12 2v6l3 3"/><path d="M9 11l3 3 3-3"/><rect x="4" y="16" width="16" height="4" rx="1"/><circle cx="8" cy="18" r="1" fill="currentColor"/><circle cx="12" cy="18" r="1" fill="currentColor"/>'),
  // Channel icons
  telegram: _i('<path d="M21.2 4.4L2.4 11.4c-.8.3-.8 1.1 0 1.4l4.3 1.6 1.7 5.3c.2.6.9.7 1.3.3l2.5-2.4 4.8 3.5c.5.4 1.3.1 1.4-.5L21.9 5.3c.2-.8-.4-1.2-.7-.9z"/><path d="M8.4 13.4l9-7.5"/>'),
  discord: _i('<path d="M9.09 12a.87.87 0 1 0 0 1.74.87.87 0 0 0 0-1.74zm5.82 0a.87.87 0 1 0 0 1.74.87.87 0 0 0 0-1.74z" fill="currentColor"/><path d="M19.54 5.03A16.1 16.1 0 0 0 15.56 4c-.17.32-.38.74-.52 1.07a15.3 15.3 0 0 0-6.08 0A12.7 12.7 0 0 0 8.44 4a16.06 16.06 0 0 0-3.98 1.03C1.75 9.14.87 13.15 1.31 17.1a16.2 16.2 0 0 0 5.02 2.59c.4-.56.76-1.16 1.07-1.78a10.23 10.23 0 0 1-1.69-.83c.14-.1.28-.21.41-.32a11.54 11.54 0 0 0 9.76 0c.14.11.27.22.41.32-.54.33-1.1.6-1.69.83.31.62.67 1.22 1.07 1.78a16.17 16.17 0 0 0 5.02-2.59c.52-4.56-.88-8.53-3.65-12.07z"/>'),
  slack: _i('<path d="M14.5 2c-.83 0-1.5.67-1.5 1.5V7h3.5c.83 0 1.5-.67 1.5-1.5S17.33 4 16.5 4h-2V2zm0 0c-.83 0-1.5.67-1.5 1.5" stroke="none" fill="none"/><rect x="13" y="2" width="3" height="5" rx="1.5"/><rect x="18" y="9" width="4" height="3" rx="1.5"/><rect x="8" y="2" width="3" height="5" rx="1.5" transform="rotate(90 9.5 4.5)"/><rect x="2" y="12" width="4" height="3" rx="1.5"/><rect x="8" y="17" width="3" height="5" rx="1.5"/><rect x="2" y="9" width="5" height="3" rx="1.5" transform="rotate(90 4.5 10.5)"/><rect x="13" y="17" width="3" height="5" rx="1.5"/><rect x="17" y="12" width="5" height="3" rx="1.5" transform="rotate(90 19.5 13.5)"/>'),
  zalo: _i('<path d="M21 12a9 9 0 0 1-13.46 7.82L3 21l1.18-4.54A9 9 0 1 1 21 12z"/><path d="M8 10h2l1 4 2-6 1 4h2"/>'),
  // Card title / action icons
  check: _i('<polyline points="20 6 9 17 4 12"/>'),
  plus: _i('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
  link: _i('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
  lock: _i('<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
  monitor: _i('<rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>'),
  shield: _i('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'),
  download: _i('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'),
  upload: _i('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>'),
  clipboard: _i('<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>'),
  folder: _i('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>'),
  calendar: _i('<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>'),
  trendingUp: _i('<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>'),
  save: _i('<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>'),
  search: _i('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
  warning: _i('<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
  headphones: _i('<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zm-18 0a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>'),
  party: _i('<path d="M5.8 11.3L2 22l10.7-3.79"/><path d="M4 3h.01"/><path d="M22 8h.01"/><path d="M15 2h.01"/><path d="M22 20h.01"/><path d="m22 2-2.24.75a2.9 2.9 0 0 0-1.96 1.96L17.05 7l2.24-.75a2.9 2.9 0 0 0 1.96-1.96z"/><path d="m22 13-.76 2.27a2.9 2.9 0 0 1-1.96 1.96L17.05 18l.75-2.24a2.9 2.9 0 0 1 1.96-1.96z"/><path d="m8 2 .75 2.24a2.9 2.9 0 0 0 1.96 1.96L13 7l-.75-2.24a2.9 2.9 0 0 0-1.96-1.96z"/>'),
  code: _i('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>'),
  settings: _i('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  rocket: _i('<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>'),
  star: _i('<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>'),
  chain: _i('<path d="M13.828 10.172a4 4 0 0 0-5.656 0l-4 4a4 4 0 1 0 5.656 5.656l1.102-1.101"/><path d="M10.172 13.828a4 4 0 0 0 5.656 0l4-4a4 4 0 0 0-5.656-5.656l-1.1 1.1"/>'),
  file: _i('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>'),
  lockOpen: _i('<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>'),
  play: _i('<polygon points="5 3 19 12 5 21 5 3"/>'),
  trash: _i('<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>'),
  refreshCw: _i('<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>'),
};

// --- Provider configs ---
// Category: 'cloud' = Cloud API, 'gateway' = Gateway/Proxy, 'local' = Self-hosted
const PROVIDERS = {
  // ====== CLOUD PROVIDERS ======
  anthropic: {
    name: 'Anthropic', envKey: 'ANTHROPIC_API_KEY', configFile: `${CONFIG_DIR}/anthropic.json`,
    color: '#d97706', icon: ICONS.anthropic, category: 'cloud',
    models: [
      { id: 'anthropic/claude-opus-4-6', name: 'Claude Opus 4.6', desc: 'Flagship — smartest' },
      { id: 'anthropic/claude-sonnet-4-6', name: 'Claude Sonnet 4.6', desc: 'Latest — balanced & fast' },
      { id: 'anthropic/claude-haiku-4-5', name: 'Claude Haiku 4.5', desc: 'Fastest — low cost' },
      { id: 'anthropic/claude-sonnet-4-5', name: 'Claude Sonnet 4.5', desc: 'Previous gen — balanced' },
      { id: 'anthropic/claude-opus-4-5', name: 'Claude Opus 4.5', desc: 'Previous gen — powerful' },
      { id: 'anthropic/claude-sonnet-4-20250514', name: 'Claude Sonnet 4', desc: 'Legacy — stable' }
    ],
    testFn: (k) => { try { return safeExec(`curl -s -o /dev/null -w '%{http_code}' -X POST https://api.anthropic.com/v1/messages -H 'x-api-key: ${k.replace(/'/g,"'\\''")}' -H 'anthropic-version: 2023-06-01' -H 'content-type: application/json' -d '{"model":"claude-haiku-4-5","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}'`, 15000) === '200'; } catch { return false; } }
  },
  openai: {
    name: 'OpenAI', envKey: 'OPENAI_API_KEY', configFile: `${CONFIG_DIR}/openai.json`,
    color: '#10a37f', icon: ICONS.openai, category: 'cloud',
    models: [
      { id: 'openai/o4-mini', name: 'o4-mini', desc: 'Reasoning — fast & cheap' },
      { id: 'openai/gpt-4.1', name: 'GPT-4.1', desc: 'Balanced — fast' },
      { id: 'openai/gpt-4.1-mini', name: 'GPT-4.1 Mini', desc: 'Lightweight — low cost' },
      { id: 'openai/o4', name: 'o4', desc: 'Reasoning — strongest' },
      { id: 'openai/gpt-5.1-codex', name: 'GPT-5.1 Codex', desc: 'Code + reasoning' },
      { id: 'openai/gpt-5.2', name: 'GPT-5.2', desc: 'Powerful — general purpose' }
    ],
    testFn: (k) => { try { return safeExec(`curl -s -o /dev/null -w '%{http_code}' https://api.openai.com/v1/models -H 'Authorization: Bearer ${k.replace(/'/g,"'\\''")}' `, 15000) === '200'; } catch { return false; } }
  },
  gemini: {
    name: 'Google Gemini', envKey: 'GOOGLE_API_KEY', configFile: `${CONFIG_DIR}/gemini.json`,
    color: '#4285f4', icon: ICONS.gemini, category: 'cloud',
    models: [
      { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro', desc: 'Flagship — reasoning & coding' },
      { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash', desc: 'Balanced — fast thinking' },
      { id: 'google/gemini-2.0-flash', name: 'Gemini 2.0 Flash', desc: 'Speed — low latency' },
      { id: 'google/gemini-2.0-flash-lite', name: 'Gemini 2.0 Flash Lite', desc: 'Lightweight — cost efficient' }
    ],
    testFn: (k) => { try { return safeExec(`curl -s -o /dev/null -w '%{http_code}' 'https://generativelanguage.googleapis.com/v1beta/models?key='${shellEsc(k)}`, 15000) === '200'; } catch { return false; } }
  },
  xai: {
    name: 'xAI (Grok)', envKey: 'XAI_API_KEY', configFile: `${CONFIG_DIR}/openai.json`,
    color: '#1d1d1f', icon: ICONS.xai, category: 'cloud',
    models: [
      { id: 'xai/grok-4-1-fast-reasoning', name: 'Grok 4.1 Fast', desc: 'Reasoning — 2M context' },
      { id: 'xai/grok-4-1-fast-non-reasoning', name: 'Grok 4.1 Instant', desc: 'Non-reasoning — 2M context' },
      { id: 'xai/grok-4-fast-reasoning', name: 'Grok 4 Fast', desc: 'Reasoning — fast' },
      { id: 'xai/grok-4-fast-non-reasoning', name: 'Grok 4 Instant', desc: 'Non-reasoning — fast' },
      { id: 'xai/grok-4-0709', name: 'Grok 4', desc: 'Flagship — strongest reasoning' },
      { id: 'xai/grok-3', name: 'Grok 3', desc: 'Stable — 131K context' },
      { id: 'xai/grok-3-mini', name: 'Grok 3 Mini', desc: 'Light reasoning — low cost' },
      { id: 'xai/grok-code-fast-1', name: 'Grok Code', desc: 'Code optimized — 256K context' }
    ],
    testFn: (k) => { try { return safeExec(`curl -s -o /dev/null -w '%{http_code}' https://api.x.ai/v1/models -H 'Authorization: Bearer ${k.replace(/'/g,"'\\''")}' `, 15000) === '200'; } catch { return false; } }
  },
  minimax: {
    name: 'MiniMax', envKey: 'MINIMAX_API_KEY', configFile: `${CONFIG_DIR}/anthropic.json`,
    color: '#6366f1', icon: ICONS.minimax, category: 'cloud',
    models: [
      { id: 'minimax/MiniMax-M2.5', name: 'MiniMax M2.5', desc: 'Latest — most capable' },
      { id: 'minimax/MiniMax-M2.1', name: 'MiniMax M2.1', desc: 'Balanced — reliable' },
      { id: 'minimax/MiniMax-M2.1-lightning', name: 'M2.1 Lightning', desc: 'Fast — low latency' },
      { id: 'minimax/MiniMax-M2', name: 'MiniMax M2', desc: 'Base — cost efficient' }
    ],
    testFn: (k) => { try { const r = safeExec(`curl -s -o /dev/null -w '%{http_code}' -X POST https://api.minimax.io/anthropic/v1/messages -H 'x-api-key: ${k.replace(/'/g,"'\\''")}' -H 'anthropic-version: 2023-06-01' -H 'content-type: application/json' -d '{"model":"MiniMax-M2.1","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}'`, 15000); return r === '200' || r === '402'; } catch { return false; } }
  },
  moonshot: {
    name: 'Moonshot AI', envKey: 'MOONSHOT_API_KEY', configFile: `${CONFIG_DIR}/openai.json`,
    color: '#7c3aed', icon: ICONS.moonshot, category: 'cloud',
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
    color: '#8b5cf6', icon: ICONS.kimi, category: 'cloud',
    models: [
      { id: 'kimi-coding/kimi-k2.5', name: 'Kimi K2.5', desc: 'Latest — code optimized' },
      { id: 'kimi-coding/kimi-k2-thinking', name: 'Kimi K2 Thinking', desc: 'Reasoning — deep thinking' },
      { id: 'kimi-coding/kimi-k2-thinking-turbo', name: 'K2 Thinking Turbo', desc: 'Fast reasoning' }
    ],
    testFn: (k) => { try { return safeExec(`curl -s -o /dev/null -w '%{http_code}' https://api.moonshot.ai/v1/models -H 'Authorization: Bearer ${k.replace(/'/g,"'\\''")}' `, 15000) === '200'; } catch { return false; } }
  },
  zai: {
    name: 'Z.AI (GLM)', envKey: 'ZAI_API_KEY', configFile: `${CONFIG_DIR}/openai.json`,
    color: '#0ea5e9', icon: ICONS.zai, category: 'cloud',
    models: [
      { id: 'zai/glm-5', name: 'GLM-5', desc: 'Flagship — most powerful' },
      { id: 'zai/glm-4.7', name: 'GLM-4.7', desc: 'Balanced — reasoning' },
      { id: 'zai/glm-4.7-flash', name: 'GLM-4.7 Flash', desc: 'Fast — reasoning' },
      { id: 'zai/glm-4.7-flashx', name: 'GLM-4.7 FlashX', desc: 'Fastest — low cost' }
    ],
    testFn: (k) => { try { const r = safeExec(`curl -s -o /dev/null -w '%{http_code}' -X POST https://api.z.ai/api/paas/v4/chat/completions -H 'Authorization: Bearer ${k.replace(/'/g,"'\\''")}' -H 'Content-Type: application/json' -d '{"model":"glm-4.7-flash","messages":[{"role":"user","content":"hi"}],"max_tokens":1}'`, 15000); return r === '200' || r === '429'; } catch { return false; } }
  },
  venice: {
    name: 'Venice AI', envKey: 'VENICE_API_KEY', configFile: `${CONFIG_DIR}/openai.json`,
    color: '#f43f5e', icon: ICONS.venice, category: 'cloud',
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
    name: 'Xiaomi MiMo', envKey: 'XIAOMI_API_KEY', configFile: `${CONFIG_DIR}/anthropic.json`,
    color: '#ff6900', icon: ICONS.xiaomi, category: 'cloud',
    models: [
      { id: 'xiaomi/mimo-v2-flash', name: 'MiMo V2 Flash', desc: '262K context — fast' }
    ],
    testFn: (k) => { try { const r = safeExec(`curl -s -o /dev/null -w '%{http_code}' -X POST https://api.xiaomimimo.com/anthropic/v1/messages -H 'x-api-key: ${k.replace(/'/g,"'\\''")}' -H 'anthropic-version: 2023-06-01' -H 'content-type: application/json' -d '{"model":"mimo-v2-flash","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}'`, 15000); return r === '200'; } catch { return false; } }
  },
  nvidia: {
    name: 'NVIDIA', envKey: 'NVIDIA_API_KEY', configFile: `${CONFIG_DIR}/openai.json`,
    color: '#76b900', icon: ICONS.nvidia, category: 'cloud',
    models: [
      { id: 'nvidia/nvidia/llama-3.1-nemotron-ultra-253b-v1', name: 'Nemotron Ultra 253B', desc: 'Flagship — strongest reasoning' },
      { id: 'nvidia/meta/llama-3.3-70b-instruct', name: 'Llama 3.3 70B', desc: 'Meta — balanced' },
      { id: 'nvidia/nvidia/llama-3.3-nemotron-super-49b-v1', name: 'Nemotron Super 49B', desc: 'Balanced reasoning' },
      { id: 'nvidia/meta/llama-4-maverick-17b-128e-instruct', name: 'Llama 4 Maverick', desc: 'Meta — 128 experts MoE' },
      { id: 'nvidia/meta/llama-4-scout-17b-16e-instruct', name: 'Llama 4 Scout', desc: 'Meta — 16 experts MoE' },
      { id: 'nvidia/nvidia/llama-3.1-nemotron-nano-4b-v1.1', name: 'Nemotron Nano 4B', desc: 'Lightweight — edge' },
      { id: 'nvidia/deepseek-ai/deepseek-v3.2', name: 'DeepSeek V3.2', desc: 'Powerful — open source' }
    ],
    testFn: (k) => { try { const r = safeExec(`curl -s -o /dev/null -w '%{http_code}' -X POST https://integrate.api.nvidia.com/v1/chat/completions -H 'Authorization: Bearer ${k.replace(/'/g,"'\\''")}' -H 'Content-Type: application/json' -d '{"model":"meta/llama-3.3-70b-instruct","messages":[{"role":"user","content":"hi"}],"max_tokens":1}'`, 15000); return r === '200'; } catch { return false; } }
  },
  bedrock: {
    name: 'Amazon Bedrock', envKey: 'AWS_ACCESS_KEY_ID', configFile: `${CONFIG_DIR}/anthropic.json`,
    color: '#ff9900', icon: ICONS.bedrock, category: 'cloud',
    keyLabel: 'Access Key ID',
    keyPlaceholder: 'e.g. AKIA...',
    extraEnvKeys: ['AWS_SECRET_ACCESS_KEY', 'AWS_REGION'],
    extraEnvLabels: { 'AWS_SECRET_ACCESS_KEY': 'Secret Access Key', 'AWS_REGION': 'AWS Region' },
    extraEnvPlaceholders: { 'AWS_SECRET_ACCESS_KEY': 'e.g. U6Rj...', 'AWS_REGION': 'e.g. us-east-1, ap-southeast-1' },
    models: [
      { id: 'amazon-bedrock/anthropic.claude-opus-4-6-v1', name: 'Claude Opus 4.6', desc: 'Flagship — strongest' },
      { id: 'amazon-bedrock/anthropic.claude-sonnet-4-6', name: 'Claude Sonnet 4.6', desc: 'Latest — balanced' },
      { id: 'amazon-bedrock/anthropic.claude-sonnet-4-20250514-v1:0', name: 'Claude Sonnet 4', desc: 'Stable — balanced' },
      { id: 'amazon-bedrock/anthropic.claude-opus-4-5-20251101-v1:0', name: 'Claude Opus 4.5', desc: 'Previous flagship' },
      { id: 'amazon-bedrock/anthropic.claude-sonnet-4-5-20250929-v1:0', name: 'Claude Sonnet 4.5', desc: 'Previous balanced' },
      { id: 'amazon-bedrock/anthropic.claude-haiku-4-5-20251001-v1:0', name: 'Claude Haiku 4.5', desc: 'Fast — low cost' },
      { id: 'amazon-bedrock/anthropic.claude-3-7-sonnet-20250219-v1:0', name: 'Claude 3.7 Sonnet', desc: 'Legacy — reasoning' }
    ],
    testFn: (k) => { try { const secret = getEnvValue('AWS_SECRET_ACCESS_KEY'); const region = getEnvValue('AWS_REGION') || 'us-east-1'; if (!k || !secret) return false; const r = spawnSync('node', ['-e', 'const{BedrockClient,ListFoundationModelsCommand}=require("@aws-sdk/client-bedrock");new BedrockClient({region:process.env._R,credentials:{accessKeyId:process.env._K,secretAccessKey:process.env._S}}).send(new ListFoundationModelsCommand({})).then(()=>console.log("OK")).catch(e=>console.error(e.name))'], { cwd: OPENCLAW_DIR, env: { ...process.env, _R: region, _K: k, _S: secret }, timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }); return (r.stdout || '').toString().trim() === 'OK'; } catch { return false; } }
  },
  synthetic: {
    name: 'Synthetic', envKey: 'SYNTHETIC_API_KEY', configFile: `${CONFIG_DIR}/anthropic.json`,
    color: '#a855f7', icon: ICONS.synthetic, category: 'cloud',
    models: [
      { id: 'synthetic/hf:nvidia/Kimi-K2.5-NVFP4', name: 'Kimi K2.5 NVFP4', desc: 'Reasoning — multimodal' },
      { id: 'synthetic/hf:Qwen/Qwen3.5-397B-A17B', name: 'Qwen 3.5 397B', desc: 'Reasoning — multimodal' },
      { id: 'synthetic/hf:MiniMaxAI/MiniMax-M2.5', name: 'MiniMax M2.5', desc: 'Multimodal — latest' },
      { id: 'synthetic/hf:MiniMaxAI/MiniMax-M2.1', name: 'MiniMax M2.1', desc: 'Balanced — 192K context' },
      { id: 'synthetic/hf:moonshotai/Kimi-K2.5', name: 'Kimi K2.5', desc: 'Multimodal — reasoning' },
      { id: 'synthetic/hf:moonshotai/Kimi-K2-Thinking', name: 'Kimi K2 Thinking', desc: 'Deep reasoning' },
      { id: 'synthetic/hf:deepseek-ai/DeepSeek-V3.2', name: 'DeepSeek V3.2', desc: 'Open source — powerful' },
      { id: 'synthetic/hf:deepseek-ai/DeepSeek-R1-0528', name: 'DeepSeek R1', desc: 'Reasoning — open source' },
      { id: 'synthetic/hf:Qwen/Qwen3-Coder-480B-A35B-Instruct', name: 'Qwen3 Coder 480B', desc: 'Code specialist' },
      { id: 'synthetic/hf:Qwen/Qwen3-235B-A22B-Thinking-2507', name: 'Qwen3 235B Thinking', desc: 'Reasoning — 256K' },
      { id: 'synthetic/hf:zai-org/GLM-4.7', name: 'GLM-4.7', desc: '128K output' },
      { id: 'synthetic/hf:openai/gpt-oss-120b', name: 'GPT-OSS 120B', desc: 'Open source GPT' },
      { id: 'synthetic/hf:meta-llama/Llama-3.3-70B-Instruct', name: 'Llama 3.3 70B', desc: 'Meta — balanced' }
    ],
    testFn: (k) => { try { const r = safeExec(`curl -s -o /dev/null -w '%{http_code}' -X POST https://api.synthetic.new/anthropic/v1/messages -H 'x-api-key: ${k.replace(/'/g,"'\\''")}' -H 'anthropic-version: 2023-06-01' -H 'content-type: application/json' -d '{"model":"hf:MiniMaxAI/MiniMax-M2.1","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}'`, 15000); return r === '200' || r === '402'; } catch { return false; } }
  },
  huggingface: {
    name: 'Hugging Face', envKey: 'HF_TOKEN', configFile: `${CONFIG_DIR}/openai.json`,
    color: '#ff9d00', icon: ICONS.huggingface, category: 'cloud',
    models: [
      { id: 'huggingface/deepseek-ai/DeepSeek-R1', name: 'DeepSeek R1', desc: 'Reasoning — open source' },
      { id: 'huggingface/deepseek-ai/DeepSeek-V3.2', name: 'DeepSeek V3.2', desc: 'Powerful — open source' },
      { id: 'huggingface/meta-llama/Llama-3.3-70B-Instruct', name: 'Llama 3.3 70B', desc: 'Meta — balanced' },
      { id: 'huggingface/openai/gpt-oss-120b', name: 'GPT-OSS 120B', desc: 'Open source GPT' },
      { id: 'huggingface/Qwen/Qwen3-8B', name: 'Qwen3 8B', desc: 'Small — fast' }
    ],
    testFn: (k) => { try { return safeExec(`curl -s -o /dev/null -w '%{http_code}' https://router.huggingface.co/v1/models -H 'Authorization: Bearer ${k.replace(/'/g,"'\\''")}' `, 15000) === '200'; } catch { return false; } }
  },
  opencode: {
    name: 'OpenCode Zen', envKey: 'OPENCODE_API_KEY', configFile: `${CONFIG_DIR}/openai.json`,
    color: '#14b8a6', icon: ICONS.opencode, category: 'cloud',
    models: [
      { id: 'opencode/claude-opus-4-6', name: 'Claude Opus 4.6', desc: 'Anthropic via OpenCode' }
    ],
    testFn: (k) => { try { return !!k && k.length > 10; } catch { return false; } }
  },
  qianfan: {
    name: 'Qianfan (Baidu)', envKey: 'QIANFAN_API_KEY', configFile: `${CONFIG_DIR}/openai.json`,
    color: '#2563eb', icon: ICONS.qianfan, category: 'cloud',
    models: [
      { id: 'qianfan/ernie-4.5-turbo-128k', name: 'ERNIE 4.5 Turbo', desc: 'Baidu — flagship' }
    ],
    testFn: (k) => { try { return !!k && k.startsWith('bce-v3/'); } catch { return false; } }
  },

  // ====== GATEWAY / PROXY PROVIDERS ======
  openrouter: {
    name: 'OpenRouter', envKey: 'OPENROUTER_API_KEY', configFile: `${CONFIG_DIR}/openai.json`,
    color: '#6d28d9', icon: ICONS.openrouter, category: 'gateway',
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
    color: '#000000', icon: ICONS.vercel, category: 'gateway',
    models: [
      { id: 'vercel-ai-gateway/anthropic/claude-opus-4.6', name: 'Claude Opus 4.6', desc: 'Anthropic via Vercel' },
      { id: 'vercel-ai-gateway/openai/gpt-5.2', name: 'GPT-5.2', desc: 'OpenAI via Vercel' }
    ],
    testFn: (k) => { try { return !!k && k.length > 10; } catch { return false; } }
  },
  'cloudflare-ai-gateway': {
    name: 'Cloudflare AI Gateway', envKey: 'CLOUDFLARE_AI_GATEWAY_API_KEY', configFile: `${CONFIG_DIR}/anthropic.json`,
    color: '#f38020', icon: ICONS.cloudflare, category: 'gateway',
    keyLabel: 'Anthropic API Key',
    keyPlaceholder: 'sk-ant-... (key proxied through Cloudflare)',
    extraEnvKeys: ['CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID', 'CLOUDFLARE_AI_GATEWAY_GATEWAY_ID'],
    extraEnvLabels: { 'CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID': 'Account ID', 'CLOUDFLARE_AI_GATEWAY_GATEWAY_ID': 'Gateway ID' },
    extraEnvPlaceholders: { 'CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID': 'e.g. abc123def456', 'CLOUDFLARE_AI_GATEWAY_GATEWAY_ID': 'e.g. my-gateway' },
    models: [
      { id: 'cloudflare-ai-gateway/claude-sonnet-4-6', name: 'Claude Sonnet 4.6', desc: 'Latest — balanced & fast' },
      { id: 'cloudflare-ai-gateway/claude-sonnet-4-5', name: 'Claude Sonnet 4.5', desc: 'Default — balanced' },
      { id: 'cloudflare-ai-gateway/claude-opus-4-6', name: 'Claude Opus 4.6', desc: 'Flagship — smartest' },
      { id: 'cloudflare-ai-gateway/claude-haiku-4-5', name: 'Claude Haiku 4.5', desc: 'Fastest — low cost' },
      { id: 'cloudflare-ai-gateway/claude-opus-4-5', name: 'Claude Opus 4.5', desc: 'Previous gen — powerful' }
    ],
    testFn: (k, extra) => { try { const acct = (extra && extra.CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID) || getEnvValue('CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID') || ''; const gw = (extra && extra.CLOUDFLARE_AI_GATEWAY_GATEWAY_ID) || getEnvValue('CLOUDFLARE_AI_GATEWAY_GATEWAY_ID') || ''; if (!acct || !gw) return false; const r = safeExec(`curl -s -o /dev/null -w '%{http_code}' -X POST 'https://gateway.ai.cloudflare.com/v1/'${shellEsc(acct.trim())}'/'${shellEsc(gw.trim())}'/anthropic/v1/messages' -H 'x-api-key: '${shellEsc(k)} -H 'anthropic-version: 2023-06-01' -H 'content-type: application/json' -d '{"model":"claude-haiku-4-5","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}'`, 15000); return r === '200'; } catch { return false; } }
  },
  litellm: {
    name: 'LiteLLM Proxy', envKey: 'LITELLM_API_KEY', configFile: `${CONFIG_DIR}/openai.json`,
    color: '#059669', icon: ICONS.litellm, category: 'gateway',
    models: [
      { id: 'litellm/claude-opus-4-6', name: 'Claude Opus 4.6', desc: 'Via LiteLLM Proxy' },
      { id: 'litellm/gpt-4o', name: 'GPT-4o', desc: 'OpenAI via LiteLLM' }
    ],
    testFn: (k) => { try { return safeExec(`curl -s -o /dev/null -w '%{http_code}' http://localhost:4000/v1/models -H 'Authorization: Bearer ${k.replace(/'/g,"'\\''")}' `, 10000) === '200'; } catch { return false; } }
  },

  // ====== SELF-HOSTED / LOCAL PROVIDERS ======
  ollama: {
    name: 'Ollama', envKey: 'OLLAMA_API_KEY', configFile: `${CONFIG_DIR}/openai.json`,
    color: '#333333', icon: ICONS.ollama, category: 'local',
    models: [
      { id: 'ollama/llama3.3', name: 'Llama 3.3', desc: 'Meta — local' },
      { id: 'ollama/gpt-oss:20b', name: 'GPT-OSS 20B', desc: 'OpenAI OSS — local' },
      { id: 'ollama/qwen3:8b', name: 'Qwen3 8B', desc: 'Alibaba — small' }
    ],
    testFn: (k) => { try { return safeExec(`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:11434/api/tags`, 10000) === '200'; } catch { return false; } }
  },
  vllm: {
    name: 'vLLM', envKey: 'VLLM_API_KEY', configFile: `${CONFIG_DIR}/openai.json`,
    color: '#475569', icon: ICONS.vllm, category: 'local',
    models: [
      { id: 'vllm/your-model-id', name: 'Custom Model', desc: 'OpenAI-compatible local' }
    ],
    testFn: (k) => { try { return safeExec(`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8000/v1/models`, 10000) === '200'; } catch { return false; } }
  }
};

// --- Channel configs ---
const CHANNELS = {
  telegram: { name: 'Telegram', icon: ICONS.telegram, envKeys: ['TELEGRAM_BOT_TOKEN'], envLabels: { TELEGRAM_BOT_TOKEN: 'Bot Token' }, envPlaceholders: { TELEGRAM_BOT_TOKEN: 'e.g. 123456:ABC-DEF...' }, pairCmd: 'telegram', desc: 'Create bot via @BotFather on Telegram', canPair: true, isBuiltin: true,
    testFn: (tokens) => { try { const t = tokens.TELEGRAM_BOT_TOKEN; if (!t) return false; return safeExec(`curl -s -o /dev/null -w '%{http_code}' 'https://api.telegram.org/bot'${shellEsc(t)}'/getMe'`, 15000) === '200'; } catch { return false; } } },
  discord: { name: 'Discord', icon: ICONS.discord, envKeys: ['DISCORD_BOT_TOKEN'], envLabels: { DISCORD_BOT_TOKEN: 'Bot Token' }, envPlaceholders: { DISCORD_BOT_TOKEN: 'e.g. MTQ3NTg...' }, pairCmd: 'discord', desc: 'Create bot at discord.com/developers', canPair: true, isBuiltin: true,
    testFn: (tokens) => { try { const t = tokens.DISCORD_BOT_TOKEN; if (!t) return false; return safeExec(`curl -s -o /dev/null -w '%{http_code}' https://discord.com/api/v10/users/@me -H 'Authorization: Bot ${t.replace(/'/g,"'\\''")}'`, 15000) === '200'; } catch { return false; } } },
  slack: { name: 'Slack', icon: ICONS.slack, envKeys: ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'], envLabels: { SLACK_BOT_TOKEN: 'Bot Token (xoxb-...)', SLACK_APP_TOKEN: 'App Token (xapp-...)' }, envPlaceholders: { SLACK_BOT_TOKEN: 'xoxb-...', SLACK_APP_TOKEN: 'xapp-...' }, pairCmd: 'slack', desc: 'Create app at api.slack.com/apps', canPair: true, isBuiltin: true,
    testFn: (tokens) => { try { const t = tokens.SLACK_BOT_TOKEN; const a = tokens.SLACK_APP_TOKEN; if (!t || !a) return false; if (!a.startsWith('xapp-')) return false; return safeExec(`curl -s -o /dev/null -w '%{http_code}' https://slack.com/api/auth.test -H 'Authorization: Bearer ${t.replace(/'/g,"'\\''")}'`, 15000) === '200'; } catch { return false; } } },
  zalo: { name: 'Zalo', icon: ICONS.zalo, envKeys: ['ZALO_BOT_TOKEN'], envLabels: { ZALO_BOT_TOKEN: 'Bot Token' }, envPlaceholders: { ZALO_BOT_TOKEN: 'Token from bot.zaloplatforms.com' }, pairCmd: 'zalo', desc: 'Create bot at bot.zaloplatforms.com', canPair: true, isBuiltin: true }
};


// --- CSS ---
const CSS = `
:root{--bg:#f4f6fb;--sidebar-bg:#111318;--sidebar-w:250px;--card-bg:#fff;--accent:#4285f4;--accent2:#34a853;--text:#1a1a2e;--text2:#5f6368;--border:#e8eaed;--danger:#ea4335;--warn:#fbbc05;--radius:16px}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',Roboto,-apple-system,BlinkMacSystemFont,sans-serif;background:#f4f6fb;color:var(--text);min-height:100vh;display:flex;transition:background-color .3s ease,color .3s ease}

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
.nav-item .nav-icon{font-size:16px;width:22px;text-align:center;flex-shrink:0;display:inline-flex;align-items:center;justify-content:center}
.nav-icon svg{width:18px;height:18px}
.ct-icon{display:inline-flex;align-items:center} .ct-icon svg{width:20px;height:20px}
.prov-card-icon svg{width:28px;height:28px}
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

/* Panel Footer */
.panel-footer{margin-top:auto;text-align:center;padding:32px 0 12px;font-size:12px;color:var(--text2)}
.panel-footer a{color:var(--accent);text-decoration:none;font-weight:600}
.panel-footer a:hover{text-decoration:underline}

/* Main */
.main{margin-left:var(--sidebar-w);flex:1;padding:32px 36px;min-height:100vh;display:flex;flex-direction:column}
.page-title{font-size:26px;font-weight:800;margin-bottom:6px;color:var(--text);letter-spacing:-.3px;display:flex;align-items:center;gap:10px}
.page-title svg{width:28px;height:28px;flex-shrink:0}
.page-desc{font-size:14px;color:var(--text2);margin-bottom:28px;line-height:1.6}

/* Cards */
.card{background:linear-gradient(135deg,#ffffff 0%,#f9fafb 100%);border-radius:var(--radius);padding:32px;box-shadow:0 10px 40px rgba(0,0,0,.08);border:1px solid rgba(0,0,0,.06);margin-bottom:24px;position:relative;overflow:hidden;transition:background-color .3s ease,border-color .3s ease,box-shadow .3s ease}
.card::before{content:'';position:absolute;top:0;left:0;right:0;height:4px;background:linear-gradient(90deg,var(--accent),var(--accent2));opacity:.85}
.card-title{font-size:17px;font-weight:700;margin-bottom:18px;display:flex;align-items:center;gap:10px}
.card-title .ct-icon{font-size:20px}

/* Provider list */
/* Provider card icon */
.prov-card-icon{width:48px;height:48px;border-radius:14px;display:flex;align-items:center;justify-content:center;font-size:26px;flex-shrink:0;transition:transform .2s}
.skill-card:hover .prov-card-icon{transform:scale(1.08)}
/* Category badges */
.cat-cloud{background:#dbeafe;color:#1e40af}
.cat-gateway{background:#ede9fe;color:#6d28d9}
.cat-local{background:#fef3c7;color:#92400e}

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
.btn svg{width:16px;height:16px;flex-shrink:0}
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

/* Skeleton loading placeholder */
.skeleton{background:linear-gradient(90deg,var(--bg2) 25%,rgba(66,133,244,.08) 50%,var(--bg2) 75%);background-size:200% 100%;animation:skeleton-shimmer 1.5s ease infinite;border-radius:8px;min-height:20px}
@keyframes skeleton-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
.skeleton-text{height:14px;margin:8px 0;border-radius:4px}
.skeleton-block{height:60px;margin:8px 0}

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
.section{display:none;flex-shrink:0} .section.active{display:block}

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
.doc-btn .db-icon svg{width:22px;height:22px}
.doc-btn .db-info{flex:1} .doc-btn .db-title{font-size:14px;font-weight:700;color:var(--text)} .doc-btn .db-desc{font-size:12px;color:var(--text2);margin-top:3px}
.doc-summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:12px;margin-bottom:18px}
.doc-stat{text-align:center;padding:16px 10px;background:linear-gradient(135deg,#f8f9fa,#f0f4ff);border-radius:12px;border:1px solid var(--border)}
.doc-stat .ds-num{font-size:30px;font-weight:800;line-height:1} .doc-stat .ds-label{font-size:12px;color:var(--text2);margin-top:6px;font-weight:600}
.doc-checks{display:flex;flex-direction:column;gap:6px;max-height:400px;overflow-y:auto}
.doc-check{display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:10px;font-size:13px;border:1px solid var(--border);background:#fff}
.doc-check.pass{border-left:4px solid #22c55e} .doc-check.warn{border-left:4px solid #f59e0b} .doc-check.fail{border-left:4px solid #ef4444}
.doc-check .dc-icon{font-size:18px;flex-shrink:0;width:22px;text-align:center;display:flex;align-items:center;justify-content:center}
.doc-check .dc-icon svg{width:18px;height:18px} .doc-check .dc-text{flex:1;color:var(--text);font-weight:600} .doc-check .dc-detail{color:var(--text2);font-size:12px;max-width:50%;text-align:right}
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
body.dark .ch-item{background:var(--card-bg);border-color:var(--border)}
body.dark .ch-item.selected{background:#1a2a4a;border-color:var(--accent)}
body.dark .cat-cloud{background:rgba(37,99,235,.15);color:#93c5fd}
body.dark .cat-gateway{background:rgba(109,40,217,.15);color:#c4b5fd}
body.dark .cat-local{background:rgba(217,119,6,.15);color:#fcd34d}
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
body.dark .skeleton{background:linear-gradient(90deg,#1e293b 25%,#2a3a4e 50%,#1e293b 75%);background-size:200% 100%}
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
.empty-state .empty-icon svg{width:36px;height:36px}
.empty-state .empty-text{font-size:14px;line-height:1.6}

/* Toggle Switch */
.toggle-switch{position:relative;display:inline-block;width:42px;height:24px;flex-shrink:0}
.toggle-switch input{opacity:0;width:0;height:0}
.toggle-slider{position:absolute;cursor:pointer;inset:0;background:#cbd5e1;border-radius:24px;transition:all .3s ease}
.toggle-slider::before{content:'';position:absolute;height:18px;width:18px;left:3px;bottom:3px;background:#fff;border-radius:50%;transition:all .3s ease;box-shadow:0 1px 3px rgba(0,0,0,.15)}
.toggle-switch input:checked+.toggle-slider{background:linear-gradient(135deg,#4285f4,#34a853)}
.toggle-switch input:checked+.toggle-slider::before{transform:translateX(18px)}
.toggle-switch input:disabled+.toggle-slider{opacity:.4;cursor:not-allowed}

/* Stat Grid */
.stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin-bottom:18px}
.stat-card{padding:16px 12px;border-radius:12px;border:1px solid var(--border);background:linear-gradient(135deg,#f8f9fa,#f0f4ff);text-align:center;transition:all .3s ease}
.stat-card:hover{transform:translateY(-2px);box-shadow:0 6px 20px rgba(0,0,0,.06)}
.stat-card .stat-num{font-size:28px;font-weight:800;line-height:1;color:var(--text)}
.stat-card .stat-label{font-size:11px;color:var(--text2);margin-top:6px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;display:flex;align-items:center;justify-content:center;gap:4px}
.stat-card .stat-label svg{width:12px;height:12px}
.stat-card.green .stat-num{color:#16a34a} .stat-card.red .stat-num{color:#dc2626} .stat-card.amber .stat-num{color:#d97706} .stat-card.blue .stat-num{color:#2563eb}
.muted{color:var(--text2);font-size:13px}

/* Filter Pills */
.filter-pills{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}
.filter-pill{padding:6px 16px;border-radius:20px;font-size:13px;font-weight:600;border:2px solid var(--border);background:var(--card-bg);color:var(--text2);cursor:pointer;transition:all .2s ease;user-select:none;display:inline-flex;align-items:center;gap:6px}
.filter-pill svg{width:14px;height:14px}
.filter-pill:hover{border-color:var(--accent);color:var(--accent);background:rgba(66,133,244,.04)}
.filter-pill.active{background:var(--accent);color:#fff;border-color:var(--accent);box-shadow:0 2px 8px rgba(66,133,244,.25)}
.filter-pill .pill-count{font-size:11px;opacity:.7;margin-left:4px}

/* Skill/Plugin Card Grid */
.skill-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px}

/* Skill/Plugin Card */
.skill-card{border:2px solid var(--border);border-radius:14px;padding:18px;cursor:pointer;transition:all .3s ease;background:var(--card-bg);position:relative;overflow:hidden}
.skill-card:hover{border-color:var(--accent);transform:translateY(-2px);box-shadow:0 8px 25px rgba(66,133,244,.12)}
.skill-card.enabled{border-color:rgba(52,168,83,.35);background:linear-gradient(135deg,#f0fdf4,#ecfdf5)}
.skill-card.enabled::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,#34a853,#22c55e)}
.skill-card.disabled-card{opacity:.65}
.skill-card .skill-emoji{font-size:28px;line-height:1;flex-shrink:0}
.skill-card .skill-name{font-size:14px;font-weight:700;color:var(--text);line-height:1.2}
.skill-card .skill-desc{font-size:12px;color:var(--text2);margin-top:10px;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.skill-card .skill-badges{display:flex;gap:6px;margin-top:4px;flex-wrap:wrap;align-items:center}
.skill-card .skill-missing{font-size:11px;color:#d97706;margin-top:6px;display:flex;align-items:center;gap:4px}

/* Marketplace Card */
.market-card{border:2px solid var(--border);border-radius:14px;padding:18px;transition:all .3s ease;background:var(--card-bg);cursor:pointer}
.market-card:hover{border-color:var(--accent);transform:translateY(-2px);box-shadow:0 8px 25px rgba(66,133,244,.12)}
.market-card .market-icon{width:42px;height:42px;border-radius:50%;background:linear-gradient(135deg,rgba(66,133,244,.12),rgba(52,168,83,.12));display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0;transition:transform .2s ease}
.market-card .market-icon svg{width:22px;height:22px}
.market-card:hover .market-icon{transform:scale(1.1)}
.market-card .market-name{font-size:14px;font-weight:700;color:var(--text);transition:color .2s}
.market-card:hover .market-name{color:var(--accent)}
.market-card .market-meta{font-size:11px;color:var(--text2);display:flex;align-items:center;gap:4px;margin-top:2px}
.market-card .market-desc{font-size:12px;color:var(--text2);margin-top:10px;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.market-card .market-stats{display:flex;gap:14px;margin-top:10px;font-size:12px;color:var(--text2)}
.market-card .market-stats span{display:flex;align-items:center;gap:4px}

/* Search Input */
.search-input{width:100%;padding:10px 16px 10px 38px;border:2px solid var(--border);border-radius:10px;font-size:14px;color:var(--text);background:var(--card-bg);outline:none;transition:all .3s ease}
.search-input:focus{border-color:var(--accent);box-shadow:0 0 0 4px rgba(66,133,244,.1)}
.search-wrap{position:relative;margin-bottom:14px}
.search-wrap::before{content:'';position:absolute;left:12px;top:50%;transform:translateY(-50%);width:16px;height:16px;opacity:.4;pointer-events:none;background:currentColor;-webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='11' cy='11' r='8'/%3E%3Cline x1='21' y1='21' x2='16.65' y2='16.65'/%3E%3C/svg%3E") center/contain no-repeat;mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='11' cy='11' r='8'/%3E%3Cline x1='21' y1='21' x2='16.65' y2='16.65'/%3E%3C/svg%3E") center/contain no-repeat}

/* Modal */
.modal-overlay{position:fixed;inset:0;z-index:100;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:16px;animation:fadeIn .2s ease}
.modal-card{background:var(--card-bg);border-radius:16px;max-width:600px;width:100%;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.25);border:1px solid var(--border);animation:modalIn .25s ease}
@keyframes modalIn{from{opacity:0;transform:scale(.95) translateY(10px)}to{opacity:1;transform:scale(1) translateY(0)}}
.modal-header{display:flex;align-items:flex-start;justify-content:space-between;padding:24px 24px 16px;border-bottom:1px solid var(--border)}
.modal-body{padding:20px 24px;overflow-y:auto;flex:1}
.modal-footer{display:flex;align-items:center;justify-content:space-between;padding:16px 24px;border-top:1px solid var(--border);background:rgba(0,0,0,.02);border-radius:0 0 16px 16px}
.modal-close{width:32px;height:32px;border-radius:8px;border:none;background:transparent;color:var(--text2);font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .2s}
.modal-close:hover{background:var(--border);color:var(--text)}
.modal-tabs{display:flex;gap:0;border-bottom:2px solid var(--border);margin-bottom:16px}
.modal-tab{padding:10px 20px;font-size:13px;font-weight:700;color:var(--text2);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-2px;transition:all .2s;display:inline-flex;align-items:center;gap:6px}
.modal-tab svg{width:14px;height:14px}
.modal-tab:hover{color:var(--text)}
.modal-tab.active{color:var(--accent);border-bottom-color:var(--accent)}

/* Status Dot */
.status-dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex-shrink:0}
.status-dot.dot-green{background:#22c55e;box-shadow:0 0 6px rgba(34,197,94,.4)}
.status-dot.dot-red{background:#ef4444;box-shadow:0 0 6px rgba(239,68,68,.3)}
.status-dot.dot-amber{background:#f59e0b;box-shadow:0 0 6px rgba(245,158,11,.3);animation:pulse-dot 1.5s ease infinite}
.status-dot.dot-gray{background:#9ca3af}
@keyframes pulse-dot{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(.8)}}

/* Dark Mode — New Components */
body.dark .stat-card{background:linear-gradient(135deg,var(--card-bg),#1a2438);border-color:var(--border)}
body.dark .skill-card{background:var(--card-bg);border-color:var(--border)}
body.dark .skill-card.enabled{background:linear-gradient(135deg,#0a2e1a,#0f2a1f);border-color:rgba(52,168,83,.3)}
body.dark .market-card{background:var(--card-bg);border-color:var(--border)}
body.dark .market-card .market-icon{background:linear-gradient(135deg,rgba(66,133,244,.15),rgba(52,168,83,.15))}
body.dark .filter-pill{background:var(--card-bg);border-color:var(--border);color:var(--text2)}
body.dark .filter-pill:hover{background:rgba(66,133,244,.08)}
body.dark .filter-pill.active{background:var(--accent);color:#fff;border-color:var(--accent)}
body.dark .toggle-slider{background:#475569}
body.dark .search-input{background:var(--card-bg);border-color:var(--border);color:var(--text)}
body.dark .modal-card{background:var(--card-bg);border-color:var(--border)}
body.dark .modal-header{border-color:var(--border)} body.dark .modal-footer{background:rgba(255,255,255,.02);border-color:var(--border)}
body.dark .modal-tabs{border-color:var(--border)}
body.dark .modal-close:hover{background:rgba(255,255,255,.1)}

/* Responsive */
.hamburger{display:none;position:fixed;top:12px;left:12px;z-index:20;background:var(--sidebar-bg);color:#fff;border:none;border-radius:10px;padding:10px 14px;font-size:18px;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.2);backdrop-filter:blur(8px)}
.hamburger:active{transform:scale(.92)}
@media(max-width:768px){
  .sidebar{transform:translateX(-100%);transition:transform .25s} .sidebar.open{transform:translateX(0)}
  .main{margin-left:0;padding:20px 16px;padding-top:56px}
  .hamburger{display:block}
  .ch-list{gap:6px}
  .skill-grid{grid-template-columns:1fr}
  .stat-grid{grid-template-columns:repeat(2,1fr)}
  .filter-pills{gap:6px}
  .filter-pill{padding:5px 12px;font-size:12px}
  .modal-card{max-width:100%;margin:8px}
  .modal-header{padding:16px 16px 12px}
  .modal-body{padding:16px}
  .modal-footer{padding:12px 16px}
  #browserCards{grid-template-columns:1fr !important}
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
body.dark{background:linear-gradient(135deg,#0f172a 0%,#1a2438 50%,#1e1a2e 100%);color:#e2e8f0}
body.dark .card{background:linear-gradient(135deg,#1e293b,#1a2438);border-color:#334155}
body.dark .field input{background:#0f172a;border-color:#334155;color:#e2e8f0}
body.dark .field input:focus{background:#0f172a;border-color:#4285f4;box-shadow:0 0 0 4px rgba(66,133,244,.2)}
body.dark .field label{color:#94a3b8} body.dark .logo p{color:#94a3b8}
body.dark .err{background:#2e0a0a;border-color:#4a1a1a;color:#f87171}
.login-footer{position:fixed;bottom:12px;left:0;right:0;text-align:center;font-size:12px;color:#5f6368}
.login-footer a{color:#4285f4;text-decoration:none;font-weight:600} .login-footer a:hover{text-decoration:underline}
body.dark .login-footer{color:#94a3b8} body.dark .login-footer a{color:#60a5fa}
</style></head><body>
<script>try{if(localStorage.getItem('oc-dark')==='1')document.body.classList.add('dark')}catch{}</script>
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
<div class="login-footer">\u26A1 VPS by <a href="https://tino.vn?php=14956" target="_blank" rel="noopener">TinoHost</a> \u2014 SSD NVMe, 99.9% uptime, t\u1EEB 89k/th</div>
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
  const provJSON = JSON.stringify(Object.entries(PROVIDERS).map(([k,v])=>({id:k,name:v.name,color:v.color,icon:v.icon,models:v.models,category:v.category||'cloud',extraEnvKeys:v.extraEnvKeys||[],keyLabel:v.keyLabel||'',keyPlaceholder:v.keyPlaceholder||'',extraEnvLabels:v.extraEnvLabels||{},extraEnvPlaceholders:v.extraEnvPlaceholders||{}})));
  const chJSON = JSON.stringify(Object.entries(CHANNELS).map(([k,v])=>({id:k,name:v.name,icon:v.icon,desc:v.desc,envKeys:v.envKeys,canPair:v.canPair,envLabels:v.envLabels||{},envPlaceholders:v.envPlaceholders||{}})));

  return `<!DOCTYPE html><html lang="vi"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenClaw Panel</title>
<style>${CSS}</style></head><body>

<button class="hamburger" onclick="document.querySelector('.sidebar').classList.toggle('open')">&#9776;</button>

<div class="sidebar">
  <div class="brand"><h1>OpenClaw</h1><p>Management Panel</p></div>
  <nav>
    <div class="nav-group-label">AI</div>
    <div class="nav-item active" onclick="showTab('provider',this)"><span class="nav-icon">${ICONS.sparkles}</span>AI Provider</div>
    <div class="nav-item" onclick="showTab('fallback',this)"><span class="nav-icon">${ICONS.refresh}</span>Fallback</div>
    <div class="nav-item" onclick="showTab('agents',this)"><span class="nav-icon">${ICONS.robot}</span>Agents</div>
    <div class="nav-item" onclick="showTab('channels',this)"><span class="nav-icon">${ICONS.mail}</span>Channels</div>
    <div class="nav-item" onclick="showTab('chat',this)"><span class="nav-icon">${ICONS.messageCircle}</span>Playground</div>
    <div class="nav-group-label">Infrastructure</div>
    <div class="nav-item" onclick="showTab('gateway',this)"><span class="nav-icon">${ICONS.key}</span>Gateway</div>
    <div class="nav-item" onclick="showTab('domain',this)"><span class="nav-icon">${ICONS.globe}</span>Domain & SSL</div>
    <div class="nav-item" onclick="showTab('browser',this)"><span class="nav-icon">${ICONS.fox}</span>Browser</div>
    <div class="nav-item" onclick="showTab('plugins',this)"><span class="nav-icon">${ICONS.puzzle}</span>Plugins</div>
    <div class="nav-item" onclick="showTab('skills',this)"><span class="nav-icon">${ICONS.zap}</span>Skills</div>
    <div class="nav-item" onclick="showTab('config',this)"><span class="nav-icon">${ICONS.wrench}</span>Config</div>
    <div class="nav-item" onclick="showTab('qr',this)"><span class="nav-icon">${ICONS.smartphone}</span>QR Code</div>
    <div class="nav-group-label">Monitoring</div>
    <div class="nav-item" onclick="showTab('analytics',this)"><span class="nav-icon">${ICONS.barChart}</span>Analytics</div>
    <div class="nav-item" onclick="showTab('history',this)"><span class="nav-icon">${ICONS.fileText}</span>History</div>
    <div class="nav-item" onclick="showTab('status',this)"><span class="nav-icon">${ICONS.circleDot}</span>Status</div>
    <div class="nav-item" onclick="showTab('doctor',this)"><span class="nav-icon">${ICONS.stethoscope}</span>Doctor</div>
    <div class="nav-group-label">Admin</div>
    <div class="nav-item" onclick="showTab('users',this)"><span class="nav-icon">${ICONS.users}</span>Users</div>
    <div class="nav-item" onclick="showTab('backup',this)"><span class="nav-icon">${ICONS.package}</span>Backup</div>
    <div class="nav-item" onclick="showTab('update',this)"><span class="nav-icon">${ICONS.arrowUp}</span>Update</div>
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
    <div class="page-desc">Select AI provider, configure API key and choose your model.</div>
    <div class="card"><div class="card-title"><span class="ct-icon">${ICONS.barChart}</span> Overview</div><div id="providerSummary" class="stat-grid"></div></div>
    <div class="card"><div class="card-title"><span class="ct-icon">${ICONS.refresh}</span> All Providers</div>
      <div style="display:flex;gap:12px;align-items:center;margin-bottom:14px;flex-wrap:wrap"><div class="search-wrap" style="flex:1;min-width:200px"><input type="text" class="search-input" id="providerSearchInput" placeholder="Search providers..." oninput="filterProviders()"></div></div>
      <div class="filter-pills" id="providerFilterPills" style="margin-bottom:14px"></div>
      <div id="providerGrid"></div>
      <div class="status" id="provStatus"></div>
    </div>
  </div>
  <div id="providerModalContainer"></div>

  <!-- TAB: Fallback -->
  <div class="section" id="sec-fallback">
    <div class="page-title">Multi-Provider Fallback</div>
    <div class="page-desc">Configure fallback provider — auto switch when primary is down.</div>
    <div class="card">
      <div class="card-title"><span class="ct-icon">${ICONS.chain}</span> Fallback Chain</div>
      <div id="fbChain" class="fb-chain"><div class="muted">Loading...</div></div>
    </div>
    <div class="card">
      <div class="card-title"><span class="ct-icon">${ICONS.plus}</span> Add Fallback Provider</div>
      <div class="field"><label>Provider</label><select id="fbProvider" onchange="onFbProviderChange()"><option value="">-- Select provider --</option></select></div>
      <div class="field"><label>Model</label><select id="fbModel"></select></div>
      <div class="field"><label>API Key</label><input type="password" id="fbApiKey" placeholder="Enter API key for this provider"></div>
      <div class="btn-row"><button class="btn btn-primary" onclick="addFallbackProvider()">Add to Chain</button></div>
      <div class="status" id="fbAddStatus"></div>
    </div>
    <div class="card">
      <div class="card-title"><span class="ct-icon">${ICONS.settings}</span> Settings</div>
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
      <div class="card-title"><span class="ct-icon">${ICONS.barChart}</span> Overview</div>
      <div id="agentSummary" class="stat-grid"><div class="muted">Loading...</div></div>
      <div class="btn-row" style="margin-top:10px"><button class="btn btn-outline btn-sm" onclick="loadAgents()">↻ Refresh</button></div>
    </div>
    <div class="card">
      <div class="card-title"><span class="ct-icon">${ICONS.robot}</span> Agents</div>
      <div class="search-wrap"><input type="text" class="search-input" id="agentSearch" placeholder="Search agents..." oninput="filterAgents()"></div>
      <div id="agentFilterPills" class="filter-pills"></div>
      <div id="agentGrid" class="skill-grid"><div class="muted">Loading...</div></div>
    </div>
    <div class="card">
      <div class="card-title"><span class="ct-icon">${ICONS.plus}</span> Add New Agent</div>
      <div class="field"><label>Template</label><select id="agentTemplate" onchange="applyAgentTemplate()"><option value="">-- Custom --</option><option value="support">\ud83c\udfa7 Support Bot</option><option value="community">\ud83c\udf89 Community Manager</option><option value="developer">\ud83d\udcbb Developer Assistant</option></select></div>
      <div class="field"><label>Agent Name (ID)</label><input type="text" id="newAgentName" placeholder="e.g. support, sales, dev"></div>
      <div class="field"><label>Model</label><select id="newAgentModel" onchange="toggleNewAgentCustomModel()"><option value="">-- Select model --</option></select></div>
      <div class="field" id="newAgentCustomModelField" style="display:none"><label>Custom Model ID</label><input type="text" id="newAgentCustomModel" placeholder="e.g. openai/gpt-4o-2024-08-06"><div style="font-size:11px;color:var(--text2);margin-top:4px">Format: provider/model-id</div></div>
      <div class="field"><label>Channel Binding (optional)</label><select id="newAgentBind"><option value="">-- No binding --</option></select></div>
      <div class="btn-row"><button class="btn btn-primary" onclick="addAgent()">Add Agent</button></div>
      <div class="status" id="addAgentStatus"></div>
    </div>
    <div id="agentModalContainer"></div>
  </div>

  <!-- TAB: Channels -->
  <div class="section" id="sec-channels">
    <div class="page-title">Messaging Channels</div>
    <div class="page-desc">Configure and pair chat channels with AI.</div>
    <div class="card"><div class="card-title"><span class="ct-icon">${ICONS.check}</span> Active</div><div id="currentChannels" class="info-grid"></div></div>
    <div class="card"><div class="card-title"><span class="ct-icon">${ICONS.plus}</span> Add Channel</div>
      <div class="ch-list" id="channelList"></div>
      <div id="channelConfig" style="display:none" class="config-pane">
        <div id="channelFields"></div>
        <div class="btn-row">
          <button class="btn btn-primary" onclick="saveChannel()">Save & Restart</button>
          <button class="btn btn-outline" id="pairChannelBtn" style="display:none" onclick="showPairForm()">Pair</button>
        </div>
        <div class="status" id="channelStatus"></div>
        <div id="pairForm" style="display:none;margin-top:14px">
          <div id="pendingPairings"></div>
          <div class="field"><label>Pairing Code</label><input type="text" id="pairCode" placeholder="Enter code manually"></div>
          <div class="btn-row"><button class="btn btn-success" onclick="pairChannel()">Approve</button></div>
          <div class="status" id="pairStatus"></div>
        </div>
      </div>
    </div>
  </div>

  <!-- TAB: Gateway -->
  <div class="section" id="sec-gateway">
    <div class="page-title">Gateway</div>
    <div class="page-desc">Auth token, device pairing and dashboard management.</div>
    <div class="card"><div class="card-title"><span class="ct-icon">${ICONS.key}</span> Information</div><div id="gatewayInfo" class="info-grid"></div></div>
    <div class="card"><div class="card-title"><span class="ct-icon">${ICONS.link}</span> Pair Dashboard</div>
      <p style="font-size:13px;color:var(--text2);margin-bottom:12px;line-height:1.6">Open the dashboard link below in a <strong>new tab</strong>, wait for it to load, then come back here and click <strong>Pair</strong> to approve.</p>
      <div id="pairDashboardUrl" style="padding:10px 14px;background:#f0f4ff;border:1.5px solid var(--accent);border-radius:8px;font-family:monospace;font-size:12px;cursor:pointer;color:var(--accent);margin-bottom:12px;word-break:break-all" onclick="window.open(this.textContent,'_blank')"></div>
      <div class="btn-row">
        <button class="btn btn-success" id="pairDeviceBtn" onclick="pairDevice()">Pair Device</button>
        <button class="btn btn-outline" onclick="loadDevices()">Refresh</button>
      </div>
      <div class="status" id="pairDeviceStatus"></div>
    </div>
    <div class="card"><div class="card-title"><span class="ct-icon">${ICONS.smartphone}</span> Paired Devices</div><div id="deviceList"><div style="color:var(--text2);font-size:12px;padding:8px">Loading...</div></div></div>
    <div class="card"><div class="card-title"><span class="ct-icon">${ICONS.refresh}</span> Change Token</div>
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
    <div class="card"><div class="card-title"><span class="ct-icon">${ICONS.globe}</span> Current</div><div id="domainInfo" class="info-grid"></div></div>
    <div class="card"><div class="card-title"><span class="ct-icon">${ICONS.lock}</span> Configure</div>
      <div class="field"><label>Domain</label><input type="text" id="domainInput" placeholder="bot.example.com"></div>
      <div class="field"><label>Let's Encrypt Email (optional)</label><input type="email" id="domainEmail" placeholder="admin@example.com"></div>
      <div class="btn-row">
        <button class="btn btn-primary" onclick="saveDomain()">Configure SSL</button>
        <button class="btn btn-outline" onclick="resetDomainToIP()">Use IP (self-signed)</button>
      </div>
      <div class="status" id="domainStatus"></div>
    </div>
  </div>

  <!-- TAB: Browser -->
  <div class="section" id="sec-browser">
    <div class="page-title">${ICONS.fox} Browser</div>
    <div class="page-desc">Install and manage the browser engine for AI browser tools.</div>
    <div class="card">
      <div class="card-title"><span class="ct-icon">${ICONS.barChart}</span> Current Status</div>
      <div id="browserStatusInfo" class="info-grid"></div>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn btn-outline" onclick="loadBrowserStatus()">Refresh</button>
      </div>
    </div>
    <div class="card">
      <div class="card-title"><span class="ct-icon">${ICONS.globe}</span> Choose Browser</div>
      <p style="font-size:13px;color:var(--text2);margin-bottom:16px;line-height:1.6">Select a browser to install. Only one browser can be active at a time.</p>
      <div id="browserCards" style="display:grid;grid-template-columns:1fr 1fr;gap:16px"></div>
    </div>
    <div class="card" id="browserLogCard" style="display:none">
      <div class="card-title"><span class="ct-icon">${ICONS.fileText}</span> Log</div>
      <div class="log-box" id="browserLogBox" style="max-height:300px;overflow-y:auto;font-size:12px"></div>
    </div>
    <div class="status" id="browserStatus"></div>
  </div>

  <!-- TAB: Doctor -->
  <div class="section" id="sec-doctor">
    <div class="page-title">System Diagnostics</div>
    <div class="page-desc">Run OpenClaw Doctor to check, repair and optimize the system.</div>
    <div class="card">
      <div class="card-title"><span class="ct-icon">${ICONS.rocket}</span> Actions</div>
      <div class="doc-actions">
        <div class="doc-btn" id="docBtnScan" onclick="runDoctor('scan')">
          <div class="db-icon" style="background:#dbeafe;color:#2563eb">${ICONS.search}</div>
          <div class="db-info"><div class="db-title">Scan</div><div class="db-desc">Check 19 items, no repair</div></div>
        </div>
        <div class="doc-btn" id="docBtnRepair" onclick="runDoctor('repair')">
          <div class="db-icon" style="background:#dcfce7;color:#16a34a">${ICONS.wrench}</div>
          <div class="db-info"><div class="db-title">Auto Repair</div><div class="db-desc">Check + auto repair errors</div></div>
        </div>
        <div class="doc-btn" id="docBtnDeep" onclick="runDoctor('deep')">
          <div class="db-icon" style="background:#fef3c7;color:#d97706">${ICONS.zap}</div>
          <div class="db-info"><div class="db-title">Deep Scan</div><div class="db-desc">Deep scan services + gateway</div></div>
        </div>
      </div>
      <div class="status" id="doctorStatus"></div>
    </div>
    <div class="card" id="doctorResultCard" style="display:none">
      <div class="card-title"><span class="ct-icon">${ICONS.barChart}</span> Result</div>
      <div class="doc-summary" id="doctorSummary"></div>
      <div class="doc-checks" id="doctorChecks"></div>
    </div>
    <div class="card" id="doctorOutputCard" style="display:none">
      <div class="card-title"><span class="ct-icon">${ICONS.code}</span> Output</div>
      <div class="log-box" id="doctorLog" style="max-height:420px"></div>
    </div>
    <div class="card">
      <div class="card-title"><span class="ct-icon">${ICONS.calendar}</span> History</div>
      <div class="doc-hist" id="doctorHistory"><div style="color:var(--text2);font-size:12px;padding:8px">No history yet.</div></div>
    </div>
  </div>

  <!-- TAB: Update -->
  <div class="section" id="sec-update">
    <div class="page-title">Update</div>
    <div class="page-desc">Update OpenClaw Gateway and Management Panel.</div>
    <div class="card"><div class="card-title"><span class="ct-icon">${ICONS.package}</span> OpenClaw Gateway</div><div id="updateInfo" class="info-grid"></div>
      <div class="btn-row" style="margin-top:16px">
        <button class="btn btn-outline" onclick="checkUpdate()">Check for Updates</button>
        <div class="field" id="updateVersionField" style="display:none;margin:0;min-width:180px"><select id="updateVersionSelect"></select></div>
        <button class="btn btn-primary" id="doUpdateBtn" style="display:none" onclick="doUpdate()">Update Gateway</button>
      </div>
      <div class="status" id="updateStatus"></div>
      <div id="updateLog" style="display:none;margin-top:14px"><div class="log-box" id="updateLogBox"></div></div>
    </div>
    <div class="card"><div class="card-title"><span class="ct-icon">${ICONS.monitor}</span> Management Panel</div><div id="panelUpdateInfo" class="info-grid"></div>
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
    <div class="card"><div class="card-title"><span class="ct-icon">${ICONS.barChart}</span> Services & System</div><div id="statusInfo" class="info-grid"></div>
      <div class="btn-row" style="margin-top:16px">
        <button class="btn btn-outline" onclick="loadStatus()">Refresh</button>
        <button class="btn btn-primary" onclick="restartSvc('openclaw')">Restart OpenClaw</button>
        <button class="btn btn-outline" onclick="restartSvc('caddy')">Restart Caddy</button>
      </div>
      <div class="status" id="statusMsg"></div>
    </div>
    <div class="card"><div class="card-title"><span class="ct-icon">${ICONS.fileText}</span> OpenClaw Logs</div><div class="log-box" id="logsBox">Loading...</div></div>
  </div>

  <!-- TAB: Chat Playground -->
  <div class="section" id="sec-chat">
    <div class="page-title">${ICONS.messageCircle} Chat Playground</div>
    <div class="page-desc">Test live chat with the current AI provider.</div>
    <div class="card">
      <div class="card-title"><span class="ct-icon">${ICONS.sparkles}</span> <span id="chatProviderLabel">AI Chat</span></div>
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
    <div class="page-title">${ICONS.barChart} Usage Analytics</div>
    <div class="page-desc">AI usage statistics — from messaging channels and Chat Playground.</div>
    <div class="card"><div class="card-title"><span class="ct-icon">${ICONS.trendingUp}</span> Overview</div><div id="analyticsOverview" class="info-grid"></div></div>
    <div class="card"><div class="card-title"><span class="ct-icon">${ICONS.smartphone}</span> By Channel</div><div id="analyticsChannels" class="info-grid"></div></div>
    <div class="card"><div class="card-title"><span class="ct-icon">${ICONS.calendar}</span> Messages (7 days)</div>
      <div id="analyticsChart" style="display:flex;align-items:flex-end;gap:6px;height:120px;padding:16px 0"></div>
      <div id="analyticsList" style="margin-top:16px"></div>
    </div>
    <div class="btn-row"><button class="btn btn-outline" onclick="loadAnalytics()">Refresh</button></div>
  </div>

  <!-- TAB: Conversation History -->
  <div class="section" id="sec-history">
    <div class="page-title">${ICONS.fileText} Conversation History</div>
    <div class="page-desc">View recent conversation history.</div>
    <div class="card"><div class="card-title"><span class="ct-icon">${ICONS.folder}</span> Conversations</div>
      <div id="historyList" style="display:flex;flex-direction:column;gap:8px"></div>
      <div class="btn-row" style="margin-top:16px">
        <button class="btn btn-outline" onclick="loadHistory()">Refresh</button>
      </div>
    </div>
    <div class="card" id="historyDetail" style="display:none">
      <div class="card-title"><span class="ct-icon">${ICONS.messageCircle}</span> <span id="historyDetailTitle">Details</span></div>
      <div id="historyMsgs" style="display:flex;flex-direction:column;gap:8px"></div>
    </div>
  </div>



  <!-- TAB: User Management -->
  <div class="section" id="sec-users">
    <div class="page-title">${ICONS.users} User Management</div>
    <div class="page-desc">Manage panel access account.</div>
    <div class="card"><div class="card-title"><span class="ct-icon">${ICONS.lockOpen}</span> Change Root Password</div>
      <div class="field"><label>Current Password</label><input type="password" id="oldPass" placeholder="Enter current password"></div>
      <div class="field"><label>New Password</label><input type="password" id="newPass" placeholder="Enter new password"></div>
      <div class="field"><label>Confirm</label><input type="password" id="confirmPass" placeholder="Re-enter new password"></div>
      <div class="btn-row"><button class="btn btn-primary" onclick="changePassword()">Change Password</button></div>
      <div class="status" id="passStatus"></div>
    </div>
    <div class="card"><div class="card-title"><span class="ct-icon">${ICONS.shield}</span> Security</div>
      <div id="securityInfo" class="info-grid"></div>
      <div class="btn-row" style="margin-top:12px"><button class="btn btn-outline" onclick="loadUsers()">Refresh</button></div>
    </div>
  </div>

  <!-- TAB: Backup & Restore -->
  <div class="section" id="sec-backup">
    <div class="page-title">${ICONS.package} Backup & Restore</div>
    <div class="page-desc">Backup and restore system configuration.</div>
    <div class="card"><div class="card-title"><span class="ct-icon">${ICONS.save}</span> Backup</div>
      <p style="font-size:13px;color:var(--text2);margin-bottom:16px;line-height:1.6">Create a backup of configuration (openclaw.json, openclaw.env, Caddyfile). API keys are hidden for security.</p>
      <div class="btn-row">
        <button class="btn btn-primary" onclick="downloadBackup()">${ICONS.download} Download Backup</button>
        <button class="btn btn-outline" onclick="doBackup()">${ICONS.clipboard} View JSON</button>
      </div>
      <div class="status" id="backupStatus"></div>
      <div id="backupData" style="display:none;margin-top:14px">
        <div class="field"><label>Backup Data (copy and save)</label>
          <textarea id="backupContent" class="json-editor" style="min-height:160px" readonly></textarea>
        </div>
      </div>
    </div>
    <div class="card"><div class="card-title"><span class="ct-icon">${ICONS.refresh}</span> Restore</div>
      <p style="font-size:13px;color:var(--text2);margin-bottom:16px;line-height:1.6">Upload a backup file or paste JSON to restore configuration.</p>
      <div class="btn-row" style="margin-bottom:16px">
        <button class="btn btn-primary" onclick="document.getElementById('restoreFile').click()">${ICONS.upload} Upload Backup File</button>
        <input type="file" id="restoreFile" accept=".json" style="display:none" onchange="handleRestoreFile(event)">
      </div>
      <div class="field"><label>Or paste backup JSON</label><textarea id="restoreContent" class="json-editor" style="min-height:120px" placeholder="Paste backup JSON here..."></textarea></div>
      <div class="btn-row"><button class="btn btn-danger" onclick="doRestore()">${ICONS.warning} Restore</button></div>
      <div class="status" id="restoreStatus"></div>
    </div>
  </div>

  <!-- TAB: Plugins -->
  <div class="section" id="sec-plugins">
    <div class="page-title">${ICONS.puzzle} Plugins</div>
    <div class="page-desc">Manage extensions: enable, disable, install or remove plugins.</div>
    <div class="card">
      <div class="card-title"><span class="ct-icon">${ICONS.package}</span> Installed Plugins</div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:8px">
        <div class="search-wrap" style="flex:1;min-width:200px;margin-bottom:0"><input type="text" class="search-input" id="pluginsSearchInput" placeholder="Search plugins..." oninput="filterPluginsUI()"></div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-outline btn-sm" onclick="loadPlugins()">${ICONS.refreshCw} Refresh</button>
          <button class="btn btn-outline btn-sm" onclick="updateAllPlugins()">${ICONS.arrowUp} Update All</button>
        </div>
      </div>
      <div id="pluginsList"></div>
      <div class="status" id="pluginsStatus"></div>
    </div>
    <div class="card">
      <div class="card-title"><span class="ct-icon">${ICONS.plus}</span> Install Plugin</div>
      <p style="font-size:13px;color:var(--text2);margin-bottom:14px;line-height:1.6">Install from npm registry or local archive (.tgz, .zip).</p>
      <div class="field"><label>Package name or path</label><input type="text" id="pluginInstallInput" placeholder="e.g. @openclaw/plugin-name or ./plugin.tgz"></div>
      <div class="btn-row">
        <button class="btn btn-primary" onclick="installPlugin()">Install</button>
      </div>
      <div class="status" id="pluginInstallStatus"></div>
      <div id="pluginInstallLog" style="display:none;margin-top:12px"><div class="log-box" id="pluginInstallLogBox" style="max-height:200px;overflow-y:auto"></div></div>
    </div>
  </div>
  <div id="pluginModalContainer"></div>

  <!-- TAB: Skills -->
  <div class="section" id="sec-skills">
    <div class="page-title">${ICONS.zap} Skills</div>
    <div class="page-desc">Browse and manage AI skills, or install new ones from ClawHub marketplace.</div>
    <div class="card">
      <div class="card-title"><span class="ct-icon">${ICONS.barChart}</span> Overview</div>
      <div id="skillsSummary" class="stat-grid"></div>
      <div style="margin-top:6px"><button class="btn btn-outline btn-sm" onclick="loadSkills()">${ICONS.refreshCw} Refresh</button></div>
    </div>
    <div class="card">
      <div class="card-title"><span class="ct-icon">${ICONS.zap}</span> Installed Skills</div>
      <div class="search-wrap"><input type="text" class="search-input" id="skillsSearchInput" placeholder="Search skills..." oninput="filterSkills()"></div>
      <div class="filter-pills" id="skillsFilterPills"></div>
      <div id="skillsList"></div>
      <div class="status" id="skillsStatus"></div>
    </div>
    <div class="card" id="skillsLogCard" style="display:none">
      <div class="card-title"><span class="ct-icon">${ICONS.fileText}</span> Install Log</div>
      <div class="log-box" id="skillsLogBox" style="max-height:300px;overflow-y:auto;font-size:12px"></div>
    </div>
    <div class="card">
      <div class="card-title"><span class="ct-icon">${ICONS.globe}</span> ClawHub \u2014 Marketplace</div>
      <p style="font-size:13px;color:var(--text2);margin-bottom:14px;line-height:1.6">Search and install community skills from the ClawHub public registry.</p>
      <div style="display:flex;gap:8px;margin-bottom:14px">
        <div class="search-wrap" style="flex:1;margin-bottom:0"><input type="text" class="search-input" id="clawhubSearchInput" placeholder="Search skills... e.g. docker, weather, git" onkeydown="if(event.key==='Enter')searchClawHub()"></div>
        <button class="btn btn-primary" style="padding:10px 24px;height:fit-content" onclick="searchClawHub()">Search</button>
      </div>
      <div id="clawhubResults"></div>
      <div class="status" id="clawhubStatus"></div>
    </div>
    <div class="card">
      <div class="card-title"><span class="ct-icon">${ICONS.package}</span> Installed from ClawHub</div>
      <div class="btn-row" style="margin-bottom:12px">
        <button class="btn btn-outline btn-sm" onclick="loadClawHubInstalled()">${ICONS.refreshCw} Refresh</button>
        <button class="btn btn-outline btn-sm" onclick="updateAllClawHub()">${ICONS.arrowUp} Update All</button>
      </div>
      <div id="clawhubInstalled"></div>
      <div class="status" id="clawhubInstalledStatus"></div>
    </div>
  </div>
  <div id="skillModalContainer"></div>

  <!-- TAB: Config Editor -->
  <div class="section" id="sec-config">
    <div class="page-title">${ICONS.wrench} Config Editor</div>
    <div class="page-desc">Edit system configuration files directly.</div>
    <div class="card"><div class="card-title"><span class="ct-icon">${ICONS.file}</span> openclaw.json</div>
      <textarea id="configJson" class="json-editor" style="min-height:320px"></textarea>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn btn-primary" onclick="saveConfigFile('json')">Save & Restart</button>
        <button class="btn btn-outline" onclick="loadConfigEditor()">Reload</button>
      </div>
      <div class="status" id="configJsonStatus"></div>
    </div>
    <div class="card"><div class="card-title"><span class="ct-icon">${ICONS.file}</span> openclaw.env</div>
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
    <div class="page-title">${ICONS.smartphone} QR Code Pairing</div>
    <div class="page-desc">QR code for quick dashboard access from your phone.</div>
    <div class="card">
      <div class="card-title"><span class="ct-icon">${ICONS.smartphone}</span> Dashboard QR</div>
      <div class="qr-box" id="qrBox">
        <div id="qrCanvas" style="margin:16px auto;display:inline-block;padding:12px;background:#fff;border-radius:8px"></div>
        <p style="font-size:12px;color:var(--text2);margin-top:12px" id="qrUrl"></p>
      </div>
      <div class="btn-row" style="justify-content:center;margin-top:12px">
        <button class="btn btn-outline" onclick="loadQR()">Regenerate QR</button>
      </div>
    </div>
  </div>

  <!-- Footer -->
  <div class="panel-footer">\u26a1 VPS by <a href="https://tino.vn?php=14956" target="_blank" rel="noopener">TinoHost</a> \u2014 SSD NVMe, 99.9% uptime, t\u1eeb 89k/th</div>

</div>

<script>
let selectedProvider=null,selectedChannel=null,availVersions=[],providerFilterMode='all',currentProviderData=null;
const PANEL_VER='${PANEL_VERSION}';
const providers=${provJSON};
const channels=${chJSON};

function showTab(name,el){
  document.querySelectorAll('.section').forEach(s=>s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  const sec=document.getElementById('sec-'+name);if(sec)sec.classList.add('active');
  if(el)el.classList.add('active');
  document.querySelector('.sidebar').classList.remove('open');
  const loaders={provider:loadProvider,fallback:loadFallback,agents:loadAgents,channels:loadChannels,gateway:loadGateway,domain:loadDomain,browser:loadBrowserStatus,update:loadUpdate,
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
function streamTask(taskId,logBox,statusEl,onDone){
  logBox.textContent='';
  const src=new EventSource('/api/tasks/'+taskId+'/stream');
  src.onmessage=function(e){
    try{
      const d=JSON.parse(e.data);
      if(d.type==='log'){logBox.textContent+=d.text+'\\n';logBox.scrollTop=logBox.scrollHeight}
      else if(d.type==='done'){
        src.close();
        if(!d.ok){statusEl.className='status fail';statusEl.textContent=d.error||'Operation failed'}
        if(onDone)onDone(d);
      }
    }catch{}
  };
  src.onerror=function(){if(src.readyState===EventSource.CLOSED){statusEl.className='status fail';statusEl.textContent='Connection lost'}};
  return src;
}
function toggleTokenVis(){const el=document.getElementById('tokenDisplay');if(!el||!window._gwToken)return;window._gwTokenVis=!window._gwTokenVis;if(window._gwTokenVis)el.textContent=window._gwToken;else{const t=window._gwToken;el.textContent=t.substring(0,8)+'\\u2022'.repeat(8)+t.substring(t.length-8)}}

// === Provider ===
async function loadProvider(){
  const d=await api('/api/current-config');
  currentProviderData=d;
  const sum=document.getElementById('providerSummary');
  const cloud=providers.filter(p=>(p.category||'cloud')==='cloud').length;
  const gateway=providers.filter(p=>p.category==='gateway').length;
  const local=providers.filter(p=>p.category==='local').length;
  const curName=d.provider?esc(d.providerName||d.provider):'<span style="color:var(--warn)">Not set</span>';
  const curModel=d.model?esc((d.model||'').split('/').pop()):'\\u2014';
  const cfgCount=(d.configuredProviders||[]).length;
  sum.innerHTML=
    '<div class="stat-card"><div class="stat-num" style="font-size:16px;line-height:1.3">'+curName+'</div><div class="stat-label">Active Provider</div></div>'
    +'<div class="stat-card"><div class="stat-num" style="font-size:16px;line-height:1.3">'+curModel+'</div><div class="stat-label">Current Model</div></div>'
    +'<div class="stat-card"><div class="stat-num">'+cfgCount+'</div><div class="stat-label">${ICONS.key} Configured</div></div>'
    +'<div class="stat-card"><div class="stat-num">'+(cloud+gateway+local)+'</div><div class="stat-label">${ICONS.globe} Available</div></div>';
  renderProviderFilterPills(providers.length,cloud,gateway,local);
  filterProviders();
}
function renderProviderFilterPills(total,cloud,gateway,local){
  const el=document.getElementById('providerFilterPills');if(!el)return;
  const pills=[{key:'all',label:'All',count:total},{key:'cloud',label:'${ICONS.cloudflare} Cloud',count:cloud},{key:'gateway',label:'${ICONS.openrouter} Gateway',count:gateway},{key:'local',label:'${ICONS.monitor} Local',count:local}];
  el.innerHTML=pills.map(p=>
    '<button class="filter-pill'+(providerFilterMode===p.key?' active':'')+'" onclick="setProviderFilter(\\''+p.key+'\\')">'+p.label+'<span class="pill-count">'+p.count+'</span></button>'
  ).join('');
}
function setProviderFilter(mode){
  providerFilterMode=mode;
  const cloud=providers.filter(p=>(p.category||'cloud')==='cloud').length;
  const gateway=providers.filter(p=>p.category==='gateway').length;
  const local=providers.filter(p=>p.category==='local').length;
  renderProviderFilterPills(providers.length,cloud,gateway,local);
  filterProviders();
}
function filterProviders(){
  let list=providers.slice();
  if(providerFilterMode!=='all')list=list.filter(p=>(p.category||'cloud')===providerFilterMode);
  const q=(document.getElementById('providerSearchInput')||{}).value;
  if(q&&q.trim()){const lq=q.trim().toLowerCase();list=list.filter(p=>(p.name||'').toLowerCase().includes(lq)||(p.id||'').toLowerCase().includes(lq))}
  renderProviderGrid(list);
}
function renderProviderGrid(list){
  const el=document.getElementById('providerGrid');if(!el)return;
  if(!list.length){el.innerHTML='<div class="empty-state"><div class="empty-icon">${ICONS.search}</div><div class="empty-text">No providers match this filter.</div></div>';return}
  let h='<div class="skill-grid">';
  list.forEach(p=>{
    const isCurrent=currentProviderData&&currentProviderData.provider===p.id;
    const hasKey=currentProviderData&&currentProviderData.configuredProviders&&currentProviderData.configuredProviders.includes(p.id);
    const cardClass='skill-card'+((isCurrent||hasKey)?' enabled':'');
    const activeBadge=isCurrent?'<span class="badge bg-green">ACTIVE</span>':(hasKey?'<span class="badge bg-blue">CONFIGURED</span>':'');
    const cat=p.category||'cloud';
    const catClass=cat==='gateway'?'cat-gateway':cat==='local'?'cat-local':'cat-cloud';
    const catLabel=cat==='gateway'?'Gateway':cat==='local'?'Local':'Cloud';
    const catBadge='<span class="badge '+catClass+'">'+catLabel+'</span>';
    const modelCount='<span style="font-size:10px;color:var(--text2);background:var(--border);padding:1px 6px;border-radius:4px">'+p.models.length+' model'+(p.models.length>1?'s':'')+'</span>';
    const preview=p.models.slice(0,3).map(m=>esc(m.name)).join(', ')+(p.models.length>3?' +'+( p.models.length-3)+' more':'');
    h+='<div class="'+cardClass+'" onclick="showProviderDetail(\\''+esc(p.id).replace(/'/g,"\\\\'")+'\\')">'
      +'<div style="display:flex;justify-content:space-between;align-items:flex-start">'
      +'<div style="display:flex;align-items:center;gap:12px">'
      +'<div class="prov-card-icon" style="background:'+p.color+'15;color:'+p.color+'">'+p.icon+'</div>'
      +'<div><div class="skill-name">'+esc(p.name)+'</div>'
      +'<div class="skill-badges">'+activeBadge+catBadge+' '+modelCount+'</div></div></div>'
      +'</div>'
      +'<div class="skill-desc" style="margin-top:8px;font-size:12px;color:var(--text2)">'+preview+'</div>'
      +'</div>';
  });
  h+='</div>';
  el.innerHTML=h;
}
function showProviderDetail(id){
  const p=providers.find(pr=>pr.id===id);
  if(!p)return;
  selectedProvider=id;
  const container=document.getElementById('providerModalContainer');if(!container)return;
  const isCurrent=currentProviderData&&currentProviderData.provider===id;
  const hasKey=currentProviderData&&currentProviderData.configuredProviders&&currentProviderData.configuredProviders.includes(id);
  const currentModel=isCurrent?(currentProviderData.model||''):'';
  const statusDot=isCurrent
    ?'<span class="status-dot dot-green"></span> <span style="color:#16a34a;font-weight:600;font-size:13px">Active</span>'
    :(hasKey?'<span class="status-dot dot-green"></span> <span style="color:#3b82f6;font-weight:600;font-size:13px">Configured</span>'
    :'<span class="status-dot dot-amber"></span> <span style="color:var(--text2);font-weight:600;font-size:13px">Not configured</span>');
  const activeBadge=isCurrent?'<span class="badge bg-green">ACTIVE</span>':(hasKey?'<span class="badge bg-blue">CONFIGURED</span>':'');
  const cat=p.category||'cloud';
  const catClass=cat==='gateway'?'cat-gateway':cat==='local'?'cat-local':'cat-cloud';
  const catLabel=cat==='gateway'?'Gateway':cat==='local'?'Local':'Cloud';
  const catBadge='<span class="badge '+catClass+'">'+catLabel+'</span>';
  const isCustomModel=currentModel&&currentModel.startsWith(id+'/')&&!p.models.some(m=>m.id===currentModel);
  const modelOptions=p.models.map(m=>'<option value="'+esc(m.id)+'"'+(m.id===currentModel?' selected':'')+'>'+esc(m.name)+' \\u2014 '+esc(m.desc)+'</option>').join('')+'<option value="__custom__"'+(isCustomModel?' selected':'')+'>\\u270f Custom model...</option>';
  let extraHtml='';
  if(p.extraEnvKeys&&p.extraEnvKeys.length>0)p.extraEnvKeys.forEach(ek=>{const ekLabel=(p.extraEnvLabels&&p.extraEnvLabels[ek])||ek;const ekPh=(p.extraEnvPlaceholders&&p.extraEnvPlaceholders[ek])||('Enter '+ek);extraHtml+='<div class="field"><label>'+esc(ekLabel)+'</label><input type="text" id="provExtra-'+esc(ek)+'" placeholder="'+esc(ekPh)+'"></div>'});
  let infoHtml='<div class="info-grid" style="margin-bottom:16px">'
    +'<div class="info-row"><span class="info-k">Models</span><span class="info-v">'+p.models.length+' available</span></div>'
    +'<div class="info-row"><span class="info-k">Category</span><span class="info-v">'+catBadge+'</span></div>';
  if(isCurrent)infoHtml+='<div class="info-row"><span class="info-k">Current Model</span><span class="info-v" style="font-size:12px">'+esc(currentModel.split('/').pop())+'</span></div>';
  infoHtml+='</div>';
  container.innerHTML='<div class="modal-overlay" onclick="closeProviderModal()">'
    +'<div class="modal-card" onclick="event.stopPropagation()">'
    +'<div class="modal-header">'
    +'<div style="display:flex;align-items:center;gap:16px">'
    +'<div class="prov-card-icon" style="background:'+p.color+'15;color:'+p.color+';width:52px;height:52px;font-size:28px">'+p.icon+'</div>'
    +'<div><div style="font-size:18px;font-weight:800;color:var(--text)">'+esc(p.name)+'</div>'
    +'<div style="display:flex;gap:8px;margin-top:6px;align-items:center">'+activeBadge+catBadge+'</div></div></div>'
    +'<button class="modal-close" onclick="closeProviderModal()">\\u2715</button>'
    +'</div>'
    +'<div class="modal-body">'
    +infoHtml
    +'<div class="field"><label>Model</label><select id="provModel" onchange="toggleProvCustomModel()">'+modelOptions+'</select></div>'
    +'<div class="field" id="provCustomModelField" style="display:'+(isCustomModel?'block':'none')+'"><label>Custom Model ID</label><input type="text" id="provCustomModel" placeholder="e.g. gpt-4o-2024-08-06" value="'+(isCustomModel?esc(currentModel.split('/').slice(1).join('/')):'')+'">'
    +'<div style="font-size:11px;color:var(--text2);margin-top:4px">Enter the exact model ID from the provider\\u2019s API docs</div></div>'
    +'<div class="field"><label>'+(p.keyLabel||'API Key')+'</label><input type="password" id="provKey" placeholder="'+(p.keyPlaceholder||'Enter API key')+'"></div>'
    +extraHtml
    +'<div class="btn-row" style="margin-top:16px;flex-wrap:wrap">'
    +'<button class="btn btn-outline btn-sm" onclick="testProviderKey()">${ICONS.zap} Test Key</button>'
    +'<button class="btn btn-outline btn-sm" style="border-color:var(--accent2);color:var(--accent2)" onclick="saveProviderKey()">${ICONS.save} Save Key</button>'
    +'<button class="btn btn-primary btn-sm" onclick="applyProvider()">${ICONS.zap} Apply & Switch</button>'
    +(hasKey&&!isCurrent?'<button class="btn btn-outline btn-sm" style="border-color:var(--danger);color:var(--danger)" onclick="removeProviderKey()">${ICONS.trash} Remove Key</button>':'')
    +'</div>'
    +'<div class="status" id="provModalStatus"></div>'
    +'</div>'
    +'<div class="modal-footer">'
    +'<div style="display:flex;align-items:center;gap:8px">'+statusDot+'</div>'
    +'<div style="font-size:12px;color:var(--text2)">'+p.models.length+' model'+(p.models.length>1?'s':'')+' + custom</div>'
    +'</div>'
    +'</div></div>';
}
function toggleProvCustomModel(){
  const sel=document.getElementById('provModel');const f=document.getElementById('provCustomModelField');
  if(sel&&f)f.style.display=sel.value==='__custom__'?'block':'none';
}
function getSelectedProvModel(){
  const sel=document.getElementById('provModel');if(!sel)return'';
  if(sel.value==='__custom__'){const ci=document.getElementById('provCustomModel');return ci?selectedProvider+'/'+ci.value.trim():''}
  return sel.value;
}
function toggleAgentCustomModel(){
  const sel=document.getElementById('agentModalModel');const f=document.getElementById('agentCustomModelField');
  if(sel&&f)f.style.display=sel.value==='__custom__'?'block':'none';
}
function toggleNewAgentCustomModel(){
  const sel=document.getElementById('newAgentModel');const f=document.getElementById('newAgentCustomModelField');
  if(sel&&f)f.style.display=sel.value==='__custom__'?'block':'none';
}
function closeProviderModal(){const c=document.getElementById('providerModalContainer');if(c)c.innerHTML=''}
async function testProviderKey(){
  const st=document.getElementById('provModalStatus')||document.getElementById('provStatus'),k=document.getElementById('provKey').value.trim();
  if(!k){st.className='status fail';st.textContent='Enter API key';return}
  st.className='status loading';st.textContent='Checking...';
  const prov=providers.find(p=>p.id===selectedProvider);const extraEnv={};
  if(prov&&prov.extraEnvKeys)prov.extraEnvKeys.forEach(ek=>{const el=document.getElementById('provExtra-'+ek)||document.getElementById('extraEnv-'+ek);if(el)extraEnv[ek]=el.value.trim()});
  const d=await api('/api/test-key','POST',{provider:selectedProvider,apiKey:k,extraEnv});
  st.className=d.ok?'status ok':'status fail';st.textContent=d.ok?'API key is valid!':d.error||'Invalid key';
}
async function saveProviderKey(){
  const st=document.getElementById('provModalStatus')||document.getElementById('provStatus'),k=document.getElementById('provKey').value.trim();
  if(!selectedProvider){st.className='status fail';st.textContent='Select a provider';return}
  if(!k){st.className='status fail';st.textContent='Enter API key';return}
  st.className='status loading';st.textContent='Saving key...';
  const prov=providers.find(p=>p.id===selectedProvider);const extraEnv={};
  if(prov&&prov.extraEnvKeys)prov.extraEnvKeys.forEach(ek=>{const el=document.getElementById('provExtra-'+ek)||document.getElementById('extraEnv-'+ek);if(el)extraEnv[ek]=el.value.trim()});
  const d=await api('/api/provider-save-key','POST',{provider:selectedProvider,apiKey:k,extraEnv});
  st.className=d.ok?'status ok':'status fail';st.textContent=d.ok?'API key saved for '+esc(prov?prov.name:selectedProvider)+'! Current model unchanged.':d.error||'Error';
  if(d.ok)setTimeout(()=>{closeProviderModal();loadProvider()},1500);
}
async function applyProvider(){
  const st=document.getElementById('provModalStatus')||document.getElementById('provStatus'),k=document.getElementById('provKey').value.trim(),m=getSelectedProvModel();
  if(!selectedProvider){st.className='status fail';st.textContent='Select a provider';return}
  const alreadyConfigured=currentProviderData&&currentProviderData.configuredProviders&&currentProviderData.configuredProviders.includes(selectedProvider);
  if(!k&&!alreadyConfigured){st.className='status fail';st.textContent='Enter API key';return}
  if(!m||m.endsWith('/')){st.className='status fail';st.textContent='Enter a valid model ID';return}
  st.className='status loading';st.textContent='Applying...';
  const prov=providers.find(p=>p.id===selectedProvider);const extraEnv={};
  if(prov&&prov.extraEnvKeys)prov.extraEnvKeys.forEach(ek=>{const el=document.getElementById('provExtra-'+ek)||document.getElementById('extraEnv-'+ek);if(el)extraEnv[ek]=el.value.trim()});
  const d=await api('/api/provider','POST',{provider:selectedProvider,model:m,apiKey:k,extraEnv});
  st.className=d.ok?'status ok':'status fail';st.textContent=d.ok?'Success! OpenClaw restarted.':d.error||'Error';
  if(d.ok)setTimeout(()=>{closeProviderModal();loadProvider()},1500);
}
async function removeProviderKey(force){
  if(!selectedProvider)return;
  const prov=providers.find(p=>p.id===selectedProvider);
  const name=prov?prov.name:selectedProvider;
  if(!force&&!confirm('Remove API key for '+name+'? This provider will no longer be available.'))return;
  const st=document.getElementById('provModalStatus')||document.getElementById('provStatus');
  st.className='status loading';st.textContent='Removing key...';
  const d=await api('/api/provider-remove-key','POST',{provider:selectedProvider,force:!!force});
  if(!d.ok&&d.confirm){
    if(confirm(d.error)){removeProviderKey(true);return}
    st.className='status';st.textContent='';return;
  }
  st.className=d.ok?'status ok':'status fail';st.textContent=d.ok?'API key removed for '+esc(name)+'.':d.error||'Error';
  if(d.ok)setTimeout(()=>{closeProviderModal();loadProvider()},1500);
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
      fields.innerHTML=c.envKeys.map(k=>'<div class="field"><label>'+esc((c.envLabels&&c.envLabels[k])||k)+'</label><input type="text" id="chfield-'+k+'" placeholder="'+esc((c.envPlaceholders&&c.envPlaceholders[k])||('Enter '+k))+'"></div>').join('');pb.style.display=c.canPair?'inline-flex':'none';
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
async function showPairForm(){
  document.getElementById('pairForm').style.display='block';
  if(!selectedChannel||!selectedChannel.canPair)return;
  const pp=document.getElementById('pendingPairings');pp.innerHTML='<div style="color:var(--text2);font-size:12px;padding:4px 0">Loading pending requests...</div>';
  const d=await api('/api/channel-pair-list','POST',{channel:selectedChannel.id});
  if(d.ok&&d.requests&&d.requests.length>0){
    pp.innerHTML='<div style="font-weight:600;font-size:13px;margin-bottom:8px">Pending Pairing Requests</div>'+d.requests.map(r=>{
      const label=r.displayName||r.username||r.userId||r.code||'Unknown';
      const code=r.code||r.pairingCode||'';
      return '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:var(--bg);border-radius:8px;margin-bottom:6px">'
        +'<div><span style="font-weight:600;font-size:13px">'+esc(label)+'</span>'+(code?' <span style="color:var(--text2);font-size:11px">'+esc(code)+'</span>':'')+'</div>'
        +'<button class="btn btn-success" style="padding:4px 14px;font-size:12px" onclick="approvePairing(\\x27'+esc(code)+'\\x27,this)">Approve</button>'
        +'</div>';
    }).join('');
  }else{pp.innerHTML='<div style="color:var(--text2);font-size:12px;padding:4px 0">No pending requests. Send a message to the bot first, then click Pair again.</div>'}
}
async function approvePairing(code,btn){
  if(!selectedChannel||!code)return;
  const orig=btn.textContent;btn.disabled=true;btn.textContent='Approving...';
  const d=await api('/api/channel-pair','POST',{channel:selectedChannel.id,code});
  if(d.ok){btn.innerHTML='${ICONS.check} Approved';btn.style.background='var(--accent2)';setTimeout(()=>showPairForm(),1500)}
  else{btn.disabled=false;btn.textContent=orig;const st=document.getElementById('pairStatus');st.className='status fail';st.textContent=d.error||'Error'}
}
async function pairChannel(){
  if(!selectedChannel||!selectedChannel.canPair)return;const st=document.getElementById('pairStatus'),code=document.getElementById('pairCode').value.trim();
  if(!code){st.className='status fail';st.textContent='Enter pairing code';return}
  st.className='status loading';st.textContent='Approving...';
  const d=await api('/api/channel-pair','POST',{channel:selectedChannel.id,code});
  st.className=d.ok?'status ok':'status fail';st.textContent=d.ok?'Pairing successful!':d.error||'Error';
  if(d.ok){document.getElementById('pairCode').value='';setTimeout(()=>showPairForm(),1500)}
}

// === Agents ===
let allAgents=[],allAgentSkills=[],agentActiveProviders=[],agentActiveChannels=[],agentFilterMode='all';
const AGENT_TEMPLATES={support:{name:'support',emoji:'🎧',theme:'professional'},community:{name:'community',emoji:'🎉',theme:'casual'},developer:{name:'developer',emoji:'💻',theme:'technical'}};
async function loadAgents(){
  const d=await api('/api/agents');
  const grid=document.getElementById('agentGrid');
  if(!d.ok){grid.innerHTML='<div class="muted">Error: '+esc(d.error||'Unable to load')+'</div>';return}
  allAgents=d.agents||[];
  allAgentSkills=d.availableSkills||[];
  agentActiveProviders=d.activeProviders||[];
  agentActiveChannels=d.activeChannels||[];
  renderAgentSummary(allAgents);
  const defCount=allAgents.filter(a=>a.isDefault).length;
  const customCount=allAgents.length-defCount;
  renderAgentFilterPills(allAgents.length,defCount,customCount);
  filterAgents();
  populateAgentFormDropdowns();
}
function populateAgentFormDropdowns(){
  const modelSel=document.getElementById('newAgentModel');
  modelSel.innerHTML='<option value="">-- Select model --</option>';
  if(agentActiveProviders.length){agentActiveProviders.forEach(p=>{p.models.forEach(m=>{modelSel.innerHTML+='<option value="'+m.id+'">'+esc(p.name)+' \\u2014 '+esc(m.name)+'</option>'})});modelSel.innerHTML+='<option value="__custom__">\\u270f Custom model...</option>'}
  else{modelSel.innerHTML='<option value="">No AI Provider configured</option>'}
  const bindSel=document.getElementById('newAgentBind');
  bindSel.innerHTML='<option value="">-- No binding --</option>';
  agentActiveChannels.forEach(c=>{bindSel.innerHTML+='<option value="'+c.id+'">'+c.icon+' '+esc(c.name)+'</option>'});
}
function renderAgentSummary(agents){
  const el=document.getElementById('agentSummary');if(!el)return;
  const total=agents.length;
  const defAgent=agents.find(a=>a.isDefault);
  const defName=defAgent?(defAgent.identity&&defAgent.identity.name?defAgent.identity.name:defAgent.id):'N/A';
  const totalBindings=agents.reduce((s,a)=>s+(a.bindings||0),0);
  const totalRoutes=agents.reduce((s,a)=>s+(a.routes?a.routes.length:0),0);
  el.innerHTML='<div class="stat-card"><div class="stat-num">'+total+'</div><div class="stat-label">Agents</div></div>'
    +'<div class="stat-card"><div class="stat-num" style="font-size:16px;line-height:1.3">'+esc(defName)+'</div><div class="stat-label">Default Agent</div></div>'
    +'<div class="stat-card"><div class="stat-num">'+totalBindings+'</div><div class="stat-label">Bindings</div></div>'
    +'<div class="stat-card"><div class="stat-num">'+totalRoutes+'</div><div class="stat-label">Routes</div></div>';
}
function renderAgentFilterPills(total,def,custom){
  const el=document.getElementById('agentFilterPills');if(!el)return;
  const pills=[{key:'all',label:'All',count:total},{key:'default',label:'${ICONS.star} Default',count:def},{key:'custom',label:'${ICONS.robot} Custom',count:custom}];
  el.innerHTML=pills.map(p=>
    '<button class="filter-pill'+(agentFilterMode===p.key?' active':'')+'" onclick="setAgentFilter(\\''+p.key+'\\')">'+p.label+'<span class="pill-count">'+p.count+'</span></button>'
  ).join('');
}
function setAgentFilter(mode){agentFilterMode=mode;filterAgents();const defCount=allAgents.filter(a=>a.isDefault).length;renderAgentFilterPills(allAgents.length,defCount,allAgents.length-defCount)}
function filterAgents(){
  const search=(document.getElementById('agentSearch')||{}).value||'';
  const q=search.toLowerCase().trim();
  let filtered=allAgents;
  if(agentFilterMode==='default')filtered=filtered.filter(a=>a.isDefault);
  else if(agentFilterMode==='custom')filtered=filtered.filter(a=>!a.isDefault);
  if(q)filtered=filtered.filter(a=>{
    const name=a.identity&&a.identity.name?a.identity.name.toLowerCase():'';
    return a.id.toLowerCase().includes(q)||name.includes(q)||(a.model||'').toLowerCase().includes(q)
  });
  renderAgentGrid(filtered);
}
function renderAgentGrid(agents){
  const el=document.getElementById('agentGrid');if(!el)return;
  if(!agents.length){el.innerHTML='<div class="muted" style="padding:20px;text-align:center">No agents found</div>';return}
  let h='';
  agents.forEach(a=>{
    const emoji=a.identity&&a.identity.emoji?a.identity.emoji:'\\ud83e\\udd16';
    const displayName=a.identity&&a.identity.name?a.identity.name:a.id;
    const model=(a.model||'N/A').split('/').pop();
    const isDefault=a.isDefault;
    const bindChannels=a.bindingChannels&&a.bindingChannels.length?a.bindingChannels:[];
    const cardClass='skill-card'+(isDefault?' enabled':'');
    const defaultBadge=isDefault?'<span class="badge bg-green">DEFAULT</span>':'<span class="badge bg-blue">AGENT</span>';
    const bindBadge=bindChannels.length>0?bindChannels.map(function(ch){return '<span class="badge" style="background:var(--border);color:var(--text2)">'+esc(ch)+'</span>'}).join(''):'';
    const routeText=a.routes&&a.routes.length?a.routes.join(', '):(bindChannels.length?bindChannels.join(', '):'No routes');
    h+='<div class="'+cardClass+'" style="cursor:pointer" onclick="showAgentDetail(\\''+esc(a.id).replace(/'/g,"\\\\'")+'\\')">'
      +'<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">'
      +'<span style="font-size:28px">'+emoji+'</span>'
      +'<div><div class="skill-name">'+esc(displayName)+'</div>'
      +'<div style="font-size:11px;color:var(--text2)">'+esc(a.id)+'</div></div></div>'
      +'<div class="skill-badges">'+defaultBadge+bindBadge+'</div>'
      +'<div class="skill-desc" style="margin-top:6px">'+esc(model)+'</div>'
      +'<div style="font-size:11px;color:var(--text2);margin-top:4px">'+esc(routeText)+'</div>'
      +'</div>';
  });
  el.innerHTML=h;
}
function showAgentDetail(id){
  const a=allAgents.find(ag=>ag.id===id);if(!a)return;
  const container=document.getElementById('agentModalContainer');if(!container)return;
  const emoji=a.identity&&a.identity.emoji?a.identity.emoji:'\\ud83e\\udd16';
  const displayName=a.identity&&a.identity.name?a.identity.name:a.id;
  const theme=a.identity&&a.identity.theme?a.identity.theme:'';
  const isDefault=a.isDefault;
  const defaultBadge=isDefault?'<span class="badge bg-green">DEFAULT</span>':'<span class="badge bg-blue">AGENT</span>';
  const bindChannels=a.bindingChannels&&a.bindingChannels.length?a.bindingChannels:[];
  const bindText=bindChannels.length?bindChannels.map(function(ch){return '<span class="badge" style="background:var(--border);color:var(--text2)">'+esc(ch)+'</span>'}).join(' '):'<span style="color:var(--text2)">None</span>';
  const routeText=a.routes&&a.routes.length?a.routes.join(', '):(bindChannels.length?bindChannels.join(', '):'No routes');
  const skillsData=a.skills;
  const useAll=skillsData===null||skillsData===undefined;
  // Build model options for per-agent override
  const isCustomAgentModel=a.model&&!agentActiveProviders.some(p=>p.models.some(m=>m.id===a.model));
  let modelOpts='<option value="">-- Use default model --</option>';
  agentActiveProviders.forEach(p=>{p.models.forEach(m=>{
    const sel=(a.model===m.id)?' selected':'';
    modelOpts+='<option value="'+m.id+'"'+sel+'>'+esc(p.name)+' \\u2014 '+esc(m.name)+'</option>';
  })});
  modelOpts+='<option value="__custom__"'+(isCustomAgentModel?' selected':'')+'">\\u270f Custom model...</option>';
  // Build skills checkboxes
  let skillsHtml='';
  if(allAgentSkills.length){
    allAgentSkills.forEach(s=>{
      const checked=useAll||( Array.isArray(skillsData)&&skillsData.includes(s.name));
      skillsHtml+='<label style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--bg2);border-radius:8px;cursor:pointer;font-size:13px">'
        +'<input type="checkbox" class="agent-skill-cb" value="'+esc(s.name)+'"'+(checked?' checked':'')+(useAll?' disabled':'')+' style="accent-color:var(--accent)">'
        +'<span>'+s.emoji+' '+esc(s.name)+'</span></label>';
    });
  } else {
    skillsHtml='<div class="muted" style="padding:12px">No skills available</div>';
  }
  const escId=esc(id).replace(/'/g,"\\\\'");
  container.innerHTML='<div class="modal-overlay" onclick="if(event.target===this)closeAgentModal()">'
    +'<div class="modal-card">'
    +'<div class="modal-header"><div style="display:flex;align-items:center;gap:12px"><span style="font-size:32px">'+emoji+'</span>'
    +'<div><div style="font-size:18px;font-weight:700">'+esc(displayName)+'</div>'
    +'<div style="margin-top:4px">'+defaultBadge+'</div></div></div>'
    +'<button class="modal-close" onclick="closeAgentModal()">\\u2715</button></div>'
    +'<div class="modal-tabs"><button class="modal-tab active" onclick="switchAgentModalTab(\\'info\\',this)">${ICONS.robot} Info & Identity</button>'
    +'<button class="modal-tab" onclick="switchAgentModalTab(\\'skills\\',this)">${ICONS.zap} Skills</button></div>'
    +'<div class="modal-body">'
    +'<div id="agentTabInfo">'
    +'<div class="info-grid">'
    +'<div class="info-row"><span class="info-k">Agent ID</span><span class="info-v" style="font-family:monospace">'+esc(id)+'</span></div>'
    +'<div class="info-row"><span class="info-k">Model</span><span class="info-v">'+esc(a.model||'N/A')+'</span></div>'
    +'<div class="info-row"><span class="info-k">Bindings</span><span class="info-v">'+bindText+'</span></div>'
    +'<div class="info-row"><span class="info-k">Routes</span><span class="info-v">'+esc(routeText)+'</span></div>'
    +'</div>'
    +'<div style="margin-top:20px;padding-top:16px;border-top:1px solid var(--border)">'
    +'<div style="font-weight:600;margin-bottom:12px">Edit Identity</div>'
    +'<div class="field"><label>Display Name</label><input type="text" id="agentModalName" value="'+esc(displayName).replace(/"/g,'&quot;')+'" placeholder="e.g. Support Bot"></div>'
    +'<div class="field"><label>Emoji</label><input type="text" id="agentModalEmoji" value="'+esc(emoji)+'" placeholder="e.g. \\ud83e\\udd16"></div>'
    +'<div class="field"><label>Theme</label><input type="text" id="agentModalTheme" value="'+esc(theme)+'" placeholder="e.g. professional, casual"></div>'
    +'</div>'
    +'<div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border)">'
    +'<div style="font-weight:600;margin-bottom:12px">Model Override</div>'
    +'<div class="field"><label>Per-Agent Model</label><select id="agentModalModel" onchange="toggleAgentCustomModel()">'+modelOpts+'</select></div>'
    +'<div class="field" id="agentCustomModelField" style="display:'+(isCustomAgentModel?'block':'none')+'"><label>Custom Model ID</label><input type="text" id="agentCustomModel" placeholder="e.g. openai/gpt-4o-2024-08-06" value="'+(isCustomAgentModel?esc(a.model):'')+'">'
    +'<div style="font-size:11px;color:var(--text2);margin-top:4px">Format: provider/model-id</div></div>'
    +'</div>'
    +'<div class="btn-row" style="margin-top:16px"><button class="btn btn-primary" onclick="saveAgentFromModal(\\''+escId+'\\')">${ICONS.save} Save Changes</button>'
    +(isDefault?'':'<button class="btn btn-outline" style="color:var(--danger)" onclick="deleteAgent(\\''+escId+'\\')">${ICONS.trash} Delete</button>')
    +'</div><div class="status" id="agentModalStatus"></div>'
    +'</div>'
    +'<div id="agentTabSkills" style="display:none">'
    +'<div style="margin-bottom:12px"><label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:600">'
    +'<input type="checkbox" id="agentUseAllSkills"'+(useAll?' checked':'')+' onchange="toggleAllAgentSkills(this.checked)" style="accent-color:var(--accent)">'
    +' Use all skills (default)</label></div>'
    +'<div id="agentSkillsList" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px">'
    +skillsHtml+'</div>'
    +'<div class="btn-row" style="margin-top:16px"><button class="btn btn-primary" onclick="saveAgentSkills(\\''+escId+'\\')">${ICONS.save} Save Skills</button></div>'
    +'<div class="status" id="agentSkillsStatus"></div>'
    +'</div>'
    +'</div>'
    +'<div class="modal-footer"><span class="status-dot dot-green"></span> Active <span style="margin-left:auto;color:var(--text2);font-size:12px;font-family:monospace">'+esc(id)+'</span></div>'
    +'</div></div>';
}
function closeAgentModal(){const c=document.getElementById('agentModalContainer');if(c)c.innerHTML=''}
function switchAgentModalTab(tab,btn){
  const info=document.getElementById('agentTabInfo'),skills=document.getElementById('agentTabSkills');
  if(!info||!skills)return;
  info.style.display=tab==='info'?'block':'none';
  skills.style.display=tab==='skills'?'block':'none';
  const tabs=btn?btn.parentElement.querySelectorAll('.modal-tab'):[];
  tabs.forEach(t=>t.classList.remove('active'));
  if(btn)btn.classList.add('active');
}
function toggleAllAgentSkills(checked){
  const cbs=document.querySelectorAll('.agent-skill-cb');
  cbs.forEach(cb=>{cb.disabled=checked;if(checked)cb.checked=true});
}
async function saveAgentFromModal(id){
  const st=document.getElementById('agentModalStatus');
  const name=(document.getElementById('agentModalName')||{}).value||'';
  const emoji=(document.getElementById('agentModalEmoji')||{}).value||'';
  const theme=(document.getElementById('agentModalTheme')||{}).value||'';
  let model=(document.getElementById('agentModalModel')||{}).value||'';
  if(model==='__custom__'){model=(document.getElementById('agentCustomModel')||{}).value.trim();if(!model){st.className='status fail';st.textContent='Enter a custom model ID';return}}
  st.className='status loading';st.textContent='Saving...';
  // Save identity
  const idRes=await api('/api/agents/identity','POST',{agent:id,name:name.trim(),emoji:emoji.trim(),theme:theme.trim()});
  if(!idRes.ok){st.className='status fail';st.textContent=idRes.error||'Error saving identity';return}
  // Save model override
  const cfgRes=await api('/api/agents/update-config','POST',{agent:id,model:model});
  if(!cfgRes.ok){st.className='status fail';st.textContent=cfgRes.error||'Error saving model';return}
  st.className='status ok';st.textContent='Saved! Restarting...';
  setTimeout(()=>{closeAgentModal();loadAgents()},2000);
}
async function saveAgentSkills(id){
  const st=document.getElementById('agentSkillsStatus');
  const useAll=document.getElementById('agentUseAllSkills');
  let skills=null;
  if(!useAll||!useAll.checked){
    skills=[];
    document.querySelectorAll('.agent-skill-cb:checked').forEach(cb=>skills.push(cb.value));
  }
  st.className='status loading';st.textContent='Saving skills...';
  const d=await api('/api/agents/update-config','POST',{agent:id,skills:skills});
  st.className=d.ok?'status ok':'status fail';
  st.textContent=d.ok?'Skills saved! Restarting...':d.error||'Error';
  if(d.ok)setTimeout(()=>{closeAgentModal();loadAgents()},2000);
}
function applyAgentTemplate(){
  const sel=document.getElementById('agentTemplate');
  const tpl=AGENT_TEMPLATES[sel.value];
  const nameEl=document.getElementById('newAgentName');
  if(tpl){nameEl.value=tpl.name}else{nameEl.value=''}
}
async function addAgent(){
  const name=document.getElementById('newAgentName').value.trim();
  let model=document.getElementById('newAgentModel').value;
  if(model==='__custom__'){model=(document.getElementById('newAgentCustomModel')||{}).value.trim();if(!model){document.getElementById('addAgentStatus').className='status fail';document.getElementById('addAgentStatus').textContent='Enter a custom model ID';return}}
  const bind=document.getElementById('newAgentBind').value;
  const st=document.getElementById('addAgentStatus');
  const tplKey=document.getElementById('agentTemplate').value;
  if(!name){st.className='status fail';st.textContent='Enter agent name';return}
  if(!/^[a-zA-Z0-9_-]+$/.test(name)){st.className='status fail';st.textContent='Name must contain only letters, numbers, -, _';return}
  if(name.length>32){st.className='status fail';st.textContent='Name too long (max 32 chars)';return}
  st.className='status loading';st.textContent='Adding agent...';
  const d=await api('/api/agents/add','POST',{name,model,bind});
  if(!d.ok){st.className='status fail';st.textContent=d.error||'Error';return}
  // Apply template identity if selected
  const tpl=AGENT_TEMPLATES[tplKey];
  if(tpl){
    await api('/api/agents/identity','POST',{agent:name,name:tpl.name,emoji:tpl.emoji,theme:tpl.theme});
  }
  st.className='status ok';st.textContent='Added agent '+name+'!';
  document.getElementById('newAgentName').value='';
  document.getElementById('agentTemplate').value='';
  setTimeout(loadAgents,1500);
}
async function deleteAgent(agentId){
  if(!confirm('Delete agent "'+agentId+'"? Workspace and state will be deleted. This cannot be undone.'))return;
  const d=await api('/api/agents/delete','DELETE',{agent:agentId});
  if(d.ok){closeAgentModal();loadAgents()}else{alert(d.error||'Error deleting agent')}
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
  let panelUrl=d.domain?'https://'+d.domain+':9443':'http://'+d.serverIP+':9999';
  let gwUrl=d.domain?'https://'+d.domain:'http://'+d.serverIP;
  el.innerHTML='<div class="info-row"><span class="info-k">Domain/IP</span><span class="info-v">'+esc(d.domain||d.serverIP)+'</span></div>'
    +'<div class="info-row"><span class="info-k">SSL</span><span class="info-v">'+(d.domain?"Let\\'s Encrypt":'Self-signed')+'</span></div>'
    +'<div class="info-row"><span class="info-k">Panel URL</span><span class="info-v"><a href="'+esc(panelUrl)+'" style="color:var(--accent)">'+esc(panelUrl)+'</a></span></div>'
    +'<div class="info-row"><span class="info-k">Gateway URL</span><span class="info-v"><a href="'+esc(gwUrl)+'" style="color:var(--accent)">'+esc(gwUrl)+'</a></span></div>';
}
async function saveDomain(){
  const st=document.getElementById('domainStatus'),dm=document.getElementById('domainInput').value.trim(),em=document.getElementById('domainEmail').value.trim();
  if(!dm){st.className='status fail';st.textContent='Enter domain';return}
  st.className='status loading';st.textContent='Configuring Caddy + SSL...';
  const d=await api('/api/domain','POST',{domain:dm,email:em});
  if(d.ok){
    var target='https://'+dm+':9443';
    st.className='status loading';st.textContent='SSL configured! Waiting for HTTPS ready...';
    var attempts=0,maxAttempts=30;
    (function pollReady(){
      attempts++;
      st.textContent='SSL configured! Waiting for HTTPS ready... ('+attempts+'/'+maxAttempts+')';
      fetch(target+'/api/current-config',{mode:'no-cors',cache:'no-store'}).then(function(){
        st.className='status ok';st.textContent='HTTPS ready! Redirecting...';window.location.href=target;
      }).catch(function(){
        if(attempts<maxAttempts){setTimeout(pollReady,2000)}
        else{st.className='status ok';st.textContent='SSL configured! Auto-redirect timed out.';st.innerHTML+=' <a href="'+target+'" style="color:var(--accent)">Open manually</a>'}
      });
    })();
  }else{st.className='status fail';st.textContent=d.error||'Error'}
}
async function resetDomainToIP(){
  if(!confirm('Switch to IP? This will remove SSL configuration.'))return;
  const st=document.getElementById('domainStatus');st.className='status loading';st.textContent='Switching to IP...';
  const d=await api('/api/domain','POST',{resetToIP:true});
  if(d.ok){
    const ip=d.serverIP||location.hostname;
    var target='http://'+ip+':9999';
    st.className='status ok';st.textContent='Switched to IP! Redirecting in 3s...';
    setTimeout(function(){window.location.href=target},3000);
  }else{st.className='status fail';st.textContent=d.error||'Error'}
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
  document.getElementById('updateLog').style.display='block';
  const logBox=document.getElementById('updateLogBox');logBox.textContent='';
  const d=await api('/api/update','POST',{version:v});
  if(!d.ok||!d.taskId){st.className='status fail';st.textContent=d.error||'Failed to start update';return}
  streamTask(d.taskId,logBox,st,function(r){if(r.ok){st.className='status ok';st.textContent='Updated to '+v+' successfully!';loadUpdate()}});
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

// === Browser ===
async function loadBrowserStatus(){
  const el=document.getElementById('browserStatusInfo');const cards=document.getElementById('browserCards');
  const st=document.getElementById('browserStatus');
  el.innerHTML='<div style="color:var(--text2);font-size:13px">Loading...</div>';st.className='';st.textContent='';
  const d=await api('/api/browser/status');
  if(!d.ok){st.className='status fail';st.textContent=d.error||'Error';el.innerHTML='';return}
  const cur=d.current||'none';
  el.innerHTML=
    '<div class="info-row"><span class="info-k">Active Browser</span><span class="info-v">'+(cur==='chrome'?'Google Chrome':cur==='camofox'?'CamoFox':'None')+'</span></div>'+
    '<div class="info-row"><span class="info-k">Chrome</span><span class="info-v">'+(d.chrome.installed?'Installed':'Not installed')+'</span></div>'+
    '<div class="info-row"><span class="info-k">CamoFox</span><span class="info-v">'+(d.camofox.installed?(d.camofox.running?'Running':'Stopped'):'Not installed')+'</span></div>';
  // Render browser cards
  const browsers=[
    {id:'chrome',name:'Google Chrome',desc:'Standard headless Chrome browser. Fast, well-supported, uses CDP protocol.',icon:'${ICONS.globe}',installed:d.chrome.installed,active:d.chrome.active},
    {id:'camofox',name:'CamoFox',desc:'Anti-detection Firefox browser with fingerprint spoofing. REST API on port 9377.',icon:'${ICONS.fox}',installed:d.camofox.installed,active:d.camofox.active,running:d.camofox.running}
  ];
  cards.innerHTML=browsers.map(b=>{
    let badge='',actions='';
    if(b.active){badge='<span style="display:inline-block;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:600;background:#dcfce7;color:#166534">Active</span>'}
    else if(b.installed){badge='<span style="display:inline-block;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:600;background:#dbeafe;color:#1e40af">Installed</span>'}
    else{badge='<span style="display:inline-block;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:600;background:var(--border);color:var(--text2)">Not installed</span>'}
    if(!b.installed){actions='<button class="btn btn-primary" style="width:100%;margin-top:12px" onclick="installBrowser(\\x27'+b.id+'\\x27)">Install & Activate</button>'}
    else if(!b.active){actions='<button class="btn btn-primary" style="margin-top:12px;margin-right:8px" onclick="activateBrowser(\\x27'+b.id+'\\x27)">Activate</button><button class="btn btn-outline" style="margin-top:12px;color:var(--danger)" onclick="uninstallBrowser(\\x27'+b.id+'\\x27)">Uninstall</button>'}
    else{actions='<button class="btn btn-outline" style="margin-top:12px;color:var(--danger)" onclick="uninstallBrowser(\\x27'+b.id+'\\x27)">Uninstall</button>'}
    return '<div style="border:2px solid '+(b.active?'var(--accent)':'var(--border)')+';border-radius:var(--radius);padding:20px;background:var(--card-bg);transition:border-color .2s">'+
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px"><span style="font-size:24px">'+b.icon+'</span>'+badge+'</div>'+
      '<div style="font-size:16px;font-weight:700;margin-bottom:6px;color:var(--text)">'+b.name+'</div>'+
      '<div style="font-size:13px;color:var(--text2);line-height:1.5;min-height:40px">'+b.desc+'</div>'+
      '<div>'+actions+'</div></div>'
  }).join('');
}
async function installBrowser(type){
  if(!confirm('Install '+(type==='chrome'?'Google Chrome':'CamoFox')+'? '+(type==='camofox'?'This may take a few minutes (~300MB download).':'This will download and install Chrome.')))return;
  const st=document.getElementById('browserStatus');const logCard=document.getElementById('browserLogCard');const logBox=document.getElementById('browserLogBox');
  st.className='status loading';st.textContent='Installing '+(type==='chrome'?'Chrome':'CamoFox')+'...';
  logCard.style.display='block';logBox.textContent='';
  const d=await api('/api/browser/install','POST',{browser:type});
  if(!d.ok||!d.taskId){st.className='status fail';st.textContent=d.error||'Failed to start installation';return}
  const name=type==='chrome'?'Chrome':'CamoFox';
  streamTask(d.taskId,logBox,st,function(r){if(r.ok){st.className='status ok';st.textContent=name+' installed and activated!'}loadBrowserStatus()});
}
async function uninstallBrowser(type){
  if(!confirm('Uninstall '+(type==='chrome'?'Google Chrome':'CamoFox')+'? This will remove the browser completely.'))return;
  const st=document.getElementById('browserStatus');const logCard=document.getElementById('browserLogCard');const logBox=document.getElementById('browserLogBox');
  st.className='status loading';st.textContent='Uninstalling '+(type==='chrome'?'Chrome':'CamoFox')+'...';
  logCard.style.display='block';logBox.textContent='';
  const d=await api('/api/browser/uninstall','POST',{browser:type});
  if(!d.ok||!d.taskId){st.className='status fail';st.textContent=d.error||'Failed to start uninstall';return}
  const name=type==='chrome'?'Chrome':'CamoFox';
  streamTask(d.taskId,logBox,st,function(r){if(r.ok){st.className='status ok';st.textContent=name+' uninstalled.'}loadBrowserStatus()});
}
async function activateBrowser(type){
  const st=document.getElementById('browserStatus');
  st.className='status loading';st.textContent='Activating...';
  const d=await api('/api/browser/activate','POST',{browser:type});
  if(d.ok){st.className='status ok';st.textContent=(type==='chrome'?'Chrome':'CamoFox')+' activated!';loadBrowserStatus()}
  else{st.className='status fail';st.textContent=d.error||'Activation failed'}
}

// === Plugins ===
let allPlugins=[];
async function loadPlugins(){
  const el=document.getElementById('pluginsList');const st=document.getElementById('pluginsStatus');
  el.innerHTML='<div style="color:var(--text2);font-size:13px;padding:20px;text-align:center">Loading plugins...</div>';st.className='';st.textContent='';
  const d=await api('/api/plugins');
  if(!d.ok){el.innerHTML='';st.className='status fail';st.textContent=d.error||'Error loading plugins';return}
  allPlugins=d.plugins||[];
  renderPlugins(allPlugins);
}
function filterPluginsUI(){
  const q=(document.getElementById('pluginsSearchInput')||{}).value;
  let list=allPlugins;
  if(q&&q.trim()){
    const lq=q.trim().toLowerCase();
    list=allPlugins.filter(p=>(p.name||p.id||'').toLowerCase().includes(lq)||(p.description||'').toLowerCase().includes(lq));
  }
  renderPlugins(list);
}
function renderPlugins(plugins){
  const el=document.getElementById('pluginsList');const st=document.getElementById('pluginsStatus');
  if(!plugins.length){
    el.innerHTML='<div class="empty-state"><div class="empty-icon">${ICONS.puzzle}</div><div class="empty-text">No plugins found.</div></div>';
    st.className='';st.textContent='';return;
  }
  let h='<div class="skill-grid">';
  plugins.forEach(p=>{
    const isOn=p.status==='loaded'||p.enabled;
    const cardClass='skill-card'+(isOn?' enabled':'');
    const badge=isOn?'<span class="badge bg-green">Loaded</span>':'<span class="badge" style="background:#fee2e2;color:#dc2626">Disabled</span>';
    const originBadge=p.origin==='bundled'?'<span style="font-size:10px;color:var(--text2);background:var(--border);padding:1px 6px;border-radius:4px">bundled</span>'
      :p.origin==='npm'?'<span style="font-size:10px;color:#7c3aed;background:#ede9fe;padding:1px 6px;border-radius:4px">npm</span>'
      :'<span style="font-size:10px;color:var(--text2);background:var(--border);padding:1px 6px;border-radius:4px">'+esc(p.origin||'custom')+'</span>';
    const ver=p.version?'<span style="font-size:10px;color:var(--text2);background:var(--border);padding:1px 6px;border-radius:4px">v'+esc(p.version)+'</span>':'';
    // Details summary
    let detailParts=[];
    if(p.channelIds&&p.channelIds.length)detailParts.push(p.channelIds.length+' channel'+(p.channelIds.length>1?'s':''));
    if(p.toolNames&&p.toolNames.length)detailParts.push(p.toolNames.length+' tool'+(p.toolNames.length>1?'s':''));
    const detailLine=detailParts.length?'<div style="font-size:11px;color:var(--accent);margin-top:6px;display:flex;align-items:center;gap:4px">${ICONS.wrench} '+esc(detailParts.join(' \u2022 '))+'</div>':'';
    const toggleHtml='<label class="toggle-switch" onclick="event.stopPropagation()"><input type="checkbox" '+(isOn?'checked':'')+' onchange="togglePlugin(\\''+esc(p.id).replace(/'/g,"\\\\'")+'\\'  ,!this.checked)"><span class="toggle-slider"></span></label>';
    h+='<div class="'+cardClass+'" onclick="showPluginDetail(\\''+esc(p.id).replace(/'/g,"\\\\'")+'\\')">'
      +'<div style="display:flex;justify-content:space-between;align-items:flex-start">'
      +'<div style="display:flex;align-items:center;gap:12px"><span class="skill-emoji">'+(p.icon||'\ud83e\udde9')+'</span>'
      +'<div><div class="skill-name">'+esc(p.name||p.id)+'</div>'
      +'<div class="skill-badges">'+badge+' '+originBadge+' '+ver+'</div></div></div>'
      +toggleHtml
      +'</div>'
      +'<div class="skill-desc">'+esc(p.description||'No description')+'</div>'
      +detailLine
      +'</div>';
  });
  h+='</div>';
  el.innerHTML=h;
  const loaded=plugins.filter(p=>p.status==='loaded'||p.enabled).length;
  st.className='';st.textContent='';
}
function showPluginDetail(id){
  const p=allPlugins.find(pl=>pl.id===id);
  if(!p)return;
  const container=document.getElementById('pluginModalContainer');
  if(!container)return;
  const isOn=p.status==='loaded'||p.enabled;
  const badge=isOn?'<span class="badge bg-green">Loaded</span>':'<span class="badge" style="background:#fee2e2;color:#dc2626">Disabled</span>';
  const originBadge=p.origin==='bundled'?'<span class="badge" style="background:var(--border);color:var(--text2)">Bundled</span>'
    :p.origin==='npm'?'<span class="badge" style="background:#ede9fe;color:#7c3aed">npm</span>'
    :'<span class="badge" style="background:var(--border);color:var(--text2)">'+esc(p.origin||'custom')+'</span>';
  let detailsHtml='';
  if(p.channelIds&&p.channelIds.length)detailsHtml+='<div class="info-row"><span class="info-k">Channels</span><span class="info-v">'+p.channelIds.map(c=>esc(c)).join(', ')+'</span></div>';
  if(p.providerIds&&p.providerIds.length)detailsHtml+='<div class="info-row"><span class="info-k">Providers</span><span class="info-v">'+p.providerIds.map(pr=>esc(pr)).join(', ')+'</span></div>';
  if(p.toolNames&&p.toolNames.length)detailsHtml+='<div class="info-row"><span class="info-k">Tools</span><span class="info-v" style="font-size:11px">'+p.toolNames.map(t=>esc(t)).join(', ')+'</span></div>';
  const statusDot=isOn?'<span class="status-dot dot-green"></span> <span style="color:#16a34a;font-weight:600;font-size:13px">Loaded</span>'
    :'<span class="status-dot dot-red"></span> <span style="color:#dc2626;font-weight:600;font-size:13px">Disabled</span>';
  const toggleHtml='<label class="toggle-switch"><input type="checkbox" '+(isOn?'checked':'')+' onchange="togglePlugin(\\''+esc(p.id).replace(/'/g,"\\\\'")+'\\'  ,'+(isOn?'false':'true')+');closePluginModal()"><span class="toggle-slider"></span></label>';
  const actionBtns=[];
  if(p.origin==='npm')actionBtns.push('<button class="btn btn-outline btn-sm" onclick="updatePlugin(\\''+esc(p.id).replace(/'/g,"\\\\'")+'\\'  );closePluginModal()">${ICONS.arrowUp} Update</button>');
  if(p.origin!=='bundled')actionBtns.push('<button class="btn btn-outline btn-sm" style="border-color:#fecaca;color:#ef4444" onclick="uninstallPlugin(\\''+esc(p.id).replace(/'/g,"\\\\'")+'\\'  );closePluginModal()">${ICONS.trash} Uninstall</button>');

  container.innerHTML='<div class="modal-overlay" onclick="closePluginModal()">'
    +'<div class="modal-card" onclick="event.stopPropagation()">'
    +'<div class="modal-header">'
    +'<div style="display:flex;align-items:center;gap:16px"><span style="font-size:42px">'+(p.icon||'\ud83e\udde9')+'</span>'
    +'<div><div style="font-size:18px;font-weight:800;color:var(--text)">'+esc(p.name||p.id)+'</div>'
    +'<div style="display:flex;gap:8px;margin-top:6px;align-items:center">'+badge+' '+originBadge+(p.version?' <span style="font-size:12px;color:var(--text2)">v'+esc(p.version)+'</span>':'')+'</div></div></div>'
    +'<button class="modal-close" onclick="closePluginModal()">\u2715</button>'
    +'</div>'
    +'<div class="modal-body">'
    +'<div style="font-size:14px;color:var(--text);line-height:1.7;margin-bottom:16px">'+esc(p.description||'No description available.')+'</div>'
    +'<div class="info-grid">'+detailsHtml+'</div>'
    +(actionBtns.length?'<div class="btn-row" style="margin-top:16px">'+actionBtns.join('')+'</div>':'')
    +'</div>'
    +'<div class="modal-footer">'
    +'<div style="display:flex;align-items:center;gap:8px">'+statusDot+'</div>'
    +'<div style="display:flex;align-items:center;gap:8px">'+toggleHtml+'</div>'
    +'</div>'
    +'</div></div>';
}
function closePluginModal(){
  const c=document.getElementById('pluginModalContainer');if(c)c.innerHTML='';
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
let skillsFilterMode='all';

async function loadSkills(){
  const el=document.getElementById('skillsList');const st=document.getElementById('skillsStatus');const sum=document.getElementById('skillsSummary');
  el.innerHTML='<div style="color:var(--text2);font-size:13px;padding:20px;text-align:center">Loading skills...</div>';st.className='';st.textContent='';
  const d=await api('/api/skills');
  if(!d.ok){el.innerHTML='';st.className='status fail';st.textContent=d.error||'Error loading skills';return}
  allSkills=d.skills||[];
  const total=allSkills.length,eligible=allSkills.filter(s=>s.eligible&&!s.disabled).length,disabled=allSkills.filter(s=>s.disabled).length,missing=allSkills.filter(s=>!s.eligible&&!s.disabled).length;
  const canInstall=allSkills.filter(s=>!s.eligible&&!s.disabled&&s.installs&&s.installs.some(function(i){return i.supported})).length;
  // Stat cards
  sum.innerHTML='<div class="stat-card blue"><div class="stat-num">'+total+'</div><div class="stat-label">Total</div></div>'
    +'<div class="stat-card green"><div class="stat-num">'+eligible+'</div><div class="stat-label">Active</div></div>'
    +'<div class="stat-card red"><div class="stat-num">'+disabled+'</div><div class="stat-label">Disabled</div></div>'
    +'<div class="stat-card amber"><div class="stat-num">'+missing+'</div><div class="stat-label">Missing</div></div>';
  // Filter pills
  renderSkillFilterPills(total,eligible,disabled,missing,canInstall);
  filterSkills();
  loadClawHubInstalled();
}

function renderSkillFilterPills(total,eligible,disabled,missing,canInstall){
  const el=document.getElementById('skillsFilterPills');
  if(!el)return;
  const pills=[
    {key:'all',label:'All',count:total},
    {key:'eligible',label:'Eligible',count:eligible},
    {key:'installable',label:'\\u26A1 Can Install',count:canInstall||0},
    {key:'disabled',label:'Disabled',count:disabled},
    {key:'missing',label:'Missing Reqs',count:missing}
  ];
  el.innerHTML=pills.map(p=>
    '<button class="filter-pill'+(skillsFilterMode===p.key?' active':'')+'" onclick="setSkillFilter(\\''+p.key+'\\')">'+p.label+'<span class="pill-count">'+p.count+'</span></button>'
  ).join('');
}

function setSkillFilter(mode){
  skillsFilterMode=mode;
  filterSkills();
  // Update pill active states
  document.querySelectorAll('#skillsFilterPills .filter-pill').forEach(el=>{
    el.classList.toggle('active',el.textContent.toLowerCase().startsWith(mode==='all'?'all':mode==='eligible'?'elig':mode==='disabled'?'dis':'miss'));
  });
  // Simpler: re-render pills
  const total=allSkills.length,eligible=allSkills.filter(s=>s.eligible&&!s.disabled).length,disabled=allSkills.filter(s=>s.disabled).length,missing=allSkills.filter(s=>!s.eligible&&!s.disabled).length;
  const canInstall=allSkills.filter(s=>!s.eligible&&!s.disabled&&s.installs&&s.installs.some(function(i){return i.supported})).length;
  renderSkillFilterPills(total,eligible,disabled,missing,canInstall);
}

function filterSkills(){
  let list=allSkills;
  if(skillsFilterMode==='eligible')list=allSkills.filter(s=>s.eligible&&!s.disabled);
  else if(skillsFilterMode==='disabled')list=allSkills.filter(s=>s.disabled);
  else if(skillsFilterMode==='missing')list=allSkills.filter(s=>!s.eligible&&!s.disabled);
  else if(skillsFilterMode==='installable')list=allSkills.filter(s=>!s.eligible&&!s.disabled&&s.installs&&s.installs.some(function(i){return i.supported}));
  // Text search
  const q=(document.getElementById('skillsSearchInput')||{}).value;
  if(q&&q.trim()){
    const lq=q.trim().toLowerCase();
    list=list.filter(s=>(s.name||'').toLowerCase().includes(lq)||(s.description||'').toLowerCase().includes(lq));
  }
  renderSkills(list);
}

function renderSkills(skills){
  const el=document.getElementById('skillsList');const st=document.getElementById('skillsStatus');
  if(!skills.length){
    el.innerHTML='<div class="empty-state"><div class="empty-icon">${ICONS.search}</div><div class="empty-text">No skills match this filter.</div></div>';
    st.className='';st.textContent='';return;
  }
  let h='<div class="skill-grid">';
  skills.forEach(s=>{
    const isEnabled=s.eligible&&!s.disabled;
    const isMissing=!s.eligible&&!s.disabled;
    const hasMacOS=s.missing&&s.missing.os&&s.missing.os.includes('darwin');
    const hasConfigOnly=isMissing&&s.missing&&s.missing.config&&s.missing.config.length&&!(s.missing.bins&&s.missing.bins.length)&&!(s.missing.anyBins&&s.missing.anyBins.length)&&!(s.missing.env&&s.missing.env.length);
    const cardClass='skill-card'+(isEnabled?' enabled':'')+(s.disabled?' disabled-card':'');
    const badge=s.disabled?'<span class="badge" style="background:#fee2e2;color:#dc2626">Disabled</span>'
      :s.eligible?'<span class="badge bg-green">Eligible</span>'
      :hasMacOS?'<span class="badge" style="background:#e5e7eb;color:#6b7280">macOS Only</span>'
      :hasConfigOnly?'<span class="badge" style="background:#dbeafe;color:#2563eb">Setup Required</span>'
      :'<span class="badge" style="background:#fef3c7;color:#b45309">Missing Deps</span>';
    const src='<span style="font-size:10px;color:var(--text2);background:var(--border);padding:1px 6px;border-radius:4px">'+esc(s.source||'bundled')+'</span>';
    let missingHtml='';
    if(s.missing&&isMissing){
      const parts=[];
      if(hasMacOS){parts.push('Requires macOS')}
      else{
        if(s.missing.bins&&s.missing.bins.length)parts.push('Need: '+s.missing.bins.join(', '));
        if(s.missing.anyBins&&s.missing.anyBins.length)parts.push('Any of: '+s.missing.anyBins.join(' / '));
        if(s.missing.env&&s.missing.env.length)parts.push('Env: '+s.missing.env.map(function(e){return e+(s.envStatus&&s.envStatus[e]==='set'?' \\u2705':'')}).join(', '));
        if(s.missing.config&&s.missing.config.length)parts.push(s.missing.config.map(function(c){return c.replace('channels.','')}).join(', '));
      }
      if(parts.length)missingHtml='<div class="skill-missing">${ICONS.warning} '+esc(parts.join(' \\u2022 '))+'</div>';
      if(!hasMacOS){
        var btns='';
        if(s.installs&&s.installs.length){
          s.installs.forEach(function(inst){
            if(inst.supported){
              btns+='<button class="btn btn-sm" style="font-size:11px;padding:3px 12px;background:#16a34a;color:#fff;border-color:#16a34a" data-skill="'+esc(s.name)+'" data-install="'+esc(inst.id)+'" onclick="event.stopPropagation();runSkillInstall(this)">${ICONS.download} '+esc(inst.label)+'</button>';
            }
          });
        }
        if(s.homepage)btns+='<a href="'+esc(s.homepage)+'" target="_blank" rel="noopener" class="btn btn-sm" style="font-size:11px;padding:3px 12px;text-decoration:none;display:inline-flex;align-items:center;gap:4px" onclick="event.stopPropagation()">${ICONS.link} Install Guide</a>';
        else if(hasConfigOnly)btns+='<button class="btn btn-sm" style="font-size:11px;padding:3px 12px" onclick="event.stopPropagation();showTab(\\'channels\\')">\\u2699\\uFE0F Configure Channel</button>';
        if(btns)missingHtml+='<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">'+btns+'</div>';
      }
    }
    const canToggle=!hasMacOS;
    const isActive=!s.disabled;
    const toggleHtml=canToggle?'<label class="toggle-switch" onclick="event.stopPropagation()"><input type="checkbox" '+(isActive?'checked':'')+' onchange="toggleSkill(\\''+esc(s.name).replace(/'/g,"\\\\'")+'\\'  ,!this.checked)"><span class="toggle-slider"></span></label>':'';
    h+='<div class="'+cardClass+'" onclick="showSkillDetail(\\''+esc(s.name).replace(/'/g,"\\\\'")+'\\')">'
      +'<div style="display:flex;justify-content:space-between;align-items:flex-start">'
      +'<div style="display:flex;align-items:center;gap:12px"><span class="skill-emoji">'+(s.emoji||'\ud83e\udde9')+'</span>'
      +'<div><div class="skill-name">'+esc(s.name)+'</div><div class="skill-badges">'+badge+' '+src+'</div></div></div>'
      +toggleHtml
      +'</div>'
      +'<div class="skill-desc">'+esc(s.description||'No description')+'</div>'
      +missingHtml
      +'</div>';
  });
  h+='</div>';
  el.innerHTML=h;
  st.className='';st.textContent='';
}

async function toggleSkill(name,disable){
  const st=document.getElementById('skillsStatus');st.className='status loading';st.textContent=(disable?'Disabling':'Enabling')+' '+name+'...';
  const d=await api('/api/skills/toggle','POST',{name,disable});
  st.className=d.ok?'status ok':'status fail';st.textContent=d.ok?(disable?'Disabled':'Enabled')+' '+name+'. Restarting...':d.error||'Error';
  if(d.ok)setTimeout(loadSkills,2000);
}

async function runSkillInstall(el){
  var skill=el.getAttribute('data-skill');
  var installId=el.getAttribute('data-install');
  if(!skill||!installId)return;
  var label=el.textContent.trim();
  var st=document.getElementById('skillsStatus');
  var logCard=document.getElementById('skillsLogCard');
  var logBox=document.getElementById('skillsLogBox');
  st.className='status loading';st.textContent='Installing: '+label+'...';
  el.disabled=true;el.style.opacity='0.5';
  // Remove old inline error if any
  var oldErr=el.parentElement.querySelector('.skill-install-error');
  if(oldErr)oldErr.remove();
  var d=await api('/api/skills/run-install','POST',{skill:skill,installId:installId});
  if(d.ok&&d.taskId){
    // Show dedicated log card and stream
    logCard.style.display='block';logBox.textContent='';
    logCard.scrollIntoView({behavior:'smooth',block:'center'});
    streamTask(d.taskId,logBox,st,function(r){
      el.disabled=false;el.style.opacity='';
      if(r.ok){
        st.className='status ok';st.textContent='Installed! Refreshing skills...';
        setTimeout(function(){logCard.style.display='none';loadSkills()},2000);
      } else {
        st.className='status fail';st.textContent='Install failed';
      }
    });
  } else if(!d.ok){
    el.disabled=false;el.style.opacity='';
    st.className='status fail';st.textContent='Install failed';
    var errDiv=document.createElement('div');
    errDiv.className='skill-install-error';
    errDiv.style.cssText='margin-top:6px;padding:8px 12px;background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;font-size:12px;color:#991b1b;line-height:1.5';
    errDiv.innerHTML=esc(d.error||'Unknown error');
    if(d.needsBrew||d.needsTool){
      var toolBtn=document.createElement('button');
      toolBtn.className='btn btn-sm';
      toolBtn.style.cssText='margin-top:8px;background:#f59e0b;color:#fff;border-color:#f59e0b;padding:4px 14px;font-size:12px';
      if(d.needsBrew){
        toolBtn.innerHTML='\\ud83c\\udf7a Install Homebrew, then retry';
        toolBtn.onclick=function(){installToolThenRetry(el,toolBtn,'brew')};
      } else {
        toolBtn.innerHTML='\\ud83d\\udce6 Install '+d.needsTool+', then retry';
        toolBtn.onclick=function(){installToolThenRetry(el,toolBtn,d.needsTool)};
      }
      errDiv.appendChild(toolBtn);
    }
    el.parentElement.appendChild(errDiv);
  }
}
async function installToolThenRetry(origBtn,toolBtn,tool){
  var st=document.getElementById('skillsStatus');
  var logCard=document.getElementById('skillsLogCard');
  var logBox=document.getElementById('skillsLogBox');
  var label=tool==='brew'?'Homebrew':tool;
  var errDiv=toolBtn.parentElement;
  toolBtn.disabled=true;toolBtn.style.opacity='0.5';
  toolBtn.textContent='Installing '+label+'...';
  st.className='status loading';st.textContent='Installing '+label+'...';
  // Show dedicated log card
  logCard.style.display='block';logBox.textContent='Connecting...\\n';
  logCard.scrollIntoView({behavior:'smooth',block:'center'});
  var d=await api('/api/skills/install-tool','POST',{tool:tool});
  if(d.skipped){
    st.className='status ok';st.textContent=label+' already installed! Retrying skill install...';
    logCard.style.display='none';
    if(errDiv)errDiv.remove();
    await new Promise(function(r){setTimeout(r,500)});
    runSkillInstall(origBtn);
    return;
  }
  if(!d.ok||!d.taskId){
    st.className='status fail';st.textContent=d.error||label+' install failed';
    toolBtn.disabled=false;toolBtn.style.opacity='';
    toolBtn.textContent='Retry Install '+label;
    logCard.style.display='none';
    return;
  }
  // Stream task logs in real-time in the dedicated log card
  streamTask(d.taskId,logBox,st,function(r){
    if(r.ok){
      st.className='status ok';st.textContent=label+' installed! Retrying skill install...';
      toolBtn.textContent=label+' installed! Retrying...';
      setTimeout(function(){
        logCard.style.display='none';
        if(errDiv)errDiv.remove();
        runSkillInstall(origBtn);
      },1500);
    } else {
      toolBtn.disabled=false;toolBtn.style.opacity='';
      toolBtn.textContent='Retry Install '+label;
    }
  });
}

async function saveSkillEnv(btn,key){
  var inp=document.getElementById('env_'+key);
  if(!inp||!inp.value.trim()){inp&&inp.focus();return}
  var st=document.getElementById('skillsStatus');
  btn.disabled=true;btn.textContent='Saving...';
  st.className='status loading';st.textContent='Saving '+key+'...';
  var d=await api('/api/skills/set-env','POST',{key:key,value:inp.value.trim()});
  if(d.ok){
    st.className='status ok';st.textContent=key+' saved! Refreshing...';
    inp.value='';inp.placeholder='\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022 (already set)';
    inp.style.borderColor='#86efac';inp.style.background='#f0fdf4';
    btn.textContent='\\u2705 Update';btn.style.background='#16a34a';btn.style.borderColor='#16a34a';
    btn.disabled=false;
    setTimeout(function(){closeSkillModal();loadSkills()},1500);
  } else {
    st.className='status fail';st.textContent=d.error||'Failed to save';
    btn.disabled=false;btn.textContent='\\ud83d\\udcbe Save';
  }
}
async function removeSkillEnv(btn,key){
  if(!confirm('Remove '+key+'?'))return;
  var st=document.getElementById('skillsStatus');
  btn.disabled=true;st.className='status loading';st.textContent='Removing '+key+'...';
  var d=await api('/api/skills/set-env','POST',{key:key,value:''});
  if(d.ok){
    st.className='status ok';st.textContent=key+' removed! Refreshing...';
    setTimeout(function(){closeSkillModal();loadSkills()},1500);
  } else {
    st.className='status fail';st.textContent=d.error||'Failed to remove';
    btn.disabled=false;
  }
}

function showSkillDetail(name){
  const s=allSkills.find(sk=>sk.name===name);
  if(!s)return;
  const container=document.getElementById('skillModalContainer');
  if(!container)return;
  const isEnabled=s.eligible&&!s.disabled;
  const isMac=s.missing&&s.missing.os&&s.missing.os.includes('darwin');
  const hasConfigOnly2=!s.eligible&&!s.disabled&&s.missing&&s.missing.config&&s.missing.config.length&&!(s.missing.bins&&s.missing.bins.length)&&!(s.missing.anyBins&&s.missing.anyBins.length)&&!(s.missing.env&&s.missing.env.length);
  const badge=s.disabled?'<span class="badge" style="background:#fee2e2;color:#dc2626">Disabled</span>'
    :s.eligible?'<span class="badge bg-green">Eligible</span>'
    :isMac?'<span class="badge" style="background:#e5e7eb;color:#6b7280">macOS Only</span>'
    :hasConfigOnly2?'<span class="badge" style="background:#dbeafe;color:#2563eb">Setup Required</span>'
    :'<span class="badge" style="background:#fef3c7;color:#b45309">Missing Deps</span>';
  const src=s.source||'bundled';
  const srcBadge=src==='bundled'?'<span class="badge" style="background:var(--border);color:var(--text2)">Bundled</span>'
    :src==='npm'?'<span class="badge" style="background:#ede9fe;color:#7c3aed">npm</span>'
    :'<span class="badge" style="background:var(--border);color:var(--text2)">'+esc(src)+'</span>';
  let missingHtml='';
  if(s.missing&&!s.eligible){
    const parts=[];
    if(isMac){parts.push('<strong>OS:</strong> Requires macOS \\u2014 not available on Linux')}
    else{
      if(s.missing.bins&&s.missing.bins.length)parts.push('<strong>Binaries:</strong> '+s.missing.bins.map(function(b){var canInst=s.installs&&s.installs.some(function(i){return i.supported&&i.bins&&i.bins.indexOf(b)>=0});return '<code>'+esc(b)+'</code>'+(canInst?' <span style="color:#16a34a;font-size:11px">(auto-installable)</span>':'')}).join(', '));
      if(s.missing.anyBins&&s.missing.anyBins.length)parts.push('<strong>Any of:</strong> '+s.missing.anyBins.map(function(b){var canInst=s.installs&&s.installs.some(function(i){return i.supported&&i.bins&&i.bins.indexOf(b)>=0});return '<code>'+esc(b)+'</code>'+(canInst?' <span style="color:#16a34a;font-size:11px">(auto-installable)</span>':'')}).join(', '));
      if(s.missing.env&&s.missing.env.length){
        var envHtml='<strong>Env vars:</strong><div style="margin-top:6px">';
        s.missing.env.forEach(function(e){
          var isSet=s.envStatus&&s.envStatus[e]==='set';
          envHtml+='<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">'
            +'<code style="min-width:140px;font-size:12px">'+esc(e)+'</code>'
            +'<input type="text" id="env_'+esc(e)+'" placeholder="'+(isSet?'\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022 (already set)':'Enter value...')+'" style="flex:1;padding:4px 8px;border:1px solid '+(isSet?'#86efac':'var(--border)')+';border-radius:6px;font-size:12px;background:'+(isSet?'#f0fdf4':'var(--bg)')+';font-family:monospace">'
            +'<button class="btn btn-sm" style="padding:4px 12px;font-size:11px;background:'+(isSet?'#16a34a':'var(--accent)')+';color:#fff;border-color:'+(isSet?'#16a34a':'var(--accent)')+'" onclick="saveSkillEnv(this,\\''+esc(e)+'\\')">'+( isSet?'\\u2705 Update':'\\ud83d\\udcbe Save')+'</button>'
            +(isSet?'<button class="btn btn-sm" style="padding:4px 8px;font-size:11px;background:#fee2e2;color:#dc2626;border-color:#fca5a5" onclick="removeSkillEnv(this,\\''+esc(e)+'\\')">\\u2716</button>':'')
            +'</div>';
        });
        envHtml+='</div>';
        parts.push(envHtml);
      }
      if(s.missing.config&&s.missing.config.length)parts.push('<strong>Config:</strong> '+s.missing.config.map(function(c){return '<code>'+esc(c)+'</code>'}).join(', '));
    }
    if(parts.length){
      missingHtml='<div style="background:#fef3c7;border:1px solid #f59e0b;border-radius:10px;padding:12px 16px;margin-top:12px"><div style="font-size:13px;font-weight:700;color:#92400e;margin-bottom:6px">${ICONS.warning} Missing Requirements</div><div style="font-size:12px;color:#92400e;line-height:1.6">'+parts.join('<br>')+'</div>';
      if(!isMac){
        var mBtns='<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">';
        if(s.installs&&s.installs.length){
          s.installs.forEach(function(inst){
            if(inst.supported){
              mBtns+='<button class="btn btn-sm" style="background:#16a34a;color:#fff;border-color:#16a34a;padding:5px 16px" data-skill="'+esc(s.name)+'" data-install="'+esc(inst.id)+'" onclick="runSkillInstall(this);closeSkillModal()">${ICONS.download} '+esc(inst.label)+'</button>';
            } else {
              mBtns+='<span class="btn btn-sm" style="padding:5px 16px;opacity:0.6;cursor:default" title="'+esc(inst.kind)+' not available on Linux">'+esc(inst.label)+' <span style="font-size:10px">('+esc(inst.kind)+')</span></span>';
            }
          });
        }
        if(s.homepage)mBtns+='<a href="'+esc(s.homepage)+'" target="_blank" rel="noopener" class="btn btn-sm" style="padding:5px 16px;text-decoration:none;display:inline-flex;align-items:center;gap:4px">${ICONS.link} Installation Guide</a>';
        if(s.missing.config&&s.missing.config.length&&!s.missing.bins.length&&!s.missing.anyBins.length)mBtns+='<button class="btn btn-sm" style="padding:5px 16px" onclick="showTab(\\'channels\\');closeSkillModal()">\\u2699\\uFE0F Go to Channels</button>';
        mBtns+='</div>';
        missingHtml+=mBtns;
      }
      missingHtml+='</div>';
    }
  }
  const docsLink=s.homepage?'<a href="'+esc(s.homepage)+'" target="_blank" rel="noopener" style="font-size:13px;color:var(--accent);text-decoration:none;display:inline-flex;align-items:center;gap:4px">${ICONS.link} Documentation</a>':'';
  const canToggle=!isMac;
  const isActive2=!s.disabled;
  const toggleHtml=canToggle?'<label class="toggle-switch"><input type="checkbox" '+(isActive2?'checked':'')+' onchange="toggleSkill(\\''+esc(name).replace(/'/g,"\\\\'")+'\\'  ,!this.checked);closeSkillModal()"><span class="toggle-slider"></span></label>':'';
  const statusDot=isEnabled?'<span class="status-dot dot-green"></span> <span style="color:#16a34a;font-weight:600;font-size:13px">Enabled</span>'
    :s.disabled?'<span class="status-dot dot-red"></span> <span style="color:#dc2626;font-weight:600;font-size:13px">Disabled</span>'
    :isMac?'<span class="status-dot" style="background:#9ca3af"></span> <span style="color:#6b7280;font-weight:600;font-size:13px">macOS Only</span>'
    :hasConfigOnly2?'<span class="status-dot" style="background:#3b82f6"></span> <span style="color:#2563eb;font-weight:600;font-size:13px">Setup Required</span>'
    :'<span class="status-dot dot-amber"></span> <span style="color:#d97706;font-weight:600;font-size:13px">Missing Dependencies</span>';

  container.innerHTML='<div class="modal-overlay" onclick="closeSkillModal()">'
    +'<div class="modal-card" onclick="event.stopPropagation()">'
    +'<div class="modal-header">'
    +'<div style="display:flex;align-items:center;gap:16px"><span style="font-size:42px">'+(s.emoji||'\ud83e\udde9')+'</span>'
    +'<div><div style="font-size:18px;font-weight:800;color:var(--text)">'+esc(s.name)+'</div>'
    +'<div style="display:flex;gap:8px;margin-top:6px;align-items:center">'+badge+' '+srcBadge+'</div></div></div>'
    +'<button class="modal-close" onclick="closeSkillModal()">\u2715</button>'
    +'</div>'
    +'<div class="modal-body">'
    +'<div style="font-size:14px;color:var(--text);line-height:1.7;margin-bottom:16px">'+esc(s.description||'No description available.')+'</div>'
    +'<div class="info-grid" style="margin-bottom:12px">'
    +(s.version?'<div class="info-row"><span class="info-k">Version</span><span class="info-v">'+esc(s.version)+'</span></div>':'')
    +(s.author?'<div class="info-row"><span class="info-k">Author</span><span class="info-v">'+esc(s.author)+'</span></div>':'')
    +'<div class="info-row"><span class="info-k">Source</span><span class="info-v">'+esc(src)+'</span></div>'
    +'<div class="info-row"><span class="info-k">Status</span><span class="info-v">'+statusDot+'</span></div>'
    +'</div>'
    +docsLink
    +missingHtml
    +'</div>'
    +'<div class="modal-footer">'
    +'<div style="display:flex;align-items:center;gap:8px">'+statusDot+'</div>'
    +'<div style="display:flex;align-items:center;gap:8px">'+toggleHtml+'</div>'
    +'</div>'
    +'</div></div>';
}
function closeSkillModal(){
  const c=document.getElementById('skillModalContainer');if(c)c.innerHTML='';
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
  let h='<div class="skill-grid" style="margin-top:8px">';
  results.forEach(r=>{
    const name=r.name||r.slug;
    const ver=r.version?'v'+esc(r.version):'';
    const author=r.author?' \u2022 '+esc(r.author):'';
    const desc=r.description?'<div class="market-desc">'+esc(r.description)+'</div>':'';
    const downloads=r.downloads!==undefined?'<span>>${ICONS.download}</span> '+Number(r.downloads).toLocaleString()+'</span>':'';
    const stars=r.stars!==undefined?'<span>>${ICONS.star}</span> '+Number(r.stars).toLocaleString()+'</span>':'';
    const statsHtml=(downloads||stars)?'<div class="market-stats">'+downloads+stars+'</div>':'';
    h+='<div class="market-card">'
      +'<div style="display:flex;justify-content:space-between;align-items:flex-start">'
      +'<div style="display:flex;align-items:center;gap:12px">'
      +'<div class="market-icon">${ICONS.package}</div>'
      +'<div><div class="market-name">'+esc(name)+'</div>'
      +'<div class="market-meta">'+ver+author+'</div></div></div>'
      +'<button class="btn btn-primary btn-sm" style="flex-shrink:0" onclick="event.stopPropagation();installClawHubSkill(\\''+esc(r.slug).replace(/'/g,"\\\\'")+'\\')">${ICONS.download} Install</button>'
      +'</div>'
      +desc
      +statsHtml
      +'</div>';
  });
  h+='</div>';
  el.innerHTML=h;
  st.className='status ok';st.textContent=results.length+' result(s) found.';
}
async function installClawHubSkill(slug){
  if(!confirm('Install skill "'+slug+'" from ClawHub?'))return;
  const st=document.getElementById('clawhubStatus');
  const logCard=document.getElementById('skillsLogCard');
  const logBox=document.getElementById('skillsLogBox');
  st.className='status loading';st.textContent='Installing '+slug+'...';
  const d=await api('/api/clawhub/install','POST',{slug});
  if(d.ok&&d.taskId){
    logCard.style.display='block';logBox.textContent='';
    logCard.scrollIntoView({behavior:'smooth',block:'center'});
    streamTask(d.taskId,logBox,st,function(r){
      if(r.ok){
        st.className='status ok';st.textContent='Installed '+slug+'!';
        setTimeout(function(){logCard.style.display='none';loadClawHubInstalled();loadSkills()},2000);
      } else {
        st.className='status fail';st.textContent=r.error||'Install failed';
      }
    });
  } else {
    st.className='status fail';st.textContent=d.error||'Install failed';
  }
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
function clawhubStream(slug,action,apiPath,body){
  var st=document.getElementById('clawhubInstalledStatus');
  var logCard=document.getElementById('skillsLogCard');
  var logBox=document.getElementById('skillsLogBox');
  var label=action+' '+slug;
  st.className='status loading';st.textContent=label+'...';
  logCard.style.display='block';logBox.textContent='';
  logCard.scrollIntoView({behavior:'smooth',block:'center'});
  api(apiPath,'POST',body).then(function(d){
    if(d.ok&&d.taskId){
      streamTask(d.taskId,logBox,st,function(r){
        if(r.ok){
          st.className='status ok';st.textContent=label+' done!';
          setTimeout(function(){logCard.style.display='none';loadClawHubInstalled();loadSkills()},2000);
        } else {st.className='status fail';st.textContent=r.error||'Failed'}
      });
    } else {st.className='status fail';st.textContent=d.error||'Failed';logCard.style.display='none'}
  });
}
function uninstallClawHubSkill(slug){
  if(!confirm('Uninstall skill "'+slug+'"?'))return;
  clawhubStream(slug,'Uninstalling','/api/clawhub/uninstall',{slug:slug});
}
function updateClawHubSkill(slug){
  clawhubStream(slug,'Updating','/api/clawhub/update',{slug:slug});
}
function updateAllClawHub(){
  if(!confirm('Update all ClawHub skills?'))return;
  clawhubStream('all skills','Updating','/api/clawhub/update',{slug:'--all'});
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
async function loadLogs(){const d=await api('/api/logs');const box=document.getElementById('logsBox');box.textContent=d.ok?d.logs:'Error';box.scrollTop=box.scrollHeight}
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
    h+='<div class="fb-item"><div class="fb-icon">'+(pp?pp.icon:'${ICONS.sparkles}')+'</div><div class="fb-info"><div class="fb-name">'+(pp?pp.name:d.primaryProvider)+'</div><div class="fb-model">'+(d.primaryModel||'')+'</div></div><span class="fb-badge primary">PRIMARY</span><div class="fb-status-dot active" title="Active"></div></div>';
  }
  chain.forEach((c,i)=>{
    if(c.provider===d.primaryProvider)return;
    const pp=PROV_LIST_FB.find(p=>p.key===c.provider);
    const hasKey=c.hasKey;
    h+='<div class="fb-item"><div class="fb-icon">'+(pp?pp.icon:'${ICONS.sparkles}')+'</div><div class="fb-info"><div class="fb-name">'+(pp?pp.name:c.provider)+'</div><div class="fb-model">'+(c.model||'')+'</div></div><span class="fb-badge fallback">FALLBACK #'+(i+1)+'</span><div class="fb-status-dot '+(hasKey?'configured':'nokey')+'" title="'+(hasKey?'Key OK':'No API key')+'"></div><button class="fb-remove" onclick="removeFallbackProvider(\\''+c.provider+'\\')">Remove</button></div>';
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
    div.innerHTML='<span style="font-size:18px">${ICONS.messageCircle}</span><div style="flex:1"><div style="font-size:13px;font-weight:600">'+esc(c.title||'Conversation #'+(i+1))+'</div><div style="font-size:11px;color:var(--text2)">'+esc(c.date||'')+' \\u2014 '+(c.messageCount||0)+' messages'+(c.channel?' \\u2014 '+esc(c.channel):'')+'</div></div>';
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
  const hasPlugins=data.installedPlugins&&data.installedPlugins.length;
  const hasSkills=data.installedClawHubSkills&&data.installedClawHubSkills.length;
  let msg='Are you sure? Current configuration will be overwritten.';
  if(hasPlugins)msg+='\\n'+data.installedPlugins.length+' plugin(s) will be reinstalled.';
  if(hasSkills)msg+='\\n'+data.installedClawHubSkills.length+' ClawHub skill(s) will be reinstalled.';
  if(!confirm(msg))return;
  st.className='status loading';st.textContent='Restoring...'+(hasPlugins||hasSkills?' (reinstalling plugins/skills, may take a while)':'');
  const d=await api('/api/restore','POST',{data});
  st.className=d.ok?'status ok':'status fail';st.textContent=d.ok?'Restore successful! OpenClaw restarted.'+(d.log?' Plugins/skills log available.':''):d.error||'Error';
  if(d.log){document.getElementById('backupData').style.display='block';document.getElementById('backupContent').value=d.log}
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
    ch.innerHTML=summary.checks.map(c=>'<div class="doc-check '+c.status+'"><span class="dc-icon">'+(c.status==='pass'?'${ICONS.check}':c.status==='warn'?'${ICONS.warning}':'<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>')+'</span><span class="dc-text">'+esc(c.name)+'</span><span class="dc-detail">'+esc(c.detail)+'</span></div>').join('');
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

// Escape key closes any open modal
document.addEventListener('keydown',function(e){if(e.key==='Escape'){
  const overlays=document.querySelectorAll('.modal-overlay');
  overlays.forEach(function(o){if(o.offsetParent!==null||o.style.display==='flex'||getComputedStyle(o).display!=='none'){
    const container=o.parentElement;if(container)container.innerHTML='';
  }});
}});

// Status messages auto-clear after 8 seconds
(function(){
  let timers=new WeakMap();
  const obs=new MutationObserver(function(muts){muts.forEach(function(m){
    if(m.type==='attributes'&&m.attributeName==='class'){
      const el=m.target;
      if(el.classList.contains('status')&&(el.classList.contains('ok')||el.classList.contains('fail'))){
        if(timers.has(el))clearTimeout(timers.get(el));
        el.style.opacity='1';el.style.transition='opacity 0.5s ease';
        timers.set(el,setTimeout(function(){el.style.opacity='0';setTimeout(function(){if(el.style.opacity==='0'){el.className='status';el.textContent='';el.style.opacity='';el.style.transition=''}},500)},8000));
      }else if(el.classList.contains('status')&&el.classList.contains('loading')){
        if(timers.has(el)){clearTimeout(timers.get(el));timers.delete(el)}
        el.style.opacity='1';el.style.transition='';
      }
    }
  })});
  document.querySelectorAll('.status').forEach(function(el){obs.observe(el,{attributes:true})});
  // Also observe dynamically added status elements
  new MutationObserver(function(muts){muts.forEach(function(m){m.addedNodes.forEach(function(n){
    if(n.nodeType===1){n.querySelectorAll&&n.querySelectorAll('.status').forEach(function(el){obs.observe(el,{attributes:true})})}
  })})}).observe(document.body,{childList:true,subtree:true});
})();

showTab('provider',document.querySelector('.nav-item'));
</script></body></html>`;
}

// --- Async task workers (SSE-streamed) ---

async function runBrowserInstall(task, browser) {
  try {
    if (browser === 'chrome') {
      taskLog(task, 'Downloading Google Chrome...');
      const tmpDeb = safeExec('mktemp /tmp/google-chrome-XXXXXX.deb', 5000);
      if (!tmpDeb) return taskDone(task, false, 'Failed to create temp file');
      await asyncExec(task, `curl -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o "${tmpDeb}"`, 120000);
      taskLog(task, 'Installing Chrome deb...');
      await asyncExec(task, `apt-get install -y "${tmpDeb}" 2>&1 || apt-get install -fy 2>&1`, 120000);
      safeExec(`rm -f "${tmpDeb}"`, 5000);
      if (!safeExec('which google-chrome 2>/dev/null', 5000)) return taskDone(task, false, 'Chrome install failed');
      // Create wrapper script to inject --window-size (headless Chrome defaults to tiny viewport)
      taskLog(task, 'Creating Chrome wrapper...');
      fs.writeFileSync('/usr/local/bin/google-chrome-wrapper', '#!/bin/bash\nexec /usr/bin/google-chrome --window-size=1920,1080 "$@"\n', { mode: 0o755 });
      taskLog(task, 'Setting browser config...');
      try {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        cfg.browser = { headless: true, executablePath: '/usr/local/bin/google-chrome-wrapper', defaultProfile: 'openclaw', noSandbox: true };
        if (cfg.plugins && cfg.plugins.entries && cfg.plugins.entries['camofox-browser']) {
          cfg.plugins.entries['camofox-browser'].enabled = false;
        }
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
        safeExec(`chown openclaw:openclaw "${CONFIG_FILE}"`, 5000);
      } catch (e) { taskLog(task, 'Config error: ' + e.message); }
      taskLog(task, 'Creating media directory...');
      safeExec('mkdir -p /home/openclaw/.openclaw/media/browser && chown openclaw:openclaw /home/openclaw/.openclaw/media/browser', 5000);
      taskLog(task, 'Clearing old sessions...'); clearBrowserSessions();
      updateBrowserToolsMd('chrome');
      taskLog(task, 'Restarting OpenClaw...'); restartService('openclaw');
      await new Promise(r => setTimeout(r, 3000));
      taskLog(task, 'Done!');
      taskDone(task, true);
    } else {
      // CamoFox
      taskLog(task, 'Installing browser dependencies + Xvfb...');
      await asyncExec(task, 'apt-get install -qqy libgtk-3-0t64 libasound2t64 libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 libdbus-glib-1-2 libgbm1 xvfb 2>&1', 120000);
      if (!safeExec('pgrep Xvfb', 5000)) {
        taskLog(task, 'Setting up Xvfb virtual display...');
        const xvfbSvc = `[Unit]\nDescription=Virtual Framebuffer X Server\nAfter=network.target\n[Service]\nExecStart=/usr/bin/Xvfb :99 -screen 0 1920x1080x24\nRestart=on-failure\nRestartSec=3\n[Install]\nWantedBy=multi-user.target\n`;
        fs.writeFileSync('/etc/systemd/system/xvfb.service', xvfbSvc);
        safeExec('systemctl daemon-reload && systemctl enable xvfb && systemctl start xvfb', 15000);
        const oSvc = '/etc/systemd/system/openclaw.service';
        try {
          const svcContent = fs.readFileSync(oSvc, 'utf8');
          if (!svcContent.includes('DISPLAY=')) {
            fs.writeFileSync(oSvc, svcContent.replace('[Service]', '[Service]\nEnvironment=DISPLAY=:99'));
            safeExec('systemctl daemon-reload', 10000);
          }
        } catch {}
      }
      taskLog(task, 'Installing CamoFox plugin (this may take a few minutes)...');
      await asyncExec(task, suOC(`cd ${OPENCLAW_DIR} && node dist/index.js plugins install @askjo/camofox-browser`) + ' 2>&1', 300000);
      const pluginDir = '/home/openclaw/.openclaw/extensions/camofox-browser';
      if (!fs.existsSync(pluginDir + '/server.js')) return taskDone(task, false, 'CamoFox plugin install failed');
      taskLog(task, 'Rebuilding native modules...');
      await asyncExec(task, `cd "${pluginDir}" && npm rebuild better-sqlite3 2>&1`, 60000);
      safeExec(`chown -R openclaw:openclaw "${pluginDir}/node_modules/better-sqlite3"`, 15000);
      taskLog(task, 'Ensuring camoufox binary...');
      if (!fs.existsSync('/home/openclaw/.cache/camoufox')) {
        if (fs.existsSync('/root/.cache/camoufox')) {
          safeExec('mkdir -p /home/openclaw/.cache', 5000);
          await asyncExec(task, 'cp -r /root/.cache/camoufox /home/openclaw/.cache/', 30000);
          safeExec('chown -R openclaw:openclaw /home/openclaw/.cache/camoufox', 15000);
        } else {
          await asyncExec(task, suOC(`cd ${pluginDir} && npx camoufox-js fetch`) + ' 2>&1', 300000);
        }
      }
      taskLog(task, 'Configuring browser for CamoFox...');
      try {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        cfg.browser = { enabled: false };
        if (!cfg.plugins) cfg.plugins = { entries: {} };
        if (!cfg.plugins.entries) cfg.plugins.entries = {};
        cfg.plugins.entries['camofox-browser'] = { enabled: true };
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
        safeExec(`chown openclaw:openclaw "${CONFIG_FILE}"`, 5000);
      } catch (e) { taskLog(task, 'Config note: ' + e.message); }
      taskLog(task, 'Patching CamoFox plugin for media delivery...');
      taskLog(task, formatPatchResult('CamoFox plugin', patchCamofoxPlugin()));
      taskLog(task, formatPatchResult('Trusted media', patchTrustedMedia()));
      const mediaDir = '/home/openclaw/.openclaw/media/camofox';
      safeExec(`mkdir -p "${mediaDir}" && chown openclaw:openclaw "${mediaDir}"`, 5000);
      taskLog(task, 'Clearing old sessions...'); clearBrowserSessions();
      updateBrowserToolsMd('camofox');
      if (fs.existsSync('/etc/systemd/system/camofox.service')) {
        safeExec('systemctl disable --now camofox 2>/dev/null', 15000);
        safeExec('rm -f /etc/systemd/system/camofox.service', 5000);
        safeExec('systemctl daemon-reload', 10000);
      }
      taskLog(task, 'Restarting OpenClaw...'); restartService('openclaw');
      await new Promise(r => setTimeout(r, 5000));
      taskLog(task, 'Done!');
      taskDone(task, true);
    }
  } catch (e) { taskDone(task, false, e.message); }
}

async function runBrowserUninstall(task, browser) {
  try {
    if (browser === 'chrome') {
      taskLog(task, 'Removing Google Chrome...');
      await asyncExec(task, 'apt-get remove -y google-chrome-stable 2>&1', 60000);
      await asyncExec(task, 'apt-get autoremove -y 2>&1', 30000);
      taskLog(task, 'Updating config...');
      try {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        cfg.browser = { enabled: false };
        const camofoxPlugin = '/home/openclaw/.openclaw/extensions/camofox-browser/server.js';
        if (fs.existsSync(camofoxPlugin)) {
          if (!cfg.plugins) cfg.plugins = { entries: {} };
          if (!cfg.plugins.entries) cfg.plugins.entries = {};
          cfg.plugins.entries['camofox-browser'] = { enabled: true };
          taskLog(task, 'Re-enabling CamoFox plugin...');
        }
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
        safeExec(`chown openclaw:openclaw "${CONFIG_FILE}"`, 5000);
      } catch (e) { taskLog(task, 'Config error: ' + e.message); }
      if (fs.existsSync('/home/openclaw/.openclaw/extensions/camofox-browser/server.js')) {
        taskLog(task, formatPatchResult('Trusted media', patchTrustedMedia()));
      }
    } else {
      taskLog(task, 'Removing CamoFox plugin...');
      await asyncExec(task, 'echo y | ' + suOC(`cd ${OPENCLAW_DIR} && node dist/index.js plugins uninstall camofox-browser`) + ' 2>&1', 60000);
      if (fs.existsSync('/etc/systemd/system/camofox.service')) {
        safeExec('systemctl disable --now camofox 2>/dev/null', 15000);
        safeExec('rm -f /etc/systemd/system/camofox.service', 5000);
        safeExec('systemctl daemon-reload', 10000);
      }
      if (fs.existsSync('/opt/camofox-browser')) await asyncExec(task, 'rm -rf /opt/camofox-browser', 30000);
      try {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        if (safeExec('which google-chrome 2>/dev/null', 5000)) {
          cfg.browser = { headless: true, executablePath: '/usr/local/bin/google-chrome-wrapper', defaultProfile: 'openclaw', noSandbox: true };
        } else {
          cfg.browser = { enabled: false };
        }
        if (cfg.plugins?.entries) delete cfg.plugins.entries['camofox-browser'];
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
        safeExec(`chown openclaw:openclaw "${CONFIG_FILE}"`, 5000);
      } catch (e) { taskLog(task, 'Config error: ' + e.message); }
    }
    clearBrowserSessions();
    let remainingBrowser = 'none';
    if (browser === 'camofox' && safeExec('which google-chrome 2>/dev/null', 5000)) remainingBrowser = 'chrome';
    else if (browser === 'chrome' && fs.existsSync('/home/openclaw/.openclaw/extensions/camofox-browser/server.js')) remainingBrowser = 'camofox';
    updateBrowserToolsMd(remainingBrowser);
    taskLog(task, 'Restarting OpenClaw...'); restartService('openclaw');
    await new Promise(r => setTimeout(r, 3000));
    taskLog(task, 'Done!');
    taskDone(task, true);
  } catch (e) { taskDone(task, false, e.message); }
}

async function runUpdate(task, ver) {
  try {
    taskLog(task, 'Stopping OpenClaw...');
    await asyncExec(task, 'systemctl stop openclaw', 30000);
    taskLog(task, 'Fetching updates...');
    await asyncExec(task, `cd ${OPENCLAW_DIR} && git stash 2>/dev/null`, 15000);
    await asyncExec(task, `cd ${OPENCLAW_DIR} && git fetch --tags --all`, 30000);
    if (ver === 'latest') {
      await asyncExec(task, `cd ${OPENCLAW_DIR} && git checkout main && git pull origin main`, 30000);
      taskLog(task, 'Checked out main branch.');
    } else {
      await asyncExec(task, `cd ${OPENCLAW_DIR} && git checkout ${ver.replace(/[^a-zA-Z0-9._-]/g, '')}`, 15000);
      taskLog(task, 'Checked out ' + ver);
    }
    taskLog(task, 'Fixing permissions...');
    await asyncExec(task, `chown -R openclaw:openclaw ${OPENCLAW_DIR}`, 30000);
    taskLog(task, 'Building (this may take a few minutes)...');
    await asyncExec(task, suOC(`cd ${OPENCLAW_DIR} && pnpm install --frozen-lockfile 2>&1 && pnpm build 2>&1 && pnpm ui:install 2>&1 && pnpm ui:build 2>&1`), 300000);
    if (ver !== 'latest') setEnvValue('OPENCLAW_VERSION', ver);
    if (fs.existsSync('/home/openclaw/.openclaw/extensions/camofox-browser/plugin.ts')) {
      taskLog(task, 'Re-patching CamoFox plugin...');
      taskLog(task, formatPatchResult('CamoFox plugin', patchCamofoxPlugin()));
      taskLog(task, formatPatchResult('Trusted media', patchTrustedMedia()));
    }
    taskLog(task, 'Starting OpenClaw...'); restartService('openclaw');
    await new Promise(r => setTimeout(r, 3000));
    const ok = isServiceActive('openclaw');
    taskLog(task, ok ? 'OpenClaw started successfully!' : 'Failed to start OpenClaw');
    taskDone(task, ok, ok ? null : 'Unable to start OpenClaw after update');
  } catch (e) { taskDone(task, false, e.message); }
}

// --- HTTP Server ---
const server = http.createServer(async (req, res) => {
  // Security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
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
      let version = getEnvValue('OPENCLAW_VERSION') || '';
      if (!version || version === 'Latest') {
        try { version = JSON.parse(fs.readFileSync(OPENCLAW_DIR + '/package.json', 'utf8')).version || ''; } catch {}
      }
      // Collect providers with API key configured
      const configuredProviders = [];
      for (const [k, p] of Object.entries(PROVIDERS)) {
        const key = getEnvValue(p.envKey);
        if (key && !key.startsWith('#')) configuredProviders.push(k);
      }
      return json(res, 200, { ok: true, provider, providerName, model, channels: activeChannels, domain, token: getEnvValue('OPENCLAW_GATEWAY_TOKEN'), version, panelVersion: PANEL_VERSION, serverIP: getServerIP(), configuredProviders });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // Test Key
  if (req.method === 'POST' && url.pathname === '/api/test-key') {
    try {
      const body = await parseBody(req); const p = PROVIDERS[body.provider];
      if (!p) return json(res, 400, { ok: false, error: 'Invalid provider' });
      const ok = p.testFn(body.apiKey, body.extraEnv || {});
      return json(res, 200, { ok, error: ok ? null : 'Invalid API key' });
    } catch { return json(res, 500, { ok: false, error: 'Error' }); }
  }

  // Save Provider Key Only (no model change, no restart)
  if (req.method === 'POST' && url.pathname === '/api/provider-save-key') {
    try {
      const body = await parseBody(req); const prov = PROVIDERS[body.provider];
      if (!prov) return json(res, 400, { ok: false, error: 'Invalid provider' });
      if (!body.apiKey) return json(res, 400, { ok: false, error: 'Missing API key' });
      // Validate key before saving
      if (prov.testFn) { try { const valid = prov.testFn(body.apiKey, body.extraEnv || {}); if (!valid) return json(res, 400, { ok: false, error: 'Invalid API key for ' + prov.name + '. Key not saved.' }); } catch {} }
      setEnvValue(prov.envKey, body.apiKey);
      if (body.extraEnv && prov.extraEnvKeys) { for (const [ek, ev] of Object.entries(body.extraEnv)) { if (prov.extraEnvKeys.includes(ek) && ev) setEnvValue(ek, ev); } }
      return json(res, 200, { ok: true });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // Remove Provider Key
  if (req.method === 'POST' && url.pathname === '/api/provider-remove-key') {
    try {
      const body = await parseBody(req); const prov = PROVIDERS[body.provider];
      if (!prov) return json(res, 400, { ok: false, error: 'Invalid provider' });
      // Prevent removing key of active provider
      const config = getConfig();
      const primaryModel = config?.agents?.defaults?.model?.primary || '';
      const isPrimary = primaryModel.startsWith(body.provider + '/') || (body.provider === 'gemini' && primaryModel.startsWith('google/')) || (body.provider === 'bedrock' && primaryModel.startsWith('amazon-bedrock/'));
      if (isPrimary) return json(res, 400, { ok: false, error: 'Cannot remove key of active provider. Switch to another provider first.' });
      // Check if any agent uses a model from this provider
      const provModels = prov.models.map(m => m.id);
      const agentList = Array.isArray(config?.agents?.list) ? config.agents.list : Object.values(config?.agents?.list || {});
      const affectedAgents = agentList.filter(a => a.model && provModels.some(pm => a.model === pm || a.model.startsWith(body.provider + '/'))).map(a => a.id || a.name);
      if (affectedAgents.length > 0 && !body.force) {
        return json(res, 200, { ok: false, confirm: true, error: 'Agent(s) using this provider: ' + affectedAgents.join(', ') + '. Remove key and reset these agents to default model?', affectedAgents });
      }
      // Reset affected agents' model to default
      if (affectedAgents.length > 0 && body.force) {
        const list = config.agents.list;
        if (Array.isArray(list)) list.forEach(a => { if (affectedAgents.includes(a.id || a.name)) delete a.model; });
        else for (const [k, a] of Object.entries(list)) { if (affectedAgents.includes(k)) delete a.model; }
        saveConfig(config);
      }
      removeEnvValue(prov.envKey);
      if (prov.extraEnvKeys) prov.extraEnvKeys.forEach(ek => removeEnvValue(ek));
      if (affectedAgents.length > 0) { restartService('openclaw'); await new Promise(r => setTimeout(r, 2000)); }
      return json(res, 200, { ok: true });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // Apply Provider (save key + change model + restart)
  if (req.method === 'POST' && url.pathname === '/api/provider') {
    try {
      const body = await parseBody(req); const prov = PROVIDERS[body.provider];
      if (!prov) return json(res, 400, { ok: false, error: 'Invalid provider' });
      const token = getEnvValue('OPENCLAW_GATEWAY_TOKEN');
      // Validate new key before saving
      if (body.apiKey && prov.testFn) { try { const valid = prov.testFn(body.apiKey); if (!valid) return json(res, 400, { ok: false, error: 'Invalid API key for ' + prov.name }); } catch {} }
      if (body.apiKey) setEnvValue(prov.envKey, body.apiKey);
      if (body.extraEnv && prov.extraEnvKeys) { for (const [ek, ev] of Object.entries(body.extraEnv)) { if (prov.extraEnvKeys.includes(ek) && ev) setEnvValue(ek, ev); } }
      // Verify provider has a key (either new or existing)
      const existingKey = getEnvValue(prov.envKey);
      if (!existingKey || existingKey.startsWith('#')) return json(res, 400, { ok: false, error: 'No API key configured for this provider' });
      // Validate key when switching provider without entering a new key
      if (!body.apiKey && prov.testFn) {
        try { const valid = prov.testFn(existingKey); if (!valid) return json(res, 400, { ok: false, error: 'Stored API key is invalid for ' + prov.name + '. Please enter a valid key.' }); } catch {}
      }
      let config; try { config = JSON.parse(fs.readFileSync(prov.configFile, 'utf8')); } catch { config = getConfig(); }
      config.gateway = config.gateway || {}; config.gateway.auth = config.gateway.auth || {}; config.gateway.auth.token = token;
      config.agents = config.agents || { defaults: { model: {} } }; config.agents.defaults = config.agents.defaults || { model: {} }; config.agents.defaults.model = config.agents.defaults.model || {};
      if (body.model) config.agents.defaults.model.primary = body.model;
      // Auto-add max_completion_tokens compat for OpenAI reasoning models (o1/o3-mini/o4/o4-mini)
      const OPENAI_REASONING_MODELS = [
        { id: 'o4-mini', name: 'OpenAI o4-mini', input: ['text','image'], ctx: 200000, max: 100000, ci: 1.1, co: 4.4 },
        { id: 'o4', name: 'OpenAI o4', input: ['text','image'], ctx: 200000, max: 100000, ci: 2, co: 8 },
        { id: 'o3-mini', name: 'OpenAI o3-mini', input: ['text'], ctx: 200000, max: 100000, ci: 1.1, co: 4.4 },
        { id: 'o1', name: 'OpenAI o1', input: ['text','image'], ctx: 200000, max: 100000, ci: 15, co: 60 },
        { id: 'o1-mini', name: 'OpenAI o1-mini', input: ['text'], ctx: 128000, max: 65536, ci: 1.1, co: 4.4 }
      ];
      const selModel = (body.model || '').replace('openai/', '');
      if (selModel && OPENAI_REASONING_MODELS.some(m => m.id === selModel)) {
        config.models = config.models || {};
        config.models.providers = config.models.providers || {};
        config.models.providers.openai = config.models.providers.openai || { baseUrl: 'https://api.openai.com/v1', models: [] };
        if (!config.models.providers.openai.baseUrl) config.models.providers.openai.baseUrl = 'https://api.openai.com/v1';
        const existingIds = new Set((config.models.providers.openai.models || []).map(m => m.id));
        for (const rm of OPENAI_REASONING_MODELS) {
          if (!existingIds.has(rm.id)) {
            config.models.providers.openai.models.push({
              id: rm.id, name: rm.name, reasoning: true, input: rm.input,
              cost: { input: rm.ci, output: rm.co, cacheRead: rm.ci * 0.25, cacheWrite: 0 },
              contextWindow: rm.ctx, maxTokens: rm.max,
              compat: { maxTokensField: 'max_completion_tokens', supportsReasoningEffort: true }
            });
          }
        }
      }
      config.browser = config.browser || {};
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
      const agentCfg = config?.agents?.list || {};
      const cfgBindings = config?.bindings || [];
      agents = (Array.isArray(agents) ? agents : []).map(a => {
        const agentBindings = cfgBindings.filter(b => b.agentId === a.id).map(b => b.match?.channel || 'unknown');
        return {
          ...a,
          model: a.model || agentCfg[a.id]?.model || defaultModel,
          identity: a.identity || {},
          skills: agentCfg[a.id]?.skills !== undefined ? agentCfg[a.id].skills : null,
          bindingChannels: agentBindings
        };
      });
      // Collect active providers (have API key set)
      const activeProviders = [];
      for (const [k, p] of Object.entries(PROVIDERS)) {
        const key = getEnvValue(p.envKey);
        if (key && !key.startsWith('#')) activeProviders.push({ id: k, name: p.name, icon: p.icon, models: p.models });
      }
      // Collect available skill names
      let availableSkills = [];
      try {
        const skillOut = execSync('/opt/openclaw-cli.sh skills list --json 2>/dev/null', { timeout: 15000, stdio: 'pipe' }).toString();
        const skillList = JSON.parse(skillOut);
        if (Array.isArray(skillList)) availableSkills = skillList.map(s => ({ name: s.name || s.id, description: s.description || '', emoji: s.emoji || '🧩' }));
      } catch {}
      // Collect active channels (have credentials configured)
      const activeChannels = [];
      for (const [id, ch] of Object.entries(CHANNELS)) {
        if (ch.envKeys.length === 0) continue;
        if (ch.envKeys.every(k => { const v = getEnvValue(k); return v && !v.startsWith('#'); }))
          activeChannels.push({ id, name: ch.name, icon: ch.icon });
      }
      return json(res, 200, { ok: true, agents, activeProviders, availableSkills, activeChannels });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  if (req.method === 'POST' && url.pathname === '/api/agents/add') {
    try {
      const body = await parseBody(req);
      const name = (body.name || '').replace(/[^a-zA-Z0-9_-]/g, '');
      if (!name) return json(res, 400, { ok: false, error: 'Missing agent name' });
      if (name.length > 32) return json(res, 400, { ok: false, error: 'Name too long (max 32 chars)' });
      const ws = `/home/openclaw/.openclaw/agents/${name}`;
      let cmd = `agents add "${name}" --non-interactive --workspace "${ws}" --json`;
      if (body.model) { const m = body.model.replace(/[^a-zA-Z0-9/_.-]/g, ''); cmd += ` --model "${m}"`; }
      try { execSync(`/opt/openclaw-cli.sh ${cmd}`, { timeout: 30000, stdio: 'pipe' }); }
      catch (e) { const err = ((e.stderr || '') + (e.stdout || '')).toString().trim(); return json(res, 200, { ok: false, error: err.substring(0, 300) || e.message }); }
      // Add channel binding directly to config (CLI --bind doesn't work in non-interactive mode)
      if (body.bind) {
        try {
          const b = body.bind.replace(/[^a-zA-Z0-9_:-]/g, '');
          const cfg = getConfig();
          if (!cfg.bindings) cfg.bindings = [];
          cfg.bindings.push({ agentId: name, match: { channel: b } });
          saveConfig(cfg);
        } catch (be) { console.error('[Panel] Binding error:', be.message); }
      }
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
      if (body.name) cmd += ` --name ${shellEsc(body.name.substring(0, 64))}`;
      if (body.emoji) cmd += ` --emoji ${shellEsc(body.emoji.substring(0, 8))}`;
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

  // Agent config update (per-agent model + skills)
  if (req.method === 'POST' && url.pathname === '/api/agents/update-config') {
    try {
      const body = await parseBody(req);
      const agent = (body.agent || '').replace(/[^a-zA-Z0-9_-]/g, '');
      if (!agent) return json(res, 400, { ok: false, error: 'Missing agent ID' });
      const config = getConfig();
      if (!config.agents) config.agents = {};
      if (!config.agents.list) config.agents.list = {};
      if (!config.agents.list[agent]) config.agents.list[agent] = {};
      // Update per-agent model
      if (body.model !== undefined) {
        if (body.model) config.agents.list[agent].model = body.model;
        else delete config.agents.list[agent].model;
      }
      // Update per-agent skills allowlist (null=all, []=none, ['x','y']=specific)
      if (body.skills !== undefined) {
        if (body.skills === null) delete config.agents.list[agent].skills;
        else if (Array.isArray(body.skills)) config.agents.list[agent].skills = body.skills;
      }
      // Clean up empty entries
      if (Object.keys(config.agents.list[agent]).length === 0) delete config.agents.list[agent];
      saveConfig(config);
      restartService('openclaw'); await new Promise(r => setTimeout(r, 2000));
      return json(res, 200, { ok: true });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // Channels
  if (req.method === 'POST' && url.pathname === '/api/channels') {
    try {
      const body = await parseBody(req); const ch = CHANNELS[body.channel];
      if (!ch) return json(res, 400, { ok: false, error: 'Invalid channel' });
      // Validate token before saving
      if (ch.testFn) { try { const valid = ch.testFn(body.tokens || {}); if (!valid) return json(res, 400, { ok: false, error: 'Invalid token for ' + ch.name + '. Please check and try again.' }); } catch {} }
      for (const [key, val] of Object.entries(body.tokens || {})) { if (ch.envKeys.includes(key) && val) setEnvValue(key, val); }
      // Enable channel in config (BOTH channels.{id}.enabled AND plugins.entries.{id} for ALL channels)
      try {
        const cfgPath = '/home/openclaw/.openclaw/openclaw.json';
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        // Always set channels.{id}.enabled (required for channel to start)
        if (!cfg.channels) cfg.channels = {};
        if (!cfg.channels[body.channel]) cfg.channels[body.channel] = {};
        cfg.channels[body.channel].enabled = true;
        // NOTE: OpenClaw normalize config mỗi lần restart → reset groupPolicy="allowlist"
        //   → bot sẽ im lặng vì chưa có channel nào trong allowlist
        //   → LUÔN force groupPolicy="open" cho Discord/Slack mỗi lần save
        if (body.channel === 'discord' || body.channel === 'slack') {
          cfg.channels[body.channel].groupPolicy = 'open';
        }
        // NOTE: Slack streaming="partial" + nativeStreaming=true gây double message
        //   → bot gửi partial (edited) rồi gửi thêm 1 final message nữa
        //   → LUÔN force tắt streaming cho Slack mỗi lần save
        if (body.channel === 'slack') {
          cfg.channels[body.channel].streaming = 'off';
          cfg.channels[body.channel].nativeStreaming = false;
        }
        // Always set plugins.entries.{id}.enabled (required for OpenClaw to load channel plugin)
        if (!cfg.plugins) cfg.plugins = {};
        if (!cfg.plugins.entries) cfg.plugins.entries = {};
        if (!cfg.plugins.entries[body.channel]) cfg.plugins.entries[body.channel] = {};
        cfg.plugins.entries[body.channel].enabled = true;
        fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
        try { execSync('chown openclaw:openclaw ' + cfgPath); } catch {}
      } catch (pe) { console.error('[Panel] Channel config error:', pe.message); }
      // PATCH: Zalo monitor.ts — monitorZaloProvider() resolve Promise ngay lập tức
      //   → framework coi như channel crash → restart loop vô hạn
      //   → Thêm await Promise pending giữ monitor sống cho đến khi stop()/abort
      if (body.channel === 'zalo') {
        try {
          const monitorFile = '/opt/openclaw/extensions/zalo/src/monitor.ts';
          if (fs.existsSync(monitorFile)) {
            const src = fs.readFileSync(monitorFile, 'utf8');
            const bugPattern = 'startPollingLoop({\n    token,\n    account,\n    config,\n    runtime,\n    core,\n    abortSignal,\n    isStopped: () => stopped,\n    mediaMaxMb: effectiveMediaMaxMb,\n    statusSink,\n    fetcher,\n  });\n\n  return { stop };\n}';
            if (src.includes(bugPattern) && !src.includes('Keep monitor Promise pending')) {
              const patched = src.replace(bugPattern,
                'startPollingLoop({\n    token,\n    account,\n    config,\n    runtime,\n    core,\n    abortSignal,\n    isStopped: () => stopped,\n    mediaMaxMb: effectiveMediaMaxMb,\n    statusSink,\n    fetcher,\n  });\n\n  // Keep monitor Promise pending until stop() or abortSignal fires\n  // Without this, Promise resolves immediately and framework treats it as crash\n  await new Promise<void>((resolve) => {\n    stopHandlers.push(resolve);\n    abortSignal.addEventListener("abort", () => resolve(), { once: true });\n  });\n\n  return { stop };\n}');
              fs.writeFileSync(monitorFile, patched, 'utf8');
              console.log('[Panel] Patched Zalo monitor.ts — fixed restart loop bug');
            }
          }
        } catch (patchErr) { console.error('[Panel] Zalo patch error:', patchErr.message); }
      }
      restartService('openclaw'); await new Promise(r => setTimeout(r, 3000));
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
      // Disable in config (BOTH channels.{id} AND plugins.entries.{id})
      try {
        const cfgPath = '/home/openclaw/.openclaw/openclaw.json';
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        if (cfg.channels && cfg.channels[body.channel]) { cfg.channels[body.channel].enabled = false; }
        if (cfg.plugins && cfg.plugins.entries && cfg.plugins.entries[body.channel]) { cfg.plugins.entries[body.channel].enabled = false; }
        fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
        try { execSync('chown openclaw:openclaw ' + cfgPath); } catch {}
      } catch {}
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

  // Channel Pair List (pending pairing requests)
  if (req.method === 'POST' && url.pathname === '/api/channel-pair-list') {
    try {
      const body = await parseBody(req); const ch = CHANNELS[body.channel];
      if (!ch || !ch.canPair) return json(res, 200, { ok: true, requests: [] });
      let output = '';
      try { output = execSync(`/opt/openclaw-cli.sh pairing list ${ch.pairCmd} --json 2>/dev/null`, { timeout: 15000, stdio: 'pipe' }).toString(); } catch (e) { output = (e.stdout || '').toString(); }
      let data; try { data = JSON.parse(output); } catch { return json(res, 200, { ok: true, requests: [] }); }
      return json(res, 200, { ok: true, requests: data.requests || [] });
    } catch (e) { return json(res, 200, { ok: true, requests: [] }); }
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
      // Approve all pending requests
      let approved = 0, errors = [];
      for (const req of pending) {
        const requestId = req.requestId || '';
        if (!requestId) continue;
        try { execSync(`/opt/openclaw-cli.sh devices approve "${requestId}" --token=${gatewayToken}`, { timeout: 15000, stdio: 'pipe' }); approved++; }
        catch (ae) { errors.push(requestId.substring(0, 8)); }
      }
      if (approved === 0) return json(res, 200, { ok: false, error: 'Unable to approve requests' });
      return json(res, 200, { ok: true, approved });
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
        removeEnvValue('OPENCLAW_GATEWAY_BIND');
        // Remove domain origins, keep IP origin
        try {
          const config = getConfig();
          if (config.gateway?.controlUi) {
            config.gateway.controlUi.allowedOrigins = ['http://' + serverIP + ':9999'];
            saveConfig(config);
          }
        } catch {}
        // Send response BEFORE restarting (Caddy restart kills HTTPS connection)
        json(res, 200, { ok: true, serverIP });
        setTimeout(() => { restartService('caddy'); restartService('openclaw'); }, 500);
        return;
      }
      const domain = (body.domain || '').trim().toLowerCase(), email = (body.email || '').trim();
      if (!domain) return json(res, 400, { ok: false, error: 'Missing domain' });
      if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) return json(res, 400, { ok: false, error: 'Invalid domain' });
      let ips = [];
      try { const o = safeExec(`dig +short A ${domain}`, 10000); if (o) ips = o.split('\n').filter(i => /^\d+\.\d+\.\d+\.\d+$/.test(i.trim())); } catch {}
      if (!ips.length) try { const o = safeExec(`host ${domain}`, 10000); const m = o.match(/has address (\d+\.\d+\.\d+\.\d+)/g); if (m) ips = m.map(s => s.replace('has address ', '')); } catch {}
      if (!ips.length) try { const o = safeExec(`getent hosts ${domain} | awk '{print $1}'`, 10000); if (o && /^\d+\.\d+\.\d+\.\d+$/.test(o.trim())) ips = [o.trim()]; } catch {}
      if (!ips.length) return json(res, 400, { ok: false, error: `DNS resolution failed. Point A record to ${serverIP}.` });
      if (!ips.includes(serverIP)) return json(res, 400, { ok: false, error: `DNS points to ${ips.join(', ')} — not ${serverIP}.` });
      writeCaddyfile(domain, email);
      // Add gateway.controlUi.allowedOrigins for panel access via domain
      try {
        const config = getConfig();
        config.gateway = config.gateway || {};
        config.gateway.controlUi = config.gateway.controlUi || {};
        const origins = new Set(config.gateway.controlUi.allowedOrigins || []);
        origins.add('https://' + domain + ':9443');
        origins.add('https://' + domain);
        origins.add('http://' + serverIP + ':9999');
        config.gateway.controlUi.allowedOrigins = [...origins];
        saveConfig(config);
      } catch {}
      execSync('systemctl enable caddy 2>/dev/null || true', { timeout: 10000 }); restartService('caddy'); await new Promise(r => setTimeout(r, 3000));
      if (isServiceActive('caddy')) {
        restartService('openclaw'); // Reload with OPENCLAW_GATEWAY_BIND + allowedOrigins
        return json(res, 200, { ok: true, domain });
      }
      writeCaddyfile(null); restartService('caddy');
      return json(res, 500, { ok: false, error: 'Caddy error. Rolled back.' });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // Update Check
  if (req.method === 'GET' && url.pathname === '/api/update-check') {
    try {
      let cur = getEnvValue('OPENCLAW_VERSION') || '';
      if (!cur || cur === 'Latest') {
        try { cur = 'v' + JSON.parse(fs.readFileSync(OPENCLAW_DIR + '/package.json', 'utf8')).version; } catch {}
      }
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

  // Update (async with SSE streaming)
  if (req.method === 'POST' && url.pathname === '/api/update') {
    try {
      const body = await parseBody(req);
      const ver = (body.version || 'latest').trim();
      const task = createTask('update');
      json(res, 200, { ok: true, taskId: task.id });
      runUpdate(task, ver).catch(e => taskDone(task, false, e.message));
      return;
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // Browser Status
  if (req.method === 'GET' && url.pathname === '/api/browser/status') {
    try {
      const chromeInstalled = !!safeExec('which google-chrome 2>/dev/null', 5000);
      const pluginDir = '/home/openclaw/.openclaw/extensions/camofox-browser';
      const camofoxInstalled = fs.existsSync(pluginDir + '/server.js');
      // CamoFox server is managed by OpenClaw plugin — check if port 9377 responds
      let camofoxRunning = false;
      if (camofoxInstalled) { try { camofoxRunning = !!safeExec('curl -sf http://localhost:9377/health 2>/dev/null', 5000); } catch {} }
      // Detect active browser — use both config AND runtime state
      // OpenClaw may normalize config on restart, stripping plugins.entries,
      // so also check runtime indicators (port responding, browser.enabled flag)
      let current = 'none';
      try {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        const hasChromeExec = cfg.browser && cfg.browser.executablePath && cfg.browser.executablePath.includes('chrome');
        const browserDisabled = cfg.browser && cfg.browser.enabled === false;
        const camofoxEntryEnabled = cfg.plugins?.entries?.['camofox-browser']?.enabled;
        if (hasChromeExec && !browserDisabled) current = 'chrome';
        else if (camofoxInstalled && (camofoxEntryEnabled || camofoxRunning || browserDisabled)) current = 'camofox';
      } catch {
        // Config unreadable — fall back to runtime detection
        if (camofoxInstalled && camofoxRunning) current = 'camofox';
      }
      return json(res, 200, { ok: true, current,
        chrome: { installed: chromeInstalled, active: current === 'chrome' },
        camofox: { installed: camofoxInstalled, running: camofoxRunning, active: current === 'camofox' }
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // Browser Install (async with SSE streaming)
  if (req.method === 'POST' && url.pathname === '/api/browser/install') {
    try {
      const body = await parseBody(req);
      const browser = (body.browser || '').trim();
      if (browser !== 'chrome' && browser !== 'camofox') return json(res, 400, { ok: false, error: 'Invalid browser type' });
      const task = createTask('browser-install');
      json(res, 200, { ok: true, taskId: task.id });
      runBrowserInstall(task, browser).catch(e => taskDone(task, false, e.message));
      return;
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // Browser Uninstall (async with SSE streaming)
  if (req.method === 'POST' && url.pathname === '/api/browser/uninstall') {
    try {
      const body = await parseBody(req);
      const browser = (body.browser || '').trim();
      if (browser !== 'chrome' && browser !== 'camofox') return json(res, 400, { ok: false, error: 'Invalid browser type' });
      const task = createTask('browser-uninstall');
      json(res, 200, { ok: true, taskId: task.id });
      runBrowserUninstall(task, browser).catch(e => taskDone(task, false, e.message));
      return;
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // Browser Activate (switch between installed browsers)
  if (req.method === 'POST' && url.pathname === '/api/browser/activate') {
    try {
      const body = await parseBody(req);
      const browser = (body.browser || '').trim();
      if (browser !== 'chrome' && browser !== 'camofox') return json(res, 400, { ok: false, error: 'Invalid browser type' });
      if (browser === 'chrome' && !safeExec('which google-chrome 2>/dev/null', 5000)) return json(res, 400, { ok: false, error: 'Chrome is not installed' });
      if (browser === 'camofox' && !fs.existsSync('/home/openclaw/.openclaw/extensions/camofox-browser/server.js')) return json(res, 400, { ok: false, error: 'CamoFox is not installed' });
      const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (browser === 'chrome') {
        // Set Chrome browser config
        cfg.browser = { headless: true, executablePath: '/usr/local/bin/google-chrome-wrapper', defaultProfile: 'openclaw', noSandbox: true };
        // Disable CamoFox plugin if present
        if (cfg.plugins && cfg.plugins.entries && cfg.plugins.entries['camofox-browser']) {
          cfg.plugins.entries['camofox-browser'].enabled = false;
        }
        // Ensure wrapper script and media directory exist
        if (!fs.existsSync('/usr/local/bin/google-chrome-wrapper')) {
          fs.writeFileSync('/usr/local/bin/google-chrome-wrapper', '#!/bin/bash\nexec /usr/bin/google-chrome --window-size=1920,1080 "$@"\n', { mode: 0o755 });
        }
        safeExec('mkdir -p /home/openclaw/.openclaw/media/browser && chown openclaw:openclaw /home/openclaw/.openclaw/media/browser', 5000);
      } else {
        // CamoFox: disable built-in browser, enable plugin (plugin auto-starts server)
        cfg.browser = { enabled: false };
        if (!cfg.plugins) cfg.plugins = { entries: {} };
        if (!cfg.plugins.entries) cfg.plugins.entries = {};
        cfg.plugins.entries['camofox-browser'] = { enabled: true };
        // Ensure Xvfb is running (required for Firefox-based CamoFox)
        if (!safeExec('pgrep Xvfb', 5000)) {
          if (safeExec('which Xvfb 2>/dev/null', 5000)) {
            if (!fs.existsSync('/etc/systemd/system/xvfb.service')) {
              const xvfbSvc = `[Unit]\nDescription=Virtual Framebuffer X Server\nAfter=network.target\n[Service]\nExecStart=/usr/bin/Xvfb :99 -screen 0 1920x1080x24\nRestart=on-failure\nRestartSec=3\n[Install]\nWantedBy=multi-user.target\n`;
              fs.writeFileSync('/etc/systemd/system/xvfb.service', xvfbSvc);
            }
            safeExec('systemctl daemon-reload && systemctl enable xvfb && systemctl start xvfb', 15000);
          }
          const oSvc = '/etc/systemd/system/openclaw.service';
          try {
            const svcContent = fs.readFileSync(oSvc, 'utf8');
            if (!svcContent.includes('DISPLAY=')) {
              fs.writeFileSync(oSvc, svcContent.replace('[Service]', '[Service]\nEnvironment=DISPLAY=:99'));
              safeExec('systemctl daemon-reload', 10000);
            }
          } catch {}
        }
        // Ensure TRUSTED_TOOL_RESULT_MEDIA has camofox tools (may be missing after OpenClaw update)
        patchTrustedMedia();
      }
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
      safeExec(`chown openclaw:openclaw "${CONFIG_FILE}"`, 5000);
      clearBrowserSessions();
      updateBrowserToolsMd(browser);
      restartService('openclaw'); await new Promise(r => setTimeout(r, 3000));
      return json(res, 200, { ok: true });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // Plugins List
  if (req.method === 'GET' && url.pathname === '/api/plugins') {
    try {
      const out = safeExec(suOC(`cd ${OPENCLAW_DIR} && node dist/index.js plugins list --json`) + ' 2>/dev/null', 30000);
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
      const out = safeExec(suOC(`cd ${OPENCLAW_DIR} && node dist/index.js plugins ${action} ${id}`) + ' 2>&1', 30000);
      restartService('openclaw'); await new Promise(r => setTimeout(r, 2000));
      return json(res, 200, { ok: true, log: out });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // Plugin Install
  if (req.method === 'POST' && url.pathname === '/api/plugins/install') {
    try {
      const body = await parseBody(req);
      const spec = (body.spec || '').trim();
      if (!spec || !isSafeShellArg(spec)) return json(res, 400, { ok: false, error: 'Invalid package spec (only alphanumeric, @, ., /, - allowed)' });
      const out = safeExec(suOC(`cd ${OPENCLAW_DIR} && node dist/index.js plugins install '${spec}'`) + ' 2>&1', 120000);
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
      const out = safeExec(suOC(`cd ${OPENCLAW_DIR} && node dist/index.js plugins uninstall ${id} --yes`) + ' 2>&1', 60000);
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
      const out = safeExec(suOC(`cd ${OPENCLAW_DIR} && node dist/index.js ${cmd}`) + ' 2>&1', 120000);
      restartService('openclaw'); await new Promise(r => setTimeout(r, 2000));
      return json(res, 200, { ok: true, log: out });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // Skills List
  if (req.method === 'GET' && url.pathname === '/api/skills') {
    try {
      const out = safeExec(suOC(`cd ${OPENCLAW_DIR} && node dist/index.js skills list --json`) + ' 2>/dev/null', 30000);
      if (!out) return json(res, 500, { ok: false, error: 'Failed to list skills' });
      const data = JSON.parse(out);
      const skills = data.skills || [];
      const installsMap = getSkillInstalls();
      skills.forEach(s => {
        const si = installsMap[s.name] || [];
        s.installs = si.map(i => ({ id: i.id, kind: i.kind, label: i.label || (i.kind + ' install'), bins: i.bins || [], supported: !!LINUX_INSTALL_KINDS[i.kind] }));
        // Add apt fallbacks for bins without any supported install option
        if (s.missing && !s.installs.some(i => i.supported)) {
          const allBins = [...(s.missing.bins || []), ...(s.missing.anyBins || [])];
          allBins.forEach(b => { if (APT_FALLBACKS[b]) s.installs.push({ id: 'apt-' + b, kind: 'apt', label: 'Install ' + b + ' (apt)', bins: [b], package: APT_FALLBACKS[b], supported: true }); });
        }
        // Add env key status (set/unset) for missing env vars
        if (s.missing && s.missing.env && s.missing.env.length) {
          s.envStatus = {};
          s.missing.env.forEach(k => { const v = getEnvValue(k); s.envStatus[k] = v && v !== '#disabled' ? 'set' : 'unset'; });
        }
      });
      return json(res, 200, { ok: true, skills });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // Skills Toggle (enable/disable) via config set
  if (req.method === 'POST' && url.pathname === '/api/skills/toggle') {
    try {
      const body = await parseBody(req);
      const name = (body.name || '').replace(/[^a-zA-Z0-9_-]/g, '');
      if (!name) return json(res, 400, { ok: false, error: 'Missing skill name' });
      const enabled = body.disable ? 'false' : 'true';
      const out = safeExec(suOC(`cd ${OPENCLAW_DIR} && node dist/index.js config set skills.entries.${name}.enabled ${enabled}`) + ' 2>&1', 30000);
      restartService('openclaw'); await new Promise(r => setTimeout(r, 2000));
      return json(res, 200, { ok: true, log: out });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // Skills Set Env Key (for skills that require API keys)
  if (req.method === 'POST' && url.pathname === '/api/skills/set-env') {
    try {
      const body = await parseBody(req);
      const envKey = (body.key || '').replace(/[^A-Z0-9_]/g, '');
      const envVal = (body.value || '').trim();
      if (!envKey) return json(res, 400, { ok: false, error: 'Missing env key' });
      if (!envVal) {
        removeEnvValue(envKey);
        restartService('openclaw'); await new Promise(r => setTimeout(r, 2000));
        return json(res, 200, { ok: true, removed: true });
      }
      setEnvValue(envKey, envVal);
      restartService('openclaw'); await new Promise(r => setTimeout(r, 2000));
      return json(res, 200, { ok: true });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // Skills Install Dependency (from SKILL.md metadata + apt fallbacks)
  if (req.method === 'POST' && url.pathname === '/api/skills/run-install') {
    try {
      const body = await parseBody(req);
      const skillName = (body.skill || '').replace(/[^a-zA-Z0-9_-]/g, '');
      const installId = (body.installId || '').replace(/[^a-zA-Z0-9_-]/g, '');
      if (!skillName || !installId) return json(res, 400, { ok: false, error: 'Missing skill or installId' });
      // Check SKILL.md metadata first
      const installsMap = getSkillInstalls();
      let inst = (installsMap[skillName] || []).find(i => i.id === installId);
      // Check apt fallbacks (synthetic installs with id like "apt-ffmpeg")
      if (!inst && installId.startsWith('apt-')) {
        const bin = installId.substring(4);
        if (APT_FALLBACKS[bin]) inst = { id: installId, kind: 'apt', package: APT_FALLBACKS[bin], bins: [bin] };
      }
      if (!inst) return json(res, 400, { ok: false, error: 'Install option not found for ' + skillName });
      // Pre-check prerequisites (brew installed? go installed? etc.)
      const prereq = checkInstallPrereqs(inst);
      if (!prereq.ok) return json(res, 200, { ok: false, error: prereq.error, needsBrew: prereq.needsBrew || false, needsTool: prereq.needsTool || null });
      const cmd = buildInstallCmd(inst);
      if (!cmd) return json(res, 400, { ok: false, error: 'Install kind "' + inst.kind + '" not supported on this system' });
      // Async task-based install with SSE streaming
      const task = createTask('skill-install-' + skillName);
      json(res, 200, { ok: true, taskId: task.id });
      (async () => {
        try {
          taskLog(task, (inst.label || ('Installing ' + skillName)) + ' via ' + inst.kind + '...');
          await asyncExec(task, cmd, 300000);
          const bins = inst.bins || [];
          const allInstalled = bins.length === 0 || bins.every(b => safeExec('which ' + b.replace(/[^a-zA-Z0-9_-]/g, '') + ' 2>/dev/null', 5000));
          if (allInstalled) { _skillInstallsCache = null; taskLog(task, 'Installation successful!'); taskDone(task, true); }
          else { taskDone(task, false, 'Installation completed but binaries not found: ' + bins.join(', ')); }
        } catch (e) { taskDone(task, false, e.message); }
      })();
      return;
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // Install prerequisite tool (brew, go) — async with SSE streaming
  if (req.method === 'POST' && url.pathname === '/api/skills/install-tool') {
    try {
      const body = await parseBody(req);
      const tool = (body.tool || '').replace(/[^a-zA-Z0-9_-]/g, '');
      if (tool === 'brew') {
        if (safeExec('which brew 2>/dev/null', 5000) || fs.existsSync('/home/linuxbrew/.linuxbrew/bin/brew'))
          return json(res, 200, { ok: true, skipped: true });
        const task = createTask('install-brew');
        json(res, 200, { ok: true, taskId: task.id });
        (async () => {
          try {
            taskLog(task, 'Installing build dependencies...');
            await asyncExec(task, 'apt-get install -y build-essential procps curl file git 2>&1', 120000);
            taskLog(task, 'Downloading and installing Homebrew (this may take a few minutes)...');
            await asyncExec(task, "su - openclaw -c 'NONINTERACTIVE=1 /bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"' 2>&1", 600000);
            if (fs.existsSync('/home/linuxbrew/.linuxbrew/bin/brew')) {
              safeExec('ln -sf /home/linuxbrew/.linuxbrew/bin/brew /usr/local/bin/brew 2>/dev/null', 5000);
              taskLog(task, 'Homebrew installed successfully!');
              taskDone(task, true);
            } else { taskDone(task, false, 'Homebrew installation failed'); }
          } catch (e) { taskDone(task, false, e.message); }
        })();
        return;
      }
      if (tool === 'go') {
        if (safeExec('which go 2>/dev/null', 5000))
          return json(res, 200, { ok: true, skipped: true });
        const task = createTask('install-go');
        json(res, 200, { ok: true, taskId: task.id });
        (async () => {
          try {
            taskLog(task, 'Installing Go via apt...');
            await asyncExec(task, 'apt-get install -y golang-go 2>&1', 180000);
            if (safeExec('which go 2>/dev/null', 5000)) {
              taskLog(task, 'Go installed successfully!');
              taskDone(task, true);
            } else { taskDone(task, false, 'Go installation failed'); }
          } catch (e) { taskDone(task, false, e.message); }
        })();
        return;
      }
      return json(res, 400, { ok: false, error: 'Unknown tool: ' + tool });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // ClawHub Search
  if (req.method === 'POST' && url.pathname === '/api/clawhub/search') {
    try {
      const body = await parseBody(req);
      const query = (body.query || '').trim().substring(0, 100);
      if (!query || !isSafeShellArg(query)) return json(res, 400, { ok: false, error: 'Invalid query (only alphanumeric, @, ., /, - allowed)' });
      const out = safeExec(suOC(`cd ${OPENCLAW_DIR} && npx clawhub search '${query}'`) + ' 2>/dev/null', 30000);
      if (!out) return json(res, 200, { ok: true, results: [] });
      const results = out.split('\n').filter(l => l.trim() && !l.startsWith('-')).map(l => {
        const m = l.match(/^(\S+)\s+(v[\d.]+\s+)?(.+?)\s+\(([\d.]+)\)$/);
        return m ? { slug: m[1], version: (m[2] || '').trim(), name: m[3].trim(), score: parseFloat(m[4]) } : null;
      }).filter(Boolean);
      return json(res, 200, { ok: true, results });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // ClawHub Install — async with SSE streaming
  if (req.method === 'POST' && url.pathname === '/api/clawhub/install') {
    try {
      const body = await parseBody(req);
      const slug = (body.slug || '').replace(/[^a-zA-Z0-9_-]/g, '');
      if (!slug) return json(res, 400, { ok: false, error: 'Missing slug' });
      const task = createTask('clawhub-install-' + slug);
      json(res, 200, { ok: true, taskId: task.id });
      (async () => {
        try {
          taskLog(task, 'Installing ' + slug + ' from ClawHub...');
          const result = await asyncExec(task, suOC(`cd ${OPENCLAW_DIR} && npx clawhub install ${slug} --force`) + ' 2>&1', 120000);
          const log = (result && result.out) || '';
          const failed = result.code !== 0 || log.includes('Error:') || log.includes('ENOENT');
          if (!failed) {
            taskLog(task, 'Restarting OpenClaw...');
            restartService('openclaw'); await new Promise(r => setTimeout(r, 2000));
            taskLog(task, slug + ' installed successfully!');
            taskDone(task, true);
          } else { taskDone(task, false, log || 'Installation failed'); }
        } catch (e) { taskDone(task, false, e.message); }
      })();
      return;
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // ClawHub Uninstall — async with SSE streaming
  if (req.method === 'POST' && url.pathname === '/api/clawhub/uninstall') {
    try {
      const body = await parseBody(req);
      const slug = (body.slug || '').replace(/[^a-zA-Z0-9_-]/g, '');
      if (!slug) return json(res, 400, { ok: false, error: 'Missing slug' });
      const task = createTask('clawhub-uninstall-' + slug);
      json(res, 200, { ok: true, taskId: task.id });
      (async () => {
        try {
          taskLog(task, 'Uninstalling ' + slug + '...');
          await asyncExec(task, suOC(`cd ${OPENCLAW_DIR} && npx clawhub uninstall ${slug} --yes`) + ' 2>&1', 60000);
          taskLog(task, 'Restarting OpenClaw...');
          restartService('openclaw'); await new Promise(r => setTimeout(r, 2000));
          taskLog(task, slug + ' uninstalled.');
          taskDone(task, true);
        } catch (e) { taskDone(task, false, e.message); }
      })();
      return;
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // ClawHub Update — async with SSE streaming
  if (req.method === 'POST' && url.pathname === '/api/clawhub/update') {
    try {
      const body = await parseBody(req);
      const slug = (body.slug || '').replace(/[^a-zA-Z0-9_-]/g, '');
      if (!slug) return json(res, 400, { ok: false, error: 'Missing slug' });
      const cmd = slug === '--all' ? 'update --all' : `update ${slug}`;
      const label = slug === '--all' ? 'all skills' : slug;
      const task = createTask('clawhub-update-' + slug);
      json(res, 200, { ok: true, taskId: task.id });
      (async () => {
        try {
          taskLog(task, 'Updating ' + label + '...');
          await asyncExec(task, suOC(`cd ${OPENCLAW_DIR} && npx clawhub ${cmd}`) + ' 2>&1', 120000);
          taskLog(task, 'Restarting OpenClaw...');
          restartService('openclaw'); await new Promise(r => setTimeout(r, 2000));
          taskLog(task, label + ' updated!');
          taskDone(task, true);
        } catch (e) { taskDone(task, false, e.message); }
      })();
      return;
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // ClawHub List Installed
  if (req.method === 'GET' && url.pathname === '/api/clawhub/list') {
    try {
      const out = safeExec(suOC(`cd ${OPENCLAW_DIR} && npx clawhub list`) + ' 2>/dev/null', 30000);
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
      const tmpFile = '/tmp/panel-update.js';
      let log = '';
      log += 'Downloading latest panel.js...\n';
      const dlResult = safeExec(`curl -fsSL --max-time 30 -o "${tmpFile}" "${PANEL_UPDATE_URL}" && echo "OK"`, 45000);
      if (!dlResult.includes('OK')) { try { fs.unlinkSync(tmpFile); } catch {} return json(res, 500, { ok: false, error: 'Failed to download panel.js', log }); }
      log += 'Validating...\n';
      const stat = fs.statSync(tmpFile);
      if (stat.size < 5000) { fs.unlinkSync(tmpFile); return json(res, 500, { ok: false, error: 'Downloaded file too small (' + stat.size + ' bytes)', log }); }
      const head = fs.readFileSync(tmpFile, 'utf8').substring(0, 300);
      if (!head.includes('#!/usr/bin/env node') || !head.includes('OpenClaw')) { fs.unlinkSync(tmpFile); return json(res, 500, { ok: false, error: 'Invalid file', log }); }
      // Syntax check — reject if JS is invalid
      const syntaxCheck = spawnSync('node', ['--check', tmpFile], { timeout: 10000, stdio: 'pipe' });
      if (syntaxCheck.status !== 0) { fs.unlinkSync(tmpFile); return json(res, 500, { ok: false, error: 'Syntax error in downloaded file', log }); }
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
        version: (() => { let v = getEnvValue('OPENCLAW_VERSION') || ''; if (!v || v === 'Latest') { try { v = JSON.parse(fs.readFileSync(OPENCLAW_DIR + '/package.json', 'utf8')).version || '-'; } catch {} } return v; })(),
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
      if (!id || /\.\./.test(id)) return json(res, 400, { ok: false, error: 'Invalid id' });
      // Find session file by sessionId
      let sessionsData = {}; try { sessionsData = JSON.parse(fs.readFileSync(SESSIONS_INDEX, 'utf8')); } catch {}
      let sessionFile = '';
      for (const sess of Object.values(sessionsData)) {
        if (sess?.sessionId === id && sess.sessionFile) { sessionFile = sess.sessionFile; break; }
      }
      // Fallback: try direct path (with path traversal protection)
      if (!sessionFile) { const tryPath = path.resolve(SESSIONS_DIR, `${id}.jsonl`); if (tryPath.startsWith(path.resolve(SESSIONS_DIR)) && fs.existsSync(tryPath)) sessionFile = tryPath; }
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
      if (body.newPassword.length < 8) return json(res, 400, { ok: false, error: 'Password must be at least 8 characters' });
      if (!verifyPassword('root', body.oldPassword)) return json(res, 401, { ok: false, error: 'Current password incorrect' });
      try {
        const cp = spawnSync('chpasswd', [], { input: `root:${body.newPassword}\n`, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });
        if (cp.status !== 0) throw new Error((cp.stderr || '').toString().trim() || 'chpasswd failed');
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
      // Save installed plugins (npm-installed only, for reinstall on restore)
      try {
        const pout = safeExec(suOC(`cd ${OPENCLAW_DIR} && node dist/index.js plugins list --json`) + ' 2>/dev/null', 30000);
        if (pout) { const pd = JSON.parse(pout); data.installedPlugins = (pd.plugins || []).filter(p => p.origin === 'npm').map(p => ({ id: p.id, name: p.name, enabled: p.enabled })); }
      } catch { data.installedPlugins = []; }
      // Save installed ClawHub skills
      try {
        const cout = safeExec(suOC(`cd ${OPENCLAW_DIR} && npx clawhub list`) + ' 2>/dev/null', 30000);
        if (cout && !cout.includes('No installed skills')) {
          data.installedClawHubSkills = cout.split('\n').filter(l => l.trim() && !l.includes('Installed skills')).map(l => { const m = l.match(/^(\S+)\s+(v[\d.]+)?/); return m ? { slug: m[1], version: (m[2] || '').trim() } : null; }).filter(Boolean);
        } else { data.installedClawHubSkills = []; }
      } catch { data.installedClawHubSkills = []; }
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
      // Reinstall npm plugins
      let restoreLog = '';
      if (d.installedPlugins && Array.isArray(d.installedPlugins) && d.installedPlugins.length) {
        for (const p of d.installedPlugins) {
          try {
            const spec = (p.name || p.id || '').trim();
            if (spec && isSafeShellArg(spec)) { restoreLog += 'Installing plugin: ' + spec + '...\n'; safeExec(suOC(`cd ${OPENCLAW_DIR} && node dist/index.js plugins install '${spec}'`) + ' 2>&1', 120000); }
            else if (spec) { restoreLog += 'Skipping plugin (unsafe chars): ' + spec + '\n'; }
          } catch (e) { restoreLog += 'Plugin install error: ' + e.message + '\n'; }
        }
      }
      // Reinstall ClawHub skills
      if (d.installedClawHubSkills && Array.isArray(d.installedClawHubSkills) && d.installedClawHubSkills.length) {
        for (const s of d.installedClawHubSkills) {
          try {
            const slug = (s.slug || '').replace(/[^a-zA-Z0-9_-]/g, '');
            if (slug) { restoreLog += 'Installing skill: ' + slug + '...\n'; safeExec(suOC(`cd ${OPENCLAW_DIR} && npx clawhub install ${slug} --force`) + ' 2>&1', 60000); }
          } catch (e) { restoreLog += 'Skill install error: ' + e.message + '\n'; }
        }
      }
      restartService('openclaw'); await new Promise(r => setTimeout(r, 2000));
      return json(res, 200, { ok: isServiceActive('openclaw'), log: restoreLog || null });
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
          suOC(`cd ${OPENCLAW_DIR} && node dist/index.js ${cmd}`) + ' 2>&1',
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

  // SSE Task Stream — real-time log streaming for long-running operations
  if (req.method === 'GET' && url.pathname.startsWith('/api/tasks/') && url.pathname.endsWith('/stream')) {
    const taskId = url.pathname.split('/')[3];
    const task = tasks[taskId];
    if (!task) return json(res, 404, { ok: false, error: 'Task not found' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
      'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'
    });
    // Send catch-up logs
    for (const line of task.logs) {
      res.write(`data: ${JSON.stringify({ type: 'log', text: line.text })}\n\n`);
    }
    // If already done, send done event and close
    if (task.status !== 'running') {
      res.write(`data: ${JSON.stringify({ type: 'done', ...task.result })}\n\n`);
      res.end();
      return;
    }
    // Register for live updates
    task.listeners.add(res);
    req.on('close', () => task.listeners.delete(res));
    // Heartbeat every 15s
    const hb = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch { clearInterval(hb); } }, 15000);
    req.on('close', () => clearInterval(hb));
    return;
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
