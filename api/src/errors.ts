const ERRORS = {
  INVALID_INPUT: {
    status: 400,
    message: "Das hat nicht geklappt. Bitte prüfe die Eingaben.",
  },
  INVALID_INVITE: {
    status: 403,
    message: "Diese Einladung ist ungültig oder nicht mehr gültig. Bitte frage eine erwachsene Person.",
  },
  UNAUTHORIZED: {
    status: 401,
    message: "Dieses Spielprofil ist hier nicht angemeldet. Bitte frage eine erwachsene Person.",
  },
  IDENTITY_CONFLICT: {
    status: 409,
    message: "Dieses Spielprofil kann so nicht beitreten. Bitte frage eine erwachsene Person.",
  },
  ROOM_FULL: {
    status: 409,
    message: "Diese Dino-Runde ist voll. Es können höchstens 50 Spielprofile mitmachen.",
  },
  NOT_FOUND: {
    status: 404,
    message: "Diese Dino-Runde oder dieses Spielprofil gibt es nicht mehr.",
  },
  ORIGIN_NOT_ALLOWED: {
    status: 403,
    message: "Diese Spielseite darf die Bestenliste nicht verwenden.",
  },
  RATE_LIMITED: {
    status: 429,
    message: "Das waren gerade zu viele Anfragen. Bitte warte eine Minute.",
  },
  BUSY: {
    status: 503,
    message: "Die Bestenliste ist gerade beschäftigt. Versuche es gleich noch einmal.",
  },
  UNAVAILABLE: {
    status: 503,
    message: "Die Bestenliste ist gerade nicht erreichbar. Du kannst offline weiterspielen.",
  },
} as const;

export type ErrorCode = keyof typeof ERRORS;

export class ApiError extends Error {
  readonly status: number;

  constructor(readonly code: ErrorCode) {
    super(ERRORS[code].message);
    this.name = "ApiError";
    this.status = ERRORS[code].status;
  }
}

export class StoreConflict extends Error {
  constructor() {
    super("Conditional storage operation conflicted.");
    this.name = "StoreConflict";
  }
}

export class StoreUnavailable extends Error {
  constructor() {
    super("Storage operation failed.");
    this.name = "StoreUnavailable";
  }
}

export class ConfigurationError extends Error {
  constructor() {
    super("API configuration is invalid.");
    this.name = "ConfigurationError";
  }
}

export function safeError(error: unknown): ApiError {
  return error instanceof ApiError ? error : new ApiError("UNAVAILABLE");
}
