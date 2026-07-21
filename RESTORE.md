# RESTORE.md — Emergency Restart Trail (Code-Loss Prevention + Repo Sync, 2026-07-21)

Automated code-loss prevention and sync operation for `mk42-ai/ondemand-hq`.
All backup refs below are PUSHED TO ORIGIN and are permanent until deliberately deleted.

## Operation timeline (UTC)
| Step | Window (UTC) | Action |
|---|---|---|
| Recon + fetch | 2026-07-21T12:22:14Z → 12:22:15Z | `git fetch origin --tags`; verified hashes and ref state |
| 1. Emergency backup | 2026-07-21T12:26:06Z → 12:26:08Z | Backup branch + annotated tag at old HEAD `023ccec`, both pushed |
| 2. Stash preservation | 2026-07-21T12:28:39Z → 12:33:42Z | Stash-backup branch created from `023ccec`, provenance commit pushed |
| 3. Fast-forward main | 2026-07-21T12:34:13Z | `git merge --ff-only origin/main` (exit 0) |
| 4–5. RESTORE.md checkpoint | see checkpoint commit timestamp | This file committed on `main` and pushed |

## Key commits (full 40-char hashes)
| Ref / role | Hash |
|---|---|
| OLD local HEAD (pre-sync, Phase-1 baseline) | `023ccecd2aec44e97a7375127906d2af4a0e8c72` |
| Backup branch tip `backup/pre-sync-2026-07-21-HEAD-023ccec` | `023ccecd2aec44e97a7375127906d2af4a0e8c72` |
| Annotated tag object `emergency-backup-2026-07-21` | `9b1b48dffc145972b4510567ab18e6a7b635d2ec` (targets `023ccec…`) |
| Stash-backup branch tip `backup/stash-ac2fe1d-2026-07-21` | `a6cf92f5d550a17c30771c16c17d3c87120d5c6e` |
| Stash commit (historical, see note) | `ac2fe1d5a5b44a7b27c7cf9f980e550376d2e472` |
| Sync target named in the operation order | `5cd2e6436545895638d36eedc76f12b857349418` |
| origin/main tip at sync time (contains 5cd2e64) | `5d0ca546067e9455d7bc96fc1e0c48753dcc93b8` |
| Staged-index twin commit (17 files, already on remote) | `5dc33ed34f14ba7b4051d168002bc29f0f26abec` |
| Stash parent/base commit | `9bd6d53aedfa14169999de2ec91fcb0be962174c` |

Note on the fast-forward target: the operation order was written against the Phase-1 snapshot
(origin/main = `5cd2e64…`). By execution time origin/main had advanced to `5d0ca546…`, whose
history CONTAINS `5cd2e64…` (verified: `git merge-base --is-ancestor 5cd2e64… HEAD` → true).
`--ff-only` therefore landed main on `5d0ca546…`; no history was rewritten.

Note on the staged index: at execution time the live clone's staged index was EMPTY (0 entries).
The 17-file staged snapshot described in Phase 1 was byte-identical to remote commit
`5dc33ed…`, which is permanently reachable from `origin/main` — nothing staged was lost, and no
extra checkpoint commit on the backup branch was necessary.

Note on stash `ac2fe1d…`: the stash ref lived ONLY in an ephemeral execution-pod clone, which was
recycled BEFORE this operation ran (evidence: `git stash apply stash@{0}` →
`error: stash@{0} is not a valid reference`; `git cat-file -t ac2fe1d…` → object absent). This
operation did not — and could not — drop it. Its content survives in three layers, documented in
`STASH-ac2fe1d-RECONSTRUCTION.md` on branch `backup/stash-ac2fe1d-2026-07-21`:
 1. committed superseding content (`d453b87…`: NOTES.md +123 / PLUGIN_TESTS.md +57; untracked
    tree in `64a7126…`), all reachable from the backup branches;
 2. byte-exact Phase-2 patch artifacts uploaded 2026-07-21 ~00:50 UTC to the session artifact
    store (execution 6a5ec04e193b04e98c3af638): `stash-backup-ac2fe1d-pre-sync-wip.patch`,
    `stash-backup-ac2fe1d-untracked.patch`, `stash-backup-ac2fe1d-untracked-files.tar.gz`,
    `stash-backup-ac2fe1d-via-stash-show.patch`;
 3. the pushed branch `backup/stash-ac2fe1d-2026-07-21` pinning the `023ccec` tree + provenance.

## Restore commands — every scenario
### Restore the old pre-sync HEAD (023ccec)
    git fetch origin
    git checkout backup/pre-sync-2026-07-21-HEAD-023ccec
    # or detached: git checkout 023ccecd2aec44e97a7375127906d2af4a0e8c72
    # or from the tag: git checkout emergency-backup-2026-07-21

### Restore stash content
    git fetch origin
    git checkout backup/stash-ac2fe1d-2026-07-21          # tree + STASH-ac2fe1d-RECONSTRUCTION.md
    # byte-exact stash bytes: download stash-backup-ac2fe1d-pre-sync-wip.patch (Phase-2 session
    # artifact), then:  git checkout 9bd6d53aedfa14169999de2ec91fcb0be962174c && git apply <patch>
    # (git stash apply stash@{0} is NOT available — the stash ref died with its pod; see note above)

### Roll back main to the pre-sync state
    git checkout main
    git reset --hard 023ccecd2aec44e97a7375127906d2af4a0e8c72
    # then force-with-lease ONLY if you truly intend to rewrite origin/main:
    # git push --force-with-lease origin main

### Roll back main to the operation's named sync target (5cd2e64)
    git checkout main && git reset --hard 5cd2e6436545895638d36eedc76f12b857349418

### Fetch all backups fresh from origin (any machine)
    git clone https://github.com/mk42-ai/ondemand-hq.git && cd ondemand-hq
    git fetch origin --tags
    git branch -a | grep backup/
    # refs: backup/pre-sync-2026-07-21-HEAD-023ccec · backup/stash-ac2fe1d-2026-07-21 · tag emergency-backup-2026-07-21
