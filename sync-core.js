/**
 * SyncNest Pure Merge Engine (Deterministic LWW + Version History)
 */

function mergeChanges(masterMap, incomingChanges, serverSeqCounter) {
  let seqCounter = serverSeqCounter;

  for (const incoming of incomingChanges) {
    const existing = masterMap[incoming.id];

    const shouldAccept =
      !existing ||
      incoming.updatedAt > existing.updatedAt ||
      (
        incoming.updatedAt === existing.updatedAt &&
        incoming.deviceId > existing.deviceId
      );

    if (shouldAccept) {
      seqCounter += 1;
      masterMap[incoming.id] = {
        id: incoming.id,
        content: incoming.content,
        updatedAt: Number(incoming.updatedAt),
        deleted: Number(incoming.deleted || 0),
        deviceId: incoming.deviceId,
        seq: seqCounter
      };
    }
  }

  return {
    updatedMasterMap: masterMap,
    newSeqCounter: seqCounter
  };
}

function getChangesSince(masterMap, lastSeq) {
  return Object.values(masterMap).filter(
    (record) => record.seq > Number(lastSeq)
  );
}

// Append-only version snapshot merge (never overwrites history)
function mergeVersions(versionMap, incomingVersions, serverVersionSeqCounter) {
  let versionSeqCounter = serverVersionSeqCounter;

  for (const incoming of incomingVersions) {
    if (!incoming || typeof incoming !== 'object') continue;

    const versionKey =
      incoming.id ||
      `${incoming.recordId || 'rec'}_${incoming.updatedAt || incoming.createdAt || Date.now()}_${incoming.deviceId || 'unknown'}`;

    if (!versionMap[versionKey]) {
      versionSeqCounter += 1;
      versionMap[versionKey] = {
        ...incoming,
        id: versionKey,
        seq: versionSeqCounter
      };
    }
  }

  return {
    updatedVersionMap: versionMap,
    newVersionSeqCounter: versionSeqCounter
  };
}

function getVersionsSince(versionMap, lastVersionSeq) {
  return Object.values(versionMap).filter(
    (v) => v.seq > Number(lastVersionSeq)
  );
}

module.exports = {
  mergeChanges,
  getChangesSince,
  mergeVersions,
  getVersionsSince
};