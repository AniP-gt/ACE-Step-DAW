import { homedir } from 'node:os';
import { join } from 'node:path';
import { createBridgeService } from './service';
const root = process.env.LOGIC_BRIDGE_ROOT ?? join(homedir(), 'Library', 'Application Support', 'ACE-Step Bridge');
const origins = process.env.LOGIC_BRIDGE_ORIGINS?.split(',').map(origin => origin.trim()).filter(Boolean);
const service = await createBridgeService({ root, ...(process.env.LOGIC_BRIDGE_PORT ? { port: Number(process.env.LOGIC_BRIDGE_PORT) } : {}), ...(origins ? { origins } : {}) });
process.stdout.write(`Logic bridge listening at ${service.url}\n`);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void service.close().then(() => process.exit(0)); });
