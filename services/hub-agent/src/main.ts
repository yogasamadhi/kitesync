import { loadConfig } from './config.js';
import { createServer } from './server.js';

const config = loadConfig();
const app = await createServer(config);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'Shutting down Hub Agent');
  await app.close();
  process.exit(0);
};

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.host, port: config.port });
