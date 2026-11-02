#!/usr/bin/env node
/**
 * Копирует медиа в public/ для Remotion.
 * В git public/ не попадает — это генерируемая папка.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PUBLIC = path.join(ROOT, 'public');

fs.mkdirSync(PUBLIC, { recursive: true });
fs.cpSync(path.join(ROOT, 'media', 'stock'), path.join(PUBLIC, 'stock'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'brand', 'assets', 'icon.png'), path.join(PUBLIC, 'icon.png'));
fs.copyFileSync(path.join(ROOT, 'brand', 'assets', 'qr.png'), path.join(PUBLIC, 'qr.png'));
fs.copyFileSync(path.join(ROOT, 'media', 'audio', 'audio.wav'), path.join(PUBLIC, 'audio.wav'));
console.log('[prepare-media] public/: stock, icon, qr, audio');
