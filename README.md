# OpenClaw - Self-hosted AI Assistant Gateway

<p align="center">
  <img src="https://tino.vn/assets/logo/logo-mobile-light.png" alt="Logo" height="48">
</p>

Script cai dat all-in-one de deploy **OpenClaw** — AI assistant gateway tu host tren bat ky Ubuntu 24.04 VM nao. Tich hop nhieu nen tang nhan tin (Telegram, Zalo) voi cac nha cung cap LLM (Anthropic Claude, OpenAI, Google Gemini).

## Cai dat nhanh

### Phien ban No-Sandbox (khuyen nghi cho VPS nho)

```bash
curl -fsSL https://raw.githubusercontent.com/LeAnhlinux/OpenClaw/main/install-gui-nosandbox.sh | bash
```

### Phien ban co Docker Sandbox

```bash
curl -fsSL https://raw.githubusercontent.com/LeAnhlinux/OpenClaw/main/install-gui.sh | bash
```

### Phien ban CLI (khong co Web Setup UI)

```bash
curl -fsSL https://raw.githubusercontent.com/LeAnhlinux/OpenClaw/main/install.sh | bash
```

> Yeu cau: Ubuntu 24.04 LTS, toi thieu 1 vCPU / 2GB RAM

---

## Workflow sau khi cai dat

### Phase 1: Script cai dat tu dong (~10-15 phut)

```
 1.  Doi apt lock giai phong
 2.  Cap nhat he thong + cai packages (git, jq, ufw...)
 3.  Cau hinh tuong lua UFW
     ├── Port 80, 443      (HTTP/HTTPS)
     ├── Port 18789        (OpenClaw Gateway)
     ├── Port 22           (SSH - rate limit)
     └── Port 9999         (Setup UI - tam thoi)
 4.  Cai dat Node.js 22 + pnpm
 4b. Cai dat Google Chrome (cho browser tool)
 5.  Cai dat Caddy (reverse proxy + TLS tu dong)
 6.  Tao user "openclaw"
     ├── Home: /home/openclaw
     ├── Config: /home/openclaw/.openclaw/
     └── Sudoers: NOPASSWD ALL (ban nosandbox)
 7.  Clone repo openclaw + checkout version
 8.  Tao /opt/openclaw.env (bien moi truong)
 9.  Tao systemd service: openclaw.service
10.  Tao helper scripts (/opt/*.sh)
11.  Ghi config JSON templates -> /etc/config/*.json
     ├── anthropic.json
     ├── openai.json
     ├── gemini.json
     └── Moi file gom: agents, gateway, browser config
12.  Tao MOTD banner (hien khi SSH)
13.  Tao setup_wizard.sh (backup CLI)
14.  Cau hinh Caddy mac dinh (self-signed TLS cho IP)
     + Copy anthropic.json -> openclaw.json (mac dinh)
15.  Build OpenClaw (pnpm install + build + ui)
     + Tao /usr/local/bin/openclaw wrapper
16.  Cai dat Homebrew + wacli
17.  Tao gateway token (random 64 hex)
18.  Tai Setup UI (server.js) tu GitHub
     + Tao openclaw-setup.service
19.  Enable + Start services
     ├── openclaw.service    (port 18789)
     ├── caddy.service       (port 80/443)
     └── openclaw-setup.service (port 9999)
20.  Don dep apt

 => In ra URL Setup UI: http://<IP>:9999
```

### Phase 2: Setup UI Web (http://\<IP\>:9999)

Sau khi script chay xong, mo trinh duyet va truy cap Setup UI:

```
LOGIN
  |  Xac thuc PAM (root password)
  v
STEP 1: Ten mien & SSL (tuy chon)
  |  Co domain -> Nhap domain + email
  |    -> Kiem tra DNS (A record tro ve IP server)
  |    -> Cau hinh Caddy voi Let's Encrypt ACME
  |  Khong co -> Bo qua (dung IP + self-signed cert)
  v
STEP 2: Chon AI Provider + Model
  |  ○ Anthropic (Claude Opus 4.5 / Sonnet 4 / Haiku 3.5)
  |  ○ OpenAI   (GPT-5.2 / o3 / GPT-4.1 / GPT-4.1 Mini)
  |  ○ Google   (Gemini 2.5 Pro / Flash / 2.0 Flash / Lite)
  v
STEP 3: Nhap API Key
  |  -> Goi API that de verify key hop le
  |     (POST /api/test-key)
  v
STEP 4: Xac nhan cau hinh
  |  Hien thi: Provider, Model, API Key (masked)
  |  -> Bam "Hoan tat cai dat"
  |  -> Ghi API key vao /opt/openclaw.env
  |  -> Copy config JSON + set gateway token + model
  |  -> Restart openclaw
  |     (POST /api/setup)
  v
STEP 5: Kenh nhan tin (tuy chon)
  |  Chon kenh:
  |  ├── Telegram Bot
  |  │   -> Nhap Bot Token (tu @BotFather)
  |  │   -> Luu (POST /api/channels)
  |  │   -> Hien form Pairing Code
  |  │   -> Gui tin nhan cho bot -> nhan code
  |  │   -> Nhap code -> Ghep noi
  |  │      (POST /api/telegram-pair)
  |  │      -> openclaw pairing approve telegram <code>
  |  │
  |  └── Zalo Bot
  |      -> Nhap Bot Token (tu bot.zaloplatforms.com)
  |      -> Luu (POST /api/channels)
  |      -> Hien form Pairing Code
  |      -> Gui tin nhan cho bot -> nhan code
  |      -> Nhap code -> Ghep noi
  |         (POST /api/zalo-pair)
  |         -> openclaw pairing approve zalo <code>
  v
STEP 6: Ghep noi Dashboard
  |  -> Hien link dashboard (https://<host>?token=<token>)
  |  -> User mo link trong tab moi
  |  -> Quay lai bam "Ghep noi"
  |     (POST /api/pair)
  |     -> devices list -> tim pending UUID -> devices approve
  v
STEP 7: Hoan tat
     -> Hien dashboard URL
     -> selfDestruct() sau 5 giay:
        ├── ufw deny 9999
        ├── Disable + xoa openclaw-setup.service
        ├── Xoa /opt/openclaw-setup/
        └── process.exit(0)

 => Setup UI TU DONG XOA VINH VIEN sau khi hoan tat
```

### Phase 3: He thong san sang

```
Services dang chay:
├── openclaw.service   (port 18789, user: openclaw)
└── caddy.service      (port 80/443 -> reverse proxy 18789)

Setup UI: DA TU HUY (port 9999 dong)

Truy cap Dashboard:
└── https://<IP-hoac-domain>?token=<gateway-token>
```

---

## Cau truc thu muc

```
clawdbot-24-04/
├── install.sh                    # Script cai dat CLI (khong co Web UI)
├── install-gui.sh                # Script cai dat + Web Setup UI (co Docker sandbox)
├── install-gui-nosandbox.sh      # Script cai dat + Web Setup UI (khong Docker)
├── setup-ui/
│   └── server.js                 # Setup UI web server (Node.js, port 9999)
├── template.json                 # Template build Packer cho DigitalOcean
├── files/
│   ├── etc/
│   │   ├── config/               # Config JSON templates
│   │   │   ├── anthropic.json    # Anthropic Claude config
│   │   │   ├── openai.json       # OpenAI GPT config
│   │   │   ├── gemini.json       # Google Gemini config
│   │   │   └── gradientai.json   # Gradient AI config (free models)
│   │   ├── setup_wizard.sh       # Setup wizard CLI (backup)
│   │   └── update-motd.d/        # MOTD banner khi SSH
│   └── var/lib/cloud/scripts/per-instance/
│       └── 001_onboot            # Cloud-init script (Packer only)
├── scripts/
│   └── openclaw.sh               # Script cai dat cho Packer
├── CLAUDE.md                     # Huong dan cho AI assistant
└── README.md                     # File nay
```

---

## Cau hinh tren server

### Files cau hinh

| File | Mo ta |
|------|-------|
| `/opt/openclaw.env` | Bien moi truong (API keys, tokens, version) |
| `/home/openclaw/.openclaw/openclaw.json` | Config chinh (provider, model, gateway, browser) |
| `/etc/config/*.json` | Config templates (dung khi setup) |
| `/etc/caddy/Caddyfile` | Cau hinh reverse proxy |

### Config JSON mau (sau khi setup)

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-opus-4-5"
      },
      "maxConcurrent": 4,
      "subagents": {
        "maxConcurrent": 8
      }
    }
  },
  "gateway": {
    "mode": "local",
    "bind": "loopback",
    "auth": {
      "token": "<gateway-token>"
    },
    "trustedProxies": ["127.0.0.1", "::1"]
  },
  "browser": {
    "headless": true,
    "executablePath": "/usr/bin/google-chrome",
    "defaultProfile": "openclaw",
    "noSandbox": true
  }
}
```

### Browser Tool

OpenClaw co browser tool de AI co the duyet web. Cau hinh mac dinh:

- **Google Chrome** cai san tai `/usr/bin/google-chrome`
- **Headless mode**: bat (khong can man hinh)
- **Profile**: `openclaw` (CDP managed - khong can Chrome extension)
- **noSandbox**: bat (can thiet cho user non-root tren server)
- **CDP port**: 18792 (noi bo, khong can mo firewall)

### Ports su dung

| Port | Service | Ghi chu |
|------|---------|---------|
| 22 | SSH | Rate-limited boi UFW |
| 80 | Caddy (HTTP) | Redirect sang HTTPS |
| 443 | Caddy (HTTPS) | Reverse proxy -> 18789 |
| 9999 | Setup UI | Tam thoi, tu dong xoa sau setup |
| 18789 | OpenClaw Gateway | Bind loopback, phia sau Caddy |
| 18792 | Chrome CDP | Noi bo, browser tool |

---

## Lenh quan ly (tren server)

```bash
# Khoi dong lai OpenClaw
/opt/restart-openclaw.sh

# Xem trang thai + gateway token
/opt/status-openclaw.sh

# Cap nhat phien ban moi
/opt/update-openclaw.sh

# Chay lenh CLI
/opt/openclaw-cli.sh <command>
# hoac
openclaw <command>

# Giao dien Terminal UI
/opt/openclaw-tui.sh

# Cau hinh ten mien + HTTPS
/opt/setup-openclaw-domain.sh

# Mo lai Setup UI (neu can)
/opt/restart-setup-ui.sh
```

### Lenh CLI thuong dung

```bash
# Xem config
openclaw config get browser
openclaw config get gateway

# Set config
openclaw config set browser.headless true
openclaw config set browser.defaultProfile openclaw

# Browser tool
openclaw browser status
openclaw browser start
openclaw browser open https://example.com

# Kenh nhan tin - pairing
openclaw pairing list telegram
openclaw pairing approve telegram <code>
openclaw pairing list zalo
openclaw pairing approve zalo <code>

# Devices (dashboard pairing)
openclaw devices list --token=<gateway-token>
openclaw devices approve <uuid> --token=<gateway-token>
```

---

## Luu y quan trong

- **Khong commit API key** hoac token that; chi su dung gia tri placeholder
- **Gateway token** tu dong tao (64 ky tu hex) khi cai dat
- **Caddy** tu dong xu ly TLS (Let's Encrypt khi co domain, self-signed khi dung IP)
- **Setup UI tu huy** vinh vien sau khi setup xong (xoa file + dong port 9999)
- **trustedProxies** phai co ca `127.0.0.1` va `::1` (Caddy co the ket noi qua IPv6 loopback)
- **Browser tool** can `defaultProfile: "openclaw"` de dung CDP mode (mac dinh la `"chrome"` = extension relay, khong hoat dong tren headless server)
- Wrapper `/usr/local/bin/openclaw` chay bang `su - openclaw` de doc dung config tu `/home/openclaw/.openclaw/`

---

## License

MIT
