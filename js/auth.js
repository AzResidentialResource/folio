import { PublicClientApplication, InteractionRequiredAuthError } from "../vendor/msal.js";
import { CONFIG, DEMO } from "./config.js";

export class AuthNeeded extends Error {}

let pca = null;
let account = null;

const redirectUri = new URL(".", location.href).href;

export async function initAuth() {
  if (DEMO) return { username: "demo@example.com", name: "Demo" };
  pca = new PublicClientApplication({
    auth: {
      clientId: CONFIG.clientId,
      authority: `https://login.microsoftonline.com/${CONFIG.tenantId}`,
      redirectUri,
      postLogoutRedirectUri: redirectUri,
    },
    cache: { cacheLocation: "localStorage" },
  });
  await pca.initialize();
  const res = await pca.handleRedirectPromise();
  account = res?.account || pca.getAllAccounts()[0] || null;
  if (account) pca.setActiveAccount(account);
  return account;
}

export function login() {
  return pca.loginRedirect({ scopes: CONFIG.scopes, prompt: "select_account" });
}

export function logout() {
  if (DEMO) return;
  return pca.logoutRedirect({ account });
}

// Full-page trip to Microsoft to refresh sign-in. Unsaved text is already on the device.
export function reauth() {
  return pca.acquireTokenRedirect({ scopes: CONFIG.scopes, account, loginHint: account?.username });
}

export async function getToken() {
  if (DEMO) return "demo";
  if (!account) throw new AuthNeeded();
  try {
    const r = await pca.acquireTokenSilent({ scopes: CONFIG.scopes, account });
    return r.accessToken;
  } catch (e) {
    if (e instanceof InteractionRequiredAuthError || /interaction_required|login_required|consent_required|no_tokens_found|monitor_window_timeout/.test(e?.errorCode || "")) {
      throw new AuthNeeded();
    }
    throw e;
  }
}
