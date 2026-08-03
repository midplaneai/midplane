"use client";

import { useEffect, useRef } from "react";

// Cloudflare Turnstile widget, explicitly rendered.
//
// Explicit render (?render=explicit + turnstile.render) rather than the implicit
// `class="cf-turnstile"` auto-scan: the implicit mode wants a globally-named
// callback function, which doesn't compose with a React component that needs to
// hand the token to its parent's state. Explicit render keeps the callback a
// closure.
//
// The token is short-lived (~5 minutes) and single-use. Both expiry and error
// clear it via onToken(null) so the submit button re-disables rather than
// letting the form POST a token the server will reject.

interface TurnstileApi {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string;
      action?: string;
      theme?: "light" | "dark" | "auto";
      callback: (token: string) => void;
      "expired-callback"?: () => void;
      "error-callback"?: () => void;
    },
  ) => string;
  remove: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const SCRIPT_ID = "cf-turnstile-script";

/** Load the Turnstile script once per document, resolving when the API is
 *  ready. Multiple widgets (or a remount) share the single tag. */
function loadTurnstile(): Promise<TurnstileApi> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("turnstile: no window"));
  }
  if (window.turnstile) return Promise.resolve(window.turnstile);

  return new Promise((resolve, reject) => {
    const existing = document.getElementById(SCRIPT_ID);
    const onReady = () => {
      if (window.turnstile) resolve(window.turnstile);
      else reject(new Error("turnstile: script loaded but API missing"));
    };
    if (existing) {
      existing.addEventListener("load", onReady, { once: true });
      existing.addEventListener(
        "error",
        () => reject(new Error("turnstile: script failed")),
        { once: true },
      );
      return;
    }
    const script = document.createElement("script");
    script.id = SCRIPT_ID;
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.addEventListener("load", onReady, { once: true });
    script.addEventListener(
      "error",
      () => reject(new Error("turnstile: script failed")),
      { once: true },
    );
    document.head.appendChild(script);
  });
}

/** Renders the challenge and reports the token upward. Renders nothing when
 *  `siteKey` is null, so keyless dev and self-host show no empty slot — the
 *  server is correspondingly not enforcing there (lib/captcha.ts).
 *
 *  `siteKey` arrives as a PROP, resolved by a server component via
 *  captchaSiteKey(). It must not be read from process.env here: this is a
 *  client component, so a NEXT_PUBLIC_ read would be inlined at build time and
 *  come back undefined in an image built without that build arg — while the
 *  server, reading the same variable at runtime, would happily enforce. See the
 *  long note in lib/captcha.ts. */
export function TurnstileWidget({
  siteKey,
  action,
  onToken,
  onLoadError,
  resetSignal = 0,
}: {
  siteKey: string | null;
  action: string;
  onToken: (token: string | null) => void;
  /** Called when the Turnstile script cannot load or render at all (blocked by
   *  an extension, offline, CDN failure). Distinct from onToken(null), which
   *  means "not solved yet". The two are NOT interchangeable: the server
   *  enforces whenever it's configured, so a load failure makes signup
   *  impossible and the form has to SAY so — an unexplained permanently
   *  disabled button is the failure mode this exists to prevent. */
  onLoadError?: () => void;
  /** Bump to tear down and re-render the widget. Needed because tokens are
   *  single-use: after the server rejects a submit, the widget still displays a
   *  solved challenge while its token is spent, so without a reset the user
   *  sits on a disabled button with no way to retry. Also doubles as the retry
   *  path after onLoadError. */
  resetSignal?: number;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Keep the latest callback in a ref so re-rendering the parent (every
  // keystroke in the form) doesn't tear down and re-mount the widget — a
  // remount would discard a solved challenge and re-prompt the user mid-form.
  //
  // Synced in an effect rather than assigned during render: writing to a ref
  // while rendering is not safe under concurrent rendering (a render can be
  // discarded or replayed), and the React compiler lint rejects it. This effect
  // is declared FIRST so it runs before the mount effect below on the initial
  // pass; useRef's initializer covers that first render regardless.
  const onTokenRef = useRef(onToken);
  useEffect(() => {
    onTokenRef.current = onToken;
  }, [onToken]);

  const onLoadErrorRef = useRef(onLoadError);
  useEffect(() => {
    onLoadErrorRef.current = onLoadError;
  }, [onLoadError]);

  useEffect(() => {
    if (!siteKey || !containerRef.current) return;
    let widgetId: string | null = null;
    let cancelled = false;
    let api: TurnstileApi | null = null;

    loadTurnstile()
      .then((turnstile) => {
        if (cancelled || !containerRef.current) return;
        api = turnstile;
        widgetId = turnstile.render(containerRef.current, {
          sitekey: siteKey,
          action,
          theme: "dark",
          callback: (token) => onTokenRef.current(token),
          "expired-callback": () => onTokenRef.current(null),
          "error-callback": () => onTokenRef.current(null),
        });
      })
      .catch((err) => {
        // Report load failure on its OWN channel. Collapsing it into
        // onToken(null) made it indistinguishable from an unsolved challenge,
        // so the form disabled its submit button forever and explained nothing.
        console.error(err);
        if (cancelled) return;
        onTokenRef.current(null);
        onLoadErrorRef.current?.();
      });

    return () => {
      cancelled = true;
      if (widgetId && api) api.remove(widgetId);
    };
    // resetSignal is a dependency ON PURPOSE: bumping it re-runs this effect,
    // whose cleanup removes the spent widget and whose body renders a fresh
    // one. A full re-render rather than turnstile.reset() so the same mechanism
    // covers both retry cases — spent token, and a failed initial load where
    // there is no widget to reset.
  }, [siteKey, action, resetSignal]);

  if (!siteKey) return null;
  return <div ref={containerRef} className="min-h-[65px]" />;
}
