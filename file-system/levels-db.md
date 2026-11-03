# Key-Value Database: Practice Spec

A second four-level practice problem in the same format as [levels.md](./levels.md): one problem that grows over four levels, about 90 minutes, and tests you can't see. You unlock the next level only when the current one passes.

Most reports of the assessment describe an in-memory database rather than a file store, so this spec practices that variant.

**This spec was written for this repository.** It reconstructs the *format* of such an assessment and the themes reported for its database variant (records with fields, scans, timestamps with expiry, history or backups). It is not a copy of any real assessment, and its method names, rules and examples are this repository's own.

To practice it the way it is meant to be practiced, don't read past level 1. Run `npm run practice -- start --problem db` in `backend/`. The tool hands you one level at a time and keeps the clock (see [README.md](./README.md#practice-mode)).

<!-- practice:rules -->
## Rules for Every Level

Implement a class `KvStore`. Each level adds methods. Every earlier method must keep working, and some gain new rules in later levels.

**Records and fields.** The store holds **records**. Each record has a **key** and holds **fields**, and each field has a name and a value. Keys, field names and values are all strings.
- Tests pass non-empty keys and field names. A **value may be the empty string**, and `""` is a value like any other: it is not the same as a missing field.
- Names are case-sensitive: `Name` and `name` are different fields.

**Records are implicit.** You never create a record. A record exists while it holds at least one field. Writing its first field creates it, and deleting its last field deletes it. No method ever leaves an empty record behind.

**Return values.** "Fails" means the method returns `null`, as its signature says, and **changes nothing**. No method throws for an expected failure.
<!-- /practice:rules -->

<!-- practice:level:1 -->
## Level 1: Records

| Method | Returns |
|--------|---------|
| `setField(key, field, value)` | The field's **previous** value, or `null` if the field didn't exist. Stores the new value either way, creating the record if needed |
| `getField(key, field)` | The field's value, or `null` if the record or the field doesn't exist |
| `deleteField(key, field)` | The **deleted** value, or `null` if the record or the field doesn't exist |
| `deleteRecord(key)` | The number of fields the record held when it was deleted, or `null` if the record doesn't exist |

**Example.**

| Call | Result | Why |
|------|--------|-----|
| `setField("u1", "name", "Ada")` | `null` | A new field, and a new record |
| `setField("u1", "name", "Ida")` | `"Ada"` | The previous value |
| `setField("u1", "note", "")` | `null` | |
| `getField("u1", "note")` | `""` | An empty value, not a missing field |
| `getField("u2", "name")` | `null` | No such record |
| `deleteField("u1", "name")` | `"Ida"` | |
| `deleteField("u1", "name")` | `null` | Already gone |
| `deleteRecord("u1")` | `1` | Only `note` was left |
| `deleteRecord("u1")` | `null` | |
<!-- /practice:level:1 -->

<!-- practice:level:2 -->
## Level 2: Scans

| Method | Returns |
|--------|---------|
| `scanRecord(key)` | Every field of the record, formatted `"<field>=<value>"` and sorted by field name. An empty list if the record doesn't exist |
| `scanPrefix(key, prefix)` | The same, keeping only fields whose name **starts with the string** `prefix`. The empty prefix keeps every field |
| `topRecords(prefix, n)` | Up to `n` records whose key starts with the string `prefix`, formatted `"<key>(<number of fields>)"` |

**Ordering.**
- Strings compare by plain code-unit order (the default sort in JavaScript and Python). Upper case sorts before lower case (`Z` < `a`), and digits compare as characters, not numbers (`item10` < `item2`).
- `scanRecord` and `scanPrefix` sort by field name only.
- `topRecords` sorts by number of fields, most first, then by key for equal counts. If `n` is larger than the number of matches, return them all. If `n` ≤ 0, return an empty list.

**Formatting.** Nothing is escaped or trimmed: a field `a` with the value `x=y` scans as `"a=x=y"`, and one with the empty value scans as `"a="`.

**Example.** Starting empty:

| Call | Result |
|------|--------|
| `setField("user:1", "name", "Ada")`, `setField("user:1", "email", "ada@x")`, `setField("user:1", "Nick", "ada")` | `null` each time |
| `setField("user:2", "name", "Bo")`, `setField("user:2", "role", "admin")` | `null` each time |
| `setField("user:10", "name", "Cy")`, `setField("team:1", "name", "Core")` | `null` each time |
| `scanRecord("user:1")` | `["Nick=ada", "email=ada@x", "name=Ada"]` |
| `scanPrefix("user:1", "n")` | `["name=Ada"]` |
| `scanPrefix("user:3", "")` | `[]` |
| `topRecords("", 4)` | `["user:1(3)", "user:2(2)", "team:1(1)", "user:10(1)"]` |
| `topRecords("user:1", 5)` | `["user:1(3)", "user:10(1)"]` |
| `topRecords("user:", 0)` | `[]` |
<!-- /practice:level:2 -->

<!-- practice:level:3 -->
## Level 3: Timestamps and Expiry

Every operation can now carry a **timestamp**: a non-negative integer. Each earlier method gets a timestamped twin, named with `At`, that takes the timestamp as its **first** argument and otherwise behaves the same:

| Method | Returns |
|--------|---------|
| `setFieldAt(t, key, field, value, ttl?)` | As `setField`. The optional `ttl` is described below |
| `getFieldAt(t, key, field)` | As `getField` |
| `deleteFieldAt(t, key, field)` | As `deleteField` |
| `deleteRecordAt(t, key)` | As `deleteRecord` |
| `scanRecordAt(t, key)` | As `scanRecord` |
| `scanPrefixAt(t, key, prefix)` | As `scanPrefix` |
| `topRecordsAt(t, prefix, n)` | As `topRecords` |

**Time only moves forward.** Across all timestamped calls, timestamps never decrease, so you don't need to validate them. Several calls may share a timestamp, and they take effect in the order they are made.

**Untimestamped calls still work.** A level 1 or level 2 method acts at the latest timestamp any timestamped call has used so far, or at `0` before the first one.

**Time to live.** `setFieldAt` takes an optional last argument `ttl`, a positive integer. A value written at time `t` with `ttl` is live at times `t` through `t + ttl − 1`, and **expired from `t + ttl` on**. A value written without a `ttl` never expires.

**Expired fields are gone.** Every method treats an expired field as if it had been deleted at its expiry time: `getField` and `deleteField` return `null`, writing it again returns `null` as the previous value, and scans and counts leave it out. A record whose every field has expired doesn't exist.

**Every write starts a new lifetime.** Setting a field replaces its expiry along with its value. A write without a `ttl` makes the field permanent, even if the old value would have expired. A write with a `ttl` counts from the write's own timestamp.

**Example.**

| Call | Result | Why |
|------|--------|-----|
| `setFieldAt(1, "s:9", "token", "abc", 10)` | `null` | Live at 1 through 10, expired from 11 |
| `setFieldAt(2, "s:9", "user", "ada")` | `null` | No `ttl`: never expires |
| `getFieldAt(10, "s:9", "token")` | `"abc"` | |
| `scanRecordAt(11, "s:9")` | `["user=ada"]` | `token` expired at 11 |
| `setFieldAt(12, "s:9", "token", "def")` | `null` | An expired field doesn't exist |
| `setFieldAt(13, "s:9", "user", "bo", 2)` | `"ada"` | `user` now expires at 15 |
| `topRecordsAt(15, "s:", 5)` | `["s:9(1)"]` | Only `token` is left |
| `getField("s:9", "user")` | `null` | Untimestamped calls act at 15, the latest timestamp |
<!-- /practice:level:3 -->

<!-- practice:level:4-history -->
## Level 4: Point-in-Time Reads

| Method | Returns |
|--------|---------|
| `getFieldAsOf(key, field, asOf)` | The value the field held at time `asOf`, or `null` if it didn't exist then |
| `scanRecordAsOf(key, asOf)` | The record as it was at time `asOf`, in `scanRecord`'s format and order. An empty list if it didn't exist then |

`asOf` is never later than the latest timestamp used so far. These reads don't move the clock.

**"At time `t`"** means after every operation made at time `t`. If a field is set twice at the same time, `getFieldAsOf` returns the second value. If it is set and then deleted at the same time, it returns `null`.

**History includes everything.** Overwritten, deleted and expired values all stay readable at the times they were live. Expiry applies to the past exactly as it does to the present: a value written at `t` with `ttl` is readable as of `t` through `t + ttl − 1`, unless a later write or delete ended it sooner.

**Example.**

| Call | Result | Why |
|------|--------|-----|
| `setFieldAt(5, "cfg", "mode", "a")` | `null` | |
| `setFieldAt(8, "cfg", "mode", "b", 4)` | `"a"` | `b` expires at 12 |
| `setFieldAt(9, "cfg", "size", "L")` | `null` | |
| `deleteRecordAt(14, "cfg")` | `1` | `mode` expired at 12, so only `size` was deleted |
| `getFieldAsOf("cfg", "mode", 4)` | `null` | Before the first write |
| `getFieldAsOf("cfg", "mode", 7)` | `"a"` | |
| `getFieldAsOf("cfg", "mode", 11)` | `"b"` | |
| `getFieldAsOf("cfg", "mode", 12)` | `null` | Expired at 12 |
| `scanRecordAsOf("cfg", 10)` | `["mode=b", "size=L"]` | |
| `scanRecordAsOf("cfg", 14)` | `[]` | Deleted at 14 |
<!-- /practice:level:4-history -->

<!-- practice:level:4-backup -->
## Level 4: Backup and Restore

| Method | Returns |
|--------|---------|
| `backupAt(t)` | The number of live fields saved in the new backup |
| `restoreAt(t, backupTime)` | The number of fields restored, or `null` if no backup was taken at or before time `backupTime` |

**`backupAt`** saves a copy of every live field at time `t`: its record, name and value, and, if it has a `ttl`, its **remaining lifetime** (its expiry time minus `t`). A later change to the store doesn't change the backup. Every backup is kept. A second backup at the same timestamp replaces the first.

**`restoreAt`** replaces the **whole store** with the most recent backup taken at or before `backupTime`:
1. Every field the backup doesn't hold is gone afterwards, including records created after the backup.
2. Each backed-up field is written back with its saved value. A field saved with a remaining lifetime of `r` expires at `t + r`: time spent in a backup doesn't count against a lifetime. A field saved without one stays permanent.
3. Restoring removes no backups, so the same backup can be restored again later.

If there is no such backup, `restoreAt` fails and changes nothing. A backup of an empty store is still a backup: restoring it empties the store and returns `0`.

**Example.**

| Call | Result | Why |
|------|--------|-----|
| `setFieldAt(1, "a", "x", "1")` | `null` | |
| `setFieldAt(2, "a", "y", "2", 10)` | `null` | Expires at 12 |
| `backupAt(5)` | `2` | `y` has 7 left |
| `setFieldAt(6, "b", "z", "3")` | `null` | |
| `deleteFieldAt(7, "a", "x")` | `"1"` | |
| `restoreAt(20, 4)` | `null` | No backup at or before 4 |
| `restoreAt(20, 9)` | `2` | The backup from 5. `y` now expires at 27 |
| `scanRecordAt(26, "a")` | `["x=1", "y=2"]` | |
| `getFieldAt(27, "a", "y")` | `null` | |
| `getField("b", "z")` | `null` | `b` wasn't in the backup |
<!-- /practice:level:4-backup -->

**After you've tried it.** Two choices decide whether level 3 is a refactor or a rewrite. First, make each untimestamped method a one-line call to its `At` twin with the current timestamp, so the rules live in one place. Second, store each field's expiry time next to its value and treat a field as absent once the clock reaches it. Then no method needs a sweep, and the record count in `topRecords` is a count of live fields. For level 4, give every version of a field its own `from` and `to` times, with `to` set to its expiry when it is written and pulled earlier by an overwrite or delete. Expiry then needs no extra event in the history. The worked answer is `backend/src/kv/kv-store.ts`.
