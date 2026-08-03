import { mkdir, readdir, stat, statfs } from "node:fs/promises";
import path from "node:path";

export const STORAGE_ROOT = path.resolve(process.env.STORAGE_DIR ?? process.env.AUDIO_STORAGE_DIR ?? path.join(process.cwd(), "storage"));
const BACKUP_ROOT = path.resolve(process.env.BACKUP_DIR ?? path.join(STORAGE_ROOT, "backups"));
const DEFAULT_MINIMUM_FREE_BYTES = 512 * 1024 * 1024;

export type StorageHealth = {
  usedBytes: number;
  availableBytes: number;
  quotaBytes: number | null;
  remainingBytes: number;
  minimumFreeBytes: number;
  backupDirectory: string;
  lastBackupAt: string | null;
};

function positiveNumber(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function quotaBytes(): number | null {
  const gigabytes = positiveNumber(process.env.STORAGE_QUOTA_GB);
  return gigabytes ? Math.floor(gigabytes * 1024 ** 3) : null;
}

function minimumFreeBytes(): number {
  const megabytes = positiveNumber(process.env.MIN_FREE_STORAGE_MB);
  return megabytes ? Math.floor(megabytes * 1024 ** 2) : DEFAULT_MINIMUM_FREE_BYTES;
}

async function directorySize(directory: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  const sizes = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return directorySize(entryPath);
    if (!entry.isFile()) return 0;
    return (await stat(entryPath)).size;
  }));
  return sizes.reduce((sum, size) => sum + size, 0);
}

async function latestFileTime(directory: string): Promise<number | null> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const values = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return latestFileTime(entryPath);
    if (!entry.isFile()) return null;
    return (await stat(entryPath)).mtimeMs;
  }));
  const timestamps = values.filter((value): value is number => value !== null);
  return timestamps.length ? Math.max(...timestamps) : null;
}

export async function getStorageHealth(storageRoot = STORAGE_ROOT, backupRoot = storageRoot === STORAGE_ROOT ? BACKUP_ROOT : path.join(storageRoot, "backups")): Promise<StorageHealth> {
  await mkdir(storageRoot, { recursive: true });
  const [usedBytes, fileSystem, lastBackup] = await Promise.all([
    directorySize(storageRoot),
    statfs(storageRoot),
    latestFileTime(backupRoot),
  ]);
  const availableBytes = Number(fileSystem.bavail) * Number(fileSystem.bsize);
  const quota = quotaBytes();
  const remainingBytes = Math.max(0, Math.min(availableBytes, quota === null ? availableBytes : quota - usedBytes));
  return {
    usedBytes,
    availableBytes,
    quotaBytes: quota,
    remainingBytes,
    minimumFreeBytes: minimumFreeBytes(),
    backupDirectory: backupRoot,
    lastBackupAt: lastBackup === null ? null : new Date(lastBackup).toISOString(),
  };
}

export async function assertStorageCapacity(additionalBytes: number, storageRoot = STORAGE_ROOT): Promise<void> {
  if (!Number.isFinite(additionalBytes) || additionalBytes < 0) throw new Error("Ongeldige opslagberekening.");
  const health = await getStorageHealth(storageRoot);
  if (health.quotaBytes !== null && health.usedBytes + additionalBytes > health.quotaBytes) {
    throw new Error("De ingestelde opslaglimiet is bereikt. Maak eerst ruimte vrij of verhoog STORAGE_QUOTA_GB.");
  }
  if (health.availableBytes - additionalBytes < health.minimumFreeBytes) {
    throw new Error("De server heeft onvoldoende vrije schijfruimte voor deze bewerking.");
  }
}
