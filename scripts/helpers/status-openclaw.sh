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
echo "https://$myip"
