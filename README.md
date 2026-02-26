# OpenClaw — Self-hosted AI Assistant Gateway

<p align="center">
  <img src="https://img.shields.io/badge/Ubuntu-24.04-E95420?logo=ubuntu&logoColor=white" alt="Ubuntu 24.04">
  <img src="https://img.shields.io/badge/Node.js-22-339933?logo=node.js&logoColor=white" alt="Node.js 22">
  <img src="https://img.shields.io/badge/License-MIT-blue" alt="MIT License">
</p>

**OpenClaw** is a self-hosted AI assistant gateway that connects multiple messaging platforms with LLM providers. Deploy on any Ubuntu 24.04 VPS and manage everything through a web-based Management Panel.

---

## Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/LeAnhlinux/OpenClaw/main/install.sh | bash
```

> **Requirements:** Ubuntu 24.04 LTS, minimum 2 vCPU / 4GB RAM

After installation (~10-15 minutes), access the Management Panel at `http://<your-server-ip>:9999` and log in with your server's root password.

---

## Features

### AI Providers
- **Multi-provider support** — Anthropic Claude, OpenAI, Google Gemini, DeepSeek, and any OpenAI-compatible API
- **One-click switching** — Change provider and model instantly from the panel
- **API key management** — Test, save, and rotate API keys securely
- **Fallback chain** — Automatic failover when primary provider is down, with per-provider rate limits and cooldown

### Multi-Agent System
- **Multiple AI agents** — Create specialized agents (Support Bot, Community Manager, Developer Assistant, etc.)
- **Per-agent model override** — Each agent can use a different LLM model
- **Channel binding** — Assign agents to specific messaging channels
- **Custom identity** — Name, emoji, and personality per agent
- **Skill management** — Toggle skills per agent

### Messaging Channels
- **Telegram** — Bot token integration
- **Discord** — Bot token integration
- **Slack** — App token integration
- **WhatsApp** — Device pairing
- **Zalo** — Device pairing

### Browser Tool
- **Chrome** — Built-in headless Chrome for web browsing, screenshots, and automation
- **CamoFox** — Anti-detection Firefox browser (plugin-based)
- **One-click switch** — Toggle between Chrome and CamoFox

### Plugins & Skills
- **Plugin marketplace** — Install, update, and manage plugins
- **ClawHub** — Community skill marketplace with search, install, and auto-update
- **Per-agent skills** — Enable/disable skills for individual agents

### Gateway & Devices
- **Device pairing** — Approve and manage connected devices
- **Token management** — Generate, customize, and rotate gateway tokens
- **Multi-device support** — Connect from multiple platforms simultaneously

### Domain & SSL
- **Custom domain** — Point your domain to the server
- **Auto HTTPS** — Free SSL certificates via Let's Encrypt
- **One-click setup** — Domain configuration with automatic Caddy reverse proxy

### Management & Monitoring
- **Doctor** — Automated health checks with scan, repair, and deep diagnostics
- **Backup & Restore** — Export and import full configuration (agents, plugins, skills, channels)
- **Live logs** — Real-time service log streaming
- **Service control** — Restart OpenClaw, Caddy, or Panel from the UI
- **Auto-update** — Update OpenClaw to the latest version from the panel
- **Dark / Light mode** — Theme switching

### Security
- **PAM authentication** — Login with server root credentials
- **Session management** — Auto-expiring sessions (15 minutes)
- **Brute-force protection** — Rate-limited login attempts with IP blocking
- **UFW firewall** — Pre-configured firewall rules
- **Security headers** — XSS, clickjacking, and MIME-sniffing protection

---

## Management Panel

Access your panel after installation:

| Setup | URL |
|-------|-----|
| IP only (default) | `http://<server-ip>:9999` |
| With custom domain | `https://<your-domain>:9443` |

Login using your server's **root password**.

---

## License

MIT
