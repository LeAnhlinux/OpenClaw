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

${DOMAIN}:9443 {
    tls {
        issuer acme {
            dir https://acme-v02.api.letsencrypt.org/directory
            profile shortlived
        }
    }
    reverse_proxy ${BIND_IP}:9999
}
CADDYEOC
    if [ -n "$EMAIL" ]; then
        sed -i "1iemail ${EMAIL}" /etc/caddy/Caddyfile
    fi
}

# Firewall: mo 9443 (Panel HTTPS qua Caddy)
ufw allow 9443/tcp comment "OpenClaw Panel HTTPS" 2>/dev/null || true

systemctl enable caddy
systemctl restart caddy
systemctl restart openclaw

echo "Caddy dang proxy https://${DOMAIN} den ${BIND_IP}:${PORT}."
echo "Panel HTTPS: https://${DOMAIN}:9443"
echo "Gateway bind da dat la ${BIND_IP}. Ban co the chinh /opt/openclaw.env va chay lai script nay."
