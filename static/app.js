const logEl = document.getElementById("log");
function log(...args) {
  const line = args.map(a => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
  console.debug(...args);
  logEl.textContent += line + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}

const codeInput = document.getElementById("codeInput");
const btnNewCode = document.getElementById("btnNewCode");
const btnJoin = document.getElementById("btnJoin");
const sessionInfo = document.getElementById("sessionInfo");

const numChannelsInput = document.getElementById("numChannels");
const chunkSizeKBInput = document.getElementById("chunkSizeKB");

const btnIamSender = document.getElementById("btnIamSender");
const btnIamReceiver = document.getElementById("btnIamReceiver");

const senderPanel = document.getElementById("senderPanel");
const receiverPanel = document.getElementById("receiverPanel");

const fileInput = document.getElementById("fileInput");
const btnSend = document.getElementById("btnSend");
const sendProgress = document.getElementById("sendProgress");
const sendStatus = document.getElementById("sendStatus");

const recvProgress = document.getElementById("recvProgress");
const recvStatus = document.getElementById("recvStatus");
const downloads = document.getElementById("downloads");

// QR elements
const btnShowQR = document.getElementById("btnShowQR");
const btnCopyLink = document.getElementById("btnCopyLink");
const qrPanel = document.getElementById("qrPanel");
const qrCodeEl = document.getElementById("qrCode");
const shareLinkEl = document.getElementById("shareLink");

let ws = null;
let pc = null;
let isSender = null;
let joined = false;

// User-configurable settings (affect sender only)
let USER_NUM_CHANNELS = clampInt(parseInt(numChannelsInput?.value || "4", 10), 1, 8);   // 1..8
let USER_CHUNK_SIZE_KIB = clampInt(parseInt(chunkSizeKBInput?.value || "128", 10), 16, 1024); // 16..1024

if (numChannelsInput) {
  numChannelsInput.addEventListener("change", () => {
    USER_NUM_CHANNELS = clampInt(parseInt(numChannelsInput.value || "4", 10), 1, 8);
    numChannelsInput.value = String(USER_NUM_CHANNELS);
    log("Setting: parallel channels =", USER_NUM_CHANNELS);
  });
}
if (chunkSizeKBInput) {
  chunkSizeKBInput.addEventListener("change", () => {
    USER_CHUNK_SIZE_KIB = clampInt(parseInt(chunkSizeKBInput.value || "128", 10), 16, 1024);
    chunkSizeKBInput.value = String(USER_CHUNK_SIZE_KIB);
    log("Setting: chunk size =", USER_CHUNK_SIZE_KIB, "KiB");
  });
}

// Multi-channel settings (runtime)
let channels = []; // { label, dc, open, type: "data"|"ctrl" }
let ctrl = null;   // control channel entry

// Signaling buffering
let pendingSignals = [];

// Backpressure (per channel)
const MAX_BUFFERED = 16 * 1024 * 1024; // pause when >= 16 MiB queued
const LOW_WATER   =  4 * 1024 * 1024;  // resume when <= 4 MiB queued

// Sender state
let nextFileId = 1;
const awaitingAcks = new Map(); // fileId -> {resolve,reject,timeout}

// Receiver state
// fileId -> {
//   name, size, type, chunkSize, totalChunks,
//   receivedCount, receivedBytes,
//   chunks[],            // only used in memory mode
//   have: Uint8Array,    // bitmap of unique chunk indices received
//   writer, _finalized
// }
const recvFiles = new Map();
// Buffer for binary chunks that arrive before we see metadata for that fileId
const preMetaChunks = new Map(); // fileId -> Array<ArrayBuffer>

const rtcConfig = {
  iceServers: [
    { urls: ["stun:stun.l.google.com:19302", "stun:global.stun.twilio.com:3478"] },
    // For production with TURN (prefer UDP):
    // { urls: "turn:turn.example.com:3478?transport=udp", username: "user", credential: "pass" }
  ],
};

// UI actions
btnNewCode?.addEventListener("click", async () => {
  try {
    const res = await fetch("/api/new-code");
    const { code } = await res.json();
    codeInput.value = code;
    sessionInfo.textContent = `Session code: ${code} (share with peer)`;
    log("New code generated:", code);

    // Ensure QR buttons/link update immediately after programmatic value set
    window.qrUpdateShareUIFromCode?.();
  } catch (e) {
    log("Failed to get new code", e);
  }
});

btnJoin?.addEventListener("click", async () => {
  const code = (codeInput.value || "").trim();
  if (!/^\d{6}$/.test(code)) {
    alert("Enter a 6-digit code");
    return;
  }
  await joinSession(code);
});

btnIamSender?.addEventListener("click", async () => {
  if (!joined) return;
  isSender = true;
  senderPanel.hidden = false;
  receiverPanel.hidden = true;
  btnIamSender.disabled = true;
  btnIamReceiver.disabled = true;
  // Lock settings once a role is chosen to avoid mid-connection changes
  if (numChannelsInput) numChannelsInput.disabled = true;
  if (chunkSizeKBInput) chunkSizeKBInput.disabled = true;

  wsSend({ type: "role", role: "sender" });
  await setupPeerConnection();
  await startSenderOffer();
});

btnIamReceiver?.addEventListener("click", async () => {
  if (!joined) return;
  isSender = false;
  senderPanel.hidden = true;
  receiverPanel.hidden = false;
  btnIamSender.disabled = true;
  btnIamReceiver.disabled = true;
  if (numChannelsInput) numChannelsInput.disabled = true;
  if (chunkSizeKBInput) chunkSizeKBInput.disabled = true;

  wsSend({ type: "role", role: "receiver" });
  await setupPeerConnection();
  log("Receiver: waiting for offer...");
  await processPendingSignals();
});

async function joinSession(code) {
  if (joined) return;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws/${code}`);
  ws.onopen = () => {
    joined = true;
    sessionInfo.textContent = `Joined session ${code}. Choose your role.`;
    btnIamSender.disabled = false;
    btnIamReceiver.disabled = false;
    log("WebSocket connected for code", code);
  };
  ws.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data);

    if (msg.type === "peer-joined") {
      log("Peer joined.");
      if (isSender && pc && channels.every(c => !c.open)) {
        try {
          log("Sender: (re)starting offer after peer joined...");
          const offer = await pc.createOffer({ iceRestart: true });
          await pc.setLocalDescription(offer);
          wsSend({ type: "sdp", sdp: pc.localDescription });
          log("Sent (re)offer");
        } catch (e) {
          log("Error re-offering:", e);
        }
      }
      return;
    }

    if (msg.type === "peer-disconnected") {
      log("Peer disconnected.");
      teardownPeer("Peer disconnected");
      return;
    }

    if (msg.type === "role") {
      log("Peer role:", msg.role);
      if (msg.role === "receiver" && isSender && pc && channels.every(c => !c.open)) {
        try {
          log("Sender: re-offer because receiver is ready...");
          const offer = await pc.createOffer({ iceRestart: true });
          await pc.setLocalDescription(offer);
          wsSend({ type: "sdp", sdp: pc.localDescription });
          log("Sent (re)offer after receiver ready");
        } catch (e) {
          log("Error re-offering on receiver-ready:", e);
        }
      }
      return;
    }

    if (msg.type === "sdp" || msg.type === "ice") {
      await handleSignal(msg);
      return;
    }
  };
  ws.onclose = () => {
    log("WebSocket closed");
    teardownPeer("Signaling closed");
  };
  ws.onerror = (e) => {
    log("WebSocket error", e);
  };
}

function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

async function setupPeerConnection() {
  pc = new RTCPeerConnection(rtcConfig);
  channels = [];
  ctrl = null;

  pc.onicecandidate = (e) => {
    if (e.candidate) wsSend({ type: "ice", candidate: e.candidate.toJSON() });
  };
  pc.onconnectionstatechange = () => {
    log("PeerConnection state:", pc.connectionState);
    if (pc.connectionState === "disconnected" || pc.connectionState === "failed" || pc.connectionState === "closed") {
      teardownPeer(`PC state: ${pc.connectionState}`);
    }
  };

  if (isSender) {
    // 1) Dedicated ordered control channel for JSON
    const ctrlDc = pc.createDataChannel("ctrl", { ordered: true });
    attachChannel(ctrlDc, "ctrl", "ctrl");

    // 2) Unordered data channels for payload
    const count = USER_NUM_CHANNELS;
    for (let i = 0; i < count; i++) {
      const label = `data-${i}`;
      const dc = pc.createDataChannel(label, { ordered: false });
      attachChannel(dc, label, "data");
    }
  } else {
    pc.ondatachannel = (ev) => {
      const dc = ev.channel;
      const type = dc.label === "ctrl" ? "ctrl" : "data";
      attachChannel(dc, dc.label, type);
    };
  }
}

function attachChannel(dc, label, type) {
  const entry = { label, dc, open: false, type };
  channels.push(entry);
  if (type === "ctrl") ctrl = entry;

  dc.binaryType = "arraybuffer";
  try { dc.bufferedAmountLowThreshold = LOW_WATER; } catch {}

  dc.onopen = () => {
    entry.open = true;
    log(`DataChannel open: ${label}`);
    if (isSender && type !== "ctrl") {
      btnSend.disabled = !(channels.some(c => c.open && c.type === "data") && fileInput.files.length > 0);
    }
  };
  dc.onclose = () => { entry.open = false; log(`DataChannel closed: ${label}`); };
  dc.onerror = (e) => log(`DataChannel error [${label}]`, e);

  if (!isSender) {
    if (type === "ctrl") dc.onmessage = onCtrlMessage;
    else dc.onmessage = onDataMessage;
  } else {
    if (type === "ctrl") dc.onmessage = onCtrlMessageSenderSide;
  }
}

// Backpressure helpers
function waitForBufferedAmountLow(dc) {
  if (!dc || dc.readyState !== "open") return Promise.reject(new Error("DataChannel not open"));
  if (dc.bufferedAmount <= LOW_WATER) return Promise.resolve();
  return new Promise((resolve) => {
    const onLow = () => {
      if (dc.bufferedAmount <= LOW_WATER) {
        dc.removeEventListener("bufferedamountlow", onLow);
        resolve();
      }
    };
    dc.addEventListener("bufferedamountlow", onLow);
    const iv = setInterval(() => {
      if (!dc || dc.readyState !== "open") {
        clearInterval(iv);
        dc?.removeEventListener?.("bufferedamountlow", onLow);
        resolve();
      } else if (dc.bufferedAmount <= LOW_WATER) {
        clearInterval(iv);
        dc.removeEventListener("bufferedamountlow", onLow);
        resolve();
      }
    }, 50);
  });
}

async function safeSend(dc, payload) {
  while (dc.bufferedAmount >= MAX_BUFFERED) {
    await waitForBufferedAmountLow(dc);
  }
  for (;;) {
    try {
      dc.send(payload);
      return;
    } catch (err) {
      const msg = String(err?.message || err);
      if (msg.includes("send queue is full") || err?.name === "OperationError" || err?.name === "NetworkError") {
        await waitForBufferedAmountLow(dc);
        continue;
      }
      if (err?.name === "InvalidStateError") throw new Error("DataChannel is not open");
      throw err;
    }
  }
}

async function processPendingSignals() {
  if (!pc) return;
  const queue = pendingSignals.slice();
  pendingSignals = [];
  for (const msg of queue) await handleSignal(msg);
}

async function handleSignal(msg) {
  if (!pc) { pendingSignals.push(msg); return; }
  if (msg.type === "sdp") {
    const desc = msg.sdp;
    await pc.setRemoteDescription(desc);
    log("Set remote description:", desc.type);
    if (desc.type === "offer") {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      wsSend({ type: "sdp", sdp: pc.localDescription });
      log("Sent answer");
    }
  } else if (msg.type === "ice") {
    try { await pc.addIceCandidate(msg.candidate); } catch (e) { log("Error adding ICE:", e); }
  }
}

async function startSenderOffer() {
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  wsSend({ type: "sdp", sdp: pc.localDescription });
  log("Sent offer");
}

fileInput?.addEventListener("change", () => {
  if (isSender) {
    btnSend.disabled = !(channels.some(c => c.open && c.type === "data") && fileInput.files.length > 0);
  }
});

btnSend?.addEventListener("click", async () => {
  if (!isSender) return;
  const dataChans = channels.filter(c => c.open && c.type === "data");
  if (dataChans.length === 0) { alert("No data channels open yet"); return; }
  const files = [...fileInput.files];
  if (!files.length) { alert("Choose files first"); return; }
  btnSend.disabled = true;
  try {
    for (const file of files) {
      await sendFileStriped(file, dataChans);
    }
    sendStatus.textContent = "All files sent and acknowledged.";
  } catch (e) {
    log("Send error:", e?.message || e);
    sendStatus.textContent = `Error: ${e?.message || e}`;
  } finally {
    btnSend.disabled = false;
  }
});

function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }

// Sender: striped transfer with fixed per-file chunk size and requeue
async function sendFileStriped(file, dataChans) {
  const fileId = nextFileId++;

  // Use the user-configured fixed chunk size for this file
  const chunkSize = clampInt(USER_CHUNK_SIZE_KIB, 16, 1024) * 1024; // bytes
  const totalChunks = Math.ceil(file.size / chunkSize) || 1;

  // Send metadata on control channel
  const meta = {
    kind: "file-meta",
    fileId, name: file.name, size: file.size,
    type: file.type || "application/octet-stream",
    chunkSize, totalChunks
  };

  // Wait for ctrl to be open
  while (!ctrl || !ctrl.open) await sleep(10);
  await safeSend(ctrl.dc, JSON.stringify(meta));

  // Build LIFO stack of chunk indices
  const stack = [];
  for (let i = totalChunks - 1; i >= 0; i--) stack.push(i);

  let sentBytes = 0;

  // Create file-ack promise
  const ackPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Receiver did not acknowledge file completion in time")), 180000);
    awaitingAcks.set(fileId, { resolve: (info) => { clearTimeout(timeout); resolve(info); }, reject, timeout });
  });

  function makeHeader(fileId, chunkIndex) {
    const buf = new ArrayBuffer(8);
    const dv = new DataView(buf);
    dv.setUint32(0, fileId);
    dv.setUint32(4, chunkIndex);
    return buf;
  }

  async function worker(entry) {
    const dc = entry.dc;
    for (;;) {
      if (dc.readyState !== "open") throw new Error(`Channel ${entry.label} closed`);
      const idx = stack.pop();
      if (idx === undefined) return;
      const start = idx * chunkSize;
      const end = Math.min(file.size, start + chunkSize);
      const slice = file.slice(start, end);
      const frame = new Blob([makeHeader(fileId, idx), slice]);

      try {
        await safeSend(dc, frame);
      } catch (e) {
        // Requeue this index and retry later
        stack.push(idx);
        if (dc.readyState !== "open") return; // let another worker continue
        await sleep(10);
        continue;
      }

      sentBytes += (end - start);
      const pct = Math.floor((sentBytes / file.size) * 100);
      sendProgress.style.width = `${pct}%`;
      sendStatus.textContent = `Sending ${file.name}: ${pct}% (${formatBytes(sentBytes)} / ${formatBytes(file.size)})`;

      if ((idx & 63) === 0) await sleep(0); // UI responsive
    }
  }

  // Launch workers
  const workers = dataChans.map(c => worker(c));
  await Promise.all(workers);

  // Wait for channel buffers to drain
  await Promise.all(dataChans.map(c => waitForBufferedAmountLow(c.dc)));

  // Notify EOF on ctrl (optional)
  await safeSend(ctrl.dc, JSON.stringify({ kind: "file-eof", fileId }));

  // Wait for receiver ACK
  const ack = await ackPromise;
  if (!ack || ack.fileId !== fileId) throw new Error("Invalid ACK");
  if (ack.receivedBytes !== file.size) {
    throw new Error(`Receiver reported ${formatBytes(ack.receivedBytes)} of ${formatBytes(file.size)}`);
  }

  log("File sent and acknowledged:", file.name);
}

// Receiver: control messages
async function onCtrlMessage(ev) {
  const data = ev.data;
  if (typeof data !== "string") return;
  try {
    const msg = JSON.parse(data);
    if (msg.kind === "file-meta") {
      const { fileId, name, size, type, chunkSize, totalChunks } = msg;
      const state = {
        fileId, name, size, type,
        chunkSize, totalChunks,
        receivedCount: 0,
        receivedBytes: 0,
        chunks: new Array(totalChunks).fill(null),
        have: new Uint8Array(totalChunks), // 0 = missing, 1 = present
        writer: null,
        _finalized: false
      };

      // Try File System Access API (random access writes)
      if ("showSaveFilePicker" in window) {
        try {
          const handle = await window.showSaveFilePicker({
            suggestedName: name,
            types: [{ description: "All files", accept: { "*/*": [".*"] } }],
          });
          state.writer = await handle.createWritable();
          try { await state.writer.truncate(size); } catch {}
          log(`Receiver: writing ${name} directly to disk`);
        } catch {
          state.writer = null;
        }
      }

      recvFiles.set(fileId, state);
      recvStatus.textContent = `Receiving ${name} (${formatBytes(size)})...`;
      log("Receiving metadata:", { fileId, name, size, chunkSize, totalChunks });

      // Apply any chunks that arrived before metadata
      const pending = preMetaChunks.get(fileId);
      if (pending && pending.length) {
        for (const ab of pending) await applyBinaryChunk(ab);
        preMetaChunks.delete(fileId);
      }
    } else if (msg.kind === "file-eof") {
      const { fileId } = msg;
      const st = recvFiles.get(fileId);
      if (st) {
        if (st.receivedCount === st.totalChunks) await finalizeFile(st);
      }
    }
  } catch {
    // ignore parse errors
  }
}

// Sender listens for ACKs on ctrl, too
function onCtrlMessageSenderSide(ev) {
  const data = ev.data;
  if (typeof data !== "string") return;
  try {
    const msg = JSON.parse(data);
    if (msg.kind === "file-ack") {
      const waiter = awaitingAcks.get(msg.fileId);
      if (waiter) {
        awaitingAcks.delete(msg.fileId);
        waiter.resolve({ fileId: msg.fileId, receivedBytes: msg.receivedBytes });
      }
    }
  } catch {
    // ignore
  }
}

// Receiver: data messages (binary)
async function onDataMessage(ev) {
  const data = ev.data;
  if (!(data instanceof ArrayBuffer)) return;
  const dv = new DataView(data);
  if (data.byteLength < 8) { log("Too-small frame; ignoring"); return; }
  const fileId = dv.getUint32(0);
  const st = recvFiles.get(fileId);
  if (!st) {
    // Buffer until we get metadata
    if (!preMetaChunks.has(fileId)) preMetaChunks.set(fileId, []);
    preMetaChunks.get(fileId).push(data);
    return;
  }
  await applyBinaryChunk(data);
}

async function applyBinaryChunk(ab) {
  const dv = new DataView(ab);
  const fileId = dv.getUint32(0);
  const chunkIndex = dv.getUint32(4);
  const st = recvFiles.get(fileId);
  if (!st) return; // meta not yet known; caller should have buffered

  if (chunkIndex < 0 || chunkIndex >= st.totalChunks) {
    log("Invalid chunk index", chunkIndex, "for", st.name);
    return;
  }

  // If we already have this chunk, ignore duplicates
  if (st.have[chunkIndex] === 1) {
    return;
  }

  const payload = new Uint8Array(ab, 8);

  if (st.writer) {
    try {
      await st.writer.write({ type: "write", position: chunkIndex * st.chunkSize, data: payload });
      // Mark unique chunk received only after successful write
      st.have[chunkIndex] = 1;
      st.receivedCount += 1;
    } catch (e) {
      log("Writer error; falling back to memory:", e);
      st.writer = null;
      st.chunks[chunkIndex] = payload;
      st.have[chunkIndex] = 1;
      st.receivedCount += 1;
    }
  } else {
    // In-memory mode
    st.chunks[chunkIndex] = payload;
    st.have[chunkIndex] = 1;
    st.receivedCount += 1;
  }

  st.receivedBytes += payload.byteLength;

  const pct = Math.max(0, Math.min(100, Math.floor((st.receivedBytes / st.size) * 100)));
  recvProgress.style.width = `${pct}%`;
  recvStatus.textContent = `Receiving ${st.name}: ${pct}% (${formatBytes(st.receivedBytes)} / ${formatBytes(st.size)})`;

  if (st.receivedCount === st.totalChunks) {
    await finalizeFile(st);
  }
}

async function finalizeFile(st) {
  if (st._finalized) return;
  st._finalized = true;

  // If not using writer, assemble Blob and create download link
  if (st.writer) {
    try { await st.writer.close(); } catch {}
    // Safety: ensure we ACK the known total size (prevents 0-bytes ACK edge cases)
    st.receivedBytes = st.size;

    recvStatus.textContent = `Saved ${st.name} to disk`;
    const note = document.createElement("div");
    note.textContent = `Saved ${st.name}`;
    downloads.appendChild(note);
    log("Receiver: closed writer, bytes (assumed) =", st.receivedBytes);
  } else {
    // Verify all parts present and assemble
    const parts = new Array(st.totalChunks);
    let total = 0;
    for (let i = 0; i < st.totalChunks; i++) {
      const part = st.chunks[i];
      if (!part) {
        log("Missing chunk", i, "for", st.name);
        recvStatus.textContent = `Missing chunk ${i} for ${st.name}`;
        st._finalized = false; // allow finalize retry if late chunk arrives
        return; // No ACK if incomplete
      }
      parts[i] = part;
      total += part.byteLength;
    }
    const blob = new Blob(parts, { type: st.type || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = st.name;
    a.className = "dl";
    a.textContent = `Download ${st.name} (${formatBytes(blob.size)})`;
    downloads.appendChild(a);
    recvStatus.textContent = `Received ${st.name}`;
    st.receivedBytes = total;
    log("Receiver: assembled blob, bytes =", st.receivedBytes);
  }

  // Send ACK with bytes received
  if (ctrl && ctrl.open) {
    try {
      const ack = { kind: "file-ack", fileId: st.fileId, receivedBytes: st.receivedBytes };
      await safeSend(ctrl.dc, JSON.stringify(ack));
      log("Receiver: sent ACK", ack);
    } catch (e) {
      log("Receiver: failed to send ACK", e);
    }
  } else {
    log("Receiver: ctrl not open; cannot send ACK");
  }
  recvFiles.delete(st.fileId);
  log("File received:", st.name);
}

function teardownPeer(reason) {
  try { pc?.close(); } catch {}
  pc = null;
  for (const c of channels) {
    try { c.dc.close(); } catch {}
  }
  channels = [];
  ctrl = null;
  btnIamSender.disabled = joined ? false : true;
  btnIamReceiver.disabled = joined ? false : true;
  // Unlock settings on teardown so user can adjust and try again
  if (numChannelsInput) numChannelsInput.disabled = false;
  if (chunkSizeKBInput) chunkSizeKBInput.disabled = false;

  log("Tore down peer:", reason);
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do { n = n / 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(1)} ${units[i]}`;
}

function clampInt(n, min, max) {
  n = Number.isFinite(n) ? Math.floor(n) : min;
  if (n < min) n = min;
  if (n > max) n = max;
  return n;
}

/* =======================
   QR feature (non-breaking)
   ======================= */
(function qrFeature() {
  function isValidCode(v) { return /^\d{6}$/.test(v || ""); }
  function shareUrlFor(code) { return `${location.origin}/?code=${code}&join=1&role=receiver`; }

  function setDisabled(el, state) {
    if (!el) return;
    el.disabled = !!state;
    if (state) el.setAttribute("disabled", "");
    else el.removeAttribute("disabled");
  }

  function renderQR(text) {
    if (!qrCodeEl) return;
    qrCodeEl.innerHTML = "";
    if (window.QRCode) {
      new QRCode(qrCodeEl, {
        text,
        width: 144,
        height: 144,
        colorDark: "#e2e8f0",
        colorLight: "#0b1224",
        correctLevel: QRCode.CorrectLevel.M,
      });
    } else {
      const p = document.createElement("p");
      p.textContent = text;
      qrCodeEl.appendChild(p);
    }
  }

  function updateFromCode() {
    const code = (codeInput?.value || "").trim();
    const valid = isValidCode(code);

    setDisabled(btnShowQR, !valid);
    setDisabled(btnCopyLink, !valid);

    if (!valid) {
      if (qrPanel) qrPanel.hidden = true;
      if (qrCodeEl) qrCodeEl.innerHTML = "";
      if (shareLinkEl) {
        shareLinkEl.textContent = "";
        shareLinkEl.removeAttribute("href");
      }
      return;
    }
    const url = shareUrlFor(code);
    if (shareLinkEl) {
      shareLinkEl.textContent = url;
      shareLinkEl.href = url;
    }
  }

  // Expose so the main "Create session code" handler can call it after setting value
  window.qrUpdateShareUIFromCode = updateFromCode;

  codeInput?.addEventListener("input", updateFromCode);

  btnShowQR?.addEventListener("click", () => {
    const code = (codeInput?.value || "").trim();
    if (!isValidCode(code)) return;
    renderQR(shareUrlFor(code));
    if (qrPanel) qrPanel.hidden = false;
  });

  btnCopyLink?.addEventListener("click", async () => {
    const code = (codeInput?.value || "").trim();
    if (!isValidCode(code)) return;
    const url = shareUrlFor(code);
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = url;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {}
    }
  });

  // Auto-join support via URL params
  (function initFromURL() {
    const params = new URLSearchParams(location.search);
    const code = params.get("code");
    const join = params.get("join");
    const role = params.get("role"); // "receiver" or "sender"

    if (code && isValidCode(code) && codeInput) {
      codeInput.value = code;
      updateFromCode();
    }
    if (join) {
      setTimeout(() => {
        btnJoin?.click();
        if (role === "receiver") {
          setTimeout(() => document.getElementById("btnIamReceiver")?.click(), 300);
        } else if (role === "sender") {
          setTimeout(() => document.getElementById("btnIamSender")?.click(), 300);
        }
      }, 50);
    }
  })();

  // Run once on load in case a code is already present
  updateFromCode();
})();