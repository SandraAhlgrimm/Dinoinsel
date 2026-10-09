import { StoreConflict } from "../../src/errors.js";
import type { Room, RoomStore, VersionedRoom } from "../../src/model.js";

export class MemoryStore implements RoomStore {
  private readonly data = new Map<string, VersionedRoom>();
  private sequence = 0;
  replaceAttempts = 0;
  failNextReplaces = 0;
  beforeReplace: (() => Promise<void>) | undefined;

  async read(roomId: string): Promise<VersionedRoom | undefined> {
    const stored = this.data.get(roomId);
    return stored === undefined ? undefined : structuredClone(stored);
  }

  async create(room: Room): Promise<void> {
    if (this.data.has(room.id)) throw new StoreConflict();
    this.save(room);
  }

  async replace(room: Room, etag: string): Promise<void> {
    this.replaceAttempts++;
    if (this.beforeReplace) {
      const hook = this.beforeReplace;
      this.beforeReplace = undefined;
      await hook();
    }
    if (this.failNextReplaces > 0) {
      this.failNextReplaces--;
      throw new StoreConflict();
    }
    if (this.data.get(room.id)?.etag !== etag) throw new StoreConflict();
    this.save(room);
  }

  async remove(roomId: string, etag: string): Promise<void> {
    if (this.data.get(roomId)?.etag !== etag) throw new StoreConflict();
    this.data.delete(roomId);
  }

  private save(room: Room): void {
    this.data.set(room.id, { room: structuredClone(room), etag: `W/"${++this.sequence}"` });
  }
}
