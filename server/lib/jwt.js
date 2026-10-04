'use strict';
/** RS256 JWT signing for the Salesforce OAuth 2.0 JWT bearer flow. */
const crypto = require('node:crypto');

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

function signRS256(payload, privateKeyPem) {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${body}`);
  const sig = b64url(signer.sign(privateKeyPem));
  return `${header}.${body}.${sig}`;
}

module.exports = { signRS256 };
