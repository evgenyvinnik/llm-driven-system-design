# File System: Practice Spec

A four-level practice problem in the format of a timed online coding assessment: one problem that grows over four levels, about 90 minutes, and tests you can't see. You unlock the next level only when the current one passes, so you can't read ahead.

**This spec was written for this repository.** It reconstructs the *format* of such an assessment and the themes reported for it (files, queries, users with quotas, history). It is not a copy of any real assessment, and its method names, rules and examples are this repository's own.

To practice it the way it is meant to be practiced, don't read past level 1. Run `npm run practice -- start` in `backend/`. The tool hands you one level at a time and keeps the clock (see [README.md](./README.md#practice-mode)).

<!-- practice:rules -->
## Rules for Every Level

Implement a class `FileStore`. Each level adds methods. Every earlier method must keep working, and some gain new rules in later levels.

**Paths.**
- A path starts with `/` and is made of non-empty segments separated by `/`, with no trailing slash: `/docs/notes.txt`.
- `/` on its own is the root directory. It is never a file.
- Tests only pass well-formed paths, so you don't need to validate them.

**Directories are implicit.** You never create a directory. A directory exists while at least one file is stored somewhere below it, and disappears with its last file. The root always exists.

**A path is a file or a directory, never both.** A file can't be stored:
- at a path that is already a file;
- at a path that is an existing directory (adding `/a` fails while `/a/b.txt` exists);
- below a path that is a file (adding `/a/b.txt/c` fails while `/a/b.txt` is a file).

**Sizes** are non-negative integers, in bytes. Zero is allowed.

**Return values.** "Fails" means the method returns `false` or `null`, as its signature says, and **changes nothing**. No method throws for an expected failure.
<!-- /practice:rules -->

<!-- practice:level:1 -->
## Level 1: Files

| Method | Returns |
|--------|---------|
| `addFile(path, size)` | `true` if the file was created. `false` if the path is unavailable under the rules above |
| `getSize(path)` | The file's size, or `null` if no file is stored at `path`. A directory is not a file |
| `updateFile(path, size)` | The file's **previous** size after setting the new one, or `null` if no file is stored at `path` |
| `deleteFile(path)` | The deleted file's size, or `null` if no file is stored at `path` |

**Example.**

| Call | Result | Why |
|------|--------|-----|
| `addFile("/docs/a.txt", 100)` | `true` | |
| `addFile("/docs/a.txt", 5)` | `false` | Already a file |
| `addFile("/docs", 5)` | `false` | `/docs` is a directory |
| `addFile("/docs/a.txt/x", 5)` | `false` | `/docs/a.txt` is a file |
| `getSize("/docs")` | `null` | A directory, not a file |
| `updateFile("/docs/a.txt", 250)` | `100` | The previous size |
| `deleteFile("/docs/a.txt")` | `250` | |
| `addFile("/docs", 5)` | `true` | `/docs` disappeared with its last file |
<!-- /practice:level:1 -->

<!-- practice:level:2 -->
## Level 2: Queries

| Method | Returns |
|--------|---------|
| `listDir(path)` | The names directly inside directory `path`, or `null` if `path` is not an existing directory. Files appear as their name; subdirectories as their name plus `/`. `listDir("/")` always returns a list, possibly empty |
| `dirSize(path)` | The total size of every file anywhere below directory `path`, or `null` if `path` is not an existing directory. `dirSize("/")` is `0` when empty |
| `largest(prefix, n)` | Up to `n` files whose full path **starts with the string** `prefix`, formatted `"<path>(<size>)"` |

**Ordering.**
- `listDir` sorts by name **without** the trailing `/`, comparing strings by plain code-unit order (the default sort in JavaScript and Python). So `b/` comes before `b.txt`, because `b` < `b.txt`.
- `largest` sorts by size, largest first, then by path in code-unit order for equal sizes. If `n` is larger than the number of matches, return them all. If `n` ≤ 0, return an empty list.

**Prefix versus directory.** `largest` matches plain strings, so the prefix `/a/b` matches `/a/bc.txt`. `dirSize` is directory-aware, so `dirSize("/a/b")` does **not** count `/a/bc.txt`.

**Example.** Starting empty:

| Call | Result |
|------|--------|
| `addFile("/a/b.txt", 10)`, `addFile("/a/b/c.txt", 30)`, `addFile("/a/bc.txt", 30)` | `true` each time |
| `listDir("/a")` | `["b/", "b.txt", "bc.txt"]` |
| `listDir("/a/b.txt")` | `null` |
| `dirSize("/a/b")` | `30` |
| `largest("/a/b", 2)` | `["/a/b/c.txt(30)", "/a/bc.txt(30)"]` |
| `largest("/zzz", 5)` | `[]` |
<!-- /practice:level:2 -->

<!-- practice:level:3 -->
## Level 3: Users and Quotas

Files now have owners, and every user has a **capacity** in bytes. A user's **used** bytes are the total size of the files they own, and used may never exceed capacity.

Files created with level 1's `addFile` have **no owner** and count against no one.

| Method | Returns |
|--------|---------|
| `addUser(userId, capacity)` | `true` if created. `false` if `userId` already exists |
| `addFileAs(userId, path, size)` | The user's **remaining** capacity (capacity − used) after the file is created. `null` if the user doesn't exist, the path is unavailable, or the file would take the user over capacity |
| `getRemaining(userId)` | Capacity − used, or `null` if the user doesn't exist |
| `mergeUsers(targetId, sourceId)` | The target's remaining capacity after the merge. `null` if either user doesn't exist or they are the same user |

**`mergeUsers`** moves ownership of every file of `sourceId` to `targetId`, adds the source's capacity to the target's and deletes `sourceId`. Afterwards `addUser(sourceId, …)` succeeds again.

**Earlier methods gain rules.**
- `updateFile` on an owned file **fails** (returns `null`, changes nothing) if the new size would take the owner over capacity. Shrinking always succeeds.
- `deleteFile` frees the owner's bytes.

**Example.**

| Call | Result | Why |
|------|--------|-----|
| `addUser("ana", 100)` | `true` | |
| `addFileAs("ana", "/ana/a", 60)` | `40` | |
| `addFileAs("ana", "/ana/b", 50)` | `null` | 60 + 50 > 100 |
| `updateFile("/ana/a", 120)` | `null` | Over capacity; `/ana/a` stays 60 |
| `addUser("ben", 30)`, `addFileAs("ben", "/ben/x", 10)` | `true`, `20` | |
| `mergeUsers("ana", "ben")` | `60` | Capacity 130, used 70 |
| `getRemaining("ben")` | `null` | Merged away |
<!-- /practice:level:3 -->

<!-- practice:level:4-backup -->
## Level 4: Backup and Restore

| Method | Returns |
|--------|---------|
| `backupUser(userId)` | The number of files in the new backup, or `null` if the user doesn't exist |
| `restoreUser(userId)` | The number of files restored, or `null` if the user doesn't exist |

**`backupUser`** records the path and size of every file the user owns right now. It replaces that user's previous backup. A later change to the files doesn't change the backup.

**`restoreUser`** puts the user's files back the way the backup recorded them:
1. Delete every file the user currently owns.
2. Re-create each backed-up file, owned by the user, **unless its path is now unavailable** because of a file the user doesn't own: another user's, or an unowned one. Skip those paths.
3. If the user has no backup, step 1 still happens and the result is `0`.

A restore can't exceed capacity: the backup fit when it was taken, and capacity never shrinks.

**Merging.** `mergeUsers` discards the **source's** backup. The target keeps its own backup, which doesn't include the merged files, so restoring the target afterwards deletes them.

**Example.**

| Call | Result | Why |
|------|--------|-----|
| `addUser("ana", 100)`, `addFileAs("ana", "/p/a", 10)`, `addFileAs("ana", "/p/b", 20)` | | |
| `backupUser("ana")` | `2` | |
| `deleteFile("/p/a")`, `addFileAs("ana", "/p/c", 5)` | | |
| `addFile("/p/a", 1)` | `true` | An unowned file now holds `/p/a` |
| `restoreUser("ana")` | `1` | `/p/c` deleted, `/p/b` restored, `/p/a` skipped |
| `getSize("/p/a")` | `1` | The unowned file is untouched |
<!-- /practice:level:4-backup -->

<!-- practice:level:4-time -->
## Level 4: Time

A clock starts at `0`. Every operation happens at the current time.

| Method | Returns |
|--------|---------|
| `setTime(t)` | `true` after moving the clock to `t`. `false` if `t` is earlier than the current time. Setting the same time again is allowed |
| `getSizeAt(path, t)` | The size of the file at `path` at time `t`, or `null` if no file was stored there then. `t` is never later than the current time |

**Time to live.** `addFile` and `addFileAs` take an optional last argument `ttl`, a positive integer. A file added at time `c` with `ttl` expires at `c + ttl`. It is live at times `c` through `c + ttl − 1`, and **expired from `c + ttl` on**.

**Expired files are gone.** Every method treats an expired file as if it had been deleted at its expiry time: its path becomes available, its owner's bytes are freed, and it no longer appears in queries. `updateFile` keeps a file's expiry unchanged.

**"At time `t`"** means after every operation made at time `t`. If a file is added and then updated at the same time, `getSizeAt` returns the updated size. If it is added and deleted at the same time, it returns `null`. History includes deleted and expired files.

**Example.**

| Call | Result | Why |
|------|--------|-----|
| `setTime(10)`, `addFile("/t", 5, 20)` | `true`, `true` | Expires at 30 |
| `setTime(15)`, `updateFile("/t", 8)` | `true`, `5` | |
| `setTime(30)`, `getSize("/t")` | `true`, `null` | Expired at 30 |
| `getSizeAt("/t", 12)` | `5` | |
| `getSizeAt("/t", 29)` | `8` | |
| `getSizeAt("/t", 30)` | `null` | |
| `addFile("/t", 1)` | `true` | The path is free again |
| `setTime(20)` | `false` | Time can't go back |
<!-- /practice:level:4-time -->

<!-- practice:dedup -->
## Onsite Variant: Duplicate Files

A separate, reported onsite coding question, practiced here as a bonus. It works on a real directory tree on disk, not the in-memory store.

Implement `findDuplicates(root)`, an async function returning `Promise<string[][]>`: every group of two or more files below `root` whose **contents** are byte-for-byte identical. Sort the paths within each group, and sort the groups by their first path. Don't follow symbolic links.

**Constraints.** The tree is very large and some files are many gigabytes:
- Never read a whole file into memory.
- Read as few bytes from disk as you can. A file that can't have a duplicate shouldn't be read at all.
<!-- /practice:dedup -->

**After you've tried it.** The usual answer narrows candidates in stages, each costlier than the last: group by size from the directory metadata, then by a hash of the first 4 KB, then by a streamed hash of the whole file. The worked answer is `backend/src/fs/dedup.ts`, and `backend/src/fs/dedup.test.ts` checks the cost: unique sizes are never read, and small files are hashed only once. Start a practice attempt with `npm run practice -- dedup`.
