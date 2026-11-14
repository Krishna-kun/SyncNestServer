const API_BASE = '';
const knownTimestamps = new Map();
const highlightedUntil = new Map();
let lastSeqSeen = null;
let currentPriorityFilter = 'ALL';
let currentSearch = '';
let cachedRecords = [];
let cachedVersions = [];
let cachedStatus = { activeDevices: [], deviceLastSeen: {}, recentEvents: [] };
let cachedDevices = {};
let cachedPresence = [];

function getDeviceName(id) {
  if (!id) return 'Unknown';
  if (id === 'Laptop-PC' || id === 'HUB') return 'Laptop-PC (HUB)';
  return cachedDevices[id]?.deviceName || id;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatRelativeTime(ts) {
  if (!ts) return '—';
  const num = Number(ts) || new Date(ts).getTime();
  if (isNaN(num) || num <= 0) return '—';
  const diffSec = Math.max(0, Math.floor((Date.now() - num) / 1000));
  if (diffSec < 3) return 'Just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

function formatClock(ts) {
  if (!ts) return '--:--:--';
  const d = new Date(Number(ts) || ts);
  return isNaN(d.getTime()) ? '--:--:--' : d.toLocaleTimeString([], {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function formatDateTime(ts) {
  if (!ts) return '—';
  const d = new Date(Number(ts) || ts);
  return isNaN(d.getTime()) ? '—' : `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour12: false })}`;
}

function showToast(msg) {
  const el = document.getElementById('sync-toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add('hidden'), 3200);
}

function triggerHeartbeatPulse() {
  const svg = document.getElementById('heartbeat-svg');
  if (!svg) return;
  svg.classList.remove('pulsing');
  void svg.offsetWidth;
  svg.classList.add('pulsing');
  setTimeout(() => svg.classList.remove('pulsing'), 1000);
}

function updateKpi(id, newValue) {
  const el = document.getElementById(id);
  if (!el) return;
  const strVal = String(newValue);
  if (el.textContent !== strVal) {
    el.textContent = strVal;
    el.classList.remove('kpi-bump');
    void el.offsetWidth;
    el.classList.add('kpi-bump');
  }
}

// ---------------- CONNECT DEVICE MODAL ----------------
const connectModal = document.getElementById('connect-modal');
let currentHubUrl = '';

document.getElementById('open-connect-btn').addEventListener('click', async () => {
  connectModal.classList.remove('hidden');
  try {
    const res = await fetch(`${API_BASE}/hub-info`);
    const info = await res.json();
    currentHubUrl = info.url || `http://${info.ip}:${info.port}`;
    document.getElementById('modal-hub-url').textContent = currentHubUrl;
    
    const qrImg = document.getElementById('modal-qr-img');
    if (info.qrDataUrl) {
      qrImg.src = info.qrDataUrl;
    } else {
      qrImg.src = `${API_BASE}/qr`;
    }
  } catch (err) {
    document.getElementById('modal-hub-url').textContent = 'Hub connection error';
  }
});

document.getElementById('close-connect-btn').addEventListener('click', () => {
  connectModal.classList.add('hidden');
});

document.getElementById('copy-ip-btn').addEventListener('click', async (e) => {
  if (!currentHubUrl) return;
  try {
    await navigator.clipboard.writeText(currentHubUrl);
    const orig = e.target.textContent;
    e.target.textContent = 'Copied!';
    setTimeout(() => { e.target.textContent = orig; }, 1600);
  } catch {
    e.target.textContent = 'Failed';
  }
});

connectModal.addEventListener('click', (e) => {
  if (e.target === connectModal) connectModal.classList.add('hidden');
});

// ---------------- DEVICE DETAILS MODAL ----------------
const deviceModal = document.getElementById('device-modal');

function openDeviceModal(deviceId) {
  const isHub = deviceId === 'Laptop-PC' || deviceId === 'HUB';
  const roleText = isHub ? 'Hub (Local Master Coordinator)' : 'Field Phone (Offline Mesh Node)';
  const statusText = 'Online · Active';
  
  const lastSeenTs = isHub ? Date.now() : (cachedStatus.deviceLastSeen?.[deviceId] || null);
  const lastSeenFormatted = isHub
    ? 'Realtime (Local Host)'
    : (lastSeenTs ? `${formatRelativeTime(lastSeenTs)} (${formatDateTime(lastSeenTs)})` : 'Never recorded');

  // Count records authored by this device
  const ownedRecords = cachedRecords.filter((r) => r.deviceId === deviceId);

  // Count versions pushed by this device
  const pushedVersions = cachedVersions.filter(
    (v) => v.deviceId === deviceId || (v.id && typeof v.id === 'string' && v.id.includes(deviceId))
  );

  // Recent sync events for this device
  const deviceEvents = (cachedStatus.recentEvents || []).filter(
    (ev) => ev.deviceId === deviceId || (isHub && (ev.deviceId === 'Laptop-PC' || ev.type === 'SYS' || ev.type === 'OK'))
  );

  document.getElementById('devmodal-title').textContent = isHub ? 'Laptop-PC (HUB)' : getDeviceName(deviceId);
  document.getElementById('devmodal-subtitle').textContent = isHub ? 'Central Coordinator Telemetry' : 'Field Worker Telemetry';
  document.getElementById('devmodal-id').textContent = deviceId;
  document.getElementById('devmodal-role').textContent = roleText;
  document.getElementById('devmodal-status').textContent = statusText;
  document.getElementById('devmodal-lastseen').textContent = lastSeenFormatted;
  document.getElementById('devmodal-records').textContent = ownedRecords.length;
  document.getElementById('devmodal-versions').textContent = pushedVersions.length;

  const eventsContainer = document.getElementById('devmodal-events');
  if (deviceEvents.length > 0) {
    eventsContainer.innerHTML = deviceEvents
      .slice(0, 15)
      .map((ev) => {
        const tag = ev.type || (ev.receivedCount > 0 ? 'SYNC' : 'VER');
        const tagClass = tag === 'SYNC' ? 'term-tag-sync' : (tag === 'VER' ? 'term-tag-ver' : 'term-tag-sys');
        const desc = ev.message
          ? escapeHtml(ev.message)
          : `${ev.receivedCount || 0} received · ${ev.sentCount || 0} sent · ${ev.versionsCount || 0} versions`;
        return `
          <div class="dev-event-row">
            <span class="dev-event-time">[${formatClock(ev.timestamp)}]</span>
            <span class="dev-event-tag ${tagClass}">[${tag}]</span>
            <span class="dev-event-desc">${desc}</span>
          </div>
        `;
      })
      .join('');
  } else {
    eventsContainer.innerHTML = `
      <div class="empty-col-state" style="padding: 12px;">
        No sync events recorded during this session
      </div>
    `;
  }

  deviceModal.classList.remove('hidden');
}

document.getElementById('close-device-btn').addEventListener('click', () => {
  deviceModal.classList.add('hidden');
});

deviceModal.addEventListener('click', (e) => {
  if (e.target === deviceModal) deviceModal.classList.add('hidden');
});

// ---------------- VERSION HISTORY MODAL ----------------
const versionModal = document.getElementById('version-modal');

function openVersionModal(recordId) {
  const currentRec = cachedRecords.find((r) => r.id === recordId);
  let parsedCurrent = {};
  try {
    parsedCurrent = JSON.parse(currentRec?.content || '{}');
  } catch {
    parsedCurrent = { title: 'Untitled', body: currentRec?.content || '' };
  }

  // Find snapshots from cachedVersions
  const matchingVersions = cachedVersions.filter(
    (v) =>
      v.recordId === recordId ||
      v.id === recordId ||
      (typeof v.id === 'string' && v.id.startsWith(recordId))
  );

  // Sort versions descending
  matchingVersions.sort((a, b) => (b.seq || 0) - (a.seq || 0) || (b.updatedAt || 0) - (a.updatedAt || 0));

  const totalSnapshots = Math.max(1, matchingVersions.length);
  document.getElementById('vermodal-title').textContent = parsedCurrent.title || 'Record Version History';
  document.getElementById('vermodal-subtitle').textContent = `Deterministic LWW Edit Snapshots for ${recordId}`;
  document.getElementById('vermodal-recid').textContent = recordId;
  document.getElementById('vermodal-count').textContent = `${totalSnapshots} snapshot${totalSnapshots === 1 ? '' : 's'}`;

  const timelineContainer = document.getElementById('vermodal-timeline');

  if (matchingVersions.length > 0) {
    timelineContainer.innerHTML = matchingVersions
      .map((v, idx) => {
        let content = {};
        try {
          content = typeof v.content === 'string' ? JSON.parse(v.content) : (v.content || {});
        } catch {
          content = { title: 'Snapshot', body: String(v.content || '') };
        }

        const vNum = totalSnapshots - idx;
        const isCurrent = idx === 0;
        const author = v.deviceId || currentRec?.deviceId || 'Unknown';
        const timeFormatted = formatDateTime(v.updatedAt || v.createdAt || currentRec?.updatedAt);
        const relTime = formatRelativeTime(v.updatedAt || v.createdAt || currentRec?.updatedAt);

        return `
          <div class="timeline-entry ${isCurrent ? 'is-current' : ''}">
            <div class="timeline-header">
              <div class="timeline-badge-wrap">
                <span class="timeline-vtag">v${vNum}</span>
                <span class="timeline-author">${escapeHtml(author)}</span>
                ${isCurrent ? '<span class="badge-just-updated">Current Master</span>' : ''}
              </div>
              <span class="timeline-time">${relTime} · ${timeFormatted}</span>
            </div>
            <div class="timeline-content-box">
              <strong>${escapeHtml(content.title || 'Untitled')}</strong>
              ${content.body ? `<p style="margin-top: 4px;">${escapeHtml(content.body)}</p>` : ''}
            </div>
            <div class="timeline-diff-meta">
              <span>Status: <strong>${escapeHtml(content.status || 'To do')}</strong></span>
              <span>Priority: <strong>${escapeHtml(content.priority || 'Medium')}</strong></span>
              <span>Location: <strong>${escapeHtml(content.location || 'Unspecified')}</strong></span>
              ${v.seq ? `<span>Seq #${v.seq}</span>` : ''}
            </div>
          </div>
        `;
      })
      .join('');
  } else if (currentRec) {
    const author = currentRec.deviceId || 'Unknown';
    const timeFormatted = formatDateTime(currentRec.updatedAt);
    const relTime = formatRelativeTime(currentRec.updatedAt);

    timelineContainer.innerHTML = `
      <div class="timeline-entry is-current">
        <div class="timeline-header">
          <div class="timeline-badge-wrap">
            <span class="timeline-vtag">v1</span>
            <span class="timeline-author">${escapeHtml(author)}</span>
            <span class="badge-just-updated">Current Master</span>
          </div>
          <span class="timeline-time">${relTime} · ${timeFormatted}</span>
        </div>
        <div class="timeline-content-box">
          <strong>${escapeHtml(parsedCurrent.title || 'Untitled')}</strong>
          ${parsedCurrent.body ? `<p style="margin-top: 4px;">${escapeHtml(parsedCurrent.body)}</p>` : ''}
        </div>
        <div class="timeline-diff-meta">
          <span>Status: <strong>${escapeHtml(parsedCurrent.status || 'To do')}</strong></span>
          <span>Priority: <strong>${escapeHtml(parsedCurrent.priority || 'Medium')}</strong></span>
          <span>Location: <strong>${escapeHtml(parsedCurrent.location || 'Unspecified')}</strong></span>
          ${currentRec.seq ? `<span>Seq #${currentRec.seq}</span>` : ''}
        </div>
      </div>
    `;
  } else {
    timelineContainer.innerHTML = `
      <div class="empty-col-state">No version history available for this record.</div>
    `;
  }

  versionModal.classList.remove('hidden');
}

document.getElementById('close-version-btn').addEventListener('click', () => {
  versionModal.classList.add('hidden');
});

versionModal.addEventListener('click', (e) => {
  if (e.target === versionModal) versionModal.classList.add('hidden');
});

// Escape key closes open modals
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    connectModal.classList.add('hidden');
    deviceModal.classList.add('hidden');
    versionModal.classList.add('hidden');
  }
});

// ---------------- SEARCH & PRIORITY FILTERS ----------------
document.getElementById('search-input').addEventListener('input', (e) => {
  currentSearch = e.target.value.trim().toLowerCase();
  renderKanban(cachedRecords);
});

document.getElementById('priority-filters').addEventListener('click', (e) => {
  const btn = e.target.closest('.filter-pill');
  if (!btn) return;
  document.querySelectorAll('.filter-pill').forEach((p) => p.classList.remove('active'));
  btn.classList.add('active');
  currentPriorityFilter = btn.dataset.priority;
  renderKanban(cachedRecords);
});

// ---------------- RENDER DEVICES LIST ----------------
function renderDevices(activeDevices = [], deviceLastSeen = {}) {
  const listEl = document.getElementById('devices-list');
  const countEl = document.getElementById('device-count');
  
  const totalDevs = 1 + activeDevices.length;
  countEl.textContent = totalDevs;

  const hubHtml = `
    <div class="device-item-card is-hub" data-device-id="Laptop-PC" role="button" tabindex="0">
      <div class="device-info-left">
        <div class="device-signal-wrap">
          <span class="signal-dot-ping"></span>
        </div>
        <div class="device-text-meta">
          <div class="device-id-title">Laptop-PC (HUB)</div>
          <div class="device-sync-time">Hub · Local Master</div>
        </div>
      </div>
      <svg class="device-chevron" viewBox="0 0 20 20" fill="currentColor">
        <path fill-rule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clip-rule="evenodd" />
      </svg>
    </div>
  `;

  const phonesHtml = activeDevices
    .map((id) => {
      const lastSeen = deviceLastSeen[id];
      const timeText = lastSeen ? `Synced ${formatRelativeTime(lastSeen)}` : 'Connected';
      return `
        <div class="device-item-card" data-device-id="${escapeHtml(id)}" role="button" tabindex="0">
          <div class="device-info-left">
            <div class="device-signal-wrap">
              <span class="signal-dot-ping"></span>
            </div>
            <div class="device-text-meta">
              <div class="device-id-title">${escapeHtml(getDeviceName(id))}</div>
              <div class="device-sync-time">${escapeHtml(timeText)}</div>
            </div>
          </div>
          <svg class="device-chevron" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clip-rule="evenodd" />
          </svg>
        </div>
      `;
    })
    .join('');

  listEl.innerHTML = hubHtml + phonesHtml;

  // Add click listeners to every device card
  listEl.querySelectorAll('.device-item-card').forEach((card) => {
    card.addEventListener('click', () => {
      const devId = card.getAttribute('data-device-id');
      if (devId) openDeviceModal(devId);
    });
  });
}

// ---------------- RENDER KANBAN CARDS ----------------
function renderCard(rec) {
  let content = {};
  try {
    content = typeof rec.content === 'string' ? JSON.parse(rec.content) : (rec.content || {});
  } catch {
    content = { title: 'Untitled Record', body: String(rec.content || '') };
  }

  const isHighlighted = (highlightedUntil.get(rec.id) || 0) > Date.now();
  const editors = cachedPresence.filter((p) => p.recordId === rec.id);
  const priority = content.priority || 'Medium';
  // Count versions for this record
  const matchingVersions = cachedVersions.filter(
    (v) =>
      v.recordId === rec.id ||
      v.id === rec.id ||
      (typeof v.id === 'string' && v.id.startsWith(rec.id))
  );
  const versionNum = Math.max(1, matchingVersions.length);

  return `
    <article class="report-card priority-${escapeHtml(priority)} ${isHighlighted ? 'card-updated just-updated' : ''}" data-id="${escapeHtml(rec.id)}">
      <div class="card-top-row">
        <h3 class="card-title-text">${escapeHtml(content.title || 'Untitled Record')}</h3>
        ${editors.length > 0 ? `<span class="badge-editing">✏️ ${escapeHtml(editors.map((e) => e.deviceName || e.deviceId).join(', '))} editing</span>` : ''}
        <div class="card-badges-wrap">
          ${isHighlighted ? '<span class="badge-just-updated">Just updated</span>' : ''}
          <span class="card-priority-pill pill-${escapeHtml(priority)}">${escapeHtml(priority)}</span>
          <button class="version-pill" data-rec-id="${escapeHtml(rec.id)}" type="button" title="View Version Snapshots">
            v${versionNum}
          </button>
        </div>
      </div>
      ${content.body ? `<p class="card-body-text">${escapeHtml(content.body)}</p>` : ''}
      <div class="card-footer-meta">
        <span>📍 ${escapeHtml(content.location || 'Unspecified')}</span>
        <span>${escapeHtml(getDeviceName(rec.deviceId))} · ${formatRelativeTime(rec.updatedAt)}</span>
      </div>
    </article>
  `;
}

function renderKanban(records) {
  const sorted = [...records].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const groups = { 'To do': [], Doing: [], Done: [] };

  for (const rec of sorted) {
    let content = {};
    try {
      content = typeof rec.content === 'string' ? JSON.parse(rec.content) : (rec.content || {});
    } catch {
      content = { title: 'Untitled Record', body: String(rec.content || '') };
    }

    const priority = content.priority || 'Medium';
    if (currentPriorityFilter !== 'ALL' && priority !== currentPriorityFilter) continue;

    if (currentSearch) {
      const haystack = `${content.title || ''} ${content.body || ''} ${content.location || ''} ${rec.deviceId || ''}`.toLowerCase();
      if (!haystack.includes(currentSearch)) continue;
    }

    const workflowStatus =
      content.status === 'Doing' || content.status === 'Done' ? content.status : 'To do';
    groups[workflowStatus].push(rec);
  }

  const columns = [
    { key: 'To do', listId: 'col-todo', countId: 'count-todo' },
    { key: 'Doing', listId: 'col-doing', countId: 'count-doing' },
    { key: 'Done', listId: 'col-done', countId: 'count-done' }
  ];

  for (const col of columns) {
    const items = groups[col.key];
    document.getElementById(col.countId).textContent = items.length;
    const listEl = document.getElementById(col.listId);
    
    listEl.innerHTML =
      items.length > 0
        ? items.map(renderCard).join('')
        : '<div class="empty-col-state">No matching cards</div>';

    // Attach click listeners to version pills
    listEl.querySelectorAll('.version-pill').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const rId = btn.getAttribute('data-rec-id');
        if (rId) openVersionModal(rId);
      });
    });
  }
}

// ---------------- RENDER TERMINAL LOGS ----------------
function renderTerminal(recentEvents = []) {
  const feedEl = document.getElementById('activity-feed');
  if (!feedEl) return;

  if (recentEvents && recentEvents.length > 0) {
    feedEl.innerHTML = recentEvents
      .map((ev) => {
        const timeStr = `[${formatClock(ev.timestamp)}]`;
        const tag = ev.type || (ev.receivedCount > 0 ? 'SYNC' : 'VER');
        
        let tagClass = 'term-tag-sync';
        if (tag === 'VER') tagClass = 'term-tag-ver';
        else if (tag === 'SYS' || tag === 'OK') tagClass = 'term-tag-sys';

        let msg = '';
        if (ev.message) {
          msg = escapeHtml(ev.message);
        } else if (ev.receivedCount > 0) {
          msg = `pushed ${ev.receivedCount} change${ev.receivedCount === 1 ? '' : 's'}${ev.versionsCount > 0 ? ` + ${ev.versionsCount} version snapshot` : ''}`;
        } else {
          msg = `pulled ${ev.sentCount || 0} updates`;
        }

        return `
          <div class="term-row">
            <span class="term-ts">${timeStr}</span>
            <span class="term-tag ${tagClass}">[${escapeHtml(tag)}]</span>
            <span class="term-dev">${escapeHtml(getDeviceName(ev.deviceId))}:</span>
            <span class="term-msg">${msg}</span>
          </div>
        `;
      })
      .join('');
  } else {
    feedEl.innerHTML = `
      <div class="term-row" style="color: #64748b;">
        <span class="term-prompt">$</span> listening on 0.0.0.0:3000 (offline local mesh)...
      </div>
    `;
  }
}

// ---------------- LIVE POLLING LOOP ----------------
async function updateDashboard() {
  try {
    const [statusRes, recordsRes, versionsRes, devicesRes, presenceRes] = await Promise.all([
      fetch(`${API_BASE}/status`),
      fetch(`${API_BASE}/records`),
      fetch(`${API_BASE}/versions`),
      fetch(`${API_BASE}/devices`),
      fetch(`${API_BASE}/presence`)
    ]);

    const status = await statusRes.json();
    const records = await recordsRes.json();
    const versions = await versionsRes.json();
    const devicesList = await devicesRes.json();
    const presenceList = await presenceRes.json();

    cachedRecords = records;
    cachedVersions = Array.isArray(versions) ? versions : Object.values(versions || {});
    cachedStatus = status;
    cachedPresence = Array.isArray(presenceList) ? presenceList : [];

    const devMap = {};
    if (Array.isArray(devicesList)) {
      devicesList.forEach((d) => {
        if (d && d.deviceId) devMap[d.deviceId] = d;
      });
    }
    cachedDevices = devMap;

    // Detect changes to trigger teal border glow
    let hasRecordUpdates = false;
    for (const rec of records) {
      const prevTime = knownTimestamps.get(rec.id);
      if (prevTime !== undefined && prevTime !== rec.updatedAt) {
        highlightedUntil.set(rec.id, Date.now() + 8000);
        hasRecordUpdates = true;
      }
      knownTimestamps.set(rec.id, rec.updatedAt);
    }

    // Trigger toast and heartbeat pulse on sync
    if (lastSeqSeen !== null && (status.seqCounter > lastSeqSeen || hasRecordUpdates)) {
      triggerHeartbeatPulse();
      if (status.recentEvents && status.recentEvents.length > 0) {
        const latest = status.recentEvents[0];
        if (latest.type !== 'SYS' && latest.type !== 'OK') {
          showToast(`🔄 ${getDeviceName(latest.deviceId)} synced (${latest.receivedCount || 0} pushed)`);
        }
      }
    }
    lastSeqSeen = status.seqCounter;

    // 1. KPI: RECORDS
    updateKpi('kpi-records', status.totalRecords ?? records.length);

    // 2. KPI: DEVICES ONLINE
    const activeCount = (status.activeDevices || []).length;
    updateKpi('kpi-devices', 1 + activeCount);
    const devCaption = document.getElementById('kpi-devices-caption');
    if (devCaption) {
      devCaption.textContent = `1 Hub + ${activeCount} Phone${activeCount === 1 ? '' : 's'}`;
    }

    // 3. KPI: LAST SYNC
    let latestSyncTime = null;
    if (status.recentEvents && status.recentEvents.length > 0) {
      const nonSys = status.recentEvents.find((e) => e.type !== 'SYS' && e.type !== 'OK');
      if (nonSys) latestSyncTime = nonSys.timestamp;
    }
    if (!latestSyncTime && status.deviceLastSeen) {
      const timestamps = Object.values(status.deviceLastSeen).filter(Boolean);
      if (timestamps.length > 0) {
        latestSyncTime = Math.max(...timestamps);
      }
    }
    document.getElementById('kpi-last-sync').textContent = latestSyncTime
      ? formatRelativeTime(latestSyncTime)
      : 'Just now';

    // 4. KPI: SERVER SEQ
    updateKpi('kpi-seq', status.seqCounter ?? 0);
    const verCountEl = document.getElementById('kpi-versions-count');
    if (verCountEl) {
      const vTotal = cachedVersions.length;
      verCountEl.textContent = `${vTotal} saved version${vTotal === 1 ? '' : 's'}`;
    }

    // Render 3 Workspace Columns
    renderDevices(status.activeDevices || [], status.deviceLastSeen || {});
    renderKanban(records);
    renderTerminal(status.recentEvents || []);
  } catch (err) {
    console.error('Dashboard poll error:', err);
  }
}

// Initial fetch and 2000ms polling interval
updateDashboard();
setInterval(updateDashboard, 2000);