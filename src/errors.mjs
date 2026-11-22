export class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function fail(status, code, message) {
  throw new AppError(status, code, message);
}

export function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(400, 'INVALID_BODY', 'Se requiere un objeto JSON.');
  }
  return value;
}

export function id(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail(400, 'INVALID_ID', 'Identificador no válido.');
  return value;
}

export function text(value, name, min, max) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)) {
    fail(400, 'INVALID_FIELD', `El campo ${name} no es válido.`);
  }
  return value.trim();
}
