import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { createServer } from './server.js';
import { FileCredentialVault, IpcCredentialVault } from './vault.js';

const config = loadConfig();
const vault = process.send
  ? new IpcCredentialVault()
  : new FileCredentialVault(
      process.env.KITESYNC_DEV_VAULT ??
        resolve(import.meta.dirname, '../../../.kitesync-dev/credentials.json'),
    );
const app = await createServer(config, vault);
const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
await app.listen({ host: config.host, port: config.port });
