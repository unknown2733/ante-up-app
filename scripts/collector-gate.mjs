// Keep accepted publication reconciliation alive while new source work is held.
export async function collectorGate({checkStorage, reconcile}) {
  let storageReason = null;
  try { await checkStorage(); }
  catch (error) {
    if (!['STATE_STORAGE_LIMIT', 'HOST_STORAGE_LOW'].includes(error.message)) throw error;
    storageReason = error.message;
  }
  // A critically full host must not attempt even a small journal write.
  if (storageReason === 'HOST_STORAGE_LOW') return {ready:false, reason:storageReason};
  const result = await reconcile({allowPreparedResume:storageReason===null});
  if (!Number.isSafeInteger(result?.unresolved) || result.unresolved < 0)
    throw Error('PUBLICATION_RECONCILE_RESULT_INVALID');
  if (storageReason) return {ready:false, reason:storageReason, unresolved:result.unresolved};
  if (result.unresolved) return {ready:false, reason:'PUBLICATION_PENDING', unresolved:result.unresolved};
  return {ready:true};
}
