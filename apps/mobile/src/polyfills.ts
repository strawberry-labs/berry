import { getRandomValues, randomUUID } from "expo-crypto";

// Hermes lacks Web Crypto. Shared client code (queued follow-ups, the API
// client) calls crypto.randomUUID, so install Expo's native implementation.
type CryptoLike = { randomUUID?: () => string; getRandomValues?: typeof getRandomValues };
const scope = globalThis as unknown as { crypto?: CryptoLike };
scope.crypto ??= {};
scope.crypto.randomUUID ??= randomUUID;
scope.crypto.getRandomValues ??= getRandomValues;
