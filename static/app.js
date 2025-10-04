const logEl = document.getElementById("log");
function log(...args) {
  const line = args.map(a => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
  console.debug(...args);
  if (logEl) {
    logEl.textContent += line + "\n";
    logEl.scrollTop = logEl.scrollHeight;
  }
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
const dirInput = document.getElementById("dirInput");
const btnPickFiles = document.getElementById("btnPickFiles");
const btnPickFolders = document.getElementById("btnPickFolders");

const btnSend = document.getElementById("btnSend");
const btnResetSender = document.getElementById("btnResetSender");
const sendProgress = document.getElementById("sendProgress");
const sendStatus = document.getElementById("sendStatus");
const sendDetails = document.getElementById("sendDetails");

const dropZone = document.getElementById("dropZone");

const recvProgress = document.getElementById("recvProgress");
const recvStatus = document.getElementById("recvStatus");
const recvDetails = document.getElementById("recvDetails");
const downloads = document.getElementById("downloads");
const conflictModeSel = document.getElementById("conflictMode");
const btnClearDownloads = document.getElementById("btnClearDownloads");
const btnDownloadAll = document.getElementById("btnDownloadAll");

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

// Keep-alive over ctrl channel
const KEEPALIVE_MS = 15000;
const KEEPALIVE_DEAD_MS = 45000;
let keepAliveTimer = null;
let lastPong = 0;

// Sender state
let nextFileId = 1;
const awaitingAcks = new Map(); // fileId -> {resolve,reject,timeout}
const outgoing = new Map(); // fileId -> { file, chunkSize, totalChunks }

// Receiver state
// fileId -> {
//   name, size, type, chunkSize, totalChunks,
//   receivedCount, receivedBytes,
//   chunks[], have: Uint8Array, writer, _finalized,
//   sha256, hashAlg, verified, _speedo
// }
const recvFiles = new Map();
// Binary chunks before metadata
const preMetaChunks = new Map(); // fileId -> Array<ArrayBuffer>

// Collect in-memory received files for bulk download
const receivedMemFiles = []; // { name, blob, type }

// Speed tracker
function Speedo(windowMs = 1500) {
  let bytes = 0;
  let start = performance.now();
  return {
    add(n) { bytes += n; },
    rate() {
      const dt = performance.now() - start;
      if (dt <= 0) return 0;
      const r = bytes / (dt / 1000);
      if (dt > windowMs) { bytes = 0; start = performance.now(); }
      return r;
    }
  };
}

const rtcConfig = {
  iceServers: [
    { urls: ["stun:stun.l.google.com:19302", "stun:global.stun.twilio.com:3478"] },
  ],
};

// UI actions
btnNewCode?.addEventListener("click", async () => {
  try {
    const res = await fetch("/api/new-code");
    const { code } = await res.json();
    if (codeInput) codeInput.value = code;
    if (sessionInfo) sessionInfo.textContent = `Session code: ${code} (share with peer)`;
    log("New code generated:", code);

    window.qrUpdateShareUIFromCode?.();
  } catch (e) {
    log("Failed to get new code", e);
  }
});

btnJoin?.addEventListener("click", async () => {
  const code = (codeInput?.value || "").trim();
  if (!/^\d{6}$/.test(code)) {
    alert("Enter a 6-digit code");
    return;
  }
  await joinSession(code);
});

btnIamSender?.addEventListener("click", async () => {
  if (!joined) return;
  isSender = true;
  if (senderPanel) senderPanel.hidden = false;
  if (receiverPanel) receiverPanel.hidden = true;
  btnIamSender.disabled = true;
  btnIamReceiver.disabled = true;
  if (numChannelsInput) numChannelsInput.disabled = true;
  if (chunkSizeKBInput) chunkSizeKBInput.disabled = true;

  wsSend({ type: "role", role: "sender" });
  await setupPeerConnection();
  await startSenderOffer();
});

btnIamReceiver?.addEventListener("click", async () => {
  if (!joined) return;
  isSender = false;
  if (senderPanel) senderPanel.hidden = true;
  if (receiverPanel) receiverPanel.hidden = false;
  btnIamSender.disabled = true;
  btnIamReceiver.disabled = true;
  if (numChannelsInput) numChannelsInput.disabled = true;
  if (chunkSizeKBInput) chunkSizeKBInput.disabled = true;

  wsSend({ type: "role", role: "receiver" });
  await setupPeerConnection();
  log("Receiver: waiting for offer...");
  await processPendingSignals();
});

// Drag-and-drop support
if (dropZone) {
  const onOver = (e) => { e.preventDefault(); dropZone.classList.add("dragover"); };
  const onLeave = () => { dropZone.classList.remove("dragover"); };
  const onDrop = (e) => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
    const items = e.dataTransfer?.items;
    if (items && items.length) {
      readDataTransferItems(items).then((files) => {
        const dt = new DataTransfer();
        files.forEach((f) => dt.items.add(f));
        if (fileInput) fileInput.files = dt.files;
        updateSendEnabled();
      }).catch((err) => log("Drop read error:", err));
    } else {
      const files = e.dataTransfer?.files || [];
      const dt = new DataTransfer();
      [...files].forEach((f) => dt.items.add(f));
      if (fileInput) fileInput.files = dt.files;
      updateSendEnabled();
    }
  };
  dropZone.addEventListener("dragover", onOver);
  dropZone.addEventListener("dragleave", onLeave);
  dropZone.addEventListener("drop", onDrop);
}

// Picker buttons
btnPickFiles?.addEventListener("click", () => fileInput?.click());
btnPickFolders?.addEventListener("click", () => dirInput?.click());

// Merge folder files into main file input
dirInput?.addEventListener("change", () => {
  if (!dirInput.files) return;
  mergeSelectedFiles([...dirInput.files]);
});

function mergeSelectedFiles(newFiles) {
  try {
    const dt = new DataTransfer();
    if (fileInput?.files?.length) {
      [...fileInput.files].forEach(f => dt.items.add(f));
    }
    newFiles.forEach(f => dt.items.add(f));
    if (fileInput) fileInput.files = dt.files;
  } catch {
    const dt = new DataTransfer();
    newFiles.forEach(f => dt.items.add(f));
    if (fileInput) fileInput.files = dt.files;
  }
  updateSendEnabled();
}

function updateSendEnabled() {
  if (!btnSend) return;
  btnSend.disabled = !(channels.some(c => c.open && c.type === "data") && fileInput?.files?.length > 0);
}

// Read dropped items (including directories via webkit entries)
async function readDataTransferItems(items) {
  const files = [];
  const readers = [];
  for (const it of items) {
    if (it.kind === "file") {
      const entry = it.webkitGetAsEntry?.();
      if (entry && entry.isDirectory) {
        readers.push(readDirectoryEntry(entry, ""));
      } else {
        const file = it.getAsFile?.();
        if (file) files.push(file);
      }
    }
  }
  const nested = await Promise.all(readers);
  nested.forEach(arr => arr.forEach(f => files.push(f)));
  return files;
}
function readDirectoryEntry(dirEntry, path) {
  return new Promise((resolve, reject) => {
    const reader = dirEntry.createReader();
    const out = [];
    const readBatch = () => {
      reader.readEntries(async (entries) => {
        if (!entries.length) { resolve(out); return; }
        for (const entry of entries) {
          if (entry.isDirectory) {
            const nested = await readDirectoryEntry(entry, path + entry.name + "/");
            nested.forEach(f => out.push(f));
          } else if (entry.isFile) {
            entry.file((file) => {
              Object.defineProperty(file, "webkitRelativePath", { value: path + entry.name });
              out.push(file);
            }, reject);
          }
        }
        readBatch();
      }, reject);
    };
    readBatch();
  });
}

// Clear downloads
btnClearDownloads?.addEventListener("click", () => {
  if (downloads) downloads.innerHTML = "";
  if (recvDetails) recvDetails.innerHTML = "";
  receivedMemFiles.length = 0;
  updateDownloadAllState();
});

// Download all (sequential individual downloads, no ZIP)
btnDownloadAll?.addEventListener("click", async () => {
  if (!receivedMemFiles.length) return;
  for (const f of receivedMemFiles) {
    await triggerDownload(f.name, f.blob);
    await sleep(150);
  }
});

async function triggerDownload(name, blob) {
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (e) {
    log("Download failed:", name, e?.message || e);
  }
}

function updateDownloadAllState() {
  toggleDisabled(btnDownloadAll, receivedMemFiles.length === 0);
}

// Reset sender UI
btnResetSender?.addEventListener("click", () => {
  if (fileInput) fileInput.value = "";
  updateSendEnabled();
  if (sendProgress) sendProgress.style.width = "0%";
  if (sendStatus) sendStatus.textContent = "";
  if (sendDetails) sendDetails.innerHTML = "";
});

async function joinSession(code) {
  if (joined) return;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws/${code}`);
  ws.onopen = () => {
    joined = true;
    if (sessionInfo) sessionInfo.textContent = `Joined session ${code}. Choose your role.`;
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
      // Do NOT tear down the WebRTC session if signaling peer disconnects
      // The P2P connection can remain active without signaling.
      log("Peer disconnected from signaling. P2P connection remains.");
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
    // Do NOT tear down the peer on signaling close; keep P2P alive for more transfers
    log("WebSocket signaling closed; keeping P2P session alive.");
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
    if (["disconnected", "failed", "closed"].includes(pc.connectionState)) {
      teardownPeer(`PC state: ${pc.connectionState}`);
    }
  };

  if (isSender) {
    const ctrlDc = pc.createDataChannel("ctrl", { ordered: true });
    attachChannel(ctrlDc, "ctrl", "ctrl");

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
    if (type === "ctrl") startKeepAlive();
    updateSendEnabled();
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

// Keep-alive helpers
function startKeepAlive() {
  stopKeepAlive();
  lastPong = Date.now();
  keepAliveTimer = setInterval(async () => {
    if (!ctrl || !ctrl.open) return;
    try {
      await safeSend(ctrl.dc, JSON.stringify({ kind: "ping", t: Date.now() }));
    } catch {}
    const age = Date.now() - lastPong;
    if (age > KEEPALIVE_DEAD_MS) {
      log("Keep-alive: no pong for", Math.round(age / 1000), "s");
    }
  }, KEEPALIVE_MS);
}
function stopKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
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

fileInput?.addEventListener("change", updateSendEnabled);

btnSend?.addEventListener("click", async () => {
  if (!isSender) return;
  const dataChans = channels.filter(c => c.open && c.type === "data");
  if (dataChans.length === 0) { alert("No data channels open yet"); return; }
  const files = [...(fileInput?.files || [])];
  if (!files.length) { alert("Choose files first"); return; }

  btnSend.disabled = true;
  if (sendDetails) sendDetails.innerHTML = "";
  const totalBytes = files.reduce((s,f)=>s+f.size,0);
  let sentBytesAll = 0;
  const speedo = Speedo();

  try {
    for (const file of files) {
      const start = performance.now();

      // Optional SHA-256 (<=100MB)
      let sha256hex = null;
      if (file.size <= 100 * 1024 * 1024 && crypto?.subtle) {
        if (sendStatus) sendStatus.textContent = `Hashing ${file.name}...`;
        const buf = await file.arrayBuffer();
        const hash = await crypto.subtle.digest("SHA-256", buf);
        sha256hex = hex(new Uint8Array(hash));
      }

      await sendFileStriped(file, dataChans, sha256hex, (delta) => {
        sentBytesAll += delta;
        speedo.add(delta);
        const rate = speedo.rate();
        const pct = Math.floor((sentBytesAll / totalBytes) * 100);
        const eta = rate > 0 ? (totalBytes - sentBytesAll) / rate : 0;
        if (sendProgress) sendProgress.style.width = `${pct}%`;
        if (sendStatus) sendStatus.textContent = `Overall: ${pct}% • ${formatBytes(sentBytesAll)} / ${formatBytes(totalBytes)} • ${formatBytes(rate)}/s • ETA ${fmtEta(eta)}`;
      });

      const secs = ((performance.now() - start)/1000).toFixed(2);
      appendDetail(sendDetails, `Sent "${file.name}" (${formatBytes(file.size)}) in ${secs}s${sha256hex?` • SHA-256 ${sha256hex.slice(0,8)}…`:''}`);
    }
    if (sendStatus) sendStatus.textContent += " • All files sent and acknowledged.";
  } catch (e) {
    log("Send error:", e?.message || e);
    if (sendStatus) sendStatus.textContent = `Error: ${e?.message || e}`;
  } finally {
    btnSend.disabled = false;
  }
});

function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }
function hex(u8) { return [...u8].map(b=>b.toString(16).padStart(2,"0")).join(""); }
function fmtEta(sec) {
  if (!isFinite(sec)) return "—";
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s/60), r = s%60;
  if (m>0) return `${m}m ${r}s`;
  return `${r}s`;
}

// Sender: striped transfer with NACK repair
async function sendFileStriped(file, dataChans, sha256hex, onProgressDelta) {
  const fileId = nextFileId++;
  const chunkSize = clampInt(USER_CHUNK_SIZE_KIB, 16, 1024) * 1024;
  const totalChunks = Math.ceil(file.size / chunkSize) || 1;

  outgoing.set(fileId, { file, chunkSize, totalChunks });

  const meta = {
    kind: "file-meta",
    fileId, name: file.name, size: file.size,
    type: file.type || "application/octet-stream",
    chunkSize, totalChunks,
    sha256: sha256hex || null,
    hashAlg: sha256hex ? "SHA-256" : "none"
  };

  while (!ctrl || !ctrl.open) await sleep(10);
  await safeSend(ctrl.dc, JSON.stringify(meta));

  const stack = [];
  for (let i = totalChunks - 1; i >= 0; i--) stack.push(i);

  let sentBytes = 0;

  function makeHeader(fid, idx) {
    const buf = new ArrayBuffer(8);
    const dv = new DataView(buf);
    dv.setUint32(0, fid);
    dv.setUint32(4, idx);
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
      } catch {
        stack.push(idx);
        if (dc.readyState !== "open") return;
        await sleep(10);
        continue;
      }

      const delta = (end - start);
      sentBytes += delta;
      onProgressDelta?.(delta);
    }
  }

  const workers = dataChans.map(c => worker(c));
  await Promise.all(workers);
  await Promise.all(dataChans.map(c => waitForBufferedAmountLow(c.dc)));

  const ack = await waitForAckOrRepair(fileId);

  if (!ack || ack.fileId !== fileId) throw new Error("Invalid ACK");
  if (ack.receivedBytes !== file.size) {
    throw new Error(`Receiver reported ${formatBytes(ack.receivedBytes)} of ${formatBytes(file.size)}`);
  }

  outgoing.delete(fileId);
  log("File sent and acknowledged:", file.name);
}

function waitForAckOrRepair(fileId) {
  return new Promise((resolve, reject) => {
    const waiter = {
      resolve: (info) => { clearTimeout(waiter.timeout); resolve(info); },
      reject,
      timeout: setTimeout(() => reject(new Error("Receiver did not acknowledge file completion in time")), 300000)
    };
    awaitingAcks.set(fileId, waiter);
  });
}

// Receiver: control messages
async function onCtrlMessage(ev) {
  const data = ev.data;
  if (typeof data !== "string") return;
  try {
    const msg = JSON.parse(data);

    // Keep-alive respond/update
    if (msg.kind === "ping") {
      if (ctrl && ctrl.open) {
        try { await safeSend(ctrl.dc, JSON.stringify({ kind: "pong", t: msg.t })); } catch {}
      }
      return;
    }
    if (msg.kind === "pong") {
      lastPong = Date.now();
      return;
    }

    if (msg.kind === "file-meta") {
      const { fileId, name, size, type, chunkSize, totalChunks, sha256, hashAlg } = msg;
      const state = {
        fileId, name, size, type,
        chunkSize, totalChunks,
        receivedCount: 0,
        receivedBytes: 0,
        chunks: new Array(totalChunks).fill(null),
        have: new Uint8Array(totalChunks),
        writer: null,
        _finalized: false,
        sha256: sha256 || null,
        hashAlg: hashAlg || "none",
        verified: null
      };

      if ("showSaveFilePicker" in window) {
        try {
          const suggestion = uniqueName(name, conflictModeSel?.value || "auto-rename");
          const handle = await window.showSaveFilePicker({
            suggestedName: suggestion,
            types: [{ description: "All files", accept: { "*/*": [".*"] } }],
          });
          state.writer = await handle.createWritable();
          try { await state.writer.truncate(size); } catch {}
          log(`Receiver: writing ${name} directly to disk as ${suggestion}`);
        } catch {
          state.writer = null;
        }
      }

      recvFiles.set(fileId, state);
      if (recvStatus) recvStatus.textContent = `Receiving ${name} (${formatBytes(size)})...`;
      if (recvDetails) recvDetails.innerHTML = "";
      log("Receiving metadata:", { fileId, name, size, chunkSize, totalChunks, sha256, hashAlg });

      const pending = preMetaChunks.get(fileId);
      if (pending && pending.length) {
        for (const ab of pending) await applyBinaryChunk(ab);
        preMetaChunks.delete(fileId);
      }
    }
  } catch {
    // ignore parse errors
  }
}

// Sender listens for ACKs, NACKs, and keep-alive
function onCtrlMessageSenderSide(ev) {
  const data = ev.data;
  if (typeof data !== "string") return;
  try {
    const msg = JSON.parse(data);

    if (msg.kind === "ping") {
      if (ctrl && ctrl.open) {
        safeSend(ctrl.dc, JSON.stringify({ kind: "pong", t: msg.t })).catch(()=>{});
      }
      return;
    }
    if (msg.kind === "pong") {
      lastPong = Date.now();
      return;
    }

    if (msg.kind === "file-ack") {
      const waiter = awaitingAcks.get(msg.fileId);
      if (waiter) {
        awaitingAcks.delete(msg.fileId);
        waiter.resolve({ fileId: msg.fileId, receivedBytes: msg.receivedBytes });
      }
      return;
    }

    if (msg.kind === "nack") {
      const { fileId, missing } = msg;
      const waiter = awaitingAcks.get(fileId);
      if (!waiter) return;
      const info = outgoing.get(fileId);
      if (!info) return;

      const { file, chunkSize } = info;
      const dataChans = channels.filter(c => c.open && c.type === "data");
      if (dataChans.length === 0) return;

      const makeHeader = (fid, idx) => {
        const buf = new ArrayBuffer(8);
        const dv = new DataView(buf);
        dv.setUint32(0, fid);
        dv.setUint32(4, idx);
        return buf;
      };

      (async () => {
        let ci = 0;
        for (const idx of missing) {
          const start = idx * chunkSize;
          const end = Math.min(file.size, start + chunkSize);
          const slice = file.slice(start, end);
          const frame = new Blob([makeHeader(fileId, idx), slice]);
          const dc = dataChans[ci % dataChans.length].dc;
          await safeSend(dc, frame);
          ci++;
        }
        await Promise.all(dataChans.map(c => waitForBufferedAmountLow(c.dc)));
      })();

      return;
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
  if (!st) return;

  if (chunkIndex < 0 || chunkIndex >= st.totalChunks) {
    log("Invalid chunk index", chunkIndex, "for", st.name);
    return;
  }

  if (st.have[chunkIndex] === 1) {
    return; // duplicate
  }

  const payload = new Uint8Array(ab, 8);

  if (st.writer) {
    try {
      await st.writer.write({ type: "write", position: chunkIndex * st.chunkSize, data: payload });
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
    st.chunks[chunkIndex] = payload;
    st.have[chunkIndex] = 1;
    st.receivedCount += 1;
  }

  st.receivedBytes += payload.byteLength;

  if (!st._speedo) st._speedo = Speedo();
  st._speedo.add(payload.byteLength);
  const rate = st._speedo.rate();
  const pct = Math.max(0, Math.min(100, Math.floor((st.receivedBytes / st.size) * 100)));
  const eta = rate > 0 ? (st.size - st.receivedBytes) / rate : 0;
  if (recvProgress) recvProgress.style.width = `${pct}%`;
  if (recvStatus) recvStatus.textContent = `Receiving ${st.name}: ${pct}% • ${formatBytes(st.receivedBytes)} / ${formatBytes(st.size)} • ${formatBytes(rate)}/s • ETA ${fmtEta(eta)}`;

  if (st.receivedCount === st.totalChunks) {
    await finalizeOrRepair(st);
  }
}

async function finalizeOrRepair(st) {
  const missing = [];
  for (let i = 0; i < st.totalChunks; i++) {
    if (st.have[i] !== 1) missing.push(i);
  }
  if (missing.length) {
    if (ctrl && ctrl.open) {
      const nack = { kind: "nack", fileId: st.fileId, missing };
      await safeSend(ctrl.dc, JSON.stringify(nack));
      appendDetail(recvDetails, `Requested repair for ${missing.length} missing chunk(s).`);
    }
    return;
  }

  await finalizeFile(st);
}

async function finalizeFile(st) {
  if (st._finalized) return;
  st._finalized = true;

  let finalName = uniqueName(st.name, conflictModeSel?.value || "auto-rename");

  if (st.writer) {
    try { await st.writer.close(); } catch {}
    if (st.sha256) {
      st.verified = "unknown"; // cannot verify easily after writing
      appendDetail(recvDetails, `Hash verification skipped (writer mode) for ${finalName}`);
    }
    if (recvStatus) recvStatus.textContent = `Saved ${finalName} to disk`;
    const note = document.createElement("div");
    note.textContent = `Saved ${finalName}`;
    downloads?.appendChild(note);
  } else {
    // Assemble Blob and store for bulk download (no individual buttons)
    const parts = new Array(st.totalChunks);
    let total = 0;
    for (let i = 0; i < st.totalChunks; i++) {
      const part = st.chunks[i];
      if (!part) {
        log("Missing chunk", i, "for", st.name);
        if (recvStatus) recvStatus.textContent = `Missing chunk ${i} for ${st.name}`;
        st._finalized = false;
        return;
      }
      parts[i] = part;
      total += part.byteLength;
    }
    const blob = new Blob(parts, { type: st.type || "application/octet-stream" });

    if (st.sha256 && crypto?.subtle) {
      try {
        const buf = await blob.arrayBuffer();
        const hash = await crypto.subtle.digest("SHA-256", buf);
        const digest = hex(new Uint8Array(hash));
        st.verified = (digest === st.sha256);
        appendDetail(recvDetails, `Hash verification for ${finalName}: ${st.verified ? "OK" : "MISMATCH"} (${digest.slice(0,8)}… vs ${st.sha256.slice(0,8)}…)`);
      } catch (e) {
        st.verified = "unknown";
        appendDetail(recvDetails, `Hash verification failed for ${finalName}: ${e?.message || e}`);
      }
    }

    const li = document.createElement("div");
    li.textContent = `${finalName} (${formatBytes(blob.size)})${st.verified===true?" • verified": st.verified===false?" • hash mismatch":""}`;
    downloads?.appendChild(li);

    receivedMemFiles.push({ name: finalName, blob, type: st.type || "application/octet-stream" });
    updateDownloadAllState();

    if (recvStatus) recvStatus.textContent = `Received ${finalName}`;
    st.receivedBytes = total;
  }

  // Send ACK
  if (ctrl && ctrl.open) {
    try {
      const ack = { kind: "file-ack", fileId: st.fileId, receivedBytes: st.size };
      await safeSend(ctrl.dc, JSON.stringify(ack));
      appendDetail(recvDetails, `ACK sent for ${st.name}`);
    } catch (e) {
      appendDetail(recvDetails, `Failed to send ACK: ${e?.message || e}`);
    }
  } else {
    appendDetail(recvDetails, `ctrl not open; cannot send ACK`);
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
  stopKeepAlive();
  btnIamSender.disabled = joined ? false : true;
  btnIamReceiver.disabled = joined ? false : true;
  if (numChannelsInput) numChannelsInput.disabled = false;
  if (chunkSizeKBInput) chunkSizeKBInput.disabled = false;

  log("Tore down peer:", reason);
}

function formatBytes(n) {
  if (!isFinite(n)) return "—";
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
function appendDetail(ul, text) {
  if (!ul) return;
  const li = document.createElement("li");
  li.textContent = text;
  ul.appendChild(li);
}
function toggleDisabled(el, state) {
  if (!el) return;
  el.disabled = !!state;
  if (state) el.setAttribute("disabled", "");
  else el.removeAttribute("disabled");
}

// Filename conflict handling
const seenNames = new Map(); // name -> count
function uniqueName(name, mode) {
  if (mode === "overwrite") return name;
  if (mode === "skip") {
    if (!seenNames.has(name)) { seenNames.set(name, 1); return name; }
    return `${name}.skipped`;
  }
  // auto-rename: name (n).ext
  const { base, ext } = splitExt(name);
  let key = name;
  if (!seenNames.has(key)) { seenNames.set(key, 1); return name; }
  let n = seenNames.get(key);
  let candidate;
  do {
    n++;
    candidate = `${base} (${n})${ext}`;
  } while (seenNames.has(candidate));
  seenNames.set(candidate, 1);
  return candidate;
}
function splitExt(name) {
  const i = name.lastIndexOf(".");
  if (i <= 0) return { base: name, ext: "" };
  return { base: name.slice(0, i), ext: name.slice(i) };
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

  updateFromCode();
})();