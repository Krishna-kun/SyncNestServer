const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const os = require('os');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode')
const app = express();
const {
  mergeChanges,
  getChangesSince,
  mergeVersions,
  getVersionsSince
} = require('./sync-core');
// CONNECTION POINT: Local port configuration (Default: 3000, Host: '0.0.0.0', Accessible at http://192.168.1.9:3000)
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
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
  records: {},
  versions: {},
  versionSeqCounter: 0
};

const deviceLastSeen = {};
const activeDevices = new Set();
let recentEvents = [
  {
    timestamp: new Date().toISOString(),
    deviceId: 'Laptop-PC',
    type: 'SYS',
    message: 'Local mesh initialized on port 3000'
  },
  {
    timestamp: new Date().toISOString(),
    deviceId: 'Laptop-PC',
    type: 'OK',
    message: 'Deterministic LWW merge engine ready'
  }
];

// Load existing master.json on startup
if (fs.existsSync(DB_FILE)) {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    master = {
      seqCounter: Number(parsed.seqCounter || 0),
      records: parsed.records || {},
      versions: parsed.versions || {},
      versionSeqCounter: Number(parsed.versionSeqCounter || 0)
    };
    if (master.records) {
      for (const rec of Object.values(master.records)) {
        if (rec && rec.deviceId) {
          activeDevices.add(rec.deviceId);
          if (rec.updatedAt) {
            deviceLastSeen[rec.deviceId] = Math.max(
              deviceLastSeen[rec.deviceId] || 0,
              Number(rec.updatedAt)
            );
          }
        }
      }
    }
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
  syncQueue = run.catch(() => { });
  return run;
}

// ---------------- API ENDPOINTS ----------------

// Hub network info (used by dashboard & QR display)
app.get('/hub-info', async (req, res) => {
  const ip = getLocalIp();
  const qrPayload = JSON.stringify({ app: 'syncnest', ip, port: PORT });
  let qrDataUrl = '';
  try {
    qrDataUrl = await QRCode.toDataURL(qrPayload, { width: 280, margin: 2 });
  } catch (err) {
    console.error('Error generating QR for hub-info:', err.message);
  }
  res.json({
    ip,
    port: PORT,
    url: `http://${ip}:${PORT}`,
    qrDataUrl,
    qrPayload
  });
});


// High-contrast QR connect page (matches Keshav's exact SyncNest QR contract)
app.get('/qr', async (req, res) => {
  const ip = getLocalIp();
  const qrPayload = JSON.stringify({ app: 'syncnest', ip, port: PORT });
  const qrImg = await QRCode.toDataURL(qrPayload, { width: 280, margin: 2 });

  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>SyncNest Hub QR</title>
        <style>
          body { font-family: system-ui, sans-serif; background: #0f172a; color: #f8fafc; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
          .card { background: #1e293b; padding: 28px; border-radius: 16px; text-align: center; border: 1px solid #334155; }
          img { background: #ffffff; padding: 14px; border-radius: 12px; display: block; margin: 0 auto 16px; }
          code { color: #4fd1c5; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>Scan to Connect to SyncNest Hub</h2>
          <img src="${qrImg}" alt="SyncNest Hub QR" />
          <code>${qrPayload}</code>
        </div>
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
    deviceLastSeen,
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

app.get('/versions', (req, res) => {
  res.json(Object.values(master.versions || {}));
});

// Sync endpoint called by Keshav's React Native app
app.post('/sync', async (req, res) => {
  try {
    const { deviceId, lastSeq = 0, changes = [], versions = [], lastVersionSeq = 0 } = req.body || {};

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
      deviceLastSeen[deviceId] = Date.now();

      const { updatedMasterMap, newSeqCounter } = mergeChanges(
        master.records,
        changes,
        master.seqCounter
      );

      master.records = updatedMasterMap;
      master.seqCounter = newSeqCounter;
      const incomingVersions = Array.isArray(versions) ? versions : [];
      const { updatedVersionMap, newVersionSeqCounter } = mergeVersions(
        master.versions || {},
        incomingVersions,
        master.versionSeqCounter || 0
      );
      master.versions = updatedVersionMap;
      master.versionSeqCounter = newVersionSeqCounter;
      saveMaster();

      const outboundChanges = getChangesSince(master.records, Number(lastSeq));
      
      const outboundVersions = getVersionsSince(
        master.versions,
        Number(lastVersionSeq)
      );

      if (changes.length > 0 || outboundChanges.length > 0 || incomingVersions.length > 0 || outboundVersions.length > 0) {
        const eventType = changes.length > 0 ? 'SYNC' : (incomingVersions.length > 0 ? 'VER' : 'SYNC');
        const event = {
          timestamp: new Date().toISOString(),
          deviceId,
          type: eventType,
          receivedCount: changes.length,
          sentCount: outboundChanges.length,
          versionsCount: incomingVersions.length
        };

        recentEvents.unshift(event);
        recentEvents = recentEvents.slice(0, 30);

        console.log(
          `[SYNC] ${deviceId} | Uploaded: ${changes.length} | Sent back: ${outboundChanges.length} | Seq: ${master.seqCounter}`
        );
      }

      return {
        newSeq: master.seqCounter,
        changes: outboundChanges,
        newVersionSeq: master.versionSeqCounter,
        versions: outboundVersions
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
  qrcode.generate(JSON.stringify({ app: 'syncnest', ip, port: PORT }), { small: true });
});