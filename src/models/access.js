export const ROLES = Object.freeze({
  DEVELOPER: "Developer",
  ADMIN: "Admin",
  OS: "OS",
  INDICATORS: "Indicators",
  JOURNAL: "Journal",
});

export const CAPABILITIES = Object.freeze({
  BASE: "base",
  INDICATORS: "indicators",
  JOURNAL: "journal",
  ADMIN: "admin",
});

export const ACCESS_ERRORS = Object.freeze({
  AUTH_REQUIRED: "AUTH_REQUIRED",
  INSUFFICIENT_PERMISSIONS: "INSUFFICIENT_PERMISSIONS",
  ACCOUNT_BANNED: "ACCOUNT_BANNED",
  ROLE_SYNC_FAILED: "ROLE_SYNC_FAILED",
});

export const MAX_ROLE_SNAPSHOT_AGE_MS = 300_000;

export const LOGIN_ERROR_MESSAGES = Object.freeze({
  discord_cancelled: "AUTHENTICATION CANCELLED :: TRY AGAIN WHEN READY",
  invalid_oauth_state: "AUTHENTICATION FAILED :: INVALID OR EXPIRED REQUEST",
  discord_auth_failed: "AUTHENTICATION FAILED :: DISCORD UNAVAILABLE",
  access_revoked: "ACCESS FAILED :: REQUIRED ROLE NOT PRESENT",
  account_banned: "ACCESS FAILED :: ACCOUNT BANNED",
  role_sync_failed: "AUTHENTICATION FAILED :: ROLE SYNC UNAVAILABLE",
});
