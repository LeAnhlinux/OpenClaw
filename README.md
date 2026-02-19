# OpenClaw - Self-hosted AI Assistant Gateway

<p align="center">
  <img src="https://tino.vn/assets/logo/logo-mobile-light.png" alt="Logo" height="48">
</p>

Script cai dat all-in-one de deploy **OpenClaw** — AI assistant gateway tu host tren bat ky Ubuntu 24.04 VM nao. Tich hop nhieu nen tang nhan tin (Telegram, Discord, Slack, WhatsApp) voi cac nha cung cap LLM (Anthropic Claude, OpenAI, Google Gemini).

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

### Phien ban Dev (co Docker Sandbox + dev tools)

```bash
curl -fsSL https://raw.githubusercontent.com/LeAnhlinux/OpenClaw/main/install-dev.sh | bash
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
     ├── Port 9999         (Panel HTTP — mac dinh khi chua co domain)
     └── Port 22           (SSH — rate limit)
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
     ├── anthropic.json, openai.json, gemini.json
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
18b. Tai Management Panel (panel.js) tu GitHub
     + Tao openclaw-panel.service (chua enable)
19.  Enable + Start services
     ├── openclaw.service        (port 18789)
     ├── caddy.service           (port 80/443)
     ├── openclaw-setup.service  (port 9999 — tam thoi)
     └── openclaw-panel.service  (CHUA enable — doi setup xong)
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
  |    -> Cau hinh Caddy: gateway HTTPS + Panel HTTPS :9443
  |    -> Firewall: mo 9443, dong 9999
  |  Khong co -> Bo qua (dung IP + self-signed cert)
  |    -> Panel se truy cap qua HTTP :9999
  v
STEP 2: Chon AI Provider + Model
  |  ○ Anthropic (Claude Opus 4.5 / Sonnet 4 / Haiku 3.5)
  |  ○ OpenAI   (GPT-5.2 / o3 / GPT-4.1 / GPT-4.1 Mini)
  |  ○ Google   (Gemini 2.5 Pro / Flash / 2.0 Flash / Lite)
  v
STEP 3: Nhap API Key
  |  -> Goi API that de verify key hop le
  v
STEP 4: Xac nhan cau hinh
  |  -> Ghi API key vao /opt/openclaw.env
  |  -> Copy config JSON + set gateway token + model
  |  -> Restart openclaw
  v
STEP 5: Kenh nhan tin (tuy chon)
  |  └── Telegram Bot -> Nhap Bot Token -> Ghep noi
  v
STEP 6: Ghep noi Dashboard
  |  -> Mo link dashboard trong tab moi
  |  -> Quay lai bam "Ghep noi"
  |  -> devices list --json -> tim pending requestId -> devices approve
  v
STEP 7: Hoan tat -> Chuyen giao sang Management Panel (~3 giay)
     -> selfDestruct():
        ├── Enable openclaw-panel, disable openclaw-setup
        ├── server.close() giai phong port 9999
        ├── systemctl start openclaw-panel (tiep quan port 9999)
        ├── systemd-run: don dep file setup (chay ngoai process tree)
        └── process.exit(0)

 => Setup UI TU DONG XOA VINH VIEN
 => Management Panel tiep quan port 9999 ngay lap tuc
```

### Phase 3: Management Panel (chay thuong truc)

```
Truy cap:
├── Co domain:  https://<domain>:9443     (HTTPS qua Caddy)
└── Khong domain: http://<IP>:9999        (HTTP truc tiep)

Dang nhap: Xac thuc PAM (root password), session 15 phut

Cac tab quan ly:
├── AI Provider     — Doi provider, model, API key
├── Fallback        — Chuoi provider du phong
│   ├── Fallback chain (thu tu uu tien)
│   ├── Them/xoa provider voi API key rieng
│   └── Rate limit / phut + cooldown khi loi
├── Kenh nhan tin   — Quan ly Telegram, Discord, Slack tokens
├── Gateway         — Token, thiet bi, ghep noi
│   ├── Thong tin gateway token + dashboard URL
│   ├── Ghep noi thiet bi (approve pending requestId)
│   ├── Danh sach thiet bi (platform, IP, mode, trang thai)
│   └── Revoke de huy ghep noi / Tao doi token
├── Domain & SSL    — Cau hinh ten mien + Let's Encrypt
│   ├── Set domain -> Caddy gateway + Panel HTTPS :9443
│   └── Reset IP   -> Panel HTTP :9999 truc tiep
├── Chat            — Test AI chat truc tiep
├── Cap nhat        — Update phien ban OpenClaw
├── Doctor          — Chan doan he thong (scan / repair / deep)
├── Backup/Restore  — Sao luu va khoi phuc cau hinh
│   ├── Download file backup JSON
│   └── Upload file backup de restore
├── Trang thai      — Xem services, logs, restart
└── Giao dien       — Chuyen dark / light mode
```

### Toan bo lifecycle

```
[Install script]  ──>  [Setup UI :9999]  ──selfDestruct──>  [Panel :9999 hoac :9443]
   ~10-15 phut           1 lan duy nhat         ~3 giay          chay thuong truc
                         roi tu huy                              (reboot tu start)
```

---

## Cau truc thu muc

```
clawdbot-24-04/
├── install.sh                    # Script cai dat CLI (khong co Web UI)
├── install-gui.sh                # Script cai dat + Web Setup UI (co Docker sandbox)
├── install-gui-nosandbox.sh      # Script cai dat + Web Setup UI (khong Docker)
├── install-dev.sh                # Script cai dat + Web Setup UI (dev + Docker sandbox)
├── setup-ui/
│   ├── server.js                 # Setup UI web server (one-time wizard, port 9999)
│   └── panel.js                  # Management Panel server (persistent, port 9999)
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
| `/etc/caddy/Caddyfile` | Cau hinh reverse proxy (gateway + panel) |
| `/opt/openclaw-fallback.json` | Cau hinh fallback chain + rate limit |
| `/opt/openclaw-doctor-history.json` | Lich su chan doan Doctor |

### Caddyfile khi co domain

```
domain.com {
    tls { issuer acme { ... } }
    reverse_proxy 127.0.0.1:18789    # Gateway
}

domain.com:9443 {
    tls { issuer acme { ... } }
    reverse_proxy 127.0.0.1:9999     # Panel
}
```

### Caddyfile khi dung IP

```
<IP> {
    tls internal
    reverse_proxy 127.0.0.1:18789    # Gateway
}
# Panel truy cap truc tiep: http://<IP>:9999
```

### Ports su dung

| Port | Service | Ghi chu |
|------|---------|---------|
| 22 | SSH | Rate-limited boi UFW |
| 80 | Caddy (HTTP) | Redirect sang HTTPS |
| 443 | Caddy (HTTPS) | Reverse proxy -> Gateway 18789 |
| 9443 | Caddy (HTTPS) | Reverse proxy -> Panel 9999 (khi co domain) |
| 9999 | Management Panel | HTTP truc tiep (khi khong co domain) |
| 18789 | OpenClaw Gateway | Bind loopback, phia sau Caddy |
| 18792 | Chrome CDP | Noi bo, browser tool |

### Logic port Panel

| Truong hop | Panel truy cap | Firewall |
|-----------|----------------|----------|
| Co domain | `https://<domain>:9443` | Mo 9443, dong 9999 |
| Khong domain (IP) | `http://<IP>:9999` | Mo 9999, dong 9443 |

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

# Devices (dashboard pairing)
openclaw devices list --token=<gateway-token>
openclaw devices list --token=<gateway-token> --json
openclaw devices approve <requestId> --token=<gateway-token>
openclaw devices revoke --device <deviceId> --role operator --token=<gateway-token>

# Doctor (chan doan he thong)
openclaw doctor --non-interactive
openclaw doctor --repair --yes
openclaw doctor --deep --yes
```

---

## Multi-Provider Fallback

Panel ho tro cau hinh chuoi provider du phong:

```
Primary Provider (vd: Anthropic Claude)
  |  Goi API that bai / rate limit
  v
Fallback #1 (vd: OpenAI GPT-4.1)
  |  Goi API that bai / rate limit
  v
Fallback #2 (vd: Google Gemini 2.5 Pro)
  |  ...
  v
Tra loi loi neu tat ca provider deu that bai
```

- Moi provider co **rate limit rieng** (so request/phut)
- Khi provider loi, **cooldown** tu dong (mac dinh 300 giay)
- Cau hinh luu tai `/opt/openclaw-fallback.json`
- Ho tro: Anthropic (native), Google Gemini (native), OpenAI-compatible

---

## Luu y quan trong

- **Khong commit API key** hoac token that; chi su dung gia tri placeholder
- **Gateway token** tu dong tao (64 ky tu hex) khi cai dat
- **Caddy** tu dong xu ly TLS (Let's Encrypt khi co domain, self-signed khi dung IP)
- **Setup UI tu huy** vinh vien sau khi setup xong, chuyen giao sang Management Panel (~3 giay)
- **Panel HTTPS**: co domain -> port 9443, khong domain -> port 9999 HTTP
- **Device approve** can dung `requestId` (UUID), khong phai `deviceId` (64-char hex)
- **Device revoke** chi thu hoi token, device van nam trong danh sach voi trang thai "Da huy"
- **trustedProxies** phai co ca `127.0.0.1` va `::1` (Caddy co the ket noi qua IPv6 loopback)
- **Browser tool** can `defaultProfile: "openclaw"` de dung CDP mode
- Wrapper `/usr/local/bin/openclaw` chay bang `su - openclaw` de doc dung config

---

## License

MIT
