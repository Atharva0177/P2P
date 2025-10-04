# Web AirDrop • Peer‑to‑Peer file transfer in your browser

<p align="center">
  Zero‑install, end‑to‑end browser transfers powered by WebRTC. Share files across devices with session codes or a QR — no accounts, no cloud storage.
</p>

---

## ✨ Highlights

- ⚡ Fast by design: multi‑channel, unordered SCTP stripes with backpressure
- 📱 QR join: create a 6‑digit code or share a one‑tap link via QR
- 📦 Drag‑&‑drop files or whole folders (preserves relative paths when available)
- 🛡️ Integrity: optional per‑file SHA‑256 verification
- 🧩 Resilience: NACK/repair for missing chunks
- ♻️ True resume: continue on the receiver after page refresh (IndexedDB)
- ⏯️ Controls: pause / resume / cancel on the sender
- 📊 Rich progress: per‑file + overall %, throughput, ETA
- ⬇️ Bulk download: “Download all” triggers each file (no ZIP)
- 🌐 Works through NATs (STUN/TURN), keeps P2P alive with lightweight ping/pong
- 🌓 Modern, immersive UI with light/dark themes and subtle motion

> Tip: Great starting settings for most networks: 2–6 channels and 64–256 KiB chunk size.

---

## 🚀 Quick start

```bash
# 1) Clone
git clone https://github.com/Atharva0177/P2P.git
cd P2P

# 2) Install (choose one)
npm install
# or
pnpm install
# or
yarn

# 3) Run the app
npm run dev   # development
# or
npm run start # production

# 4) Open the URL printed in your terminal (e.g., http://localhost:3000)
```

1) Click “Create session code”  
2) On the other device, scan the QR or paste the 6‑digit code  
3) Choose roles (Sender / Receiver)  
4) Drag files/folders or use the pickers, then Send

---

## 🧠 How it works

```text
┌────────────┐    WebSocket     ┌────────────┐
│   Sender   │ ───────────────▶ │ Signaling  │  Room: 6‑digit code
│  Browser   │ ◀─────────────── │  Server    │  (SDP/ICE relay only)
└─────┬──────┘                  └─────┬──────┘
      │ WebRTC (SDP/ICE via WS)       │
      └───────────────────────────────┘
             ↓ DTLS/SCTP/UDP/TCP
┌────────────────────────────────────────────────┐
│                 P2P DataChannels               │
│  ctrl (JSON, ordered)     data-0..data-N (unordered) │
└────────────────────────────────────────────────┘
  file-meta → striped chunks → nack/repair → file-ack
```

- Sender opens one ordered ctrl channel and N unordered data channels
- Receiver reconstructs files in memory or writes directly to disk (File System Access API)
- Missing pieces? Receiver sends `nack` with indices; sender resends just those
- Keep‑alive pings keep NAT bindings fresh; signaling can drop, P2P continues

---

## 🧩 Feature tour

### Joining via QR
- Share a link encoded as `/?code=XXXXXX&join=1&role=receiver`
- Auto‑fills the code and clicks Join + selects role for your peer

### Integrity checks
- For small/medium files (default ≤100 MB), sender includes SHA‑256 in `file-meta`
- Receiver verifies before acknowledging (in memory mode)

### True resume (receiver)
- Receiver persists manifests and chunks to IndexedDB with a transfer ID (`xferId`)
- On reconnect, Receiver sends a `resume-request` listing missing chunk indices
- Sender resends only those chunks if original file is still available in its tab

### Pause / resume / cancel (sender)
- Global controls halt or resume workers; cancel aborts active files immediately
- Status mirrored to receiver via ctrl messages

### Bulk download (no ZIP)
- Completed in‑memory files appear in Downloads; “Download all” triggers per‑file downloads sequentially
- Files saved directly to disk (writer mode) aren’t re-downloaded — they’re already there

---

## 🛠️ Configuration

| Area            | Where                        | Notes |
|-----------------|------------------------------|-------|
| Channels        | UI setting                   | 1–8 channels; unordered for throughput |
| Chunk size      | UI setting                   | 16–1024 KiB; keep ≤ `pc.sctp.maxMessageSize` |
| STUN/TURN       | `rtcConfig` in app.js        | Add your TURN for strict networks |
| Hashing         | app.js                       | SHA‑256 enabled by default for ≤100 MB |
| Theme           | UI toggle (persisted)        | Light / Dark |

Example TURN entry (client-side RTC config):

```js
const rtcConfig = {
  iceServers: [
    { urls: ["stun:stun.l.google.com:19302", "stun:global.stun.twilio.com:3478"] },
    { urls: "turn:turn.example.com:3478?transport=udp", username: "user", credential: "pass" }
  ]
};
```

---

## 🔌 Control protocol (ctrl channel)

All ctrl messages are JSON strings over the ordered channel.

- Keep‑alive: `{"kind":"ping","t":<ms>}` → `{"kind":"pong","t":<ms>}`
- File metadata:
  - `{"kind":"file-meta","fileId":1,"xferId":"uuid","name":"a.txt","size":1234,"type":"text/plain","chunkSize":131072,"totalChunks":10,"sha256":"hex","hashAlg":"SHA-256"|"none"}`
- Loss recovery:
  - `{"kind":"nack","fileId":1,"missing":[3,7,9]}`
- Completion:
  - `{"kind":"file-ack","fileId":1,"receivedBytes":1234}`
- Pause / resume / cancel:
  - `{"kind":"pause-all"}`, `{"kind":"resume-all"}`, `{"kind":"cancel-all"}`
  - Optional per‑file: `{"kind":"cancel","fileId":1,"xferId":"uuid"}`
- Resume:
  - Receiver → Sender: `{"kind":"resume-request","entries":[{"xferId":"uuid","missing":[…],...}]}`
  - Sender → Receiver: `{"kind":"resume-accept","xferId":"uuid"}` or `{"kind":"resume-needed","xferId":"uuid"}`

Data frames (binary on data channels): 8‑byte header `[uint32 fileId][uint32 chunkIndex]` + payload.

---

## 🧪 Browser support

- Chrome / Edge: best coverage (DataChannels, File System Access API)
- Firefox: DataChannels supported; falls back to memory mode for saving
- Safari (iOS/macOS): works; start with 1–2 channels and 64–128 KiB chunks on relay paths

> If your path is relayed (TURN over TCP/TLS) or on iOS, conservative settings improve reliability.

---

## 🧯 Troubleshooting

- QR buttons are greyed out
  - A valid 6‑digit code is required. Use “Create session code,” then Show QR.
  - Hard refresh with cache bypass (Ctrl/Cmd+Shift+R) if the UI didn’t update.

- “Receiver did not acknowledge file completion in time”
  - Check receiver logs for NACK/repair activity.
  - Writer mode (save-to-disk) sends ACK using known file size; integrity for writer mode is marked “unknown”.

- “Allow multiple downloads” prompt
  - Browsers may ask once for permission when using “Download all.”

- Slow or flaky transfers
  - Lower channels (1–2) and chunk size (64–128 KiB).
  - Configure a TURN server near both peers.

---

## 🧰 Development

```
static/
  ├─ index.html    # UI structure (IDs are part of the app contract)
  ├─ style.css     # Modern glass/aurora theme, animations, reveal on scroll
  ├─ ui.js         # Theme toggle, ripples, visual-only behavior
  └─ app.js        # Signaling, WebRTC, transfer engine (NACK, resume, keep-alive)
server/
  └─ ...           # Signaling WS /ws/{code} and /api/new-code (implementation dependent)
```

Scripts (adjust to your setup):
```bash
npm run dev     # Start in development
npm run start   # Start in production
npm run build   # Bundle/prepare assets (if applicable)
```

---

## 🔒 Security notes

- All WebRTC DataChannels are encrypted (DTLS). With TURN/TLS, traffic is also encrypted to the relay.
- Metadata (filenames, sizes) is sent inside the DTLS session on ctrl.
- Optional hardening: add application‑layer E2EE (ECDH → HKDF → AES‑GCM) and display a short authentication string (SAS) to defend against malicious signaling.

---

## 🗺️ Roadmap (nice next steps)

- Adaptive channels & chunk sizes from observed throughput/loss
- Per‑chunk integrity (Merkle) to catch corruption early
- Sender re‑attach for resume (browse original file after restart)
- Diagnostics panel (ICE pair, RTT/loss, sctp caps, bufferedAmount)
- Optional E2EE with SAS fingerprint in the QR

---

## 🙌 Contributing

- Pull requests welcome! If you’re unsure where to start:
  1. Open an issue describing the problem/idea
  2. Keep PRs focused and small
  3. Include before/after notes and screenshots for UI changes

> Please run the app locally and test both roles before submitting changes.

---
