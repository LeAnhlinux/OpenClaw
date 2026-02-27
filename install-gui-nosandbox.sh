#!/bin/bash
set -euo pipefail

# =============================================================================
# OpenClaw — Unified Install Script
# =============================================================================
# Set 2 bien ben duoi de chon mode cai dat:
#
#   ENABLE_SANDBOX : true = cai Docker + build sandbox image
#                    false = khong cai Docker, khong sandbox
#
#   ENABLE_GUI     : true = Management Panel (web admin vinh vien)
#                    false = chi CLI (setup wizard qua SSH)
#
# Vi du:
#   SANDBOX=true  GUI=false  → Giong install.sh (Packer/DigitalOcean)
#   SANDBOX=false GUI=true   → Giong install-dev.sh (dev, no Docker)
#   SANDBOX=true  GUI=true   → Giong install-gui.sh (full features)
#   SANDBOX=false GUI=true   → Giong install-gui-nosandbox.sh
# =============================================================================

ENABLE_SANDBOX=false    # true | false
ENABLE_GUI=true         # true | false

# --- App config ---
APP_VERSION="Latest"
REPO_URL="https://github.com/openclaw/openclaw.git"
REPO_DIR="/opt/openclaw"
LOG_FILE="/var/log/openclaw-install.log"

# --- GUI config (chi dung khi ENABLE_GUI=true) ---
PANEL_PORT=9999
PANEL_DIR="/opt/openclaw-panel"
PANEL_REPO="https://raw.githubusercontent.com/LeAnhlinux/OpenClaw/main/setup-ui/panel.js"

# --- Logging helper ---
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"; }

MODE_DESC="CLI-only"
if [ "$ENABLE_GUI" = "true" ] && [ "$ENABLE_SANDBOX" = "true" ]; then
    MODE_DESC="GUI + Sandbox"
elif [ "$ENABLE_GUI" = "true" ]; then
    MODE_DESC="GUI (no sandbox)"
elif [ "$ENABLE_SANDBOX" = "true" ]; then
    MODE_DESC="CLI + Sandbox"
fi
log "=== Bat dau cai dat OpenClaw ${APP_VERSION} (${MODE_DESC}) ==="

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

PACKAGES="procps file apt-transport-https ca-certificates curl software-properties-common git build-essential libsystemd-dev jq unzip gnupg ufw"
if [ "$ENABLE_SANDBOX" = "true" ]; then
    PACKAGES="$PACKAGES docker.io"
fi
if [ "$ENABLE_GUI" = "true" ]; then
    PACKAGES="$PACKAGES dnsutils"
fi
apt-get -qqy -o Dpkg::Options::='--force-confdef' -o Dpkg::Options::='--force-confold' install $PACKAGES
apt-get -qqy clean

# =============================================================================
# 3. Cau hinh tuong lua (UFW)
# =============================================================================
log "Cau hinh tuong lua..."
ufw allow 80
ufw allow 443
if [ "$ENABLE_GUI" = "true" ]; then
    ufw allow ${PANEL_PORT}/tcp comment 'OpenClaw Panel HTTP'
fi
ufw allow ssh/tcp
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
# 4b. Browser se duoc cai qua Management Panel (Chrome hoac CamoFox)
# =============================================================================
log "Browser se duoc cai sau qua Management Panel..."

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
if [ "$ENABLE_SANDBOX" = "true" ]; then
    usermod -aG docker openclaw || true
fi

# GUI can sudo de Panel restart services, update, v.v.
if [ "$ENABLE_GUI" = "true" ]; then
    echo 'openclaw ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/openclaw
    chmod 440 /etc/sudoers.d/openclaw
fi

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
    git checkout "$APP_VERSION" || { log "ERROR: Failed to checkout $APP_VERSION"; exit 1; }
fi
chown -R openclaw:openclaw "$REPO_DIR"
# Fix git safe.directory — repo owned by openclaw but panel runs as root
# Use --system to avoid $HOME not set error during cloud-init
git config --system --add safe.directory "$REPO_DIR"

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

# Cau hinh kenh nhan tin (uncomment va dien token)
# TELEGRAM_BOT_TOKEN=your_bot_token_here
# DISCORD_BOT_TOKEN=your_bot_token_here
# SLACK_BOT_TOKEN=your_bot_token_here
# SLACK_APP_TOKEN=your_app_token_here
# ZALO_BOT_TOKEN=your_bot_token_here
EOF

# =============================================================================
# 9. Tao systemd service (OpenClaw Gateway)
# =============================================================================
log "Tao systemd service..."
if [ "$ENABLE_SANDBOX" = "true" ]; then
    SVC_DESC="Openclaw Gateway Service"
    SVC_AFTER="After=network-online.target docker.service"
    SVC_REQUIRES="Requires=docker.service"
else
    SVC_DESC="Openclaw Gateway Service (no sandbox)"
    SVC_AFTER="After=network-online.target"
    SVC_REQUIRES=""
fi

cat > /etc/systemd/system/openclaw.service << SVCEOF
[Unit]
Description=${SVC_DESC}
${SVC_AFTER}
Wants=network-online.target
${SVC_REQUIRES}

[Service]
Type=simple
User=openclaw
Group=openclaw
WorkingDirectory=/opt/openclaw
EnvironmentFile=/opt/openclaw.env
Environment="HOME=/home/openclaw"
Environment="NODE_ENV=production"
Environment="NODE_OPTIONS=--dns-result-order=ipv4first --no-network-family-autoselection"
Environment="PATH=/home/openclaw/.npm/bin:/home/openclaw/homebrew/bin:/usr/local/bin:/usr/bin:/bin:"

ExecStart=/usr/bin/node /opt/openclaw/dist/index.js gateway --port \${OPENCLAW_GATEWAY_PORT} --allow-unconfigured

Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
SVCEOF

# =============================================================================
# 10. Tao helper scripts (download tu GitHub — single source of truth)
# =============================================================================
log "Tai helper scripts tu GitHub..."
HELPERS_BASE="https://raw.githubusercontent.com/LeAnhlinux/OpenClaw/main/scripts/helpers"
for script in restart-openclaw.sh status-openclaw.sh update-openclaw.sh openclaw-cli.sh openclaw-tui.sh setup-openclaw-domain.sh; do
    log "  Downloading $script..."
    curl -fsSL --max-time 10 "${HELPERS_BASE}/${script}" -o "/opt/${script}" || log "WARN: Failed to download $script"
    chmod +x "/opt/${script}"
done

# =============================================================================
# 11. Ghi config JSON
# =============================================================================
log "Ghi config JSON..."
mkdir -p /etc/config

# --- Helper: tao config JSON cho 1 provider ---
write_provider_config() {
    local file="$1" model="$2"
    if [ "$ENABLE_SANDBOX" = "true" ]; then
        SANDBOX_BLOCK=',
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
      }'
    else
        SANDBOX_BLOCK=""
    fi
    cat > "$file" << JSONEOF
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "${model}"
      },
      "maxConcurrent": 4,
      "subagents": {
        "maxConcurrent": 8
      }${SANDBOX_BLOCK}
    }
  },
  "gateway": {
    "mode": "local",
    "bind": "loopback",
    "auth": {
      "token": "\${OPENCLAW_GATEWAY_TOKEN}"
    },
    "trustedProxies": ["127.0.0.1", "::1"]
  }
}
JSONEOF
}

write_provider_config "/etc/config/anthropic.json" "anthropic/claude-opus-4-5"
write_provider_config "/etc/config/openai.json" "openai/gpt-5.2"
# GUI variants luon co gemini; CLI-only (install.sh goc) khong co
if [ "$ENABLE_GUI" = "true" ]; then
    write_provider_config "/etc/config/gemini.json" "google/gemini-2.5-pro"
fi

# =============================================================================
# 12. Ghi MOTD banner
# =============================================================================
log "Tao MOTD banner..."
mkdir -p /etc/update-motd.d

if [ "$ENABLE_GUI" = "true" ]; then
# --- MOTD: GUI mode (dynamic, check setup status) ---
cat > /etc/update-motd.d/99-one-click << 'MOTDEOF'
#!/bin/sh

myip=$(hostname -I | awk '{print$1}')
gateway_token=$(grep "^OPENCLAW_GATEWAY_TOKEN=" /opt/openclaw.env 2>/dev/null | cut -d'=' -f2)

cat <<EOF
********************************************************************************

Chao mung den OpenClaw - Tro ly AI ca nhan cua ban

Management Panel: http://$myip:9999

Dashboard & Gateway:
  Dashboard URL: https://$myip?token=$gateway_token
  Gateway Token: $gateway_token

Cau hinh:
  File moi truong: /opt/openclaw.env
  File cau hinh:   /home/openclaw/.openclaw/openclaw.json

Lenh quan ly:
  - /opt/restart-openclaw.sh   (khoi dong lai + kiem tra)
  - /opt/status-openclaw.sh    (xem trang thai + token)
  - /opt/update-openclaw.sh    (cap nhat phien ban moi)
  - /opt/openclaw-cli.sh       (chay lenh CLI)
  - /opt/openclaw-tui.sh       (giao dien Terminal UI)

Bat HTTPS (TLS):
  sudo /opt/setup-openclaw-domain.sh

Tai lieu: https://docs.clawd.bot/
GitHub:  https://github.com/openclaw/openclaw

********************************************************************************
De xoa thong bao nay: rm -rf $(readlink -f ${0})
EOF
MOTDEOF

else
# --- MOTD: CLI mode (static, no setup UI) ---
cat > /etc/update-motd.d/99-one-click << 'MOTDEOF'
#!/bin/sh

myip=$(hostname -I | awk '{print$1}')
gateway_token=$(grep "^OPENCLAW_GATEWAY_TOKEN=" /opt/openclaw.env 2>/dev/null | cut -d'=' -f2)

cat <<EOF
********************************************************************************

Chao mung den OpenClaw - Tro ly AI ca nhan cua ban

OpenClaw la tro ly AI tu host, tra loi ban tren cac kenh ban dang dung
(Telegram, Slack, Discord, Zalo va nhieu hon nua).

Truy cap Dashboard & Gateway:
  Dashboard URL: https://$myip?token=$gateway_token
  Gateway Token: $gateway_token

Cau hinh:
  File moi truong: /opt/openclaw.env
  File cau hinh:   /home/openclaw/.openclaw/openclaw.json

Lenh quan ly:
  Khoi dong lai:   systemctl restart openclaw
  Xem trang thai:  systemctl status openclaw
  Xem log:         journalctl -u openclaw -f

  Hoac su dung helper scripts:
  - /opt/restart-openclaw.sh   (khoi dong lai + kiem tra)
  - /opt/status-openclaw.sh    (xem trang thai + token)
  - /opt/update-openclaw.sh    (cap nhat phien ban moi)
  - /opt/openclaw-cli.sh       (chay lenh CLI)
  - /opt/openclaw-tui.sh       (giao dien Terminal UI)

Bat HTTPS (TLS):
  Tro ten mien ve server nay, sau do chay:
  sudo /opt/setup-openclaw-domain.sh

Cau hinh kenh nhan tin:
  1. Sua /opt/openclaw.env voi token kenh cua ban
  2. Hoac dung CLI: /opt/openclaw-cli.sh channels add
  3. Khoi dong lai: systemctl restart openclaw

Tai lieu: https://docs.clawd.bot/
GitHub:  https://github.com/openclaw/openclaw

Mo Terminal UI:
  $ /opt/openclaw-tui.sh

********************************************************************************
De xoa thong bao nay: rm -rf $(readlink -f ${0})
EOF
MOTDEOF
fi

chmod +x /etc/update-motd.d/99-one-click

# =============================================================================
# 13. Ghi setup_wizard.sh (backup cho SSH)
# =============================================================================
log "Tao setup wizard (backup)..."

if [ "$ENABLE_GUI" = "true" ]; then
# --- GUI: setup wizard ngan gon (uu tien Web UI) ---
cat > /etc/setup_wizard.sh << 'WIZARDEOF'
#!/bin/bash

# OpenClaw - Script cau hinh AI Provider (backup)
# Uu tien su dung Web UI: http://<IP>:9999

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

model_access_key=""
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
    echo "OpenClaw da khoi dong lai thanh cong!"
else
    echo "Dich vu co the can kiem tra. Xem: systemctl status openclaw"
fi

echo "Cai dat OpenClaw hoan tat!"
WIZARDEOF

else
# --- CLI: setup wizard day du (co pairing flow) ---
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

model_access_key=""
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
    echo "OpenClaw da khoi dong lai thanh cong!"
else
    echo "Dich vu co the can kiem tra. Xem: systemctl status openclaw"
fi

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
fi

chmod +x /etc/setup_wizard.sh

# =============================================================================
# 14. Caddy default config
# =============================================================================
log "Cau hinh Caddy mac dinh..."
DROPLET_IP=$(hostname -I | awk '{print $1}')

if [ "$ENABLE_GUI" = "true" ]; then
# GUI: Caddy don gian (Panel se cau hinh chi tiet sau)
cat > /etc/caddy/Caddyfile << CADDYEOF
${DROPLET_IP} {
    tls internal
    reverse_proxy localhost:18789
}
CADDYEOF
else
# CLI: Caddy voi Let's Encrypt
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
fi

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

# Tao /usr/local/bin/openclaw wrapper (GUI variants + no-sandbox)
if [ "$ENABLE_GUI" = "true" ] || [ "$ENABLE_SANDBOX" = "false" ]; then
    log "Tao /usr/local/bin/openclaw..."
    cat > /usr/local/bin/openclaw << 'BINEOF'
#!/bin/bash
su - openclaw -c "cd /opt/openclaw && node dist/index.js $*"
BINEOF
    chmod +x /usr/local/bin/openclaw
fi

# Build sandbox image (chi khi ENABLE_SANDBOX=true)
if [ "$ENABLE_SANDBOX" = "true" ]; then
    log "Build sandbox image..."
    cd /opt/openclaw
    bash scripts/sandbox-setup.sh || log "Canh bao: Sandbox image build that bai, se duoc build khi su dung lan dau"
fi

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
# 18. Management Panel (chi khi ENABLE_GUI=true)
# =============================================================================
if [ "$ENABLE_GUI" = "true" ]; then
    log "Cai dat Management Panel..."
    mkdir -p ${PANEL_DIR}
    curl -fsSL "${PANEL_REPO}" -o ${PANEL_DIR}/panel.js || {
        log "Canh bao: Khong tai duoc Management Panel."
    }
    if [ -f "${PANEL_DIR}/panel.js" ] && [ -s "${PANEL_DIR}/panel.js" ]; then
        chmod 644 ${PANEL_DIR}/panel.js
        log "Management Panel: ${PANEL_DIR}/panel.js OK ($(wc -l < ${PANEL_DIR}/panel.js) dong)"
    else
        log "LOI: panel.js khong ton tai hoac rong! Panel se khong hoat dong."
        log "Thu tai lai: curl -fsSL ${PANEL_REPO} -o ${PANEL_DIR}/panel.js"
    fi

    cat > /etc/systemd/system/openclaw-panel.service << PANELEOF
[Unit]
Description=OpenClaw Management Panel (web admin)
After=network-online.target openclaw.service
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=${PANEL_DIR}
ExecStart=/usr/bin/node ${PANEL_DIR}/panel.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
PANELEOF

else
    # CLI-only: them setup wizard vao .bashrc root (chay khi SSH lan dau)
    log "Cau hinh setup wizard cho SSH lan dau..."
    cat >> /root/.bashrc << 'BASHEOF'
# Chay setup wizard OpenClaw khi SSH lan dau
if [ -f /etc/setup_wizard.sh ]; then
    chmod +x /etc/setup_wizard.sh
    /etc/setup_wizard.sh
fi
BASHEOF
fi

# =============================================================================
# 19. Kich hoat va khoi dong dich vu
# =============================================================================
log "Kich hoat va khoi dong dich vu..."
systemctl daemon-reload
systemctl enable openclaw
systemctl enable caddy
systemctl restart openclaw
systemctl restart caddy

if [ "$ENABLE_GUI" = "true" ]; then
    systemctl enable openclaw-panel
    systemctl start openclaw-panel
    log "Management Panel dang chay tai http://$(hostname -I | awk '{print $1}'):${PANEL_PORT}"
fi

# =============================================================================
# 20. Don dep
# =============================================================================
log "Don dep..."
apt-get -qqy autoremove
apt-get -qqy autoclean

# =============================================================================
# Hoan tat
# =============================================================================
if [ "$ENABLE_GUI" = "true" ]; then
    PANEL_URL="http://$(hostname -I | awk '{print $1}'):${PANEL_PORT}"
    log "=== Cai dat OpenClaw ${APP_VERSION} hoan tat! ==="
    log "Gateway token: ${NEW_GATEWAY_TOKEN}"
    log ""
    log "=========================================="
    log "  Management Panel:"
    log "  ${PANEL_URL}"
    log "  (Dang nhap bang tai khoan root)"
    log "=========================================="
    log ""
    log "Backup: SSH vao server va chay: sudo /etc/setup_wizard.sh"
else
    log "=== Cai dat OpenClaw ${APP_VERSION} hoan tat! ==="
    log "Gateway token: ${NEW_GATEWAY_TOKEN}"
    log ""
    log "SSH vao server de chay setup wizard, hoac:"
    log "  1. Sua /opt/openclaw.env voi API key"
    log "  2. systemctl restart openclaw"
fi
