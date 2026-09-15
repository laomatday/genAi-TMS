const DATABASE_NAME = 'genai-tms-client-state';
const DATABASE_VERSION = 1;
const STORE_NAME = 'records';

interface StoredRecord {
  key: string;
  value: unknown;
}

let databasePromise: Promise<IDBDatabase | null> | null = null;

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (databasePromise) return databasePromise;

  databasePromise = new Promise((resolve) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        databasePromise = null;
      };
      resolve(database);
    };
    request.onerror = () => {
      databasePromise = null;
      resolve(null);
    };
    request.onblocked = () => {
      databasePromise = null;
      resolve(null);
    };
  });

  return databasePromise;
}

export async function readClientState<T>(key: string): Promise<T | null> {
  const database = await openDatabase();
  if (!database) return null;

  return new Promise((resolve) => {
    try {
      const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key);
      request.onsuccess = () => resolve((request.result as StoredRecord | undefined)?.value as T | undefined ?? null);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function writeClientState(key: string, value: unknown): Promise<void> {
  const database = await openDatabase();
  if (!database) return;

  await new Promise<void>((resolve) => {
    try {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put({ key, value } satisfies StoredRecord);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
      transaction.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function removeClientState(key: string): Promise<void> {
  const database = await openDatabase();
  if (!database) return;

  await new Promise<void>((resolve) => {
    try {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).delete(key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
      transaction.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}
