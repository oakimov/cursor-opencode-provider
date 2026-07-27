import { CURSOR_WEBSITE_HOST } from "../shared.js"
import { cursorApiBaseURL } from "../plugin-core.js"
import {
  buildLoginUrl,
  decodeJwtExpiryMs,
  exchangeApiKey,
  generatePkceChallenge,
  generatePkceParams,
  isExpiringSoon,
  pollForTokens,
  refreshAccessToken,
} from "../auth.js"
import { CURSOR_INTEGRATION_ID } from "./catalog.js"
import type {
  CredentialOAuth,
  CredentialValue,
  IntegrationDomain,
  IntegrationDraft,
} from "./types.js"

/**
 * Integration registration for the OpenCode 2.0 plugin — the replacement for the
 * classic plugin's `auth` hook (`methods` + `loader`).
 *
 * Unlike the 1.18 v2 API (where OAuth registration is Effect-valued), 2.0 takes
 * plain Promises, so the PKCE flow from `src/auth.ts` ports across unchanged.
 */

export const CURSOR_OAUTH_METHOD_ID = "oauth"

/** Env vars that can supply a Cursor API key without running /connect. */
export const CURSOR_ENV_NAMES = ["CURSOR_API_KEY"]

function websiteURL(): string {
  return process.env.CURSOR_WEBSITE_URL ?? `https://${CURSOR_WEBSITE_HOST}`
}

/** Browser (PKCE) login: open URL, then poll until Cursor hands back tokens. */
async function authorizeOAuth() {
  const params = generatePkceParams()
  const challenge = await generatePkceChallenge(params.verifier)
  const apiBaseURL = cursorApiBaseURL()
  const url = buildLoginUrl(challenge, params.uuid, websiteURL())

  return {
    url,
    instructions: "Open this URL in a browser to sign in to Cursor",
    mode: "auto" as const,
    callback: pollForTokens(params.uuid, params.verifier, apiBaseURL).then(
      (result): CredentialOAuth => ({
        type: "oauth",
        methodID: CURSOR_OAUTH_METHOD_ID,
        access: result.accessToken,
        refresh: result.refreshToken,
        expires: decodeJwtExpiryMs(result.accessToken) ?? Date.now(),
      }),
    ),
  }
}

/**
 * Renew an expiring Cursor JWT. The host calls this lazily when the stored
 * credential is close to expiry, so it must not assume it runs on every request.
 */
async function refreshOAuth(credential: CredentialOAuth): Promise<CredentialOAuth> {
  const tokens = await refreshAccessToken(credential.refresh, cursorApiBaseURL())
  return {
    type: "oauth",
    methodID: credential.methodID || CURSOR_OAUTH_METHOD_ID,
    access: tokens.accessToken,
    refresh: tokens.refreshToken,
    expires: decodeJwtExpiryMs(tokens.accessToken) ?? Date.now(),
    ...(credential.metadata === undefined ? {} : { metadata: credential.metadata }),
  }
}

/** Register the Cursor integration and its three connection methods. */
export function applyCursorIntegration(draft: IntegrationDraft): void {
  draft.update(CURSOR_INTEGRATION_ID, (integration) => {
    integration.id = CURSOR_INTEGRATION_ID
    integration.name = "Cursor"
  })

  draft.method.update({
    integrationID: CURSOR_INTEGRATION_ID,
    method: {
      id: CURSOR_OAUTH_METHOD_ID,
      type: "oauth",
      label: "Cursor account (browser login)",
    },
    authorize: authorizeOAuth,
    refresh: refreshOAuth,
  })

  draft.method.update({
    integrationID: CURSOR_INTEGRATION_ID,
    method: { type: "key", label: "API key (cursor.com/settings)" },
  })

  draft.method.update({
    integrationID: CURSOR_INTEGRATION_ID,
    method: { type: "env", names: CURSOR_ENV_NAMES },
  })
}

/**
 * Turn a stored credential into a Cursor access token.
 *
 * OAuth credentials already hold a JWT (the host refreshes them via `refresh`
 * above). A `key` credential is the raw `crsr_…` API key, which Cursor requires us
 * to exchange for a short-lived JWT — mirroring the classic plugin's behavior.
 */
export async function accessTokenFromCredential(
  credential: CredentialValue | undefined,
): Promise<string | undefined> {
  if (!credential) return undefined

  if (credential.type === "oauth") {
    if (credential.access && !isExpiringSoon(credential.access)) return credential.access
    if (!credential.refresh) return credential.access || undefined
    try {
      return (await refreshOAuth(credential)).access
    } catch {
      // Fall back to the existing token; the call may still succeed.
      return credential.access || undefined
    }
  }

  if (credential.type === "key") {
    // Already a JWT (e.g. exchanged by an earlier run) — use it directly.
    if (!credential.key.startsWith("crsr_")) return credential.key
    try {
      return (await exchangeApiKey(credential.key, cursorApiBaseURL())).accessToken
    } catch {
      return undefined
    }
  }

  return undefined
}

/** Resolve the active Cursor connection into an access token, if any. */
export async function resolveCursorAccessToken(
  integration: IntegrationDomain,
): Promise<string | undefined> {
  try {
    const connection = await integration.connection.active(CURSOR_INTEGRATION_ID)
    if (!connection) return undefined
    return await accessTokenFromCredential(await integration.connection.resolve(connection))
  } catch {
    return undefined
  }
}
