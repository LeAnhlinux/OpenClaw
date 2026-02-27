#!/bin/bash
echo "Dang khoi dong lai OpenClaw Gateway..."
systemctl restart openclaw
sleep 2
if systemctl is-active --quiet openclaw; then
    echo "OpenClaw da khoi dong lai thanh cong!"
    echo "Gateway dang chay tren port 18789"
    echo "Xem log: journalctl -u openclaw -f"
else
    echo "Loi: Khong the khoi dong lai OpenClaw"
    echo "Kiem tra log: journalctl -u openclaw -xe"
    exit 1
fi
