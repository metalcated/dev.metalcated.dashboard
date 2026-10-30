// Browser connections live in a database. If storage is unavailable, retain the
// connection only for this page's lifetime so the dashboard remains usable.
const DATABASE = 'homey-web-dashboard';
const STORE = 'connections';
const RECORD = 'current';
let opening = null;
let memory;

function database() {
  if (!globalThis.indexedDB) return Promise.reject(new Error('Browser storage is unavailable.'));
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); opening = null; };
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error('Could not open browser storage.'));
    request.onblocked = () => reject(new Error('Browser storage is busy.'));
  }).catch((error) => { opening = null; throw error; });
  return opening;
}

export async function readConnection() {
  if (memory !== undefined) return structuredClone(memory);
  try {
    const db = await database();
    const value = await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readonly');
      const request = transaction.objectStore(STORE).get(RECORD);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
      transaction.onabort = () => reject(transaction.error);
    });
    if (value !== null) memory = value;
    return value;
  } catch {
    return null;
  }
}

export async function writeConnection(config) {
  memory = structuredClone(config);
  try {
    const db = await database();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).put(memory, RECORD);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    return true;
  } catch {
    return false;
  }
}
