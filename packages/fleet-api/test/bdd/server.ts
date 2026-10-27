import { setup } from '../ui/helpers';

const { app } = setup({ auth: { alwaysSignedInAs: 'browser-test' } });
const port = Number(process.env['FLEET_DOWNLOAD_TEST_PORT'] ?? '39219');
Bun.serve({ hostname: '127.0.0.1', port, fetch: app.fetch });
