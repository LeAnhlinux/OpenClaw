#!/bin/bash
# Helper script chay lenh CLI OpenClaw
su - openclaw -c "cd /opt/openclaw && node dist/index.js $*"
