export type Region = "fra" | "iad";
export type KmsMode = "env" | "kms";

// Wire format (env mode):
//   version (1 byte) | nonce (12) | tag (16) | ciphertext (var)
// AAD = utf8(`${customerId}|${region}`) — binds ciphertext to its owner.
export const WIRE_VERSION = 0x01;
