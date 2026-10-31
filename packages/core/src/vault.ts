import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { AppError } from "./errors.js";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const VERSION = "v1";

export interface SecretBox {
  /** `context` is bound as AAD: ciphertext from one row cannot be decrypted as another's. */
  seal(plaintext: string, context: string): string;
  open(sealed: string, context: string): string;
  /** Keyed, non-reversible fingerprint (HMAC-SHA256) for audit fields such as queries. */
  fingerprint(value: string): string;
}

/**
 * AES-256-GCM envelope for connector tokens and OAuth secrets (FR-CON-02).
 * Local stand-in for KMS envelope encryption: swap the key source, keep the format.
 */
export function createSecretBox(base64Key: string): SecretBox {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== KEY_BYTES) {
    throw new AppError("CONFIG_INVALID", "Encryption key must be 32 bytes, base64-encoded");
  }
  // Separate subkey so fingerprints never reuse the encryption key directly.
  const macKey = createHmac("sha256", key).update("nexus-brain/fingerprint/v1").digest();

  return {
    fingerprint(value) {
      return createHmac("sha256", macKey).update(value, "utf8").digest("hex");
    },
    seal(plaintext, context) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      cipher.setAAD(Buffer.from(context, "utf8"));
      const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return [VERSION, iv, cipher.getAuthTag(), body].map(encode).join(".");
    },
    open(sealed, context) {
      const [version, iv, tag, body] = sealed.split(".");
      if (version !== VERSION || !iv || !tag || !body) {
        throw new AppError("INTERNAL", "Unreadable sealed secret");
      }
      try {
        const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, "base64url"));
        decipher.setAAD(Buffer.from(context, "utf8"));
        decipher.setAuthTag(Buffer.from(tag, "base64url"));
        return Buffer.concat([
          decipher.update(Buffer.from(body, "base64url")),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        throw new AppError("INTERNAL", "Unreadable sealed secret");
      }
    },
  };
}

function encode(part: string | Buffer): string {
  return typeof part === "string" ? part : part.toString("base64url");
}
