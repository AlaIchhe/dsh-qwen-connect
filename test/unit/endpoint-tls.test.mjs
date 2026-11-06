// VPC TLS relaxation must stay scoped to the single gateway hop.
// Backported from zcode-ai-connect (11-05); adapted so the assertions do not
// depend on the host process's NODE_TLS_REJECT_UNAUTHORIZED setting.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { relaxTlsForVpc, fetchWithoutTlsVerify } from '../../lib/endpoint.js';

let temp;
let tls;
let certDir;
let opensslAvailable = true;

try {
  temp = await mkdtemp(path.join(tmpdir(), 'qwen-tls-'));
  certDir = temp;
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048',
    '-keyout', path.join(certDir, 'key.pem'),
    '-out', path.join(certDir, 'cert.pem'),
    '-days', '1', '-nodes', '-subj', '/CN=localhost',
  ], { stdio: 'ignore' });
} catch {
  opensslAvailable = false;
}

after(async () => {
  if (tls) await new Promise((resolve) => tls.close(resolve));
  if (temp) await rm(temp, { recursive: true, force: true });
});

test('relaxTlsForVpc never disables TLS verification process-wide', () => {
  const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  const vpc = relaxTlsForVpc('https://tenant.vpc.qwenwork.cn');
  const pub = relaxTlsForVpc('https://gateway.qwenwork.cn');
  assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, before);
  assert.equal(pub, globalThis.fetch, 'public cloud must keep the global fetch');
  assert.equal(vpc, fetchWithoutTlsVerify, 'VPC must get the scoped fetch');
});

test('the scoped fetch reaches a self-signed gateway without touching global TLS', {
  skip: !opensslAvailable && 'openssl unavailable',
}, async () => {
  const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  const [key, cert] = await Promise.all([
    readFile(path.join(certDir, 'key.pem')),
    readFile(path.join(certDir, 'cert.pem')),
  ]);
  tls = createServer({ key, cert }, (_req, res) => {
    res.writeHead(418, { 'content-type': 'text/plain' });
    res.end('vpc-reached');
  });
  await new Promise((resolve) => tls.listen(0, '127.0.0.1', resolve));
  const url = `https://127.0.0.1:${tls.address().port}/up`;
  const res = await fetchWithoutTlsVerify(url, { method: 'POST', body: '{}' });
  assert.equal(res.status, 418);
  assert.equal(await res.text(), 'vpc-reached');
  assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, before);
});
