import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import type { ImageProviderAdapter, ProviderGenerateInput, ProviderGenerateResult } from "./types.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function parseSize(size: string): { width: number; height: number } {
  if (size === "auto") return { width: 768, height: 768 };
  const match = size.match(/^(\d+)x(\d+)$/);
  if (!match) return { width: 768, height: 768 };
  const width = Math.max(256, Math.min(1024, Number(match[1])));
  const height = Math.max(256, Math.min(1024, Number(match[2])));
  return { width, height };
}

function colorFromHash(hash: Buffer, offset: number): [number, number, number] {
  return [hash[offset], hash[offset + 1], hash[offset + 2]];
}

function createMockPng(input: ProviderGenerateInput, index: number): { buffer: Buffer; width: number; height: number } {
  const { width, height } = parseSize(input.size);
  const hash = createHash("sha256")
    .update(input.prompt)
    .update(input.instruction ?? "")
    .update(input.contextSummary ?? "")
    .update(String(index))
    .digest();
  const a = colorFromHash(hash, 0);
  const b = colorFromHash(hash, 8);
  const c = colorFromHash(hash, 16);
  const raw = Buffer.alloc((width * 4 + 1) * height);

  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (width * 4 + 1);
    raw[rowOffset] = 0;
    for (let x = 0; x < width; x += 1) {
      const px = rowOffset + 1 + x * 4;
      const t = x / Math.max(1, width - 1);
      const u = y / Math.max(1, height - 1);
      const wave = (Math.sin((x + hash[24]) / 28) + Math.cos((y + hash[25]) / 31) + 2) / 4;
      raw[px] = Math.round(a[0] * (1 - t) + b[0] * t * (1 - u) + c[0] * u * wave);
      raw[px + 1] = Math.round(a[1] * (1 - u) + b[1] * u * (1 - t) + c[1] * t * wave);
      raw[px + 2] = Math.round(a[2] * (1 - wave) + b[2] * wave * (1 - u) + c[2] * u);
      raw[px + 3] = 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const text = Buffer.from(`Software\0Workbench Images mock provider`, "latin1");
  const png = Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("tEXt", text),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
  return { buffer: png, width, height };
}

export const mockProvider: ImageProviderAdapter = {
  provider: "mock",
  capabilities: ["create", "refine", "edit", "context_update", "reference", "source"],
  async generate(input: ProviderGenerateInput): Promise<ProviderGenerateResult> {
    const count = Math.max(1, Math.min(8, input.count));
    const images = Array.from({ length: count }, (_value, index) => {
      const image = createMockPng(input, index);
      return {
        buffer: image.buffer,
        mimeType: "image/png",
        width: image.width,
        height: image.height,
        metadata: {
          mock: true,
          intent: input.intent,
          sourceImageCount: input.images.length,
          preserve: input.preserve ?? []
        }
      };
    });
    return {
      provider: "mock",
      model: input.model,
      images,
      metadata: {
        mock: true
      }
    };
  }
};
