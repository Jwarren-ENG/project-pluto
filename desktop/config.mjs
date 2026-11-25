import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';

export function createConfig(directory, safeStorage) {
  const db=new DatabaseSync(path.join(directory,'connections.sqlite'));
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS credentials (key TEXT PRIMARY KEY, value BLOB NOT NULL)');
  const prefs={
    get(key){ const row=db.prepare('SELECT value FROM settings WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; },
    set(key,value){db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run(key,JSON.stringify(value));}
  };
  async function verifyCrypto(){
    if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error('Unlock the system credential store and try again.');
  }
  const secrets={
    async get(key){const row=db.prepare('SELECT value FROM credentials WHERE key=?').get(key);if(!row)return null;
      await verifyCrypto(); const {result}=await safeStorage.decryptStringAsync(Buffer.from(row.value));return result;},
    async set(key,value){await verifyCrypto();const encrypted=await safeStorage.encryptStringAsync(value);
      db.prepare('INSERT OR REPLACE INTO credentials VALUES (?,?)').run(key,encrypted);},
    async remove(key){db.prepare('DELETE FROM credentials WHERE key=?').run(key);}
  };
  return {prefs,secrets,close:()=>db.close()};
}
