/**
 * Registry and virtual asset router for custom and in-memory mascot packs.
 *
 * Decouples the engine from the static HTTP pack root by allowing in-memory
 * virtual packs (from zip files, blobs, or dynamic generation) to be registered
 * and routed transparently.
 */

export interface MascotPackMeta {
  author?: string;
  description?: string;
  version?: string;
  license?: string;
}

export interface MascotPack {
  /** Unique mascot key/identifier, e.g. "Kitten" or "Neuron" */
  name: string;
  /** Normalized actions XML string */
  actionsXml: string;
  /** Normalized behaviors XML string */
  behaviorsXml: string;
  /** Normalized image path (e.g. "shime1.png") -> Blob URL or Data URL */
  sprites: Map<string, string>;
  /** Optional pack metadata */
  meta?: MascotPackMeta;
}

export class PackRegistry {
  private static packs = new Map<string, MascotPack>();

  /**
   * Register a custom mascot pack in memory.
   * If a pack with the same name already exists, its previous blob URLs will be revoked.
   */
  public static register(pack: MascotPack): void {
    if (!pack || !pack.name) {
      throw new Error("[web-mascot] Cannot register a pack without a name");
    }
    // Clean up previous registration of the same name if exists
    this.unregister(pack.name);
    this.packs.set(pack.name, pack);
  }

  /**
   * Retrieve a registered in-memory pack.
   */
  public static get(name: string): MascotPack | undefined {
    return this.packs.get(name);
  }

  /**
   * Check if an in-memory pack is registered.
   */
  public static has(name: string): boolean {
    return this.packs.has(name);
  }

  /**
   * Unregister an in-memory pack and release any Blob URLs it created to prevent memory leaks.
   */
  public static unregister(name: string): boolean {
    const pack = this.packs.get(name);
    if (!pack) return false;

    // Revoke any blob: URLs created for this pack
    for (const url of pack.sprites.values()) {
      if (typeof url === "string" && url.startsWith("blob:")) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // ignore revocation errors
        }
      }
    }

    return this.packs.delete(name);
  }

  /**
   * Clear all registered in-memory packs and revoke all associated Blob URLs.
   */
  public static clear(): void {
    for (const name of Array.from(this.packs.keys())) {
      this.unregister(name);
    }
  }

  /**
   * List all currently registered pack names.
   */
  public static list(): string[] {
    return Array.from(this.packs.keys());
  }
}

