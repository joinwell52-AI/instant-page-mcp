import { createPageService, pageServiceSettings } from './service.mjs';

let service;
try {
  const { directory, contextFile, capability, linkTtlSeconds, port } = pageServiceSettings();
  service = createPageService({ directory, contextFile, capability, linkTtlSeconds });
  const probing = process.argv[2] === '--probe';
  const listeningPort = await service.listen(probing ? 0 : port);
  if (probing) process.env.PAGE_MCP_PORT = String(listeningPort);
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    if (process.connected) process.disconnect();
    void service.close();
  };
  process.once('disconnect', close);
  process.stdin.once('end', close);
  await import('./mcp.mjs');
  if (process.connected) process.send({ ready: true });
} catch (error) {
  console.error(error.code === 'EADDRINUSE' ? 'IPM: local page service port is already in use.' :
    'IPM: could not start the local page service. Check the context, data directory and port.');
  process.exitCode = 1;
  if (service?.server.listening) await service.close();
  if (process.connected) process.disconnect();
}
