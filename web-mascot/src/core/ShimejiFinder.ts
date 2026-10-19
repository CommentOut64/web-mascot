import { unzipSync } from "fflate/browser";
import { translateShimejiXml } from "./Translator.js";
import { DEFAULT_ACTIONS_XML, DEFAULT_BEHAVIORS_XML } from "./defaultXmls.js";
import type { MascotPack, MascotPackMeta } from "./PackRegistry.js";

export interface ShimejiWarning {
  type: "missing_sprite" | "unsupported_action" | "encoding_fallback" | "xml_syntax" | "general";
  message: string;
  data?: unknown;
}

export interface ImportOptions {
  /** Explicit mascot name. If omitted, will be inferred from folder/file name. */
  name?: string;
  /** Whether to replace a built-in model if the name matches. Default true. */
  replaceBuiltin?: boolean;
  /** Preferred text encoding for XML/filenames (e.g. "utf-8", "shift-jis", "gbk"). */
  encoding?: string;
  /** Custom warning handler. If omitted, warnings are logged via console.warn. */
  onWarning?: (warning: ShimejiWarning) => void;
}

export interface ShimejiFinderResult extends MascotPack {
  warnings: ShimejiWarning[];
}

const ACTIONS_ALIASES = ["actions.xml", "動作.xml", "action.xml", "one.xml", "1.xml"];
const BEHAVIORS_ALIASES = ["behaviors.xml", "行動.xml", "behavior.xml", "two.xml", "2.xml"];

const BLACKLISTED_FOLDER_NAMES = new Set([
  "img",
  "conf",
  "shimeji",
  "shimeji-ee",
  "shimejiee",
  "unused",
  "src",
  "sound",
  "bin",
  "",
  ".",
  "..",
]);

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "");
}

function getBasename(p: string): string {
  const norm = normalizePath(p);
  const idx = norm.lastIndexOf("/");
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

function getDirname(p: string): string {
  const norm = normalizePath(p);
  const idx = norm.lastIndexOf("/");
  return idx >= 0 ? norm.slice(0, idx) : "";
}

export function normalizeSpriteKey(image: string): string {
  let clean = image.replace(/^[/\\]+/, "").trim();
  if (clean.toLowerCase().startsWith("img/")) {
    clean = clean.slice(4).replace(/^[/\\]+/, "");
  }
  if (!/\.(png|gif|webp)$/i.test(clean)) {
    clean += ".png";
  }
  return clean.toLowerCase();
}

function decodeText(bytes: Uint8Array, preferredEncoding?: string): string {
  if (preferredEncoding) {
    try {
      return new TextDecoder(preferredEncoding).decode(bytes);
    } catch {
      // fallback to auto-detection below
    }
  }
  // Try UTF-8 first (strict mode: throws on invalid bytes)
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // If invalid UTF-8, fall back to Shift-JIS for classic Japanese Shimeji packs
    try {
      return new TextDecoder("shift-jis").decode(bytes);
    } catch {
      return new TextDecoder("utf-8").decode(bytes);
    }
  }
}

/**
 * Scan XML to collect all referenced image paths (<Pose Image="..."> and <ポーズ 画像="...">)
 */
function extractReferencedImages(xmlText: string): Set<string> {
  const paths = new Set<string>();
  const translated = translateShimejiXml(xmlText);
  const clean = translated.replace(/xmlns=".*?"/g, "");

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(clean, "text/xml");
    const poseNodes = Array.from(doc.getElementsByTagName("Pose"));
    for (const pose of poseNodes) {
      const img = pose.getAttribute("Image") || pose.getAttribute("ImageRight");
      if (img) {
        paths.add(img.trim());
      }
    }
  } catch {
    // If DOMParser fails, fallback to regex scanning
    const matches = clean.matchAll(/(?:Image|ImageRight)=["']([^"']+)["']/g);
    for (const m of matches) {
      if (m[1]) paths.add(m[1].trim());
    }
  }

  return paths;
}

/**
 * Pure TypeScript ShimejiFinder.
 * Analyzes and extracts Shimeji / Shimeji-ee packs from in-memory ZIP archives.
 */
export class ShimejiFinder {
  /**
   * Parse a mascot archive from various input sources.
   */
  public static async analyze(
    source: File | Blob | ArrayBuffer | Uint8Array | string,
    options?: ImportOptions,
  ): Promise<ShimejiFinderResult> {
    const warnings: ShimejiWarning[] = [];
    const emitWarning = (warning: ShimejiWarning) => {
      warnings.push(warning);
      if (options?.onWarning) {
        options.onWarning(warning);
      } else {
        console.warn(`[ShimejiFinder] ${warning.message}`);
      }
    };

    let rawBytes: Uint8Array;

    if (typeof source === "string") {
      // URL input: fetch the archive bytes
      const response = await fetch(source);
      if (!response.ok) {
        throw new Error(`[ShimejiFinder] Failed to fetch mascot pack from URL: ${source} (${response.status})`);
      }
      const buffer = await response.arrayBuffer();
      rawBytes = new Uint8Array(buffer);
    } else if (typeof Blob !== "undefined" && (source instanceof Blob || (source && typeof (source as any).arrayBuffer === "function" && !(source instanceof ArrayBuffer)))) {
      // File or Blob input
      const buffer = await (source as any).arrayBuffer();
      rawBytes = new Uint8Array(buffer);
    } else if (ArrayBuffer.isView(source)) {
      rawBytes = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    } else if (source instanceof ArrayBuffer || (source && Object.prototype.toString.call(source) === "[object ArrayBuffer]")) {
      rawBytes = new Uint8Array(source as ArrayBuffer);
    } else {
      throw new Error("[ShimejiFinder] Invalid input source type");
    }

    // 1. Unzip archive in memory
    let unzipped: Record<string, Uint8Array>;
    try {
      unzipped = unzipSync(rawBytes);
    } catch (err) {
      throw new Error(`[ShimejiFinder] Failed to decompress archive: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Index all entries with normalized paths
    const files = new Map<string, Uint8Array>();
    for (const [rawPath, bytes] of Object.entries(unzipped)) {
      if (rawPath.endsWith("/")) continue; // skip directories
      const norm = normalizePath(rawPath);
      files.set(norm, bytes);
    }

    // 2. Discover actions.xml and behaviors.xml pairs
    let actionsPath: string | null = null;
    let behaviorsPath: string | null = null;
    let configDir = "";

    // Candidate search
    for (const [path] of files.entries()) {
      const base = getBasename(path).toLowerCase();
      if (ACTIONS_ALIASES.includes(base) && !actionsPath) {
        actionsPath = path;
      }
      if (BEHAVIORS_ALIASES.includes(base) && !behaviorsPath) {
        behaviorsPath = path;
      }
    }

    // Inferred pack name
    let inferredName = options?.name;
    if (!inferredName && actionsPath) {
      configDir = getDirname(actionsPath);
      const segments = configDir.split("/").filter(Boolean);
      for (let i = segments.length - 1; i >= 0; i--) {
        const seg = segments[i].toLowerCase();
        if (!BLACKLISTED_FOLDER_NAMES.has(seg)) {
          inferredName = segments[i];
          break;
        }
      }
    }

    // Try inferring from sprite subdirectories (e.g. img/Shimeji/, img/KuroShimeji/, characters/Ayaka/)
    if (!inferredName) {
      for (const filePath of files.keys()) {
        const match = filePath.match(/(?:^|\/)(?:img|characters)\/([^/]+)\//i);
        if (match && match[1]) {
          const candidate = match[1];
          if (!["unused", "conf", "img", "src", "bin"].includes(candidate.toLowerCase())) {
            inferredName = candidate;
            break;
          }
        }
      }
    }

    // Try inferring from source (File name or URL)
    if (!inferredName) {
      if (typeof source === "string") {
        const urlBase = getBasename(source.split("?")[0]).replace(/\.[^/.]+$/, "");
        if (urlBase && !BLACKLISTED_FOLDER_NAMES.has(urlBase.toLowerCase())) {
          inferredName = urlBase;
        }
      } else if (typeof File !== "undefined" && source instanceof File && source.name) {
        inferredName = source.name.replace(/\.[^/.]+$/, "");
      }
    }

    // Fallback name if none found
    if (!inferredName) {
      inferredName = "CustomMascot";
    }

    const sprites = new Map<string, string>();
    let actionsXml = "";
    let behaviorsXml = "";
    let meta: MascotPackMeta | undefined;

    // Read metadata if info.json exists
    for (const [path, bytes] of files.entries()) {
      if (getBasename(path).toLowerCase() === "info.json") {
        try {
          const infoText = decodeText(bytes, options?.encoding);
          meta = JSON.parse(infoText) as MascotPackMeta;
        } catch {
          // ignore JSON parse error
        }
        break;
      }
    }

    if (actionsPath && behaviorsPath) {
      // CASE 1: Standard pack with XML definitions
      const actionsBytes = files.get(actionsPath)!;
      const behaviorsBytes = files.get(behaviorsPath)!;

      actionsXml = translateShimejiXml(decodeText(actionsBytes, options?.encoding));
      behaviorsXml = translateShimejiXml(decodeText(behaviorsBytes, options?.encoding));

      const referencedImages = extractReferencedImages(actionsXml);

      // Search and map every referenced image into sprites
      for (const refImg of referencedImages) {
        const refBase = getBasename(refImg).toLowerCase();
        const normKey = normalizeSpriteKey(refImg);

        // Find file matching refBase or normKey in files
        let matchedBytes: Uint8Array | undefined;

        // Try exact/relative match first
        for (const [filePath, bytes] of files.entries()) {
          const fileBase = getBasename(filePath).toLowerCase();
          if (fileBase === refBase || fileBase === normKey) {
            matchedBytes = bytes;
            break;
          }
        }

        if (matchedBytes) {
          const blob = new Blob([matchedBytes as unknown as BlobPart], { type: "image/png" });
          const blobUrl = URL.createObjectURL(blob);
          sprites.set(normKey, blobUrl);
          sprites.set(refImg, blobUrl);
          sprites.set(refBase, blobUrl);
        } else {
          emitWarning({
            type: "missing_sprite",
            message: `Sprite referenced in XML but not found in archive: "${refImg}"`,
            data: { image: refImg },
          });
        }
      }

      // Also map all other PNG images in the archive as extra/direct poses
      for (const [filePath, bytes] of files.entries()) {
        const fileBase = getBasename(filePath).toLowerCase();
        if (fileBase.endsWith(".png")) {
          const normKey = normalizeSpriteKey(fileBase);
          if (!sprites.has(normKey)) {
            const blob = new Blob([bytes as unknown as BlobPart], { type: "image/png" });
            const blobUrl = URL.createObjectURL(blob);
            sprites.set(normKey, blobUrl);
            sprites.set(fileBase, blobUrl);
          }
        }
      }
    } else {
      // CASE 2: No XML found. Check for classic 46-frame skin pack (shime1.png ~ shime46.png)
      const shimeMap = new Map<number, Uint8Array>();
      let hasShime47 = false;

      for (const [filePath, bytes] of files.entries()) {
        const fileBase = getBasename(filePath).toLowerCase();
        const match = fileBase.match(/^shime(\d+)\.png$/);
        if (match) {
          const num = parseInt(match[1], 10);
          if (num === 47) hasShime47 = true;
          shimeMap.set(num, bytes);
        }
      }

      // If at least shime1.png ~ shime46.png exist and not a larger custom set
      if (shimeMap.size >= 46 && !hasShime47) {
        actionsXml = DEFAULT_ACTIONS_XML;
        behaviorsXml = DEFAULT_BEHAVIORS_XML;

        for (let i = 1; i <= 46; i++) {
          const bytes = shimeMap.get(i);
          if (bytes) {
            const blob = new Blob([bytes as unknown as BlobPart], { type: "image/png" });
            const blobUrl = URL.createObjectURL(blob);
            const namePng = `shime${i}.png`;
            sprites.set(namePng, blobUrl);
            sprites.set(`/shime${i}.png`, blobUrl);
          }
        }
      } else {
        throw new Error(
          `[ShimejiFinder] Could not find valid Shimeji configurations (actions.xml/behaviors.xml) or a complete 46-frame sprite set in the archive.`
        );
      }
    }

    return {
      name: inferredName,
      actionsXml,
      behaviorsXml,
      sprites,
      meta,
      warnings,
    };
  }
}
