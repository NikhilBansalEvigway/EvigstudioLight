import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import App from "./App.tsx";
import "./index.css";

const isLocalhost =
  typeof window !== "undefined" &&
  ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);

// We ship a self-signed cert in the Docker image for convenience.
// Browsers will not allow a service worker on an origin with cert errors.
// Keep SW enabled for http://localhost (allowed) and for non-localhost deployments.
const allowServiceWorker =
  typeof window !== "undefined" && (!isLocalhost || window.location.protocol === "http:");

if (import.meta.env.PROD && allowServiceWorker && "serviceWorker" in navigator) {
  registerSW({
    immediate: true,
    onOfflineReady() {
      console.info("[EvigStudio] Offline cache ready");
    },
    onRegisterError(error) {
      console.error("[EvigStudio] Service worker registration failed", error);
    },
  });
} else if ("serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    for (const registration of registrations) {
      registration.unregister();
    }
  });
}

createRoot(document.getElementById("root")!).render(<App />);
