import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { canonicalJson, sha256Hex } from './canonical'
import type { SignedEvent, SyncEvent } from './types'

/** A device's signing identity. The private key never leaves the local config. */
export interface Identity {
  deviceId: string
  publicKey: string // base64 SPKI DER
  privateKey: string // PKCS8 PEM
}

export function newIdentity(): Identity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  return { deviceId: deviceIdFromPublicKey(pub), publicKey: pub, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }
}

export function deviceIdFromPublicKey(publicKey: string): string {
  return sha256Hex(Buffer.from(publicKey, 'base64')).slice(0, 24)
}

export function signEvent<E extends SyncEvent>(event: E, identity: Identity): E & { sig: string } {
  const sig = sign(null, Buffer.from(canonicalJson(event)), createPrivateKey(identity.privateKey)).toString('base64')
  return { ...event, sig }
}

export function verifyEvent(event: SignedEvent, publicKey: string): boolean {
  const { sig, ...body } = event
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' })
    return verify(null, Buffer.from(canonicalJson(body)), key, Buffer.from(sig, 'base64'))
  } catch {
    return false
  }
}

/** Invite codes carry everything a friend needs to trust this device explicitly. */
export interface Invite {
  v: 1
  name: string
  deviceId: string
  publicKey: string
  syncthingId: string
}

export function encodeInvite(invite: Invite): string {
  return 'ce1:' + Buffer.from(JSON.stringify(invite)).toString('base64url')
}

export function decodeInvite(code: string): Invite | null {
  const trimmed = code.trim()
  if (!trimmed.startsWith('ce1:')) return null
  try {
    const raw = JSON.parse(Buffer.from(trimmed.slice(4), 'base64url').toString('utf8'))
    if (raw?.v !== 1) return null
    const { name, deviceId, publicKey, syncthingId } = raw
    if (typeof name !== 'string' || !name.trim() || name.length > 64) return null
    if (typeof publicKey !== 'string' || deviceIdFromPublicKey(publicKey) !== deviceId) return null
    if (typeof syncthingId !== 'string' || !/^[A-Z0-9]{7}(-[A-Z0-9]{7}){7}$/.test(syncthingId)) return null
    return { v: 1, name: name.trim(), deviceId, publicKey, syncthingId }
  } catch {
    return null
  }
}
