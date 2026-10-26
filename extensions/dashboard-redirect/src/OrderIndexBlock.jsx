import '@shopify/ui-extensions/preact';
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

const DASHBOARD_URL = "https://esafetysupplies.com.au/pages/dashboard?view=dashboard";
const SESSION_KEY = "esa_dashboard_redirect_done";

export default async () => {
  render(<DashboardRedirect />, document.body);
};

function DashboardRedirect() {
  const [status, setStatus] = useState("checking"); // 'checking' | 'b2b' | 'not-b2b'
  const [showFallback, setShowFallback] = useState(false);

  useEffect(() => {
    let fallbackTimer = null;

    const isB2B = detectB2BSync();

    if (!isB2B) {
      setStatus("not-b2b");
      return;
    }

    setStatus("b2b");

    let alreadyRedirected = false;
    try { alreadyRedirected = !!sessionStorage.getItem(SESSION_KEY); } catch (e) {}

    if (alreadyRedirected) {
      setShowFallback(true);
      return;
    }

    try { sessionStorage.setItem(SESSION_KEY, "1"); } catch (e) {}
    tryAllNavigationMethods();

    fallbackTimer = setTimeout(() => setShowFallback(true), 2000);

    return () => {
      if (fallbackTimer) clearTimeout(fallbackTimer);
    };
  }, []);

  if (status !== "b2b") return null;

  return (
    <s-banner tone="info">
      <s-heading>Redirecting to your dashboard...</s-heading>
      <s-text>
        Please wait while we take you to the eSafety Advantage dashboard.
      </s-text>
      {showFallback && (
        <>
          <s-text>Not redirecting? Click the link below.</s-text>
          <s-link href={DASHBOARD_URL} target="_top">
            Go to Dashboard
          </s-link>
        </>
      )}
    </s-banner>
  );
}

// B2B = the authenticated account has a `purchasingCompany` context.
// shopify.authenticatedAccount exposes purchasingCompany as a signal for
// customers buying on behalf of a company (Shopify Plus B2B).
function detectB2BSync() {
  try {
    if (typeof shopify === "undefined" || !shopify) return false;
    const account = shopify.authenticatedAccount;
    if (!account) return false;

    const pc = account.purchasingCompany;
    if (!pc) return false;

    // Signal-style access first, then plain object fallback.
    let value = pc;
    if (typeof pc === "object") {
      if ("value" in pc) value = pc.value;
      else if ("current" in pc) value = pc.current;
    }

    return !!value;
  } catch (e) {
    return false;
  }
}

function tryAllNavigationMethods() {
  try {
    if (window.top && window.top !== window.self) {
      window.top.location.href = DASHBOARD_URL;
    }
  } catch (e) {}

  try {
    if (window.parent && window.parent !== window.self) {
      window.parent.location.href = DASHBOARD_URL;
    }
  } catch (e) {}

  try { window.location.replace(DASHBOARD_URL); } catch (e) {}
  try { window.location.href = DASHBOARD_URL; } catch (e) {}

  try {
    const a = document.createElement("a");
    a.href = DASHBOARD_URL;
    a.target = "_top";
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
  } catch (e) {}

  try {
    if (typeof shopify !== "undefined" && shopify.navigation && typeof shopify.navigation.navigate === "function") {
      shopify.navigation.navigate(DASHBOARD_URL);
    }
  } catch (e) {}

  try {
    if (window.parent) {
      window.parent.postMessage({ type: "esa-redirect", url: DASHBOARD_URL }, "*");
    }
  } catch (e) {}

  try {
    const meta = document.createElement("meta");
    meta.httpEquiv = "refresh";
    meta.content = "0;url=" + DASHBOARD_URL;
    document.head.appendChild(meta);
  } catch (e) {}
}
