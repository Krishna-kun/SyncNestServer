/**
 * SyncNest Pure Merge Engine (Deterministic Last-Write-Wins)
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

module.exports = {
  mergeChanges,
  getChangesSince
};