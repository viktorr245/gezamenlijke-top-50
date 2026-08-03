import { createReadStream } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

const UTF8_WITH_DESCRIPTOR = 0x0808;
const MAX_ZIP32_VALUE = 0xffffffff;

type CentralEntry = {
  name: Buffer;
  crc32: number;
  size: number;
  localOffset: number;
  dosDate: number;
  dosTime: number;
};

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1;
  return crc >>> 0;
});

function updateCrc32(crc: number, bytes: Uint8Array): number {
  let value = crc;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ value >>> 8;
  return value >>> 0;
}

function dosTimestamp(value: Date) {
  const year = Math.min(2107, Math.max(1980, value.getFullYear()));
  return {
    date: (year - 1980) << 9 | (value.getMonth() + 1) << 5 | value.getDate(),
    time: value.getHours() << 11 | value.getMinutes() << 5 | Math.floor(value.getSeconds() / 2),
  };
}

function assertZip32(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_ZIP32_VALUE) {
    throw new Error(`${label} is te groot voor het ZIP-formaat.`);
  }
}

function localHeader(name: Buffer, date: number, time: number): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(UTF8_WITH_DESCRIPTOR, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(time, 10);
  header.writeUInt16LE(date, 12);
  header.writeUInt16LE(name.length, 26);
  return Buffer.concat([header, name]);
}

function dataDescriptor(crc32: number, size: number): Buffer {
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(crc32, 4);
  descriptor.writeUInt32LE(size, 8);
  descriptor.writeUInt32LE(size, 12);
  return descriptor;
}

function centralHeader(entry: CentralEntry): Buffer {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(UTF8_WITH_DESCRIPTOR, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(entry.dosTime, 12);
  header.writeUInt16LE(entry.dosDate, 14);
  header.writeUInt32LE(entry.crc32, 16);
  header.writeUInt32LE(entry.size, 20);
  header.writeUInt32LE(entry.size, 24);
  header.writeUInt16LE(entry.name.length, 28);
  header.writeUInt32LE(entry.localOffset, 42);
  return Buffer.concat([header, entry.name]);
}

export class ZipWriter {
  private constructor(private readonly file: FileHandle) {}

  private offset = 0;
  private readonly entries: CentralEntry[] = [];
  private closed = false;

  static async create(filePath: string): Promise<ZipWriter> {
    return new ZipWriter(await open(filePath, "w"));
  }

  private async write(bytes: Uint8Array) {
    let written = 0;
    while (written < bytes.byteLength) {
      const result = await this.file.write(bytes, written, bytes.byteLength - written, this.offset + written);
      if (result.bytesWritten <= 0) throw new Error("Schrijven naar het ZIP-archief is mislukt.");
      written += result.bytesWritten;
    }
    this.offset += written;
    assertZip32(this.offset, "Het archief");
  }

  private async startEntry(nameValue: string, modifiedAt: Date) {
    if (this.closed) throw new Error("Het ZIP-archief is al gesloten.");
    const name = Buffer.from(nameValue.replaceAll("\\", "/"), "utf8");
    if (!name.length || name.length > 0xffff) throw new Error("Ongeldige bestandsnaam in het ZIP-archief.");
    const timestamp = dosTimestamp(modifiedAt);
    const localOffset = this.offset;
    await this.write(localHeader(name, timestamp.date, timestamp.time));
    return { name, localOffset, dosDate: timestamp.date, dosTime: timestamp.time };
  }

  private async finishEntry(entry: Omit<CentralEntry, "crc32" | "size">, crc: number, size: number) {
    assertZip32(size, "Een bestand in het archief");
    const crc32 = (crc ^ 0xffffffff) >>> 0;
    await this.write(dataDescriptor(crc32, size));
    this.entries.push({ ...entry, crc32, size });
  }

  async addBuffer(name: string, value: Uint8Array | string, modifiedAt = new Date()) {
    const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
    const entry = await this.startEntry(name, modifiedAt);
    const crc = updateCrc32(0xffffffff, bytes);
    await this.write(bytes);
    await this.finishEntry(entry, crc, bytes.byteLength);
  }

  async addFile(name: string, filePath: string, modifiedAt = new Date()) {
    const entry = await this.startEntry(name, modifiedAt);
    let crc = 0xffffffff;
    let size = 0;
    for await (const chunk of createReadStream(filePath)) {
      const bytes = chunk as Buffer;
      crc = updateCrc32(crc, bytes);
      size += bytes.byteLength;
      assertZip32(size, "Een bestand in het archief");
      await this.write(bytes);
    }
    await this.finishEntry(entry, crc, size);
  }

  async close() {
    if (this.closed) return;
    try {
      const centralOffset = this.offset;
      for (const entry of this.entries) await this.write(centralHeader(entry));
      const centralSize = this.offset - centralOffset;
      if (this.entries.length > 0xffff) throw new Error("Het ZIP-archief bevat te veel bestanden.");
      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0);
      end.writeUInt16LE(this.entries.length, 8);
      end.writeUInt16LE(this.entries.length, 10);
      end.writeUInt32LE(centralSize, 12);
      end.writeUInt32LE(centralOffset, 16);
      await this.write(end);
      await this.file.sync();
      this.closed = true;
    } finally {
      await this.file.close();
    }
  }

  async abort() {
    if (this.closed) return;
    this.closed = true;
    await this.file.close();
  }
}
