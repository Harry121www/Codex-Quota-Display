import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DEFAULT_THEME, normalizeTheme } from './public/theme-utils.js';

export function createThemeStore(filePath) {
  let current = { ...DEFAULT_THEME };
  if (filePath && existsSync(filePath)) current = normalizeTheme(JSON.parse(readFileSync(filePath, 'utf8')));
  return {
    get() { return { ...current }; },
    set(value) {
      const next = normalizeTheme(value);
      if (filePath) {
        const temporary = `${filePath}.${randomUUID()}.tmp`;
        try {
          writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { flag: 'wx' });
          renameSync(temporary, filePath);
        } catch (error) {
          if (existsSync(temporary)) unlinkSync(temporary);
          throw error;
        }
      }
      current = next;
      return { ...current };
    },
  };
}
