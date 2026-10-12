// Boundary helpers only; generated Anchor IDL/client remains unavailable until build.
export const FORMULA_VERSION = 'h3-d7-q12-v1';
const encoder = new TextEncoder();

export function formulaVersionBytes(value) {
  if (value !== FORMULA_VERSION) throw new Error('VERSION_MISMATCH');
  const out = new Uint8Array(16);
  out.set(encoder.encode(value));
  return out;
}

export function decodeHash(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error('INVALID_INPUT');
  return Uint8Array.from(value.match(/../g), byte => Number.parseInt(byte, 16));
}

export function parseU64(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('INVALID_INPUT');
  const n = BigInt(value);
  if (n > (1n << 64n) - 1n) throw new Error('INVALID_INPUT');
  return n;
}

const admissionStates = {BLOCKED: 0, RECOVERING: 1, OPEN: 2};
const admissionReasons = {
  WRONG_PHASE: 0, DATA_NOT_READY: 1, DATA_STALE: 2, LOW_ACTIVITY: 3,
  INVALID_DENOMINATOR: 4, PRECISION_UNDERFLOW: 5, VERSION_MISMATCH: 6,
  REQUOTE_REQUIRED: 7, LIMIT_REACHED: 8, INSUFFICIENT_FREE_CAPITAL: 9,
  LP_WINDOW_CLOSED: 10, ALREADY_EXECUTED: 11, UNAUTHORIZED: 12,
  PENDING_CONFIRMATION: 13, BUDGET_EXHAUSTED: 14, STORAGE_BACKLOG: 15,
  INVALID_INPUT: 16,
};

// Reference Borsh encoding for the Rust TradingAdmission struct. The generated
// IDL will be the transaction client's authority once Anchor builds succeed.
export function admissionBorshBytes(value) {
  if (!value || !Object.hasOwn(admissionStates, value.state) ||
      !Number.isInteger(value.recoveryCount) || value.recoveryCount < 0 || value.recoveryCount > 2) {
    throw new Error('INVALID_INPUT');
  }
  if (value.reason !== null && !Object.hasOwn(admissionReasons, value.reason)) throw new Error('INVALID_INPUT');
  if (value.state === 'OPEN' && (value.reason !== null || ![0, 2].includes(value.recoveryCount))) throw new Error('INVALID_INPUT');
  if (value.state === 'RECOVERING' && (value.reason === null || value.recoveryCount !== 1)) throw new Error('INVALID_INPUT');
  if (value.state === 'BLOCKED' && (value.reason === null || value.recoveryCount !== 0)) throw new Error('INVALID_INPUT');
  const bytes = [admissionStates[value.state], value.recoveryCount, Number(value.reason !== null)];
  if (value.reason !== null) bytes.push(admissionReasons[value.reason]);
  return Uint8Array.from(bytes);
}
