import { z } from "zod";
const HEX64 = /^0x[0-9a-fA-F]{64}$/;
const HEX40 = /^0x[a-fA-F0-9]{40}$/;

export const cursorSchema = z.object({
  cursor: z.string()
    .refine((s) => {
      try {
        const decoded = Buffer.from(s, "base64").toString("utf-8");
        const parts = decoded.split("::");
        return parts.length >= 2 && parts[0].match(/^\d+(\.\d+)?$/) && parts[1].length === 64;
      } catch {
        return false;
      }
    }, "Cursor must be a base64-encoded string with format created_at:publicId")
    .refine((s) => {
      const decoded = Buffer.from(s, "base64").toString("utf-8");
      const [createdAt, publicId] = decoded.split("::");
      if (!createdAt || !publicId) return false;
      return HEX64.test(publicId);
    }, "Cursor must encode a valid order ID"),
});

export type Cursor = z.infer<typeof cursorSchema>;

export function encodeCursor(createdAt: number, publicId: string): string {
  const cursor = `${createdAt}:${publicId}`;
  return Buffer.from(cursor).toString("base64");
}

export function decodeCursor(encoded: string): { createdAt: number; publicId: string } | null {
  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf-8");
    const [createdAt, publicId] = decoded.split("::");
    if (!createdAt || !publicId) return null;
    const parsedCreatedAt = parseFloat(createdAt);
    if (isNaN(parsedCreatedAt)) return null;
    return { createdAt: parsedCreatedAt, publicId };

/**
 * Cursor utilities for stable pagination.
 * Cursor = base64-encoded JSON of {offset, createdAt} for stable offset-based pagination.
 */

export interface CursorData {
  offset: number;
  createdAt: number;
}

/** Encode cursor to base64 string */
export function encodeCursor(data: CursorData): string {
  return Buffer.from(JSON.stringify(data)).toString("base64");
}

/** Decode cursor from base64 string */
export function decodeCursor(cursor: string): CursorData | null {
  try {
    const decoded = Buffer.from(cursor, "base64").toString("utf-8");
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}
export function validateCursor(cursor: { createdAt: number; publicId: string; network: string; user: string }): boolean {
  const { createdAt, publicId, network, user } = cursor;
  if (isNaN(createdAt)) return false;
  if (publicId.length !== 64) return false;
  if (!network || network.length < 2) return false;
  if (!user || !user.startsWith("0x")) return false;
  return true;
}
r
