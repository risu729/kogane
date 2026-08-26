import { createBitwardenAssertion } from '../packages/auth-bitwarden/src/fido2'
import type { BitwardenPasskey } from '../packages/auth-bitwarden/src/vault'
import { createPasskeySession } from '../packages/provider-sbi-sec/src/session'
import type { PasskeyAssertionProvider } from '../packages/provider-sbi-sec/src/types'

interface BitwardenCliItem {
  id?: unknown
  name?: unknown
  login?: {
    uris?: unknown
    fido2Credentials?: unknown
  }
}

interface BitwardenCliUri {
  uri?: unknown
}

type BitwardenCliPasskey = Record<string, unknown>

interface TraceEntry {
  stage: string
  method: string
  status?: number
  outcome: 'response' | 'blocked-before-mts' | 'network-error'
}

const MTS_PROBE_ORIGIN = 'https://sbi-mts-probe.invalid'

class MtsHandoffReached extends Error {
  constructor() {
    super('MTS handoff reached')
    this.name = 'MtsHandoffReached'
  }
}

const readStdin = async () => {
  const chunks: Uint8Array[] = []
  for await (const chunk of Bun.stdin.stream()) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

const requiredString = (value: unknown, label: string) => {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`missing ${label}`)
  return value
}

const optionalString = (value: unknown) =>
  typeof value === 'string' && value.length > 0 ? value : undefined

const readBoolean = (value: unknown, fallback: boolean) => {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

const readCounter = (value: unknown) => {
  const counter = typeof value === 'number' ? value : Number(value)
  return Number.isSafeInteger(counter) && counter >= 0 ? counter : 0
}

const readPasskey = (item: BitwardenCliItem) => {
  const credentials = item.login?.fido2Credentials
  if (!Array.isArray(credentials) || credentials.length !== 1) {
    throw new Error('expected exactly one Bitwarden passkey in the selected item')
  }
  const raw = credentials[0] as BitwardenCliPasskey
  const passkey: BitwardenPasskey = {
    cipherId: requiredString(item.id, 'cipher ID'),
    cipherName: requiredString(item.name, 'cipher name'),
    credentialId: requiredString(raw.credentialId, 'credential ID'),
    rpId: requiredString(raw.rpId, 'RP ID'),
    rpName: optionalString(raw.rpName),
    userName: optionalString(raw.userName),
    userHandle: optionalString(raw.userHandle),
    userDisplay: optionalString(raw.userDisplayName ?? raw.userDisplay),
    counter: readCounter(raw.counter),
    discoverable: readBoolean(raw.discoverable, true),
    keyValue: requiredString(raw.keyValue, 'private key'),
  }
  return passkey
}

const hostnameMatchesRpId = (hostname: string, rpId: string) =>
  hostname === rpId || hostname.endsWith(`.${rpId}`)

const deriveAuthEntryUrl = (item: BitwardenCliItem, rpId: string) => {
  const override = process.env.SBI_AUTH_BASE_URL
  if (override) return new URL(override).toString()

  const uris = item.login?.uris
  if (!Array.isArray(uris)) throw new Error('Bitwarden item has no login URI')
  const matchingUri = uris
    .map((entry) => (entry as BitwardenCliUri).uri)
    .filter((value): value is string => typeof value === 'string')
    .map((value) => new URL(value))
    .find((url) => url.protocol === 'https:' && hostnameMatchesRpId(url.hostname, rpId))
  if (!matchingUri) throw new Error('no HTTPS Bitwarden URI matches the passkey RP ID')

  const path = process.env.SBI_AUTH_ENTRY_PATH ?? '/login/entry'
  return new URL(path, matchingUri.origin).toString()
}

const classifyStage = (url: URL) => {
  if (url.hostname === 'sbi-mts-probe.invalid') return 'mts-handoff'
  if (url.pathname === '/api/fido2/auth/challenge') return 'challenge'
  if (url.pathname === '/fido2/auth') return 'assertion'
  if (url.pathname === '/sso/channel') return 'callback'
  return 'entry'
}

const verifyMtsHandoff = (init?: RequestInit) => {
  const body = init?.body
  if (!(body instanceof URLSearchParams)) throw new Error('unexpected MTS handoff body')
  if (body.get('KIND') !== 'L' || !body.get('TOKEN')) {
    throw new Error('MTS handoff did not contain the decrypted access token')
  }
}

const main = async () => {
  const rawItem = JSON.parse(await readStdin()) as BitwardenCliItem
  const passkey = readPasskey(rawItem)
  const authBaseUrl = deriveAuthEntryUrl(rawItem, passkey.rpId)
  const origin = new URL(authBaseUrl).origin
  const provider: PasskeyAssertionProvider = {
    rpId: passkey.rpId,
    createAssertion: async (request) =>
      createBitwardenAssertion(passkey, request, {
        origin,
        userVerification: true,
        counterBump: false,
      }),
  }

  const trace: TraceEntry[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    const stage = classifyStage(url)
    if (stage === 'mts-handoff') {
      verifyMtsHandoff(init)
      trace.push({ stage, method, outcome: 'blocked-before-mts' })
      throw new MtsHandoffReached()
    }
    try {
      const response = await originalFetch(input, init)
      trace.push({ stage, method, status: response.status, outcome: 'response' })
      return response
    } catch (error) {
      trace.push({ stage, method, outcome: 'network-error' })
      throw error
    }
  }

  try {
    await createPasskeySession({
      authBaseUrl,
      mtsBaseUrl: MTS_PROBE_ORIGIN,
      passkeyProvider: provider,
    })
    throw new Error('MTS handoff was not intercepted')
  } catch (error) {
    if (!(error instanceof MtsHandoffReached)) throw error
  } finally {
    globalThis.fetch = originalFetch
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        status: 'passkey-auth-succeeded',
        mtsHandoffReached: true,
        accessTokenPresent: true,
        trace,
      },
      null,
      2,
    )}\n`,
  )
}

try {
  await main()
} catch (error) {
  const name = error instanceof Error ? error.name : 'UnknownError'
  process.stderr.write(`${JSON.stringify({ status: 'failed', errorType: name })}\n`)
  process.exitCode = 1
}
