import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function openJsonl(path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '');
  return {
    path,
    write(row) {
      appendFileSync(path, `${JSON.stringify(row)}\n`);
    },
  };
}

export function readJsonl(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (caught) {
    const error = new Error(`cannot read ${path}: ${caught.message}`);
    error.isUsageError = true;
    throw error;
  }
  const rows = [];
  text.split('\n').forEach((line, index) => {
    if (!line.trim()) return;
    try {
      rows.push(JSON.parse(line));
    } catch (caught) {
      const error = new Error(`${path}:${index + 1} is not valid JSON: ${caught.message}`);
      error.isUsageError = true;
      throw error;
    }
  });
  if (!rows.length) {
    const error = new Error(`${path} contains no rows`);
    error.isUsageError = true;
    throw error;
  }
  return rows;
}
