import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

// Unregister any stale service workers to ensure fresh code loads
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(registrations => {
        for (const registration of registrations) {
            registration.unregister();
            console.log('[EvigStudio] Unregistered stale service worker');
        }
    });
}

createRoot(document.getElementById("root")!).render(<App />);
