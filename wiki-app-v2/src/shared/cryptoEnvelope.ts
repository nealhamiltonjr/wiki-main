/**
 * §13.7 per-page encryption envelope. Uses the WebCrypto `crypto.subtle` API,
 * which is available in both the browser and Node 22+, so the same module is
 * imported by the client (protect/unlock/re-seal) and the server (shape
 * validation only — the server never holds the passphrase, KEK, or DEK).
 *
 * Envelope design (DEK + KEK):
 *   - DEK: a random 256-bit AES-GCM key that actually encrypts the page body.
 *   - KEK: derived from the user's unlock passphrase via PBKDF2-SHA-256. It
 *     only wraps (encrypts) the DEK, so changing the body never re-derives the
 *     passphrase — the client re-seals new content with the same in-memory DEK.
 *   - The server stores only the envelope (ciphertext + wrapped DEK + KDF
 *     salt/iterations), never plaintext or any key material in the clear.
 */

export interface CryptoEnvelope {
  v: 1;
  kdf: { alg: "PBKDF2-SHA-256"; salt: string; iterations: number };
  /** DEK wrapped with the KEK (AES-GCM). */
  dek: { iv: string; data: string };
  /** Page body encrypted with the DEK (AES-GCM). */
  content: { iv: string; data: string };
}

export const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const GCM_IV_BYTES = 12;

export class EncryptionUnlockError extends Error {
  constructor() {
    super("Wrong unlock passphrase");
    this.name = "EncryptionUnlockError";
  }
}

// ---------------------------------------------------------------------------
// base64 helpers (cross-platform; avoid Node Buffer so the client bundle works)
// ---------------------------------------------------------------------------

/** WebCrypto's `BufferSource` requires an `ArrayBuffer`-backed view, not the
 *  generic `ArrayBufferLike` default of `Uint8Array`. */
type Bytes = Uint8Array<ArrayBuffer>;

function bytesToBase64(bytes: Bytes): string {
  let binary = "";
  // Chunk so `String.fromCharCode(...huge array)` never blows the call stack
  // for a large page body.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Bytes {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function randomBytes(length: number): Bytes {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

// ---------------------------------------------------------------------------
// WebCrypto primitives
// ---------------------------------------------------------------------------

async function deriveKek(passphrase: string, salt: Bytes, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function generateDek(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

async function importDek(raw: Bytes): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function aesGcmEncrypt(plaintext: Bytes, key: CryptoKey, iv: Bytes): Promise<Bytes> {
  // AES-GCM returns ciphertext||tag as one buffer; storing the whole thing is
  // the standard envelope form (the 16-byte tag rides at the end).
  return new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
}

async function aesGcmDecrypt(data: Bytes, key: CryptoKey, iv: Bytes): Promise<Bytes> {
  // Throws OperationError on authentication failure — the wrong-passphrase and
  // tampered-ciphertext signal. Callers map that to EncryptionUnlockError.
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data));
}

async function encryptContent(plaintext: unknown, dek: CryptoKey): Promise<CryptoEnvelope["content"]> {
  const iv = randomBytes(GCM_IV_BYTES);
  const serialized = new TextEncoder().encode(JSON.stringify(plaintext));
  const data = await aesGcmEncrypt(serialized, dek, iv);
  return { iv: bytesToBase64(iv), data: bytesToBase64(data) };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Create a fresh envelope: new DEK, new salt, wrap DEK with the passphrase. */
export async function createEnvelope(plaintext: unknown, passphrase: string): Promise<CryptoEnvelope> {
  const salt = randomBytes(SALT_BYTES);
  const kek = await deriveKek(passphrase, salt, PBKDF2_ITERATIONS);
  const dek = await generateDek();
  const dekRaw = new Uint8Array(await crypto.subtle.exportKey("raw", dek));

  const wrapIv = randomBytes(GCM_IV_BYTES);
  const wrappedDek = await aesGcmEncrypt(dekRaw, kek, wrapIv);

  return {
    v: 1,
    kdf: { alg: "PBKDF2-SHA-256", salt: bytesToBase64(salt), iterations: PBKDF2_ITERATIONS },
    dek: { iv: bytesToBase64(wrapIv), data: bytesToBase64(wrappedDek) },
    content: await encryptContent(plaintext, dek),
  };
}

/** Unlock an envelope with the passphrase. Returns the plaintext body and the
 *  live DEK so the session can re-seal edits without re-deriving the KEK. */
export async function unlockEnvelope(
  envelope: CryptoEnvelope,
  passphrase: string,
): Promise<{ plaintext: unknown; dek: CryptoKey }> {
  validateEnvelope(envelope);
  const kek = await deriveKek(passphrase, base64ToBytes(envelope.kdf.salt), envelope.kdf.iterations);

  let dek: CryptoKey;
  try {
    const dekRaw = await aesGcmDecrypt(base64ToBytes(envelope.dek.data), kek, base64ToBytes(envelope.dek.iv));
    dek = await importDek(dekRaw);
  } catch {
    throw new EncryptionUnlockError();
  }

  let plaintext: unknown;
  try {
    const bytes = await aesGcmDecrypt(base64ToBytes(envelope.content.data), dek, base64ToBytes(envelope.content.iv));
    plaintext = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new EncryptionUnlockError();
  }

  return { plaintext, dek };
}

/** Re-encrypt the body with an already-unlocked DEK. Callers keep the original
 *  envelope's `kdf` + `dek` and replace only `content` with this result. */
export async function sealContent(plaintext: unknown, dek: CryptoKey): Promise<CryptoEnvelope["content"]> {
  return encryptContent(plaintext, dek);
}

// ---------------------------------------------------------------------------
// Server-side shape validation (no crypto keys required)
// ---------------------------------------------------------------------------

function isBase64(value: unknown, expectedBytes?: number): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    const bytes = base64ToBytes(value);
    return expectedBytes === undefined || bytes.length === expectedBytes;
  } catch {
    return false;
  }
}

/** Structural validation only. The server cannot verify the passphrase or
 *  ciphertext, but it must reject an envelope that isn't shaped like one
 *  before persisting it (prevents storing a plaintext body under the
 *  encrypted-page flag). */
export function validateEnvelope(input: unknown): asserts input is CryptoEnvelope {
  if (typeof input !== "object" || input === null) throw new Error("Envelope must be an object");
  const env = input as Record<string, unknown>;
  if (env.v !== 1) throw new Error("Unsupported envelope version");
  const kdf = env.kdf as Record<string, unknown> | undefined;
  if (!kdf || kdf.alg !== "PBKDF2-SHA-256") throw new Error("Invalid envelope KDF");
  if (typeof kdf.iterations !== "number" || !Number.isInteger(kdf.iterations) || kdf.iterations < 10_000 || kdf.iterations > 10_000_000) {
    throw new Error("Invalid envelope KDF iterations");
  }
  if (!isBase64(kdf.salt)) throw new Error("Invalid envelope salt");
  const dek = env.dek as Record<string, unknown> | undefined;
  if (!dek || !isBase64(dek.iv, GCM_IV_BYTES) || !isBase64(dek.data)) throw new Error("Invalid wrapped DEK");
  const content = env.content as Record<string, unknown> | undefined;
  if (!content || !isBase64(content.iv, GCM_IV_BYTES) || !isBase64(content.data)) throw new Error("Invalid envelope content");
}
