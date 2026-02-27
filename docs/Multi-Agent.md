# Multi-Agent Management — Hướng dẫn sử dụng

## Mục lục

- [Tổng quan](#tổng-quan)
- [Binding & Routing](#binding--routing)
  - [Thứ tự ưu tiên](#thứ-tự-ưu-tiên-matching)
  - [Bảng tổng hợp các trường match](#bảng-tổng-hợp-các-trường-match)
- [Peer Matching](#1️⃣-peer-matching)
- [Guild ID Matching](#2️⃣-guild-id-matching--discord-only)
- [Team ID Matching](#3️⃣-team-id-matching)
- [Discord Roles Matching](#4️⃣-discord-roles-matching)
- [Group Chat Mention Patterns](#5️⃣-group-chat-mention-patterns)
- [Agent-to-Agent Communication](#6️⃣-agent-to-agent-communication)
- [Multi-Account per Channel](#7️⃣-multi-account-per-channel)
- [Ví dụ tổng hợp](#ví-dụ-tổng-hợp-setup-multi-agent-cho-discord-server)

---

## Tổng quan

OpenClaw hỗ trợ **nhiều agent** hoạt động đồng thời trên cùng hệ thống. Mỗi agent có thể có identity, model, và hành vi riêng. Hệ thống **binding** cho phép route tin nhắn đến đúng agent dựa trên các điều kiện match như channel, peer, guild, role, account, và mention pattern.

Quản lý tất cả tại: **Panel** → Tab **Agents**

---

## Binding & Routing

### Binding là gì?

**Binding** là cơ chế route tin nhắn đến đúng agent dựa trên điều kiện match. Mỗi binding gồm:
- **Agent** — agent sẽ nhận và xử lý tin nhắn
- **Match object** — tập hợp điều kiện để xác định tin nhắn nào được route đến agent đó

Khi có tin nhắn đến, OpenClaw kiểm tra từng binding theo thứ tự ưu tiên. Binding đầu tiên thỏa mãn sẽ được chọn.

### Thứ tự ưu tiên matching

Binding càng cụ thể (nhiều điều kiện match) → ưu tiên càng cao:

```
peer → parentPeer → guild + roles → guild → team → account → channel → default
```

**Ví dụ:** Tin nhắn từ user `12345` trong Discord guild `99999` có role `VIP`:

| Ưu tiên | Binding match | Agent | Kết quả |
|---------|--------------|-------|---------|
| 1 (cao nhất) | `peer.id=12345` | personal-bot | ✅ Được chọn |
| 2 | `guildId=99999, roles=[VIP]` | vip-support | ⏭️ Bỏ qua |
| 3 (thấp nhất) | `channel=discord` | general-bot | ⏭️ Bỏ qua |

### Bảng tổng hợp các trường match

| Trường | Telegram | Discord | Mô tả | UI |
|--------|----------|---------|--------|----|
| **Peer Kind** | ✅ direct / group / channel | ✅ direct / channel | Loại cuộc hội thoại | Dropdown |
| **Peer ID** | ✅ | ✅ | ID cụ thể của user/group/channel | Text input |
| **Guild ID** | ❌ | ✅ | ID của Discord server | Text input |
| **Role IDs** | ❌ | ✅ | Discord role IDs (match OR) | Text input |
| **Team ID** | ⚙️ API only | ⚙️ API only | Nhóm tổ chức | Chỉ qua Config |
| **Account ID** | ✅ | ✅ | Multi-account routing | Text input |

> **Lưu ý:** UI binding form chỉ hỗ trợ Telegram và Discord. Các channel khác (Slack, WhatsApp, Zalo) có thể cấu hình binding qua tab Config (edit trực tiếp JSON).

---

## 1️⃣ Peer Matching

**Mục đích:** Route tin nhắn dựa trên **loại cuộc hội thoại** (DM, group, channel) và/hoặc **ID cụ thể** của người gửi hoặc nhóm chat.

**Vị trí UI:** Agents → Agent modal → Tab **Bindings** → Chọn Telegram hoặc Discord

### Telegram

| Field | Label | Placeholder |
|-------|-------|-------------|
| Peer Kind | `Peer Kind (optional)` | Dropdown: `-- Any --`, `direct (DM)`, `group`, `channel` |
| Peer / Chat ID | `Peer / Chat ID (optional)` | `e.g. 123456789` |

### Discord

| Field | Label | Placeholder |
|-------|-------|-------------|
| Peer Kind | `Peer Kind (optional)` | Dropdown: `-- Any --`, `direct (DM)`, `channel` |
| Peer ID | `Peer ID (optional)` | `e.g. channel or user ID` |

### Logic xử lý

- Chỉ nhập **Peer ID** mà không chọn Kind → mặc định `kind: "direct"`
- Chỉ chọn **Kind** mà không nhập ID → match tất cả peer có kind đó
- Nhập cả 2 → match chính xác peer cụ thể
- Bỏ trống cả 2 → không filter theo peer

### Ví dụ

| Kịch bản | Kind | ID | Ý nghĩa |
|----------|------|-----|---------|
| Bot chỉ trả lời DM | `direct` | _(trống)_ | Mọi tin nhắn riêng |
| Bot chỉ cho 1 group | `group` | `-1001234567890` | Group Telegram cụ thể |
| Bot riêng cho 1 user | `direct` | `987654321` | Chỉ user đó nhận |
| Bot cho Discord channel | `channel` | `1122334455` | Channel Discord cụ thể |

### Hiển thị trên binding card

```
Peer: direct:123456789
```

---

## 2️⃣ Guild ID Matching — Discord only

**Mục đích:** Giới hạn agent **chỉ hoạt động trong 1 Discord server** (guild) cụ thể. Hữu ích khi bot join nhiều server nhưng cần agent khác nhau cho từng server.

**Vị trí UI:** Agents → Bindings → Chọn Discord → Field **"Guild ID (optional)"**

| Field | Label | Placeholder |
|-------|-------|-------------|
| Guild ID | `Guild ID (optional)` | `e.g. 123456789` |

### Cách lấy Guild ID

1. Mở Discord → **Server Settings** → **Widget** → Copy **Server ID**
2. Hoặc: bật **Developer Mode** (User Settings → App Settings → Advanced) → chuột phải server icon → **Copy Server ID**

### Kết hợp với Roles

Guild ID + Role IDs → agent chỉ trả lời user có role cụ thể **trong** server cụ thể:

```
Guild: 99999 | Roles: 111, 222
→ Match user có role 111 HOẶC 222 trong server 99999
```

### Hiển thị trên binding card

```
Guild: 123456789
```

---

## 3️⃣ Team ID Matching

**Mục đích:** Phân nhóm tổ chức — route tin nhắn dựa trên **team/workspace** mà user thuộc về. Thường dùng cho Slack workspaces hoặc enterprise scenarios.

**⚠️ Hiện tại chưa có UI form trực tiếp.** Có thể set qua:
- Tab **Config** → edit trực tiếp `openclaw.json`
- API endpoint `POST /api/agents/bindings`

### Cấu trúc trong config

```json
{
  "match": {
    "channel": "slack",
    "teamId": "T0123ABCDEF"
  }
}
```

### Hiển thị trên binding card

```
Team: T0123ABCDEF
```

---

## 4️⃣ Discord Roles Matching

**Mục đích:** Route tin nhắn đến agent dựa trên **Discord role** của người gửi. Matching logic **OR** — user chỉ cần có **bất kỳ 1 role** trong danh sách là match.

**Vị trí UI:** Agents → Bindings → Chọn Discord → Field **"Role IDs"**

| Field | Label | Placeholder |
|-------|-------|-------------|
| Role IDs | `Role IDs (optional, comma-separated)` | `e.g. 123456789,987654321` |

### Cách lấy Role ID

1. Discord → **Server Settings** → **Roles** → click role → copy ID từ URL
2. Hoặc: bật **Developer Mode** → chuột phải role trong member list → **Copy Role ID**

### Validation

- Nhập nhiều role cách nhau bởi dấu phẩy: `111222333,444555666`
- Mỗi role ID: chỉ chấp nhận chữ, số, `_` — tối đa 64 ký tự
- Ký tự đặc biệt tự động bị loại bỏ

### Ví dụ

```
Agent "vip-support":
  channel: discord
  guildId: 99999
  roles: [VIP_ROLE_ID, PREMIUM_ROLE_ID]
  → Match user có role "VIP" HOẶC "Premium" trong server 99999
```

### Hiển thị trên binding card

```
Roles: 123456789, 987654321
```

---

## 5️⃣ Group Chat Mention Patterns

**Mục đích:** Trong **group chat có nhiều agent**, xác định agent nào phản hồi dựa trên **regex pattern** của tin nhắn. Chỉ agent có pattern match mới trả lời — thay vì tất cả agent cùng phản hồi.

**Vị trí UI:** Agents → Agent modal → Tab **Info** → Section cuối form: **"Group Chat Mention Patterns"**

### Cách dùng

1. Mở agent modal → tab **Info**
2. Cuộn đến section **"Group Chat Mention Patterns"**
3. Có mô tả: _"Regex patterns that trigger this agent in group chats"_
4. Gõ regex pattern vào ô input → nhấn **Enter** để thêm
5. Pattern xuất hiện dưới dạng **tag pill** (xanh dương, font monospace, có nút ✕)
6. Click **✕** trên tag để xóa pattern
7. Click **Save Changes** để lưu

### Validation

- Pattern phải là **regex hợp lệ** — nếu sai sẽ hiện lỗi `Invalid regex: <chi tiết>`
- Không cho thêm pattern trùng lặp
- Tối đa 256 ký tự mỗi pattern

### Ví dụ patterns

| Pattern | Kích hoạt khi | Use case |
|---------|--------------|----------|
| `^@support` | Tin nhắn bắt đầu bằng `@support` | Mention theo tên |
| `^/help` | Tin nhắn bắt đầu bằng `/help` | Command-style |
| `(?i)bug\|lỗi\|error` | Chứa "bug", "lỗi", hoặc "error" (không phân biệt hoa thường) | Keyword matching |
| `(?i)^(hi\|hello\|xin chào)` | Tin nhắn bắt đầu bằng lời chào | Greeting bot |
| `\bđơn hàng\b` | Chứa từ "đơn hàng" | Order support |

### Hiển thị trên agent card

Sau khi lưu, agent card hiển thị mention badges (nền vàng, tối đa 3 badge, nếu nhiều hơn hiện `+N`).

---

## 6️⃣ Agent-to-Agent Communication

**Mục đích:** Cho phép agent **gửi tin nhắn và đọc lịch sử** của agent khác trong cùng conversation. Hữu ích khi cần agent chuyên biệt hợp tác — ví dụ: agent "reception" nhận yêu cầu → ping agent "tech-support" để xử lý kỹ thuật → "tech-support" trả lời trực tiếp cho user.

**Vị trí UI:** Tab **Agents** → Card **"Agent-to-Agent Communication"** (nằm giữa agent grid và form Add Agent)

### Các control

| Element | Mô tả |
|---------|-------|
| Checkbox **"Enable Agent-to-Agent messaging"** | Bật/tắt tính năng toàn cục |
| **Agent checkboxes** | Tick chọn agent nào được phép tham gia A2A (multi-select) |
| **Max Ping-Pong Turns** (0–5) | Giới hạn số lượt trao đổi qua lại giữa 2 agent |
| **Save** | Lưu cấu hình |
| **Reload** | Load lại từ config hiện tại |

### Max Ping-Pong Turns

| Giá trị | Hành vi |
|---------|---------|
| `0` | Agent chỉ gửi 1 chiều, không nhận phản hồi |
| `1` | A gửi → B trả lời → dừng |
| `2` | A → B → A → dừng |
| `3` | Mặc định — A ↔ B trao đổi tối đa 3 lượt |
| `5` | Tối đa — cho workflow phức tạp nhiều bước |

### Lưu ý

- Setting này là **global** — ảnh hưởng tất cả agent trên hệ thống
- Chỉ các agent được tick trong danh sách "allow" mới có thể tham gia A2A
- Sau khi Save, OpenClaw service sẽ tự restart để áp dụng

---

## 7️⃣ Multi-Account per Channel

**Mục đích:** Chạy **nhiều bot token** cùng 1 nền tảng trên 1 OpenClaw instance. Mỗi account có thể route đến agent khác nhau qua binding. Ví dụ: 1 bot Telegram cho khách hàng, 1 bot Telegram khác cho nội bộ — cùng quản lý trên 1 hệ thống.

**Vị trí UI:**
- **Quản lý accounts:** Tab Channels → Click channel đã cấu hình → Section **"👥 Multi-Account"**
- **Gắn vào binding:** Tab Agents → Binding form → Field **"Account ID (optional, for multi-account)"**

### Token fields theo channel

| Channel | Token fields cần nhập |
|---------|----------------------|
| Telegram | `Bot Token` |
| Discord | `Token` |
| Slack | `Bot Token` + `App Token` |

### Cách dùng — Quản lý accounts

1. Vào tab **Channels** → Click vào channel card (VD: Telegram)
2. Cuộn xuống section **"👥 Multi-Account"**
3. Account **default** tự động hiện từ token hiện tại (legacy ENV)
4. Click **+ Add Account** để thêm account mới:
   - **Account ID** — tên định danh duy nhất, VD: `support-bot`, `sales`
   - **Token fields** — nhập token tương ứng với loại channel
5. Click **Save Account** → service tự restart để áp dụng

### Cách dùng — Gắn account vào binding

**Cách 1: Agent đã có** — Thêm binding cho agent hiện tại

1. Vào tab **Agents** → click vào agent card → tab **Bindings**
2. Ở form "Add New Binding", chọn channel
3. Nhập **Account ID** đã tạo vào field **"Account ID (optional, for multi-account)"**
4. Click **+ Add Binding** → agent này sẽ chỉ nhận tin từ account đó

**Cách 2: Tạo agent mới** — Gắn account ngay lúc tạo

1. Cuộn xuống section **"+ Add New Agent"** ở cuối trang Agents
2. Điền tên agent, chọn model
3. Click **+ Add Binding** → chọn channel (VD: Telegram)
4. Nhập **Account ID** vào field **"Account ID (opt, for multi-account)"** bên dưới
5. Click **Add Agent** → agent mới được tạo kèm binding đến account đó

### Quy tắc quan trọng

- Account **`default`** **không thể xóa** — nó sync với ENV legacy token
- Xóa account khác → tự động xóa tất cả binding tham chiếu đến account đó
- Account ID chỉ chấp nhận: chữ cái, số, `-`, `_` (tối đa 64 ký tự)
- Token hiển thị dạng masked trên UI: `8640***GuqE` (4 ký tự đầu + 4 cuối)

### Ví dụ setup

```
Telegram accounts:
  ├── default      → Bot Token: 8640***GuqE  (bot chính)
  ├── support-bot  → Bot Token: 9123***XyZw  (bot hỗ trợ)
  └── sales        → Bot Token: 7456***AbCd  (bot bán hàng)

Bindings:
  agent "main"     → channel: telegram              (nhận mọi tin từ bot chính)
  agent "support1" → channel: telegram, accountId: support-bot
  agent "sales1"   → channel: telegram, accountId: sales
```

### Hiển thị trên binding card

```
Account: support-bot
```

---

## Ví dụ tổng hợp: Setup Multi-Agent cho Discord Server

### Kịch bản

Một Discord server cần 4 agent với vai trò khác nhau:

| Agent | Vai trò | Điều kiện kích hoạt |
|-------|---------|-------------------|
| `main` | Trả lời mọi tin nhắn chung | Fallback — không có binding cụ thể |
| `vip-bot` | Chỉ phục vụ VIP members | Match Discord role "VIP" |
| `tech-bot` | Xử lý vấn đề kỹ thuật | Trigger bằng keyword "bug/error/lỗi" |
| `mod-bot` | Chỉ hoạt động trong #mod-channel | Match peer channel cụ thể |

### Cấu hình Bindings

```
vip-bot:
  channel: discord
  guildId: 99999
  roles: [VIP_ROLE_ID]

tech-bot:
  channel: discord
  guildId: 99999
  mentionPatterns: ["(?i)bug|error|lỗi"]

mod-bot:
  channel: discord
  peer: { kind: channel, id: MOD_CHANNEL_ID }

main:
  channel: discord
  (không thêm điều kiện → fallback nhận mọi thứ còn lại)
```

### Cấu hình Agent-to-Agent

```
enabled: true
allow: [tech-bot, mod-bot]
maxPingPongTurns: 2
```

→ `tech-bot` có thể ping `mod-bot` nếu cần escalate vấn đề.

### Kết quả hoạt động

| Tình huống | Agent xử lý | Lý do |
|-----------|-------------|-------|
| User VIP gửi tin bất kỳ | **vip-bot** | Match role VIP (ưu tiên cao) |
| User thường gõ "có bug kìa" | **tech-bot** | Match mentionPattern `(?i)bug` |
| Tin nhắn trong #mod-channel | **mod-bot** | Match peer channel cụ thể |
| User thường gõ "hello" | **main** | Fallback — không match binding nào khác |
| tech-bot cần hỗ trợ mod | **mod-bot** | A2A messaging — tech-bot ping mod-bot |

### Mở rộng với Multi-Account

Nếu cần 2 bot Discord riêng biệt (1 cho community, 1 cho support):

```
Discord accounts:
  ├── default       → Token: abc***xyz  (community bot)
  └── support-dc    → Token: def***uvw  (support bot)

Thêm vào binding:
  vip-bot:   accountId: support-dc   (chỉ nhận từ support bot)
  tech-bot:  accountId: support-dc   (chỉ nhận từ support bot)
  main:      accountId: default      (nhận từ community bot)
```
