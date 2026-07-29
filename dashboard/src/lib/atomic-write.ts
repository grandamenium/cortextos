/**
 * The dashboard's single point of coupling to the framework's atomic file write.
 *
 * Follows `file-lock.ts`, and for the same reason: this RE-EXPORTS
 * `src/utils/atomic.ts` rather than reimplementing temp-file-plus-rename.  A
 * dashboard-local copy would drift from the CLI's copy in exactly the details
 * that matter — the temp file's directory (a rename is only atomic within one
 * filesystem), its mode, and whether the payload gets a trailing newline.
 *
 * WHAT THE GUARANTEE ACTUALLY IS.  `atomicWriteSync` writes a temp file in the
 * target's own directory and renames it over the target.  A reader therefore
 * never observes a partially-written file: it sees either the whole old
 * contents or the whole new contents.  It does NOT fsync the file or the
 * directory, so this is NOT durability against power loss — post-crash the
 * rename may not have reached disk.  The claim is "no torn read", nothing
 * stronger.  Say it that way.
 *
 * Two behaviours callers get wrong, both silent:
 *   - it appends its own trailing "\n", so callers must NOT add one;
 *   - the temp file is created mode 0o600 and rename preserves that, so a file
 *     that was 0644 becomes 0600 the first time it is written this way.
 */
export { atomicWriteSync, ensureDir } from '../../../src/utils/atomic';
