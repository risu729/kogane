interface BitwardenCliItem {
  id?: unknown
  name?: unknown
  login?: {
    username?: unknown
    password?: unknown
    uris?: unknown
    fido2Credentials?: unknown
  }
}

interface BitwardenCliUri {
  uri?: unknown
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

const itemUris = (item: BitwardenCliItem) => {
  if (!Array.isArray(item.login?.uris)) return []
  return item.login.uris.flatMap((entry) => {
    const uri = (entry as BitwardenCliUri).uri
    return typeof uri === 'string' && uri.length > 0 ? [uri] : []
  })
}

const hostnameMatchesRpId = (hostname: string, rpId: string) =>
  hostname === rpId || hostname.endsWith(`.${rpId}`)

const itemMatchesRpId = (item: BitwardenCliItem, rpId: string) =>
  itemUris(item).some((uri) => {
    try {
      return hostnameMatchesRpId(new URL(uri).hostname, rpId)
    } catch {
      return false
    }
  })

const hasPassword = (item: BitwardenCliItem) =>
  typeof item.login?.password === 'string' && item.login.password.length > 0

export const prepareSbiBitwardenCliSecret = (items: BitwardenCliItem[]) => {
  if (!Array.isArray(items)) throw new Error('Bitwarden item list is not an array')

  const passkeyItems = items.filter(
    (item) => Array.isArray(item.login?.fido2Credentials) && item.login.fido2Credentials.length > 0,
  )
  if (passkeyItems.length !== 1) {
    throw new Error('expected exactly one SBI item with a passkey')
  }
  const passkeyItem = passkeyItems[0]
  const credentials = passkeyItem.login?.fido2Credentials
  if (!Array.isArray(credentials) || credentials.length !== 1) {
    throw new Error('expected exactly one passkey in the SBI item')
  }
  const rawPasskey = credentials[0] as Record<string, unknown>
  const rpId = requiredString(rawPasskey.rpId, 'passkey RP ID')

  const passwordItem = hasPassword(passkeyItem)
    ? passkeyItem
    : (() => {
        const candidates = items.filter((item) => hasPassword(item) && itemMatchesRpId(item, rpId))
        if (candidates.length !== 1) {
          throw new Error('expected exactly one password item matching the passkey RP ID')
        }
        return candidates[0]
      })()

  const uris = [...new Set([...itemUris(passkeyItem), ...itemUris(passwordItem)])].filter((uri) => {
    try {
      return new URL(uri).protocol === 'https:' && hostnameMatchesRpId(new URL(uri).hostname, rpId)
    } catch {
      return false
    }
  })
  if (uris.length === 0) throw new Error('no HTTPS login URI matches the passkey RP ID')

  return {
    id: requiredString(passkeyItem.id, 'passkey item ID'),
    name: requiredString(passkeyItem.name, 'passkey item name'),
    login: {
      username: requiredString(passwordItem.login?.username, 'login ID'),
      password: requiredString(passwordItem.login?.password, 'login password'),
      uris: uris.map((uri) => ({ uri })),
      fido2Credentials: [
        {
          credentialId: requiredString(rawPasskey.credentialId, 'credential ID'),
          keyValue: requiredString(rawPasskey.keyValue, 'private key'),
          rpId,
          rpName: rawPasskey.rpName,
          userName: rawPasskey.userName,
          userHandle: rawPasskey.userHandle,
          userDisplayName: rawPasskey.userDisplayName,
          counter: rawPasskey.counter,
          discoverable: rawPasskey.discoverable,
        },
      ],
    },
  }
}

const main = async () => {
  const items = JSON.parse(await readStdin()) as BitwardenCliItem[]
  process.stdout.write(`${JSON.stringify(prepareSbiBitwardenCliSecret(items), null, 2)}\n`)
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    const name = error instanceof Error ? error.name : 'UnknownError'
    process.stderr.write(`${JSON.stringify({ status: 'failed', errorType: name })}\n`)
    process.exitCode = 1
  }
}
