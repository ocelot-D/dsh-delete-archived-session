# dsh-delete-archived-session

A DSH plugin that **lists and deletes archived sessions**.

DSH only ships `archiveSession` / `unarchiveSession`: archiving *hides* a session, and its
log stays on disk forever. There is no built-in way to reclaim that space. This plugin adds
the missing destructive half, as a model-facing tool plus a human-facing slash command.

## What you get

| Surface | Name | Purpose |
|---|---|---|
| Tool | `delete_archived_sessions` | `action:"list"` reports every archived session; `action:"delete"` removes chosen ones |
| Command | `/delete-archived` | Same operations, typed by a person in the composer |

```
/delete-archived list
/delete-archived delete 11111111-2222-3333-4444-555555555555 --yes
/delete-archived delete <id> <id> --yes --permanent
```

## Safety model

Deleting a session destroys conversation history, so the plugin is deliberately conservative.
Every one of these rules is enforced in code and covered by `test/self-test.js`:

1. **Archive-set membership.** Only ids present in `workspaceRegistry.archivedSessionIds` are
   eligible. A non-archived session is refused, never touched.
2. **Explicit intent.** A delete requires at least one exact session id *and* `confirm: true`
   (tool) / `--yes` (command). `/delete-archived delete <id>` without `--yes` refuses and
   prints the exact command to re-run.
3. **Ownership proof.** Before anything is removed, the first record of the session's own log
   must carry that exact `id`. A directory holding another session's log, or no log at all,
   is refused — this is what stops a stray directory from being destroyed by name collision.
4. **Root containment.** The resolved session directory must be a strict descendant of the
   sessions root, so no path can escape it.
5. **Reversible by default.** A delete *moves* the session folder into a trash directory;
   `permanent: true` / `--permanent` unlinks it for real. The trashed copy keeps the exact
   project/session folder names it had under the sessions root, nested under a timestamped
   batch folder:

   ```
   <root>/<projectKey>/<encodedId>  ->  <trashDir>/<timestamp>/<projectKey>/<encodedId>
   ```

   Keeping those names is what makes restoration a plain move back — renaming the folder would
   leave a log the backend can no longer find. A cross-volume trash is reported as an error
   rather than silently becoming a half-finished copy.
6. **Archive entry cleared.** After a successful removal the id is dropped from the archive
   set via `unarchiveSession`, so the UI stops listing a session whose log is gone. An
   archived id with no log on disk also has its stale entry cleared.
7. **Never fatal.** Compressed logs are verified by streaming through a zstd decompressor with
   explicit error handlers, falling back to a bounded in-memory decode. A log still being
   appended can present a torn frame; that must settle as a refused delete, never as an
   unhandled stream error, which inside the Harness host process would be fatal.

## Install

The plugin is a standard DSH bundle: `package.json` declares `dsh.bundle.patch`, and
`cordis.patch.yml` inserts one row.

From an agent session in this profile, using the plugin manager tool (needs
`danger-full-access` or approval):

```
plugin_manager { action: "install_bundle", target: "file:/absolute/path/to/dsh-delete-archived-session" }
```

Then confirm the row is enabled:

```
plugin_manager { action: "list_plugins" }
```

Or manage it by hand in the Web sidebar's **Plugins** page. Installation enables the new
bundle by default; the change affects every session in the profile and, when the profile runs
with HMR, applies immediately — otherwise restart DSH.

To install by hand instead, add the dependency to the profile and list the bundle in
`package.json`:

```json
{
  "dependencies": { "dsh-delete-archived-session": "file:./dsh-delete-archived-session" },
  "dsh": { "profile": { "bundles": ["dsh-delete-archived-session"] } }
}
```

## Configuration

The plugin imports **nothing outside Node's standard library** — it registers plain tool and
command descriptors and takes no schemastery `Config`. That keeps it mountable regardless of
how a profile hoists DSH's own packages. Configuration is therefore environmental:

| Variable | Default | Meaning |
|---|---|---|
| `DSH_DELETE_ARCHIVED_SESSIONS_ROOT` | `$DSH_HOME/sessions` | Sessions root to operate on |
| `DSH_DELETE_ARCHIVED_SESSIONS_TRASH` | `<root>/../.deleted-sessions` | Where deletions are moved |
| `DSH_DELETE_ARCHIVED_SESSIONS_PERMANENT` | unset (permanent allowed) | `0`, `false`, or `no` refuses permanent deletion, forcing the reversible path |

`$DSH_HOME` is read the way DSH itself reads it: `$DSH_HOME`, then `~/.dsh`.

The bundle row id is `delete-archived-session`, so a profile patch can also target it by
id and supply `config.sessionsRoot` / `config.trashDir` / `config.allowPermanent` directly.

## How deletion actually works

There is no session-delete API anywhere in DSH, so the plugin reconstructs the storage layout
the persistence backend uses and acts on the filesystem:

```
<sessions root>/<projectKey(cwd)>/<encodeSegment(sessionId)>/*.jsonl[.zstd]
```

`encodeSegment` and `projectKey` in `lib/session-store.js` are byte-for-byte copies of the
shipped encoders, so a computed directory name matches the one the backend wrote. The session
directory is found by scanning for that **exact** encoded name, which also means an id
containing separators or `..` cannot steer the search.

The consequence worth knowing: DSH's full-text search index (`session-query-sqlite`) is a
*derived* read model. It is mounted with `openAt: never` in the base profile and is not
notified by this plugin, so a deployment that enables content search may keep returning a
deleted session in search results until its index is rebuilt or the process restarts. The log
files, which are the source of truth, are gone immediately.

## Test

```sh
node test/self-test.js        # 26 unit + end-to-end checks, no dependencies
node test/check-manifest.js   # bundle manifest, patch structure, catalog-submission rules
node test/round-trip.js <sandboxRoot> <sessionId>   # real-data delete/restore round-trip
node test/validate-against-dsh.js <dsh-tools/lib/index.js>   # schemas vs. the real DSH validator
```

`self-test.js` covers the encoders, location, ownership proof, root containment, zstd
verification (including a torn trailing frame and an unreadable log), reversible trash,
permanent purge, the command grammar, independent surface mounting, and end-to-end deletes.
`round-trip.js` runs against a copy of a real session directory and proves that a trashed
session still carries the exact folder names the backend locates sessions by, so a move back
restores it byte-for-byte. `validate-against-dsh.js` loads the harness's own `dsh-tools` and
runs its `assertSupportedJsonSchema` / `validateJsonSchemaValue` over this plugin's registry
descriptors, which is what actually decides whether the plugin mounts.

## Verified against a live store

Checked against the sessions root of a running DSH install (`~/.dsh/sessions`, sessions stored
as `session.v4.jsonl.zstd`): all sessions verify by header, and a real 62 KB compressed
session moved to trash and restored intact.

## Publishing to the plugin market

The market ([dsh-market](https://github.com/dsh-market/dsh-market)) reads a curated catalog
served from `awesome-dsh-plugin.com/plugins.json`; the catalog itself comes from the
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) registry. There
is **no automatic GitHub discovery** — a repo appears in the market only after an entry is
merged there.

To list this plugin:

1. Push this directory to a **public** GitHub repo, and add the `dsh-plugin` topic.
2. Open a PR against `awesome-dsh-plugin/awesome-dsh-plugin` adding **one file**, named
   `data/plugins/<owner>__<repo>.yml`. A ready-to-edit copy is in
   [`contrib/OWNER__dsh-delete-archived-session.yml`](contrib/OWNER__dsh-delete-archived-session.yml)
   — replace `OWNER` with your GitHub username and rename the file to match.
3. Optional but recommended: publish to npm as `dsh-delete-archived-session`. The catalog links
   a package to a repo through the package's `repository` field, so set it to your repo URL
   before publishing. Prebuilt installs also skip the build-approval step.

The catalog gate requires a `dsh.bundle` manifest (not `dsh.client` alone), real working code,
a repo at least one day old, and a description that matches the code. `test/check-manifest.js`
checks the machine-checkable half of that locally.

Note for a submission: this plugin's function overlaps existing catalog entries
(`BakaCirno233/dsh-session-delete`, `ChuShiZ/dsh-archive-manager`,
`Earnest02522/dsh-archive-manager`, `AKS1st/dsh-archived-conversations`). The registry's rule
for overlap is "whichever is better kept", so a submission should state what this one does
differently — here, that the default deletion is **reversible** (a trash move that preserves
the folder names needed to restore the session) rather than an outright unlink.
