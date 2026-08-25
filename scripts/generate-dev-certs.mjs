import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { run } from './command.mjs';

const certDirectory = resolve('deploy/compose/certs');
mkdirSync(certDirectory, { recursive: true });

const files = {
  caCert: resolve(certDirectory, 'ca.crt'),
  caKey: resolve(certDirectory, 'ca.key'),
  serverCert: resolve(certDirectory, 'hub-agent.crt'),
  serverKey: resolve(certDirectory, 'hub-agent.key'),
  clientCert: resolve(certDirectory, 'control-plane.crt'),
  clientKey: resolve(certDirectory, 'control-plane.key'),
};

if (Object.values(files).every(existsSync)) {
  console.log('Development certificates already exist.');
  process.exit(0);
}

const serverConfig = resolve(certDirectory, 'server.ext');
const clientConfig = resolve(certDirectory, 'client.ext');
writeFileSync(
  serverConfig,
  ['subjectAltName=DNS:localhost,DNS:hub-agent,IP:127.0.0.1', 'extendedKeyUsage=serverAuth'].join(
    '\n',
  ),
);
writeFileSync(clientConfig, 'extendedKeyUsage=clientAuth\n');

run('openssl', [
  'req',
  '-x509',
  '-newkey',
  'rsa:3072',
  '-sha256',
  '-days',
  '3650',
  '-nodes',
  '-subj',
  '/CN=KiteSync Development CA',
  '-keyout',
  files.caKey,
  '-out',
  files.caCert,
]);

for (const identity of [
  {
    name: 'hub-agent',
    cert: files.serverCert,
    key: files.serverKey,
    ext: serverConfig,
    subject: '/CN=hub-agent',
  },
  {
    name: 'control-plane',
    cert: files.clientCert,
    key: files.clientKey,
    ext: clientConfig,
    subject: '/CN=control-plane',
  },
]) {
  const csr = resolve(certDirectory, identity.name + '.csr');
  run('openssl', [
    'req',
    '-newkey',
    'rsa:3072',
    '-nodes',
    '-subj',
    identity.subject,
    '-keyout',
    identity.key,
    '-out',
    csr,
  ]);
  run('openssl', [
    'x509',
    '-req',
    '-sha256',
    '-days',
    '825',
    '-in',
    csr,
    '-CA',
    files.caCert,
    '-CAkey',
    files.caKey,
    '-CAcreateserial',
    '-extfile',
    identity.ext,
    '-out',
    identity.cert,
  ]);
}

console.log('Generated development mTLS certificates in ' + certDirectory);
