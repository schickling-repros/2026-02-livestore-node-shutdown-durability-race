# LiveStore Node Adapter — commit durability race on immediate shutdown

This repro demonstrates that `store.commit(...)` can update local state while persistence is still pending, so immediate `store.shutdownPromise()` can lose recent committed client-document updates.

## Reproduction

```bash
bun install
bun run repro
```

## Expected

After burst commits, `store.shutdownPromise()` should complete only after the last committed draft is durably persisted.

## Actual

With this repro configuration, reopening the store after immediate shutdown restores a stale draft.
In repeated local runs it consistently restored `event=100` instead of the last committed `event=199`.

## Versions

- @livestore/livestore: 0.3.1
- @livestore/adapter-node: 0.3.1
- Runtime: Node.js 24.13.0
- OS: Linux

## Related Issue

- TBD
