# CLAUDE.md - OpenClaw Setup & Management Panel

## Tổng quan dự án

Công cụ cài đặt và quản lý **OpenClaw** — AI assistant gateway tự host, tích hợp nhiều nền tảng nhắn tin (WhatsApp, Telegram, Slack, Discord, Zalo) với các nhà cung cấp LLM (Anthropic Claude, OpenAI, Google Gemini, DeepSeek, v.v.).

## Công nghệ sử dụng

- **Ubuntu 24.04 LTS** — Hệ điều hành nền
- **Node.js 22** với **pnpm** — Runtime ứng dụng
- **Caddy** — Reverse proxy với TLS tự động
- **Docker** — Môi trường sandbox
- **systemd** — Quản lý dịch vụ
- **UFW** — Tường lửa

## Cài đặt

```bash
curl -fsSL https://<host>/install.sh | bash
```

Sau khi cài xong, truy cập `http://<server-ip>:9999` để vào Management Panel và cấu hình.

## Cấu trúc thư mục

```
clawdbot-24-04/
├── install.sh                 # ⭐ Script cài đặt all-in-one
├── setup-ui/
│   └── panel.js               # ⭐ Management Panel — SPA single-file (~4600 lines)
├── files/
│   ├── etc/
│   │   ├── config/            # Cấu hình nhà cung cấp LLM (anthropic.json, openai.json)
│   │   ├── setup_wizard.sh    # Trình hướng dẫn cài đặt lần đầu
│   │   └── update-motd.d/     # Banner SSH
│   └── var/lib/cloud/scripts/per-instance/
│       └── 001_onboot         # Script chạy lần đầu khởi động
└── scripts/
    └── openclaw.sh            # Script cài đặt (Node.js, Caddy, OpenClaw, helper scripts)
```

## Management Panel (`setup-ui/panel.js`)

### Kiến trúc

File **duy nhất** `panel.js` chứa toàn bộ: Node.js HTTP server, API endpoints, HTML template literal, CSS, và browser JavaScript. Chạy như systemd service `openclaw-panel` trên port **9999**.

### Tính năng UI

#### AI Provider
- **Grid cards** với badge trạng thái: `ACTIVE` (xanh lá), `CONFIGURED` (xanh dương), hoặc chưa cấu hình
- **Modal**: Chọn model, nhập/test API key, Apply & Switch, Save Key, Remove Key
- Provider đã CONFIGURED → bấm Apply & Switch không cần nhập lại key
- Xóa key provider → nếu có agent đang dùng → confirm reset agent về default model
- **Stat overview**: Active Provider, Current Model, Configured, Available

#### Multi-Agent Management
- **Stat overview**: Tổng agents, Default agent, Bindings, Routes
- **Grid cards**: emoji, tên, ID, model, binding channels (telegram, zalo, etc.)
- **Filter pills**: All / Default / Custom + Search theo tên/ID/model
- **Modal 2 tabs**:
  - **Info & Identity**: xem/sửa identity (name/emoji/theme), model override, bindings (hiện tên channel), delete
  - **Skills**: toggle per-agent skills (Use all / chọn từng skill)
- **Add Agent**: template presets (Support Bot, Community Manager, Developer Assistant), model, channel binding (chỉ hiện channels đã có token)

#### Fallback Chain
- Chuỗi provider dự phòng khi primary fail
- Thêm/xóa provider, sắp xếp priority

#### Channels
- Cấu hình Telegram, Discord, Slack, WhatsApp, Zalo
- Nhập token, pair device, enable/disable

#### Gateway
- Quản lý token, pair devices (approve tất cả pending requests cùng lúc)
- Revoke devices, generate/custom token

#### Browser
- CamoFox (anti-detection Firefox) hoặc Chrome
- Install, activate, uninstall
- Status detection dùng runtime state (port check) làm fallback

#### Plugins & Skills
- Grid cards + modal detail + search/filter
- ClawHub marketplace: search, install, update, uninstall
- Toggle enable/disable per plugin/skill

#### Các tab khác
- **Domain**: Custom domain + HTTPS tự động (Let's Encrypt)
- **Config**: Raw JSON editor cho openclaw.json
- **Status**: Service logs, restart openclaw/caddy/panel
- **Doctor**: Health check tự động
- **Chat Playground**: Test chat trực tiếp
- **Analytics**: Usage statistics
- **History**: Conversation history
- **Users**: User management
- **Backup**: Backup & restore config
- **QR Code**: Tạo QR code local

### CLI Quirks quan trọng

```bash
# CLI agents add --non-interactive BẮT BUỘC --workspace
/opt/openclaw-cli.sh agents add "name" --non-interactive \
  --workspace "/home/openclaw/.openclaw/agents/name" --json

# CLI --bind KHÔNG HOẠT ĐỘNG trong non-interactive mode (plugin registry không load)
# → Panel ghi binding trực tiếp vào config.bindings[]

# Channel binding dropdown chỉ hiện channels đã có token (active channels)
```

### Syntax Check & Deploy

```bash
# Syntax check
node --check setup-ui/panel.js && node /tmp/check_panel5.js

# Deploy
scp setup-ui/panel.js root@<server>:/opt/openclaw-panel/panel.js
ssh root@<server> 'systemctl restart openclaw-panel'
```

## Quy ước kỹ thuật

- Gateway port **18789** phía sau Caddy reverse proxy
- Panel port **9999**
- Config chính: `/home/openclaw/.openclaw/openclaw.json` — `getConfig()` / `saveConfig()`
- Environment: `/home/openclaw/.openclaw/.env` — `getEnvValue()` / `setEnvValue()` / `removeEnvValue()`
- `agents.list` trong config có thể là array hoặc object — code handle cả 2
- OpenClaw normalizes config on restart — có thể strip `plugins.entries` và `browser.enabled`

## Scripts quản lý (trên server)

| Script | Mô tả |
|--------|--------|
| `/opt/openclaw-cli.sh` | CLI wrapper (`su - openclaw -c "cd /opt/openclaw && node dist/index.js $*"`) |
| `/opt/restart-openclaw.sh` | Restart dịch vụ |
| `/opt/status-openclaw.sh` | Xem trạng thái + gateway token |
| `/opt/update-openclaw.sh` | Cập nhật phiên bản mới |
| `/opt/openclaw-tui.sh` | Terminal UI |
| `/opt/setup-openclaw-domain.sh` | Cấu hình domain + HTTPS |

## Lưu ý quan trọng

- Không commit API key hoặc token thật — chỉ dùng placeholder
- Gateway token tự động tạo (64 hex chars) lần đầu khởi động
- Caddy tự động xử lý TLS qua Let's Encrypt
- Browser status detection dùng runtime port check làm fallback khi config bị normalize
