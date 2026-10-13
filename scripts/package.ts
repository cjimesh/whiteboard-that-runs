/**
 * Packages the shipped file for sending to somebody.
 *
 * This exists because "we could share it" is not a step and `npm run package` is.
 * The project this one replaces died with a working build nobody ever sent, at the
 * publish step, and the counter to that is making the publish step a command that
 * either ran or did not.
 *
 * A zip rather than the bare `.html`: mail gateways strip HTML attachments and
 * Slack serves them as downloads rather than rendering them, so the bare file
 * often does not survive the trip. The archive is written here rather than shelled
 * out to `zip`, which is not installed everywhere, and rather than pulling in a
 * dependency for sixty lines of a format that has not changed since 1989.
 *
 * The recipient unzips one file and double-clicks it. No server, no install, and
 * nothing fetched — which the build test asserts against this same artifact.
 */
import { deflateRawSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let bit = 0; bit < 8; bit += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = ((crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] as number)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS date/time, which is what the format stores. */
function dosStamp(when: Date): { time: number; date: number } {
  return {
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1),
    date: ((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
  };
}

/** A single-entry zip, deflate-compressed. */
function zipOne(name: string, contents: Buffer, when: Date): Buffer {
  const compressed = deflateRawSync(contents, { level: 9 });
  const crc = crc32(contents);
  const { time, date } = dosStamp(when);
  const nameBytes = Buffer.from(name, "utf8");

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); // local file header signature
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0, 6); // flags
  local.writeUInt16LE(8, 8); // method: deflate
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(contents.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  local.writeUInt16LE(0, 28); // extra field length

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); // central directory header signature
  central.writeUInt16LE(20, 4); // version made by
  central.writeUInt16LE(20, 6); // version needed
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(time, 12);
  central.writeUInt16LE(date, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(contents.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt16LE(0, 30); // extra
  central.writeUInt16LE(0, 32); // comment
  central.writeUInt16LE(0, 34); // disk number
  central.writeUInt16LE(0, 36); // internal attributes
  central.writeUInt32LE(0, 38); // external attributes
  central.writeUInt32LE(0, 42); // offset of local header

  const centralSize = central.length + nameBytes.length;
  const centralOffset = local.length + nameBytes.length + compressed.length;

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with central directory
  end.writeUInt16LE(1, 8); // entries on this disk
  end.writeUInt16LE(1, 10); // entries total
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([local, nameBytes, compressed, central, nameBytes, end]);
}

const root = resolve(import.meta.dirname, "..");
const when = new Date();
const stamp = when.toISOString().slice(0, 10);

const built = await readFile(resolve(root, "dist/index.html"));
const archive = zipOne("whiteboard-that-runs.html", built, when);

const shareDir = resolve(root, "share");
await mkdir(shareDir, { recursive: true });
const target = resolve(shareDir, `whiteboard-that-runs-${stamp}.zip`);
await writeFile(target, archive);

const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} kB`;
console.log(`share/whiteboard-that-runs-${stamp}.zip  ${kb(archive.length)} (from ${kb(built.length)})`);
console.log("Send that file. The recipient unzips it and opens the HTML — no server, nothing fetched.");
