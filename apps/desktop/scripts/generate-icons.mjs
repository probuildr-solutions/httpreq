/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

// Generates every platform icon from the master SVG using Electron's own renderer, so no extra
// image tooling is required. Run with `npm run icons --workspace=@httpreq/desktop`.
//
//   build/icon.svg           master artwork (edit this)
//   build/icon.png           1024px PNG (electron-builder fallback)
//   build/icon.ico           Windows executable, installer and shortcut icon
//   build/icon.icns          macOS app and DMG icon (Apple icon-grid variant with shadow)
//   build/icons/NxN.png      Linux icon set (AppImage, deb, desktop entry)
//   resources/icon.png       runtime window/taskbar icon on Windows and Linux
//   ../web/public/favicon.*  browser favicon and touch icon
import { app, BrowserWindow } from 'electron';
import { Buffer } from 'node:buffer';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = join(root, 'build');
const master = readFileSync(join(buildDir, 'icon.svg'), 'utf8');

const inner = master.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
// macOS icons sit on Apple's 824px grid inside the 1024px canvas and carry a soft shadow.
const macSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs><filter id="shadow" x="-10%" y="-10%" width="120%" height="130%">
    <feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#000" flood-opacity="0.28"/>
  </filter></defs>
  <g filter="url(#shadow)"><g transform="translate(100 100) scale(${824 / 960}) translate(-32 -32)">${inner}</g></g>
</svg>`;

const standardSizes = [16, 24, 32, 48, 64, 128, 180, 256, 512, 1024];
const macSizes = [16, 32, 64, 128, 256, 512, 1024];

const rasterize = async (window, svg, sizes) => {
    const source = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
    const images = await window.webContents.executeJavaScript(`(async () => {
    const image = new Image();
    image.src = ${JSON.stringify(source)};
    await image.decode();
    const result = {};
    for (const size of ${JSON.stringify(sizes)}) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const context = canvas.getContext('2d');
      context.imageSmoothingQuality = 'high';
      context.drawImage(image, 0, 0, size, size);
      result[size] = canvas.toDataURL('image/png').split(',')[1];
    }
    return result;
  })()`);
    return Object.fromEntries(
        Object.entries(images).map(([size, base64]) => [size, Buffer.from(base64, 'base64')]),
    );
};

/** ICO container with PNG-compressed entries (supported since Windows Vista). */
const toIco = (pngs) => {
    const entries = Object.entries(pngs).map(([size, data]) => ({ size: Number(size), data }));
    const header = Buffer.alloc(6 + entries.length * 16);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(entries.length, 4);
    let offset = header.length;
    entries.forEach(({ size, data }, index) => {
        const at = 6 + index * 16;
        header.writeUInt8(size >= 256 ? 0 : size, at);
        header.writeUInt8(size >= 256 ? 0 : size, at + 1);
        header.writeUInt8(0, at + 2);
        header.writeUInt8(0, at + 3);
        header.writeUInt16LE(1, at + 4);
        header.writeUInt16LE(32, at + 6);
        header.writeUInt32LE(data.length, at + 8);
        header.writeUInt32LE(offset, at + 12);
        offset += data.length;
    });
    return Buffer.concat([header, ...entries.map((entry) => entry.data)]);
};

/** ICNS container with PNG entries, including the Retina (@2x) variants. */
const toIcns = (pngs) => {
    const types = [
        ['icp4', 16],
        ['icp5', 32],
        ['icp6', 64],
        ['ic07', 128],
        ['ic08', 256],
        ['ic09', 512],
        ['ic10', 1024],
        ['ic11', 32],
        ['ic12', 64],
        ['ic13', 256],
        ['ic14', 512],
    ];
    const chunks = types.map(([type, size]) => {
        const data = pngs[size];
        const head = Buffer.alloc(8);
        head.write(type, 0, 'ascii');
        head.writeUInt32BE(data.length + 8, 4);
        return Buffer.concat([head, data]);
    });
    const body = Buffer.concat(chunks);
    const head = Buffer.alloc(8);
    head.write('icns', 0, 'ascii');
    head.writeUInt32BE(body.length + 8, 4);
    return Buffer.concat([head, body]);
};

const write = (path, data) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
    console.log(`wrote ${relative(root, path)} (${data.length} bytes)`);
};

app.whenReady().then(async () => {
    const window = new BrowserWindow({ show: false, width: 64, height: 64 });
    await window.loadURL('about:blank');
    const standard = await rasterize(window, master, standardSizes);
    const mac = await rasterize(window, macSvg, macSizes);
    window.destroy();

    write(join(buildDir, 'icon.png'), standard[1024]);
    for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
        write(join(buildDir, 'icons', `${size}x${size}.png`), standard[size]);
    }
    const ico = {};
    for (const size of [16, 24, 32, 48, 64, 128, 256]) ico[size] = standard[size];
    write(join(buildDir, 'icon.ico'), toIco(ico));
    write(join(buildDir, 'icon.icns'), toIcns(mac));
    write(join(root, 'resources', 'icon.png'), standard[512]);

    const web = join(root, '..', 'web', 'public');
    write(join(web, 'favicon.svg'), Buffer.from(master));
    write(join(web, 'apple-touch-icon.png'), standard[180]);
    app.quit();
});
