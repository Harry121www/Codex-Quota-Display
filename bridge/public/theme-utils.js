export const DEFAULT_THEME = Object.freeze({ accent: '#FFFF00', background: '#080808' });

export function normalizeTheme(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== 2 || !Object.hasOwn(value, 'accent') || !Object.hasOwn(value, 'background')) {
    throw new Error('请选择主题色和背景色');
  }
  const result = {};
  for (const key of ['accent', 'background']) {
    if (typeof value[key] !== 'string' || !/^#[0-9a-f]{6}$/i.test(value[key])) throw new Error('颜色格式应为 #RRGGBB');
    result[key] = value[key].toUpperCase();
  }
  return result;
}

function channels(hex) { return [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16)); }

function blend(front, back, amount) {
  const a = channels(front), b = channels(back);
  return '#' + a.map((channel, i) => Math.round(channel * amount + b[i] * (1 - amount)).toString(16).padStart(2, '0')).join('').toUpperCase();
}

export function paletteHex(theme) {
  return {
    accent: theme.accent, background: theme.background,
    muted: blend(theme.accent, theme.background, 0.68),
    track: blend(theme.accent, theme.background, 0.18),
    warning: '#FFA500', danger: '#FF0000',
  };
}

export function rgb565(hex) {
  const [red, green, blue] = channels(hex);
  return ((red & 0xF8) << 8) | ((green & 0xFC) << 3) | (blue >> 3);
}

export function palette565(theme) {
  return Object.fromEntries(Object.entries(paletteHex(theme)).map(([key, value]) => [key, rgb565(value)]));
}
