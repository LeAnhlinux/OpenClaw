#!/bin/bash
set -euo pipefail

# =============================================================================
# OpenClaw - Script cai dat local (no panel, no SSL, co sandbox)
# Dung cho may tinh ca nhan / local server
# Chay: sudo bash install-local.sh
# =============================================================================

APP_VERSION="Latest"
REPO_URL="https://github.com/openclaw/openclaw.git"
REPO_DIR="/opt/openclaw"
LOG_FILE="/var/log/openclaw-install.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"; }

if [ "$(id -u)" -ne 0 ]; then
    echo "Vui long chay voi quyen root: sudo bash $0"
    exit 1
fi

INSTALL_START_TIME=$(date +%s)
log "=== Bat dau cai dat OpenClaw ${APP_VERSION} (local mode) ==="

# =============================================================================
# 1. Cap nhat he thong va cai dat packages
# =============================================================================
log "Cap nhat va cai dat packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get -qqy update
apt-get -qqy -o Dpkg::Options::='--force-confdef' -o Dpkg::Options::='--force-confold' install \
    procps file apt-transport-https ca-certificates curl software-properties-common \
    git build-essential jq unzip docker.io gnupg openssl
apt-get -qqy clean

# =============================================================================
# 2. Cai dat Node.js 22 + pnpm
# =============================================================================
log "Cai dat Node.js 22..."
if ! command -v node &>/dev/null || [[ "$(node -e 'process.stdout.write(process.versions.node.split(\".\")[0])')" -lt 22 ]]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
else
    log "Node.js $(node --version) da co san, bo qua."
fi

log "Kich hoat corepack va pnpm..."
corepack enable
corepack prepare pnpm@latest --activate

# =============================================================================
# 3. Kiem tra / khoi dong Docker
# =============================================================================
log "Kiem tra Docker..."
systemctl enable docker --now || true
if ! docker info &>/dev/null; then
    log "CANH BAO: Docker chua san sang. Sandbox co the khong hoat dong."
fi

# =============================================================================
# 4. Tao user openclaw va cac thu muc
# =============================================================================
log "Tao user openclaw..."
useradd -m -s /bin/bash openclaw 2>/dev/null || log "User openclaw da ton tai."
usermod -aG docker openclaw 2>/dev/null || true

mkdir -p /home/openclaw/.openclaw
mkdir -p /home/openclaw/clawd
chown -R openclaw:openclaw /home/openclaw/.openclaw
chmod 0700 /home/openclaw/.openclaw
chown -R openclaw:openclaw /home/openclaw/clawd

# =============================================================================
# 5. Clone repo
# =============================================================================
log "Clone OpenClaw repo (${APP_VERSION})..."
if [ -d "$REPO_DIR" ]; then
    log "Thu muc $REPO_DIR da ton tai, dang pull ban moi nhat..."
    cd "$REPO_DIR"
    git fetch --tags --all
    [ "$APP_VERSION" = "Latest" ] && git pull origin main || git checkout "$APP_VERSION"
else
    git clone "$REPO_URL" "$REPO_DIR"
    cd "$REPO_DIR"
    git fetch --tags
    [ "$APP_VERSION" != "Latest" ] && git checkout "$APP_VERSION"
fi
chown -R openclaw:openclaw "$REPO_DIR"

# =============================================================================
# 6. Tao file /opt/openclaw.env
# =============================================================================
log "Tao file cau hinh moi truong..."
if [ ! -f /opt/openclaw.env ]; then
    cat > /opt/openclaw.env << 'EOF'
# Cau hinh moi truong OpenClaw (local)
OPENCLAW_VERSION=Latest
OPENCLAW_GATEWAY_PORT=18789
OPENCLAW_GATEWAY_BIND=loopback
OPENCLAW_GATEWAY_TOKEN=PLACEHOLDER_WILL_BE_REPLACED

# API Keys (bo comment dong tuong ung va dien key):
# ANTHROPIC_API_KEY=your_api_key_here
# OPENAI_API_KEY=your_api_key_here

# Channels (bo comment va dien token khi can):
# TELEGRAM_BOT_TOKEN=your_bot_token_here
# DISCORD_BOT_TOKEN=your_bot_token_here
# SLACK_BOT_TOKEN=your_bot_token_here
# SLACK_APP_TOKEN=your_app_token_here
EOF
    chmod 0600 /opt/openclaw.env
else
    log "File /opt/openclaw.env da ton tai, giu nguyen."
fi

# =============================================================================
# 7. Ghi template config JSON (co sandbox, khong co Caddy/SSL)
# =============================================================================
log "Ghi config JSON templates..."
mkdir -p /etc/config

cat > /etc/config/anthropic.json << 'EOF'
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-sonnet-4-6"
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
  }
}
EOF

cat > /etc/config/openai.json << 'EOF'
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "openai/gpt-4.1"
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
  }
}
EOF

# =============================================================================
# 8. Build OpenClaw
# =============================================================================
log "Build OpenClaw (co the mat vai phut)..."
cd /opt/openclaw
su - openclaw -c "cd /opt/openclaw && pnpm install --frozen-lockfile"
su - openclaw -c "cd /opt/openclaw && pnpm build"

# Build UI neu co (co the khong co trong local build)
su - openclaw -c "cd /opt/openclaw && pnpm ui:install 2>/dev/null || true"
su - openclaw -c "cd /opt/openclaw && pnpm ui:build 2>/dev/null || true"

# Build sandbox Docker image
log "Build sandbox Docker image..."
if [ -f "$REPO_DIR/scripts/sandbox-setup.sh" ]; then
    bash "$REPO_DIR/scripts/sandbox-setup.sh" || log "CANH BAO: Sandbox build that bai, se thu lai khi su dung lan dau."
else
    log "Khong tim thay sandbox-setup.sh, bo qua."
fi

# Cau hinh npm prefix cho user openclaw
mkdir -p /home/openclaw/.npm
chown -R openclaw:openclaw /home/openclaw/.npm
su - openclaw -c "npm config set prefix /home/openclaw/.npm"

# =============================================================================
# 9. Tao Gateway Token
# =============================================================================
log "Tao Gateway Token..."
if grep -q "PLACEHOLDER_WILL_BE_REPLACED" /opt/openclaw.env; then
    NEW_GATEWAY_TOKEN=$(openssl rand -hex 32)
    sed -i "s/OPENCLAW_GATEWAY_TOKEN=PLACEHOLDER_WILL_BE_REPLACED/OPENCLAW_GATEWAY_TOKEN=$NEW_GATEWAY_TOKEN/" /opt/openclaw.env
else
    NEW_GATEWAY_TOKEN=$(grep "^OPENCLAW_GATEWAY_TOKEN=" /opt/openclaw.env | cut -d'=' -f2)
    log "Gateway token da ton tai, giu nguyen."
fi

# Luu token ra file rieng
echo "$NEW_GATEWAY_TOKEN" > /home/openclaw/.openclaw/gateway-token.txt
chown openclaw:openclaw /home/openclaw/.openclaw/gateway-token.txt
chmod 600 /home/openclaw/.openclaw/gateway-token.txt

# =============================================================================
# 10. Copy config mac dinh vao thu muc openclaw
# =============================================================================
log "Tao config OpenClaw mac dinh (Anthropic)..."
if [ ! -f /home/openclaw/.openclaw/openclaw.json ]; then
    cp /etc/config/anthropic.json /home/openclaw/.openclaw/openclaw.json
    # Dien gateway token vao config
    jq --arg token "$NEW_GATEWAY_TOKEN" '.gateway.auth.token = $token' \
        /home/openclaw/.openclaw/openclaw.json > /home/openclaw/.openclaw/openclaw.json.tmp
    mv /home/openclaw/.openclaw/openclaw.json.tmp /home/openclaw/.openclaw/openclaw.json
fi
chown openclaw:openclaw /home/openclaw/.openclaw/openclaw.json
chmod 0600 /home/openclaw/.openclaw/openclaw.json

# =============================================================================
# 11. Tao systemd service (khong co Panel, khong co Caddy)
# =============================================================================
log "Tao systemd service..."
cat > /etc/systemd/system/openclaw.service << 'EOF'
[Unit]
Description=OpenClaw Gateway Service (local)
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
Environment="NODE_OPTIONS=--dns-result-order=ipv4first --no-network-family-autoselection"
Environment="PATH=/home/openclaw/.npm/bin:/usr/local/bin:/usr/bin:/bin"

ExecStart=/usr/bin/node /opt/openclaw/dist/index.js gateway \
    --port ${OPENCLAW_GATEWAY_PORT} \
    --allow-unconfigured

Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

# =============================================================================
# 12. Tao helper scripts
# =============================================================================
log "Tao helper scripts..."

cat > /opt/openclaw-cli.sh << 'SCRIPT'
#!/bin/bash
su - openclaw -c "cd /opt/openclaw && node dist/index.js $*"
SCRIPT

cat > /opt/restart-openclaw.sh << 'SCRIPT'
#!/bin/bash
echo "Dang khoi dong lai OpenClaw..."
systemctl restart openclaw && sleep 2
systemctl is-active --quiet openclaw \
    && echo "✅ OpenClaw dang chay! (port 18789)" \
    || { echo "❌ Loi: journalctl -u openclaw -xe"; exit 1; }
SCRIPT

cat > /opt/status-openclaw.sh << 'SCRIPT'
#!/bin/bash
echo "=== Trang thai OpenClaw ==="
systemctl status openclaw --no-pager
echo ""
echo "Gateway token: $(grep '^OPENCLAW_GATEWAY_TOKEN=' /opt/openclaw.env | cut -d= -f2)"
echo "Gateway URL:   http://127.0.0.1:18789"
SCRIPT

cat > /opt/update-openclaw.sh << 'SCRIPT'
#!/bin/bash
echo "Dang cap nhat OpenClaw..."
systemctl stop openclaw
cd /opt/openclaw
git stash
git fetch --tags --all
git checkout main && git pull origin main
su - openclaw -c "cd /opt/openclaw && pnpm install --frozen-lockfile && pnpm build"
su - openclaw -c "cd /opt/openclaw && pnpm ui:install 2>/dev/null; pnpm ui:build 2>/dev/null; true"
systemctl start openclaw && echo "✅ Cap nhat hoan tat!" || echo "❌ Loi khi khoi dong lai"
SCRIPT

cat > /opt/configure-openclaw.sh << 'SCRIPT'
#!/bin/bash
# Script cau hinh nhanh API key cho OpenClaw
GATEWAY_TOKEN=$(grep '^OPENCLAW_GATEWAY_TOKEN=' /opt/openclaw.env | cut -d= -f2)

echo "=== Cau hinh OpenClaw ==="
echo "Chon provider:"
echo "  1) Anthropic (Claude)"
echo "  2) OpenAI (GPT)"
read -rp "Chon (1/2): " choice

case "$choice" in
    1)
        read -rp "Nhap ANTHROPIC_API_KEY: " API_KEY
        ENV_KEY="ANTHROPIC_API_KEY"
        CONFIG_SRC="/etc/config/anthropic.json"
        ;;
    2)
        read -rp "Nhap OPENAI_API_KEY: " API_KEY
        ENV_KEY="OPENAI_API_KEY"
        CONFIG_SRC="/etc/config/openai.json"
        ;;
    *)
        echo "Lua chon khong hop le."
        exit 1
        ;;
esac

# Luu API key vao .env
if grep -q "^${ENV_KEY}=" /opt/openclaw.env; then
    sed -i "s|^${ENV_KEY}=.*|${ENV_KEY}=${API_KEY}|" /opt/openclaw.env
elif grep -q "^#${ENV_KEY}=" /opt/openclaw.env; then
    sed -i "s|^#${ENV_KEY}=.*|${ENV_KEY}=${API_KEY}|" /opt/openclaw.env
else
    echo "${ENV_KEY}=${API_KEY}" >> /opt/openclaw.env
fi

# Cap nhat config JSON
cp "$CONFIG_SRC" /home/openclaw/.openclaw/openclaw.json
jq --arg token "$GATEWAY_TOKEN" '.gateway.auth.token = $token' \
    /home/openclaw/.openclaw/openclaw.json > /tmp/oc_cfg.tmp
mv /tmp/oc_cfg.tmp /home/openclaw/.openclaw/openclaw.json
chown openclaw:openclaw /home/openclaw/.openclaw/openclaw.json
chmod 0600 /home/openclaw/.openclaw/openclaw.json

echo "Khoi dong lai OpenClaw..."
systemctl restart openclaw && sleep 2
systemctl is-active --quiet openclaw \
    && echo "✅ Cau hinh thanh cong! Gateway: http://127.0.0.1:18789?token=${GATEWAY_TOKEN}" \
    || echo "❌ Loi: journalctl -u openclaw -xe"
SCRIPT

chmod +x /opt/openclaw-cli.sh /opt/restart-openclaw.sh /opt/status-openclaw.sh \
         /opt/update-openclaw.sh /opt/configure-openclaw.sh

# =============================================================================
# 13. Kich hoat va khoi dong
# =============================================================================
log "Kich hoat va khoi dong OpenClaw..."
systemctl daemon-reload
systemctl enable openclaw
systemctl restart openclaw

sleep 3

# =============================================================================
# 14. Don dep
# =============================================================================
apt-get -qqy autoremove
apt-get -qqy autoclean

# =============================================================================
INSTALL_END_TIME=$(date +%s)
ELAPSED=$(( (INSTALL_END_TIME - INSTALL_START_TIME) / 60 ))m$(( (INSTALL_END_TIME - INSTALL_START_TIME) % 60 ))s

log "=== Cai dat hoan tat trong ${ELAPSED} ==="
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║           ✅ OpenClaw da cai dat thanh cong!         ║"
echo "╠══════════════════════════════════════════════════════╣"
echo "║  Gateway URL  : http://127.0.0.1:18789               ║"
echo "║  Gateway Token: ${NEW_GATEWAY_TOKEN}  ║"
echo "╠══════════════════════════════════════════════════════╣"
echo "║  Buoc tiep theo:                                     ║"
echo "║    sudo /opt/configure-openclaw.sh   # Cau hinh key  ║"
echo "║    sudo /opt/openclaw-cli.sh --help  # Xem lenh CLI  ║"
echo "║    journalctl -u openclaw -f         # Xem log       ║"
echo "╚══════════════════════════════════════════════════════╝"
