/**
 * Zotero adapter (CLI only — uses bun:sqlite). Opens the database read-only
 * (mode=ro, WAL replayed; never writable, never immutable) and implements the
 * core LocalLibrary interface.
 */
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LocalHit, LocalLibrary, RefEntry } from "./core/types.ts";
import { normDoi, titleSim } from "./core/match.ts";

export class ZoteroLibrary implements LocalLibrary {
  private db: Database;
  private baseAttachmentPath: string;
  private dataDir: string;

  constructor(sqlitePath?: string, dataDir?: string) {
    const p = sqlitePath ?? join(homedir(), "Zotero", "zotero.sqlite");
    if (!existsSync(p)) throw new Error(`Zotero DB not found at ${p}`);
    this.db = new Database(`file:${p}?mode=ro`, { readonly: true });
    this.dataDir = dataDir ?? join(p, "..");
    this.baseAttachmentPath = findBaseAttachmentPath(this.dataDir);
  }

  lookup(entry: RefEntry): LocalHit | null {
    if (entry.doi) {
      for (const id of this.fieldQuery("DOI", entry.doi, false)) {
        const item = this.item(id);
        if (normDoi(item.doi) === entry.doi) return item;
      }
    }
    if (entry.title) {
      for (const id of this.fieldQuery("title", entry.title, true)) return this.item(id);
      for (const id of this.fieldQuery("title", entry.title.slice(0, 60), false)) {
        const item = this.item(id);
        if (titleSim(item.title, entry.title) >= 0.75) return item;
      }
    }
    return null;
  }

  private fieldQuery(field: string, value: string, exact: boolean): number[] {
    const rows = this.db
      .query(
        `SELECT id.itemID FROM itemData id
         JOIN fields f ON f.fieldID = id.fieldID
         JOIN itemDataValues v ON v.valueID = id.valueID
         WHERE f.fieldName = ? AND ${exact ? "LOWER(v.value) = ?" : "v.value LIKE ?"}
         LIMIT 5`,
      )
      .all(field, exact ? value.toLowerCase() : `%${value}%`) as { itemID: number }[];
    return rows.map((r) => r.itemID);
  }

  private item(itemID: number): LocalHit {
    const fields = Object.fromEntries(
      (
        this.db
          .query(
            `SELECT f.fieldName, v.value FROM itemData id
             JOIN fields f ON f.fieldID = id.fieldID
             JOIN itemDataValues v ON v.valueID = id.valueID
             WHERE id.itemID = ?`,
          )
          .all(itemID) as { fieldName: string; value: string }[]
      ).map((r) => [r.fieldName, r.value]),
    );
    const authors = (
      this.db
        .query(
          `SELECT c.lastName FROM itemCreators ic
           JOIN creators c ON c.creatorID = ic.creatorID
           WHERE ic.itemID = ? ORDER BY ic.orderIndex`,
        )
        .all(itemID) as { lastName: string }[]
    ).map((r) => r.lastName);
    const att = this.db
      .query(
        `SELECT ia.path, i.key FROM itemAttachments ia
         JOIN items i ON i.itemID = ia.itemID
         WHERE ia.parentItemID = ? AND ia.contentType = 'application/pdf' AND ia.path IS NOT NULL
         LIMIT 1`,
      )
      .get(itemID) as { path: string; key: string } | null;
    let pdf: string | null = null;
    if (att?.path) {
      if (att.path.startsWith("attachments:"))
        pdf = join(this.baseAttachmentPath, att.path.slice("attachments:".length));
      else if (att.path.startsWith("storage:"))
        pdf = join(this.dataDir, "storage", att.key, att.path.slice("storage:".length));
      else pdf = att.path;
    }
    return {
      id: itemID,
      title: fields["title"] ?? "",
      year: (fields["date"] ?? "").match(/\d{4}/)?.[0] ?? "",
      journal: fields["publicationTitle"] ?? "",
      doi: normDoi(fields["DOI"] ?? ""),
      authors,
      pdf,
    };
  }
}

/** Linked-file attachments resolve against Zotero's baseAttachmentPath pref, not the data dir. */
function findBaseAttachmentPath(dataDir: string): string {
  const candidates = [join(dataDir, "prefs.js")];
  for (const profileRoot of [
    join(homedir(), "Library", "Application Support", "Zotero", "Profiles"), // macOS
    join(homedir(), ".zotero", "zotero"), // Linux
    join(homedir(), "AppData", "Roaming", "Zotero", "Zotero", "Profiles"), // Windows
  ]) {
    try {
      for (const d of readdirSync(profileRoot)) candidates.push(join(profileRoot, d, "prefs.js"));
    } catch {}
  }
  for (const p of candidates) {
    try {
      const m = readFileSync(p, "utf8").match(/baseAttachmentPath",\s*"([^"]+)"/);
      if (m) return m[1]!;
    } catch {}
  }
  return dataDir;
}
