import { z } from "zod";

const HEX64 = /^0x[0-9a-fA-F]{64}$/;

export const cursorSchema = z.object({
  cursor: z.string()
    .refine((s) => {
      try {
        const decoded = Buffer.from(s, "base64").toString("utf-8");
        const [createdAt, publicId] = decoded.split("::");
        return (
          decoded.length > 0 &&
          typeof createdAt === "string" &&
          /^\d+(\.\d+)?$/.test(createdAt) &&
          typeof publicId === "string" &&
          HEX64.test(publicId)
        );
      } catch {
        return false;
      }
    }, "Cursor must be a base64-encoded string with format created_at:publicId"),
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