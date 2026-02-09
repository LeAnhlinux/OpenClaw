# CLAUDE.md - OpenClaw DigitalOcean 1-Click Image

## Tổng quan dự án

Đây là công cụ build image **OpenClaw** 1-Click Droplet cho DigitalOcean. Sử dụng Packer để tạo snapshot triển khai một AI assistant gateway tự host, tích hợp nhiều nền tảng nhắn tin (WhatsApp, Telegram, Slack, Discord) với các nhà cung cấp LLM (Anthropic Claude, OpenAI).

Ngoài ra có file **`install.sh`** all-in-one để cài đặt trực tiếp trên bất kỳ Ubuntu VM nào qua cloud-init hoặc chạy thủ công.

## Công nghệ sử dụng

- **Packer** — Tự động hóa build image cho DigitalOcean
- **Ubuntu 24.04 LTS** — Hệ điều hành nền
- **Node.js 22** với **pnpm** — Runtime ứng dụng
- **Caddy** — Reverse proxy với TLS tự động
- **Docker** — Môi trường sandbox
- **systemd** — Quản lý dịch vụ
- **UFW / fail2ban** — Tường lửa và chống xâm nhập

## Cấu trúc thư mục

```
clawdbot-24-04/
├── install.sh                 # ⭐ Script cài đặt all-in-one (dùng cho cloud-init hoặc chạy thủ công)
├── template.json              # Template build Packer (phiên bản, packages, provisioners)
├── files/
│   ├── etc/
│   │   ├── config/            # Cấu hình nhà cung cấp LLM (anthropic.json, openai.json)
│   │   ├── setup_wizard.sh    # Trình hướng dẫn cài đặt khi đăng nhập lần đầu
│   │   └── update-motd.d/     # Banner hiển thị khi SSH
│   └── var/lib/cloud/scripts/per-instance/
│       └── 001_onboot         # Script cloud-init chạy lần đầu khởi động (dùng cho Packer)
└── scripts/
    └── openclaw.sh            # Script cài đặt chính cho Packer (Node.js, Caddy, OpenClaw, helper scripts)
```

## Cài đặt nhanh (install.sh)

Trên bất kỳ Ubuntu 24.04 VM nào, chạy:

```bash
curl -fsSL https://<host>/install.sh | bash
```

Hoặc qua cloud-init (`cloud.cfg` hoặc user-data):

```yaml
runcmd:
  - bash -c 'while pgrep -x apt > /dev/null; do sleep 5; done'
  - bash -c 'curl -fsSL https://<host>/install.sh | bash > /var/log/openclaw-install.log 2>&1'
```

Sau khi cài xong, SSH vào server → setup wizard sẽ tự động chạy để cấu hình AI provider.

## Lệnh build Packer (tạo DigitalOcean snapshot)

Yêu cầu biến môi trường `DIGITALOCEAN_API_TOKEN` và Packer >= 1.7.0.

```bash
# Từ thư mục cha (droplet-1-clicks/)
make build-clawdbot-24-04
make validate-clawdbot-24-04

# Lệnh Packer trực tiếp
packer build clawdbot-24-04/template.json
PACKER_LOG=1 packer build clawdbot-24-04/template.json   # bật log debug
packer build -on-error=ask clawdbot-24-04/template.json   # hỏi khi gặp lỗi
```

## Cấu hình quan trọng

- **template.json** — Template Packer: phiên bản image (`v2026.2.3`), kích thước instance (`s-1vcpu-2gb`), region (`nyc3`), các bước provisioning
- **install.sh** — Script cài đặt all-in-one: gộp mọi thứ (apt, firewall, Node.js, Caddy, clone/build, config, helper scripts, token, MOTD, wizard)
- **files/etc/config/*.json** — Cấu hình nhà cung cấp LLM (Anthropic, OpenAI) với thiết lập model, sandbox và xác thực gateway
- **scripts/openclaw.sh** — Script cài đặt cho Packer: tường lửa, Node.js, Caddy, clone/build OpenClaw, helper scripts, Homebrew + wacli

## Quy ước

- Phiên bản ứng dụng được theo dõi trong `template.json` tại trường `application_version`
- Ứng dụng OpenClaw được clone từ `github.com/openclaw/openclaw` và build bằng `pnpm install --frozen-lockfile && pnpm build`
- Gateway chạy trên port 18789 phía sau Caddy reverse proxy
- File cấu hình sử dụng cú pháp `${ENV_VAR}` để thay thế giá trị lúc runtime
- Các helper scripts được tạo trong `/opt/` trên droplet đã triển khai
- User hệ thống `openclaw` sở hữu ứng dụng với quyền hạn chế (0700 cho thư mục cấu hình)

## Scripts quản lý (trên Droplet đã triển khai)

- `/opt/restart-openclaw.sh` — Khởi động lại dịch vụ
- `/opt/status-openclaw.sh` — Xem trạng thái và gateway token
- `/opt/update-openclaw.sh` — Cập nhật lên phiên bản mới nhất
- `/opt/openclaw-cli.sh` — Chạy lệnh CLI
- `/opt/openclaw-tui.sh` — Giao diện Terminal UI
- `/opt/setup-openclaw-domain.sh` — Cấu hình tên miền riêng với HTTPS

## Lưu ý quan trọng

- Không bao giờ commit API key hoặc token thật; chỉ sử dụng giá trị placeholder
- Gateway token được tự động tạo (64 ký tự hex) khi khởi động lần đầu qua `001_onboot`
- Caddy tự động xử lý TLS thông qua Let's Encrypt khi cấu hình tên miền
- Trình hướng dẫn cài đặt (`setup_wizard.sh`) chạy khi SSH lần đầu và cấu hình nhà cung cấp AI
