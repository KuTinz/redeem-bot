import { createHmac } from 'node:crypto'

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function decodeBase32(secret: string): Buffer {
    const clean = secret.toUpperCase().replace(/[^A-Z2-7]/g, '')
    let bits = ''
    for (const char of clean) {
        const value = alphabet.indexOf(char)
        if (value < 0) continue
        bits += value.toString(2).padStart(5, '0')
    }
    const bytes: number[] = []
    for (let index = 0; index + 8 <= bits.length; index += 8) {
        bytes.push(Number.parseInt(bits.slice(index, index + 8), 2))
    }
    return Buffer.from(bytes)
}

export function totp(secret: string, now = Date.now()): string {
    const key = decodeBase32(secret)
    if (!key.byteLength) throw new Error('TOTP secret is empty after base32 decoding')
    const counter = Math.floor(now / 1000 / 30)
    const buffer = Buffer.alloc(8)
    buffer.writeBigUInt64BE(BigInt(counter))
    const digest = createHmac('sha1', key).update(buffer).digest()
    const offset = digest[digest.length - 1] & 0x0f
    const code =
        ((digest[offset] & 0x7f) << 24) |
        ((digest[offset + 1] & 0xff) << 16) |
        ((digest[offset + 2] & 0xff) << 8) |
        (digest[offset + 3] & 0xff)
    return String(code % 1000000).padStart(6, '0')
}
