#!/bin/bash
set -euo pipefail

# =============================================================================
# OpenClaw - Script cai dat all-in-one
# Chay qua cloud-init hoac thu cong: curl -fsSL <url>/install.sh | bash
# =============================================================================

APP_VERSION="v2026.2.3"
REPO_URL="https://github.com/openclaw/openclaw.git"
REPO_DIR="/opt/openclaw"
LOG_FILE="/var/log/openclaw-install.log"

# --- Logging helper ---
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"; }

log "=== Bat dau cai dat OpenClaw ${APP_VERSION} ==="

# =============================================================================
# 1. Doi apt lock
# =============================================================================
log "Doi apt lock..."
while fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; do
    log "apt dang chay. Doi 5 giay..."
    sleep 5
done
while pgrep -x apt >/dev/null 2>&1; do
    log "apt process dang chay. Doi 5 giay..."
    sleep 5
done

# =============================================================================
# 2. Cap nhat he thong va cai dat packages
# =============================================================================
log "Cap nhat he thong va cai dat packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get -qqy update
apt-get -qqy -o Dpkg::Options::='--force-confdef' -o Dpkg::Options::='--force-confold' full-upgrade
apt-get -qqy -o Dpkg::Options::='--force-confdef' -o Dpkg::Options::='--force-confold' install \
    procps file apt-transport-https ca-certificates curl software-properties-common \
    git build-essential libsystemd-dev jq unzip docker.io gnupg fail2ban ufw
apt-get -qqy clean

# =============================================================================
# 3. Cau hinh tuong lua (UFW)
# =============================================================================
log "Cau hinh tuong lua..."
ufw allow 80
ufw allow 443
ufw limit ssh/tcp
ufw --force enable

# =============================================================================
# 4. Cai dat Node.js 22 + pnpm
# =============================================================================
log "Cai dat Node.js 22..."
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

log "Kich hoat corepack va pnpm..."
corepack enable
corepack prepare pnpm@latest --activate

# =============================================================================
# 4b. Cai dat Google Chrome (cho browser tool)
# =============================================================================
log "Cai dat Google Chrome..."
curl -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o /tmp/google-chrome.deb
apt-get install -y /tmp/google-chrome.deb || apt-get install -fy
rm -f /tmp/google-chrome.deb

# =============================================================================
# 5. Cai dat Caddy (reverse proxy voi TLS tu dong)
# =============================================================================
log "Cai dat Caddy..."
curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/gpg.key" | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main" > /etc/apt/sources.list.d/caddy-stable.list
apt-get update -y
apt-get install -y caddy
mkdir -p /var/log/caddy
chown -R caddy:caddy /var/log/caddy
touch /var/log/caddy/access.json
chown caddy:caddy /var/log/caddy/access.json

# =============================================================================
# 6. Tao user openclaw va thu muc
# =============================================================================
log "Tao user openclaw..."
useradd -m -s /bin/bash openclaw || true
usermod -aG docker openclaw || true

mkdir -p /home/openclaw/.openclaw
mkdir -p /home/openclaw/clawd
chown -R openclaw:openclaw /home/openclaw/.openclaw
chmod 0700 /home/openclaw/.openclaw
chown -R openclaw:openclaw /home/openclaw/clawd

# =============================================================================
# 7. Clone repo va checkout version
# =============================================================================
log "Clone OpenClaw repo (${APP_VERSION})..."
cd /opt && git clone "$REPO_URL" "$REPO_DIR"
cd "$REPO_DIR"
git fetch --tags
if [ "$APP_VERSION" != "Latest" ]; then
    git checkout "$APP_VERSION"
fi
chown -R openclaw:openclaw "$REPO_DIR"

# =============================================================================
# 8. Tao file /opt/openclaw.env
# =============================================================================
log "Tao file cau hinh moi truong..."
cat > /opt/openclaw.env << EOF
# Cau hinh moi truong OpenClaw
#
# Sau khi thay doi file nay, khoi dong lai OpenClaw:
#   systemctl restart openclaw

# Phien ban OpenClaw da cai
OPENCLAW_VERSION=${APP_VERSION}

# Cau hinh Gateway
OPENCLAW_GATEWAY_PORT=18789
OPENCLAW_GATEWAY_BIND=lan

# Gateway token se duoc tu dong tao ben duoi
OPENCLAW_GATEWAY_TOKEN=PLACEHOLDER_WILL_BE_REPLACED

# Cau hinh Model
# Chay script cau hinh tuong tac de chon provider:
#   sudo /etc/setup_wizard.sh
#
# Hoac uncomment va dien API key:
# ANTHROPIC_API_KEY=your_api_key_here
# OPENAI_API_KEY=your_api_key_here

# Cau hinh kenh nhan tin (uncomment va dien token)
# TELEGRAM_BOT_TOKEN=your_bot_token_here
# DISCORD_BOT_TOKEN=your_bot_token_here
# SLACK_BOT_TOKEN=your_bot_token_here
# SLACK_APP_TOKEN=your_app_token_here
EOF

# =============================================================================
# 9. Tao systemd service
# =============================================================================
log "Tao systemd service..."
cat > /etc/systemd/system/openclaw.service << 'EOF'
[Unit]
Description=Openclaw Gateway Service
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
Type=simple
User=openclaw
Group=openclaw
WorkingDirectory=/opt/openclaw
EnvironmentFile=/opt/openclaw.env
Environment="HOME=/home/openclaw"
Environment="NODE_ENV=production"
Environment="PATH=/home/openclaw/.npm/bin:/home/openclaw/homebrew/bin:/usr/local/bin:/usr/bin:/bin:"

ExecStart=/usr/bin/node /opt/openclaw/dist/index.js gateway --port ${OPENCLAW_GATEWAY_PORT} --allow-unconfigured

Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

# =============================================================================
# 10. Tao helper scripts
# =============================================================================
log "Tao helper scripts..."

# --- restart-openclaw.sh ---
cat > /opt/restart-openclaw.sh << 'SCRIPT'
#!/bin/bash
echo "Dang khoi dong lai OpenClaw Gateway..."
systemctl restart openclaw
sleep 2
if systemctl is-active --quiet openclaw; then
    echo "✅ OpenClaw da khoi dong lai thanh cong!"
    echo "Gateway dang chay tren port 18789"
    echo "Xem log: journalctl -u openclaw -f"
else
    echo "❌ Loi: Khong the khoi dong lai OpenClaw"
    echo "Kiem tra log: journalctl -u openclaw -xe"
    exit 1
fi
SCRIPT

# --- status-openclaw.sh ---
cat > /opt/status-openclaw.sh << 'SCRIPT'
#!/bin/bash
echo "=== Trang thai OpenClaw Gateway ==="
systemctl status openclaw --no-pager
echo ""
echo "=== Gateway Token ==="
if [ -f "/opt/openclaw.env" ]; then
    grep "^OPENCLAW_GATEWAY_TOKEN=" /opt/openclaw.env | cut -d'=' -f2
else
    echo "Token chua duoc tao."
fi
echo ""
echo "=== Gateway URL ==="
myip=$(hostname -I | awk '{print$1}')
echo "http://$myip:18789"
SCRIPT

# --- update-openclaw.sh ---
cat > /opt/update-openclaw.sh << 'SCRIPT'
#!/bin/bash
APP_VERSION="Latest"
if [ -f "/opt/openclaw.env" ]; then
    APP_VERSION_VALUE=$(grep -E '^OPENCLAW_VERSION=' /opt/openclaw.env | tail -n 1 | cut -d'=' -f2-)
    if [ -n "$APP_VERSION_VALUE" ]; then
        APP_VERSION="$APP_VERSION_VALUE"
    fi
fi

echo "Dang cap nhat OpenClaw (phien ban muc tieu: ${APP_VERSION})..."

if [ ! -d "/opt/openclaw" ]; then
    echo "Loi: Khong tim thay thu muc /opt/openclaw"
    exit 1
fi

echo "Dung dich vu OpenClaw..."
systemctl stop openclaw

cd /opt/openclaw
git stash

echo "Tai cap nhat tu GitHub..."
git fetch --tags --all

if [ "$APP_VERSION" = "Latest" ]; then
    TARGET_REF="main"
    echo "Checkout nhanh ${TARGET_REF}..."
    git checkout "${TARGET_REF}"
    echo "Pull code moi nhat tu ${TARGET_REF}..."
    git pull origin "${TARGET_REF}"
else
    TARGET_REF="$APP_VERSION"
    echo "Checkout release ${TARGET_REF}..."
    git checkout "${TARGET_REF}"
    git reset --hard "${TARGET_REF}"
fi

if [ $? -eq 0 ]; then
    echo "Code da cap nhat. Dang build lai..."
    su - openclaw -c "cd /opt/openclaw && pnpm install --frozen-lockfile"
    su - openclaw -c "cd /opt/openclaw && pnpm build"
    su - openclaw -c "cd /opt/openclaw && pnpm ui:install"
    su - openclaw -c "cd /opt/openclaw && pnpm ui:build"

    if [ $? -eq 0 ]; then
        echo "Khoi dong lai OpenClaw..."
        systemctl start openclaw
        if [ $? -eq 0 ]; then
            echo "✅ OpenClaw da cap nhat va khoi dong lai thanh cong!"
        else
            echo "❌ Loi: Khong the khoi dong lai OpenClaw"
            exit 1
        fi
    else
        echo "❌ Loi: Build that bai"
        exit 1
    fi
else
    echo "ℹ️  Khong co ban cap nhat hoac cap nhat that bai."
fi

echo "Qua trinh cap nhat hoan tat."
SCRIPT

# --- openclaw-cli.sh ---
cat > /opt/openclaw-cli.sh << 'SCRIPT'
#!/bin/bash
# Helper script chay lenh CLI OpenClaw
su - openclaw -c "cd /opt/openclaw && node dist/index.js $*"
SCRIPT

# --- openclaw-tui.sh ---
cat > /opt/openclaw-tui.sh << 'SCRIPT'
#!/bin/bash
gateway_token=$(grep "^OPENCLAW_GATEWAY_TOKEN=" /opt/openclaw.env 2>/dev/null | cut -d'=' -f2)
/opt/openclaw-cli.sh tui --token=${gateway_token}
SCRIPT

# --- setup-openclaw-domain.sh ---
cat > /opt/setup-openclaw-domain.sh << 'SCRIPT'
#!/bin/bash
set -euo pipefail

PORT=18789
BIND_IP=127.0.0.1

read -rp "Nhap ten mien da tro ve server nay (vd: bot.example.com): " DOMAIN
if [ -z "${DOMAIN}" ]; then
    echo "Ten mien khong duoc de trong."
    exit 1
fi

read -rp "Nhap email cho thong bao Let's Encrypt (tuy chon): " EMAIL

if grep -q '^OPENCLAW_GATEWAY_BIND=' /opt/openclaw.env; then
    sed -i "s/^OPENCLAW_GATEWAY_BIND=.*/OPENCLAW_GATEWAY_BIND=${BIND_IP}/" /opt/openclaw.env
else
    echo "OPENCLAW_GATEWAY_BIND=${BIND_IP}" >> /opt/openclaw.env
fi

{
    cat > /etc/caddy/Caddyfile << CADDYEOC
${DOMAIN} {
    tls {
        issuer acme {
            dir https://acme-v02.api.letsencrypt.org/directory
            profile shortlived
        }
    }
    reverse_proxy ${BIND_IP}:${PORT}
}
CADDYEOC
    if [ -n "$EMAIL" ]; then
        sed -i "1iemail ${EMAIL}" /etc/caddy/Caddyfile
    fi
}

systemctl enable caddy
systemctl restart caddy
systemctl restart openclaw

echo "Caddy dang proxy https://${DOMAIN} den ${BIND_IP}:${PORT}."
echo "Gateway bind da dat la ${BIND_IP}. Ban co the chinh /opt/openclaw.env va chay lai script nay."
SCRIPT

# Dat quyen thuc thi cho tat ca helper scripts
chmod +x /opt/restart-openclaw.sh
chmod +x /opt/status-openclaw.sh
chmod +x /opt/update-openclaw.sh
chmod +x /opt/openclaw-cli.sh
chmod +x /opt/openclaw-tui.sh
chmod +x /opt/setup-openclaw-domain.sh

# =============================================================================
# 11. Ghi config JSON (Anthropic, OpenAI)
# =============================================================================
log "Ghi config JSON..."
mkdir -p /etc/config

# --- anthropic.json ---
cat > /etc/config/anthropic.json << 'EOF'
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-opus-4-5"
      },
      "maxConcurrent": 4,
      "subagents": {
        "maxConcurrent": 8
      },
      "sandbox": {
        "workspaceAccess": "rw",
        "mode": "all",
        "docker": {
          "network": "bridge",
          "binds": [
            "/home/openclaw/homebrew:/home/openclaw/homebrew:ro",
            "/opt/openclaw:/opt/openclaw:ro"
          ]
        }
      }
    }
  },
  "gateway": {
    "mode": "local",
    "bind": "loopback",
    "auth": {
      "token": "${OPENCLAW_GATEWAY_TOKEN}"
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
EOF

# --- openai.json ---
cat > /etc/config/openai.json << 'EOF'
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "openai/gpt-5.2"
      },
      "maxConcurrent": 4,
      "subagents": {
        "maxConcurrent": 8
      },
      "sandbox": {
        "workspaceAccess": "rw",
        "mode": "all",
        "docker": {
          "network": "bridge",
          "binds": [
            "/home/openclaw/homebrew:/home/openclaw/homebrew:ro",
            "/opt/openclaw:/opt/openclaw:ro"
          ]
        }
      }
    }
  },
  "gateway": {
    "mode": "local",
    "bind": "loopback",
    "auth": {
      "token": "${OPENCLAW_GATEWAY_TOKEN}"
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
EOF

# =============================================================================
# 12. Ghi MOTD banner (tieng Viet)
# =============================================================================
log "Tao MOTD banner..."
mkdir -p /etc/update-motd.d

cat > /etc/update-motd.d/99-one-click << 'MOTDEOF'
#!/bin/sh

myip=$(hostname -I | awk '{print$1}')
gateway_token=$(grep "^OPENCLAW_GATEWAY_TOKEN=" /opt/openclaw.env 2>/dev/null | cut -d'=' -f2)

cat <<EOF
********************************************************************************

Chao mung den OpenClaw - Tro ly AI ca nhan cua ban

OpenClaw la tro ly AI tu host, tra loi ban tren cac kenh ban dang dung
(WhatsApp, Telegram, Slack, Discord, va nhieu hon nua).

🌐 Truy cap Dashboard & Gateway:
  Dashboard URL: https://$myip?token=$gateway_token
  Gateway Token: $gateway_token

📝 Cau hinh:
  File moi truong: /opt/openclaw.env
  File cau hinh:   /home/openclaw/.openclaw/openclaw.json

🔧 Lenh quan ly:
  Khoi dong lai:   systemctl restart openclaw
  Xem trang thai:  systemctl status openclaw
  Xem log:         journalctl -u openclaw -f

  Hoac su dung helper scripts:
  - /opt/restart-openclaw.sh   (khoi dong lai + kiem tra)
  - /opt/status-openclaw.sh    (xem trang thai + token)
  - /opt/update-openclaw.sh    (cap nhat phien ban moi)
  - /opt/openclaw-cli.sh       (chay lenh CLI)
  - /opt/openclaw-tui.sh       (giao dien Terminal UI)

🔒 Bat HTTPS (TLS):
  Tro ten mien ve server nay, sau do chay:
  sudo /opt/setup-openclaw-domain.sh

📱 Cau hinh kenh nhan tin:
  1. Sua /opt/openclaw.env voi token kenh cua ban
  2. Hoac dung CLI: /opt/openclaw-cli.sh channels add
  3. Khoi dong lai: systemctl restart openclaw

📚 Tai lieu: https://docs.clawd.bot/
🔗 GitHub:  https://github.com/openclaw/openclaw

🔧 Mo Terminal UI:
  $ /opt/openclaw-tui.sh

********************************************************************************
De xoa thong bao nay: rm -rf $(readlink -f ${0})
EOF
MOTDEOF

chmod +x /etc/update-motd.d/99-one-click

# =============================================================================
# 13. Ghi setup_wizard.sh (bo GradientAI)
# =============================================================================
log "Tao setup wizard..."
cat > /etc/setup_wizard.sh << 'WIZARDEOF'
#!/bin/bash

# OpenClaw - Script cau hinh AI Provider
# Chay script nay de cau hinh OpenClaw voi API key cua ban

PS3="Chon nha cung cap (1-2): "
options=("OpenAI" "Anthropic")

selected_provider="n/a"
target_config="n/a"
echo "--- Chon nha cung cap AI ---"

select opt in "${options[@]}"
do
  case $opt in
    "OpenAI")
        selected_provider="OpenAI"
        target_config="/etc/config/openai.json"
        env_key_name="OPENAI_API_KEY"
        echo "Ban da chon OpenAI."
        break
        ;;
    "Anthropic")
        selected_provider="Anthropic"
        target_config="/etc/config/anthropic.json"
        env_key_name="ANTHROPIC_API_KEY"
        echo "Ban da chon Anthropic."
        break
        ;;
    *)
        echo "Lua chon khong hop le. Vui long thu lai."
        ;;
  esac
done

echo "${selected_provider} - Cau hinh"
echo "=============================="
echo ""

while [ -z "$model_access_key" ]
  do
    read -p "Nhap ${selected_provider} API key: " model_access_key
  done

mkdir -p /home/openclaw/.openclaw

cp ${target_config} /home/openclaw/.openclaw/openclaw.json
echo -e "\n${env_key_name}=${model_access_key}" >> /opt/openclaw.env

GATEWAY_TOKEN=$(grep "^OPENCLAW_GATEWAY_TOKEN=" /opt/openclaw.env 2>/dev/null | cut -d'=' -f2)

jq --arg key "${GATEWAY_TOKEN}" '.gateway.auth.token = $key' /home/openclaw/.openclaw/openclaw.json > /home/openclaw/.openclaw/openclaw.json.tmp
mv /home/openclaw/.openclaw/openclaw.json.tmp /home/openclaw/.openclaw/openclaw.json

chown openclaw:openclaw /home/openclaw/.openclaw/openclaw.json
chmod 0600 /home/openclaw/.openclaw/openclaw.json

echo ""
echo "${selected_provider} key da duoc cau hinh thanh cong."
echo "Dang khoi dong lai OpenClaw..."
systemctl restart openclaw

sleep 2

if systemctl is-active --quiet openclaw; then
    echo "✅ OpenClaw da khoi dong lai thanh cong!"
else
    echo "⚠️ Dich vu co the can kiem tra. Xem: systemctl status openclaw"
fi

printf "\nTu phien ban 1.26, OpenClaw yeu cau ghep noi thu cong de truy cap UI dashboard.\n"

while true; do
    read -p "Ban co muon chay ghep noi tu dong bay gio khong? (yes/no): " yn
    case "${yn,,}" in
        yes|y )
            echo "Dang tien hanh ghep noi tu dong..."
            break
            ;;
        no|n )
            echo "Cai dat OpenClaw hoan tat! Chuc ban su dung vui ve!"
            cp /etc/skel/.bashrc /root
            exit 0
            ;;
        * )
            echo "Khong hop le. Vui long nhap 'yes' hoac 'no'."
            ;;
    esac
done

DROPL_IP=$(hostname -I | awk '{print$1}')

printf "\nVui long mo dashboard UI tren trinh duyet de bat dau ghep noi.\nBan se thay loi ghep noi - dieu nay la binh thuong:\n\t> https://${DROPL_IP}?token=${GATEWAY_TOKEN}\n\n"

while true; do
    read -p "Nhap 'continue' khi ban thay loi ghep noi tren dashboard. (continue/exit): " yn
    case "${yn,,}" in
        continue|c )
            printf "\nDang tim yeu cau ghep noi..."
            break
            ;;
        exit|e )
            echo "Cai dat OpenClaw hoan tat! Chuc ban su dung vui ve!"
            exit 0
            ;;
        * )
            echo "Khong hop le. Vui long nhap 'continue' hoac 'exit'."
            ;;
    esac
done

OUTPUT=$(/opt/openclaw-cli.sh devices list --token=${GATEWAY_TOKEN} | sed -n '/Pending/,/Paired/p')
REQUEST_IDS=($(echo "$OUTPUT" | grep -oP '[a-f0-9]{8}-([a-f0-9]{4}-){3}[a-f0-9]{12}'))
COUNT=${#REQUEST_IDS[@]}

if [ "$COUNT" -eq 1 ]; then
    printf "Da tim thay yeu cau ghep noi!...\n"
    /opt/openclaw-cli.sh devices approve "${REQUEST_IDS[0]}" --token=${GATEWAY_TOKEN}
    printf "Yeu cau ghep noi da duoc chap nhan!\n\nCai dat hoan tat. Ban co the lam moi dashboard UI va bat dau su dung OpenClaw!\n"
    cp /etc/skel/.bashrc /root
    exit 0
elif [ "$COUNT" -eq 0 ]; then
    echo "Loi: Khong tim thay yeu cau nao. Vui long ghep noi thu cong." >&2
    exit 1
else
    echo "Loi: Tim thay nhieu yeu cau ($COUNT). Can xu ly thu cong." >&2
    printf "\nNhieu yeu cau cho nghia la co nguoi khac dang co ket noi den dashboard cua ban.\nScript khong the phan biet yeu cau cua ban voi nguoi khac."
    exit 1
fi

cp /etc/skel/.bashrc /root
WIZARDEOF

chmod +x /etc/setup_wizard.sh

# =============================================================================
# 14. Caddy default config
# =============================================================================
log "Cau hinh Caddy mac dinh..."
DROPLET_IP=$(hostname -I | awk '{print $1}')

cat > /etc/caddy/Caddyfile << CADDYEOF
${DROPLET_IP} {
    tls {
        issuer acme {
            dir https://acme-v02.api.letsencrypt.org/directory
            profile shortlived
        }
    }
    reverse_proxy localhost:18789
}
CADDYEOF

# Copy config mac dinh vao thu muc openclaw
cp /etc/config/anthropic.json /home/openclaw/.openclaw/openclaw.json
chmod 0600 /home/openclaw/.openclaw/openclaw.json
chown openclaw:openclaw /home/openclaw/.openclaw/openclaw.json

# =============================================================================
# 15. Build OpenClaw
# =============================================================================
log "Build OpenClaw (co the mat vai phut)..."
cd /opt/openclaw
su - openclaw -c "cd /opt/openclaw && pnpm install --frozen-lockfile"
su - openclaw -c "cd /opt/openclaw && pnpm build"
su - openclaw -c "cd /opt/openclaw && pnpm ui:install"
su - openclaw -c "cd /opt/openclaw && pnpm ui:build"

# Build sandbox image
log "Build sandbox image..."
cd /opt/openclaw
bash scripts/sandbox-setup.sh || log "Canh bao: Sandbox image build that bai, se duoc build khi su dung lan dau"

# =============================================================================
# 16. Cai dat Homebrew + wacli
# =============================================================================
log "Cai dat Homebrew va wacli..."
su - openclaw -c "mkdir -p ~/homebrew && curl -L https://github.com/Homebrew/brew/tarball/master | tar xz --strip 1 -C ~/homebrew"
su - openclaw -c "~/homebrew/bin/brew install steipete/tap/wacli"
su - openclaw -c "~/homebrew/bin/brew link wacli"

# Cau hinh npm prefix
mkdir -p /home/openclaw/.npm
chown -R openclaw:openclaw /home/openclaw/.npm
su - openclaw -c "npm config set prefix /home/openclaw/.npm"

# =============================================================================
# 17. Tao gateway token
# =============================================================================
log "Tao gateway token..."
NEW_GATEWAY_TOKEN=$(openssl rand -hex 32)
sed -i "s/OPENCLAW_GATEWAY_TOKEN=PLACEHOLDER_WILL_BE_REPLACED/OPENCLAW_GATEWAY_TOKEN=$NEW_GATEWAY_TOKEN/" /opt/openclaw.env

# Luu token ra file de truy cap de dang
echo "$NEW_GATEWAY_TOKEN" > /home/openclaw/.openclaw/gateway-token.txt
chown openclaw:openclaw /home/openclaw/.openclaw/gateway-token.txt
chmod 600 /home/openclaw/.openclaw/gateway-token.txt

# =============================================================================
# 18. Them setup wizard vao .bashrc root (chay khi SSH lan dau)
# =============================================================================
log "Cau hinh setup wizard cho SSH lan dau..."
cat >> /root/.bashrc << 'BASHEOF'
# Chay setup wizard OpenClaw khi SSH lan dau
if [ -f /etc/setup_wizard.sh ]; then
    chmod +x /etc/setup_wizard.sh
    /etc/setup_wizard.sh
fi
BASHEOF

# =============================================================================
# 19. Kich hoat va khoi dong dich vu
# =============================================================================
log "Kich hoat va khoi dong dich vu..."
systemctl enable fail2ban
systemctl restart fail2ban

systemctl daemon-reload
systemctl enable openclaw
systemctl enable caddy
systemctl restart openclaw
systemctl restart caddy

# =============================================================================
# 20. Don dep
# =============================================================================
log "Don dep..."
apt-get -qqy autoremove
apt-get -qqy autoclean

# =============================================================================
log "=== Cai dat OpenClaw ${APP_VERSION} hoan tat! ==="
log "Gateway token: ${NEW_GATEWAY_TOKEN}"
log "Dashboard: https://$(hostname -I | awk '{print $1}')?token=${NEW_GATEWAY_TOKEN}"
log "SSH vao server de chay setup wizard cau hinh AI provider."
