import { spawnSync } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { makeAdapter } from '@livestore/adapter-node'
import { createStorePromise, makeSchema, queryDb, Schema, SessionIdSymbol, State } from '@livestore/livestore'

const baseDirectory = '.repro-data'

const attempts = Number(process.env.REPRO_ATTEMPTS ?? 20)
const burstCount = Number(process.env.REPRO_BURST_COUNT ?? 200)
const payloadSize = Number(process.env.REPRO_PAYLOAD_SIZE ?? 2000)

const uiState = State.SQLite.clientDocument({
  name: 'uiState',
  schema: Schema.Struct({ draft: Schema.String }),
  default: {
    id: SessionIdSymbol,
    value: { draft: '' },
  },
})

const events = {
  uiStateSet: uiState.set,
}

const state = State.SQLite.makeState({
  tables: { uiState },
  materializers: State.SQLite.materializers(events, {}),
})

const schema = makeSchema({ events, state })
const query$ = queryDb(uiState.get())
const scriptPath = fileURLToPath(import.meta.url)

const openStore = (storeId) => {
  const adapter = makeAdapter({
    storage: { type: 'fs', baseDirectory },
  })

  return createStorePromise({
    adapter,
    schema,
    storeId,
  })
}

const makeExpectedDraft = (attempt) => {
  const payloadChunk = 'x'.repeat(payloadSize)
  return `attempt=${attempt};event=${burstCount - 1};${payloadChunk}`
}

const runWriteAttempt = async (attempt) => {
  const storeId = `node-shutdown-race-${attempt}`

  const writer = await openStore(storeId)
  const payloadChunk = 'x'.repeat(payloadSize)
  for (let i = 0; i < burstCount; i += 1) {
    const expected = `attempt=${attempt};event=${i};${payloadChunk}`
    writer.commit(events.uiStateSet({ draft: expected }))
  }
  await writer.shutdown()
}

const runReadAttempt = async (attempt) => {
  const storeId = `node-shutdown-race-${attempt}`
  const reader = await openStore(storeId)
  const draft = reader.query(query$).draft
  await reader.shutdown()
  console.log(`REPRO_RESULT ${JSON.stringify({ draft })}`)
}

const runChild = (mode, attempt) => {
  const child = spawnSync(process.execPath, [scriptPath, mode, String(attempt)], {
    env: process.env,
    encoding: 'utf8',
  })
  if (child.status !== 0) {
    throw new Error(
      `child ${mode} failed status=${child.status}\nSTDOUT:\n${child.stdout ?? ''}\nSTDERR:\n${child.stderr ?? ''}`,
    )
  }
  return child.stdout ?? ''
}

const parseReadDraft = (stdout) => {
  const line = stdout
    .trim()
    .split('\n')
    .reverse()
    .find((_) => _.startsWith('REPRO_RESULT '))
  if (line === undefined) {
    throw new Error(`reader output missing REPRO_RESULT line:\n${stdout}`)
  }

  const parsed = JSON.parse(line.slice('REPRO_RESULT '.length))
  return parsed.draft
}

const main = async () => {
  await rm(baseDirectory, { recursive: true, force: true })

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    runChild('write', attempt)
    const readStdout = runChild('read', attempt)
    const actual = parseReadDraft(readStdout)
    const expected = makeExpectedDraft(attempt)
    if (actual !== expected) {
      throw new Error(
        `REPRODUCED attempt=${attempt} expectedLength=${expected.length} actualLength=${actual.length} expectedHead=${expected.slice(0, 64)} actualHead=${actual.slice(0, 64)}`,
      )
    }
  }

  throw new Error('Did not reproduce; increase REPRO_BURST_COUNT / REPRO_PAYLOAD_SIZE / REPRO_ATTEMPTS')
}

const mode = process.argv[2]
const attempt = Number(process.argv[3] ?? 0)

if (mode === 'write') {
  await runWriteAttempt(attempt)
} else if (mode === 'read') {
  await runReadAttempt(attempt)
} else {
  await main()
}
