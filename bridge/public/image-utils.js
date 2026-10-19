export const SIDE = 240;
export function encode565(rgba) {
  if (rgba.length !== SIDE * SIDE * 4) throw new Error('invalid_image_size');
  const bytes = new Uint8Array(SIDE * SIDE * 2);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p += 2) {
    const color = ((rgba[i] >> 3) << 11) | ((rgba[i + 1] >> 2) << 5) | (rgba[i + 2] >> 3);
    bytes[p] = color & 255; bytes[p + 1] = color >> 8;
  }
  return bytes;
}
export function decode565(bytes) {
  if (bytes.length !== SIDE * SIDE * 2) throw new Error('invalid_image_size');
  const rgba = new Uint8ClampedArray(SIDE * SIDE * 4);
  for (let p = 0, i = 0; p < bytes.length; p += 2, i += 4) {
    const color = bytes[p] | (bytes[p + 1] << 8);
    rgba[i] = Math.round(((color >> 11) & 31) * 255 / 31);
    rgba[i + 1] = Math.round(((color >> 5) & 63) * 255 / 63);
    rgba[i + 2] = Math.round((color & 31) * 255 / 31); rgba[i + 3] = 255;
  }
  return rgba;
}
export function fitRect(width, height, fit = 'contain') {
  const scale = Math[fit === 'cover' ? 'max' : 'min'](SIDE / width, SIDE / height);
  const w = width * scale, h = height * scale;
  return { x: (SIDE - w) / 2, y: (SIDE - h) / 2, width: w, height: h };
}
