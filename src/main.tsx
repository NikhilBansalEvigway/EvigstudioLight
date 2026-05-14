import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import App from "./App.tsx";
import "./index.css";

if (import.meta.env.PROD && "serviceWorker" in navigator) {
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
