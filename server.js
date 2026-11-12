const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const os = require('os');
const qrcode = require('qrcode-terminal');
const { mergeChanges, getChangesSince } = require('./sync-core');
const QRCode = require('qrcode')
const app = express();

// CONNECTION POINT: Local port configuration (Default: 3000, Host: '0.0.0.0', Accessible at http://192.168.1.9:3000)
const PORT = 3000;
const HOST = '0.0.0.0';

// CONNECTION POINT: Path to master database file (Default: './master.json')
const DB_FILE = path.join(__dirname, 'master.json');

app.use(cors());
app.use(bodyParser.json());

// CONNECTION POINT: Serve Role 3's live dashboard from './public' folder
app.use(express.static(path.join(__dirname, 'public')));

// Auto-detect PC's local Wi-Fi / Hotspot IPv4 address
function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

// In-memory state loaded from master.json
let master = {
  seqCounter: 0,
  records: {}
};

let recentEvents = [];
const activeDevices = new Set();

// Load existing master.json on startup
if (fs.existsSync(DB_FILE)) {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    master = {
      seqCounter: Number(parsed.seqCounter || 0),
      records: parsed.records || {}
    };
  } catch (err) {
    console.error('Failed to load master.json, starting fresh:', err.message);
  }
}

// Atomic write to prevent file corruption
function saveMaster() {
  const tempFile = `${DB_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(master, null, 2));
  fs.renameSync(tempFile, DB_FILE);
}

// Asynchronous FIFO queue to serialize sync requests one at a time
let syncQueue = Promise.resolve();

function enqueueSync(task) {
  const run = syncQueue.then(task, task);
  syncQueue = run.catch(() => {});
  return run;
}

// ---------------- API ENDPOINTS ----------------

// Hub network info (used by dashboard & QR display)
app.get('/hub-info', (req, res) => {
  const ip = getLocalIp();
  res.json({
    ip,
    port: PORT,
    url: `http://${ip}:${PORT}`
  });
});


// High-contrast QR connect page (testing Keshav's expected QR formats)
app.get('/qr', async (req, res) => {
  const ip = getLocalIp();
  const payloads = [
    { label: '5. JSON {url}', data: JSON.stringify({ url: `http://${ip}:${PORT}` }) },
    { label: '6. JSON {server}', data: JSON.stringify({ server: ip }) },
    { label: '7. JSON {address}', data: JSON.stringify({ address: ip }) },
    { label: '8. SYNCNEST:ip', data: `SYNCNEST:${ip}` }
  ];

  const cards = await Promise.all(
    payloads.map(async (p) => {
      const img = await QRCode.toDataURL(p.data, { width: 220, margin: 2 });
      return `
        <div class="card">
          <img src="${img}" alt="${p.label}" />
          <div><strong>${p.label}</strong></div>
          <code>${p.data}</code>
        </div>
      `;
    })
  );

  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>SyncNest Hub QR Test</title>
        <style>
          body { font-family: system-ui, sans-serif; background: #0f172a; color: #f8fafc; padding: 32px; text-align: center; }
          .row { display: flex; gap: 24px; flex-wrap: wrap; justify-content: center; margin-top: 24px; }
          .card { background: #1e293b; padding: 20px; border-radius: 16px; border: 1px solid #334155; max-width: 260px; }
          img { background: #ffffff; padding: 10px; border-radius: 10px; display: block; margin: 0 auto 12px; }
          code { color: #4fd1c5; font-size: 13px; word-break: break-all; }
        </style>
      </head>
      <body>
        <h1>SyncNest QR Format Test</h1>
        <div class="row">${cards.join('')}</div>
      </body>
    </html>
  `);
});


// Health & dashboard metrics
app.get('/status', (req, res) => {
  const activeRecords = Object.values(master.records).filter(
    (r) => Number(r.deleted) === 0
  );

  res.json({
    status: 'online',
    seqCounter: master.seqCounter,
    totalRecords: activeRecords.length,
    activeDevices: Array.from(activeDevices),
    recentEvents
  });
});

// All non-deleted records for the PC Dashboard
app.get('/records', (req, res) => {
  const activeRecords = Object.values(master.records).filter(
    (r) => Number(r.deleted) === 0
  );
  res.json(activeRecords);
});

// Sync endpoint called by Keshav's React Native app
app.post('/sync', async (req, res) => {
  try {
    const { deviceId, lastSeq = 0, changes = [] } = req.body || {};

    if (
      typeof deviceId !== 'string' ||
      !deviceId.trim() ||
      !Array.isArray(changes) ||
      !Number.isFinite(Number(lastSeq)) ||
      !changes.every(
        (r) =>
          r &&
          typeof r.id === 'string' &&
          typeof r.content === 'string' &&
          Number.isFinite(Number(r.updatedAt)) &&
          typeof r.deviceId === 'string'
      )
    ) {
      return res.status(400).json({ error: 'Invalid sync payload' });
    }

    const result = await enqueueSync(async () => {
      activeDevices.add(deviceId);

      const { updatedMasterMap, newSeqCounter } = mergeChanges(
        master.records,
        changes,
        master.seqCounter
      );

      master.records = updatedMasterMap;
      master.seqCounter = newSeqCounter;

      saveMaster();

      const outboundChanges = getChangesSince(master.records, Number(lastSeq));

      const event = {
        timestamp: new Date().toISOString(),
        deviceId,
        receivedCount: changes.length,
        sentCount: outboundChanges.length
      };

      recentEvents.unshift(event);
      recentEvents = recentEvents.slice(0, 20);

      console.log(
        `[SYNC] ${deviceId} | Uploaded: ${changes.length} | Sent back: ${outboundChanges.length} | Seq: ${master.seqCounter}`
      );

      return {
        newSeq: master.seqCounter,
        changes: outboundChanges
      };
    });

    res.json(result);
  } catch (err) {
    console.error('Sync error:', err);
    res.status(500).json({ error: 'Internal sync error' });
  }
});

// Start PC Hub Server
app.listen(PORT, HOST, () => {
  const ip = getLocalIp();
  console.log('=========================================');
  console.log('SyncNest PC Hub Server is ONLINE');
  console.log(`Local browser:   http://localhost:${PORT}/status`);
  console.log(`Network devices: http://${ip}:${PORT}`);
  console.log('Scan this QR in the SyncNest mobile app:');
  console.log('=========================================');
  qrcode.generate(ip, { small: true });
});