import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';

function getKey() {
  const hex = process.env.ENCRYPTION_KEY || '';
  if (!hex) throw new Error('ENCRYPTION_KEY environment variable is not set');
  return Buffer.from(hex, 'hex');
}

export function encrypt(plaintext) {
  if (!plaintext) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: iv(12):tag(16):ciphertext — all base64
  return `${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decrypt(ciphertext) {
  if (!ciphertext) return null;
  const [ivB64, tagB64, dataB64] = ciphertext.split(':');
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(tag);
  return decipher.update(data) + decipher.final('utf8');
}
