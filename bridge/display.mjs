import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

export const IMAGE_SIZE = 240 * 240 * 2;
export function createDisplayStore(filePath) {
  let current = { mode: 'quota', pixels: null };
  if (filePath && existsSync(filePath)) {
    const value = JSON.parse(readFileSync(filePath, 'utf8'));
    const pixels = typeof value.pixels === 'string' ? Buffer.from(value.pixels, 'base64') : null;
    if (!['quota', 'image'].includes(value.mode) || (pixels && pixels.length !== IMAGE_SIZE) || (value.mode === 'image' && !pixels)) throw new Error('invalid_display_file');
    current = { mode: value.mode, pixels };
  }
  function commit(next) {
    if (filePath) {
      const temporary = `${filePath}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify({ mode: next.mode, pixels: next.pixels?.toString('base64') ?? null }) + '\n', { flag: 'wx' });
        renameSync(temporary, filePath);
      } catch (error) {
        if (existsSync(temporary)) unlinkSync(temporary);
        throw error;
      }
    }
    current = next;
    return get();
  }
  function get() {
    return { mode: current.mode, image: current.pixels ? {
      revision: createHash('sha256').update(current.pixels).digest('hex'), width: 240, height: 240, format: 'rgb565le',
    } : null };
  }
  return {
    get,
    image() { return current.pixels ? Buffer.from(current.pixels) : null; },
    upload(pixels) {
      if (!Buffer.isBuffer(pixels) || pixels.length !== IMAGE_SIZE) throw new Error('invalid_image_size');
      return commit({ mode: 'image', pixels: Buffer.from(pixels) });
    },
    setMode(value) {
      if (!value || typeof value !== 'object' || Object.keys(value).length !== 1 || !['quota', 'image'].includes(value.mode)) throw new Error('invalid_display_mode');
      if (value.mode === 'image' && !current.pixels) throw new Error('请先上传一张图片');
      return commit({ ...current, mode: value.mode });
    },
  };
}
