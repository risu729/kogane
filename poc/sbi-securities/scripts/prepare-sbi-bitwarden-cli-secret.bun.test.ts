import { describe, expect, test } from 'bun:test'
import { prepareSbiBitwardenCliSecret } from './prepare-sbi-bitwarden-cli-secret'

const passkey = {
  credentialId: 'credential-id',
  keyValue: 'private-key',
  rpId: 'example.test',
  rpName: 'Example',
  userName: 'passkey-user',
  userHandle: 'user-handle',
  userDisplayName: 'User',
  counter: '0',
  discoverable: 'true',
}

const passkeyItem = (password?: string) => ({
  id: 'passkey-item',
  name: 'Example passkey',
  login: {
    username: password ? 'login-id' : undefined,
    password,
    uris: [{ uri: 'https://login.example.test/' }],
    fido2Credentials: [passkey],
  },
  fields: [{ name: 'trade password', value: 'must-not-be-copied' }],
})

const passwordItem = (id = 'password-item') => ({
  id,
  name: 'Example password',
  login: {
    username: 'login-id',
    password: 'login-password',
    uris: [{ uri: 'https://www.example.test/' }],
  },
  fields: [{ name: 'trade password', value: 'must-not-be-copied' }],
})

describe('prepareSbiBitwardenCliSecret', () => {
  test('uses a password stored with the passkey', () => {
    const result = prepareSbiBitwardenCliSecret([passkeyItem('login-password')])
    expect(result.login.username).toBe('login-id')
    expect(result.login.password).toBe('login-password')
    expect(JSON.stringify(result)).not.toContain('must-not-be-copied')
  })

  test('joins a separate password item through the passkey RP ID', () => {
    const result = prepareSbiBitwardenCliSecret([passkeyItem(), passwordItem()])
    expect(result.login.username).toBe('login-id')
    expect(result.login.password).toBe('login-password')
    expect(result.login.fido2Credentials).toEqual([passkey])
    expect(JSON.stringify(result)).not.toContain('must-not-be-copied')
  })

  test('ignores a password item for a different RP ID', () => {
    const unrelated = passwordItem('unrelated')
    unrelated.login.uris = [{ uri: 'https://unrelated.test/' }]
    expect(() => prepareSbiBitwardenCliSecret([passkeyItem(), unrelated])).toThrow(
      'expected exactly one password item matching the passkey RP ID',
    )
  })

  test('rejects ambiguous matching password items', () => {
    expect(() =>
      prepareSbiBitwardenCliSecret([passkeyItem(), passwordItem('one'), passwordItem('two')]),
    ).toThrow('expected exactly one password item matching the passkey RP ID')
  })
})
