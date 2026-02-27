#!/bin/bash

# Openclaw Update Script
# Choose from latest 3 stable releases or main branch

if [ ! -d "/opt/openclaw" ]; then
    echo "❌ Error: /opt/openclaw not found"
    exit 1
fi

cd /opt/openclaw

# Get current version
CUR_VER=""
if [ -f "package.json" ]; then
    CUR_VER="v$(node -p "require('./package.json').version" 2>/dev/null)"
fi
[ -z "$CUR_VER" ] && CUR_VER="unknown"
echo "Current version: $CUR_VER"
echo ""

# Fetch tags
echo "Fetching available versions..."
git fetch --tags --all -q 2>/dev/null

# Get 3 latest stable tags (vYYYY.M.D format only)
TAGS=($(git tag --sort=-version:refname 2>/dev/null | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -3))

if [ ${#TAGS[@]} -eq 0 ]; then
    echo "No stable releases found. Updating from main branch..."
    TARGET="main"
else
    echo "Available versions:"
    echo "  0) main (latest development)"
    for i in "${!TAGS[@]}"; do
        TAG="${TAGS[$i]}"
        MARK=""
        [ "$TAG" = "$CUR_VER" ] && MARK=" (current)"
        echo "  $((i+1))) $TAG$MARK"
    done
    echo ""

    # Accept version from argument or prompt
    if [ -n "$1" ]; then
        CHOICE="$1"
    else
        read -p "Choose version [1]: " CHOICE
        [ -z "$CHOICE" ] && CHOICE="1"
    fi

    if [ "$CHOICE" = "0" ]; then
        TARGET="main"
    elif [[ "$CHOICE" =~ ^[1-3]$ ]] && [ "$CHOICE" -le ${#TAGS[@]} ]; then
        TARGET="${TAGS[$((CHOICE-1))]}"
    else
        echo "❌ Invalid choice"
        exit 1
    fi
fi

echo ""
echo "Updating to: $TARGET"
echo "================================"

# Stop service
echo "Stopping OpenClaw..."
systemctl stop openclaw

# Stash local changes
git stash -q 2>/dev/null

if [ "$TARGET" = "main" ]; then
    echo "Checking out main..."
    git checkout main -q && git pull origin main
else
    echo "Checking out $TARGET..."
    git checkout "$TARGET" -q 2>/dev/null || git checkout -b "release-$TARGET" "$TARGET" -q
    git reset --hard "$TARGET" -q
fi

if [ $? -ne 0 ]; then
    echo "❌ Checkout failed"
    systemctl start openclaw
    exit 1
fi

echo "Fixing permissions..."
chown -R openclaw:openclaw /opt/openclaw

echo "Building (this may take a few minutes)..."
su - openclaw -c "cd /opt/openclaw && pnpm install --frozen-lockfile 2>&1 && pnpm build 2>&1 && pnpm ui:install 2>&1 && pnpm ui:build 2>&1"

if [ $? -ne 0 ]; then
    echo "❌ Build failed"
    systemctl start openclaw
    exit 1
fi

# Save version to env if not main
if [ "$TARGET" != "main" ]; then
    sed -i '/^OPENCLAW_VERSION=/d' /opt/openclaw.env 2>/dev/null
    echo "OPENCLAW_VERSION=$TARGET" >> /opt/openclaw.env
fi

echo "Starting OpenClaw..."
systemctl start openclaw
sleep 2

if systemctl is-active --quiet openclaw; then
    echo "✅ OpenClaw updated to $TARGET successfully!"
else
    echo "❌ OpenClaw failed to start"
    exit 1
fi
