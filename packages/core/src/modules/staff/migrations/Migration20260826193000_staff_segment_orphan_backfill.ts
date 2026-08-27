import { Migration } from '@mikro-orm/migrations';

/**
 * Hand-written data migration: no schema change, so the generator cannot emit it
 * and the ORM snapshot is unaffected.
 *
 * Soft-deleting a time entry never cascaded to its work segments, so every entry
 * deleted before that fix left segments with `deleted_at = NULL` pointing at a
 * deleted parent — some of them still open (`ended_at = NULL`). This adopts the
 * parent's `deleted_at` rather than `now()` so the timestamps stay coherent, and
 * deliberately does not collide with the recorded-instant restore path, since no
 * action log written before the fix carries `segmentsDeletedAt`.
 *
 * Size the affected rows before applying:
 *
 *   select count(*) from staff_time_entry_segments s
 *   join staff_time_entries e on e.id = s.time_entry_id
 *   where e.deleted_at is not null and s.deleted_at is null;
 */
export class Migration20260826193000_staff_segment_orphan_backfill extends Migration {

  override async up(): Promise<void> {
    this.addSql(`update "staff_time_entry_segments" s
      set "deleted_at" = e."deleted_at",
          "ended_at"   = coalesce(s."ended_at", e."ended_at", e."deleted_at"),
          "updated_at" = now()
      from "staff_time_entries" e
      where s."time_entry_id" = e."id"
        and e."deleted_at" is not null
        and s."deleted_at" is null;`);
  }

  override async down(): Promise<void> {
    // Not reversible: a rolled-back backfill cannot tell the rows it stamped from
    // the ones the cascade has since stamped legitimately, and both carry their
    // parent's timestamp. Leaving it applied is safe — every row it touched has a
    // parent that is already soft-deleted, so no scoped read returns them.
  }

}
